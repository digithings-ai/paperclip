import type { AdapterExecutionResult } from "../adapters/index.js";
import { redactSensitiveText } from "../redaction.js";

/**
 * Paperclip stores the output of a run in the board database. The output comes
 * from the provider and from the seat. A seat that prints its own environment
 * puts raw credentials in that output. The board database and every backup of
 * it then hold those credentials.
 *
 * The functions below use the same shape check as the runner redactor. They
 * remove a value that looks like a credential. They keep the text around it.
 */

/** A value below this depth is dropped. A deep value can hide a credential. */
const MAX_REDACTED_RUN_OUTPUT_DEPTH = 24;

/**
 * The run context holds a registry of the secret material that the run used.
 * The registry keeps the encrypted material. The run must read it later. The
 * redaction must not touch it.
 */
const RUN_SECRET_REDACTION_REGISTRY_KEY = "paperclipSecretRedactions";

/** The redaction marker of the server redactor. */
export const REDACTED_RUN_OUTPUT_VALUE = "***REDACTED***";

/**
 * The marker of a value that the redaction kept but did not inspect. The value
 * is a class instance, a typed array or a document that sits below the depth
 * limit. The redaction keeps it, because dropping it would lose data. It
 * marks it, because the reader of the stored value has to know that the
 * structure below it was not walked.
 */
export const NOT_INSPECTED_RUN_OUTPUT_VALUE = "***NOT_INSPECTED***";

/** A character of a credential token. The runner uses the same set. */
function isTokenByte(char: string): boolean {
  if (char === ".") return true;
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    char === "_" ||
    char === "-"
  );
}

/** A segment of a JSON string escape. */
const JSON_SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/**
 * The length of a JSON string escape at `index`, and the byte it stands for.
 * A simple escape stands for a control character. A unicode escape stands for
 * the code point it names. The length is zero when the text has no escape.
 */
function jsonEscapeAt(
  text: string,
  index: number,
): { length: number; decoded: string } | null {
  if (text[index] !== "\\") return null;
  const next = text[index + 1];
  if (next === undefined) return { length: 1, decoded: "" };
  if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
    const code = parseInt(text.slice(index + 2, index + 6), 16);
    return { length: 6, decoded: String.fromCharCode(code) };
  }
  if (JSON_SIMPLE_ESCAPES.has(next)) {
    return { length: 2, decoded: "" };
  }
  return { length: 1, decoded: next };
}

/**
 * The runs of token bytes in a text, as `[start, end)` ranges.
 *
 * The runner redactor reads the decoded text of an event. There a newline is a
 * real delimiter between two words. The output that Paperclip stores is the
 * JSON event stream of the provider, so a newline is still the two characters
 * `\` and `n`. The second one is a letter, and a letter that touches a token
 * hides the token from the shape check. This scanner treats a JSON escape
 * sequence as the delimiter that it stands for.
 */
function findTokenRuns(text: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const escape = jsonEscapeAt(text, index);
      if (escape && escape.decoded !== "" && isTokenByte(escape.decoded)) {
        // The escape stands for a token byte, so the run continues.
        if (runStart < 0) runStart = index;
        index += escape.length;
        continue;
      }
      if (runStart >= 0) {
        runs.push([runStart, index]);
        runStart = -1;
      }
      index += escape ? escape.length : 1;
      continue;
    }
    if (isTokenByte(char)) {
      if (runStart < 0) runStart = index;
      index += 1;
      continue;
    }
    if (runStart >= 0) {
      runs.push([runStart, index]);
      runStart = -1;
    }
    index += 1;
  }
  if (runStart >= 0) runs.push([runStart, text.length]);
  return runs;
}

/** A credential token has segments of at least eight token bytes. */
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

/**
 * The shape check of the runner redactor. A token has three or five segments.
 * Its first segment is a JSON header that names an algorithm, or it starts
 * with the base64 prefix of a JSON object.
 */
function looksLikeCredentialToken(candidate: string): boolean {
  const segments = candidate.split(".");
  if (segments.length !== 3 && segments.length !== 5) return false;
  if (!segments.every((segment) => JWT_SEGMENT_PATTERN.test(segment))) return false;
  if (candidate.startsWith("eyJ")) return true;
  try {
    const header = JSON.parse(
      atob(segments[0].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return (
      typeof header === "object" &&
      header !== null &&
      typeof (header as { alg?: unknown }).alg === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Drop a period that ends a sentence. The period is not part of the token. A
 * period inside the token or a second period is not a sentence end.
 */
function sentencePeriodEnd(text: string, start: number, end: number): number {
  if (end - start > 1 && text[end - 1] === "." && text[end - 2] !== ".") {
    const after = text[end];
    if (after === undefined || /\s/.test(after)) return end - 1;
  }
  return end;
}

/**
 * A credential token in a run of token bytes. The token can start inside the
 * run. A seat that prints `${TOKEN:+yes}${TOKEN}` glues the value to a word,
 * and the value is still a value.
 */
const JWT_CANDIDATE_PATTERN =
  /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}(?:\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})?/g;

/**
 * Redact a credential token that the word boundary check of the server
 * redactor cannot see. The output that Paperclip stores keeps the JSON escape
 * form of a newline, and a token that follows such an escape looks like part
 * of a longer word. A seat can also glue the value to a word. This pass uses
 * the shape check of the runner redactor, so both paths agree on what is a
 * credential.
 */
export function redactCredentialTokensInText(value: string): string {
  if (!value.includes("eyJ")) return value;
  const runs = findTokenRuns(value);
  let result = "";
  let cursor = 0;
  for (const [start, runEnd] of runs) {
    const run = value.slice(start, runEnd);
    const pattern = new RegExp(JWT_CANDIDATE_PATTERN.source, "g");
    let match: RegExpExecArray | null = pattern.exec(run);
    while (match !== null) {
      const matchStart = start + match.index;
      const end = sentencePeriodEnd(value, matchStart, matchStart + match[0].length);
      if (looksLikeCredentialToken(value.slice(matchStart, end))) {
        result += value.slice(cursor, matchStart) + REDACTED_RUN_OUTPUT_VALUE;
        cursor = end;
        pattern.lastIndex = match.index + match[0].length;
      }
      match = pattern.exec(run);
    }
  }
  if (cursor === 0) return value;
  return result + value.slice(cursor);
}

/** Redact a text value that Paperclip stores in the board database. */
export function redactPersistedRunText(value: string): string {
  return redactCredentialTokensInText(redactSensitiveText(value));
}

/** Redact a text value that can be empty. */
export function redactPersistedRunTextOrNull(value: string | null): string | null {
  return typeof value === "string" ? redactPersistedRunText(value) : null;
}

/**
 * Mark a value that the redaction keeps but does not inspect. The marker tells
 * the reader of the stored value that the structure was not walked.
 */
function markNotInspected(value: unknown): Record<string, unknown> {
  return { [NOT_INSPECTED_RUN_OUTPUT_VALUE]: true, value };
}

/**
 * A plain record is an object with the prototype of an object literal, or an
 * object without a prototype. A class instance, a typed array, a map and a set
 * are not plain records. The redaction keeps those values as they are, because
 * rebuilding them would lose their prototype or their data.
 */
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The registry of the run context is a list of entries. Every entry carries a
 * fingerprint and the encrypted material of a registered secret. The redaction
 * keeps the registry, because the run reads it later. It keeps the registry
 * only in that shape, so that a map that hides under the same key is redacted
 * like any other value.
 */
function looksLikeSecretRedactionRegistry(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return (
      typeof record.fingerprintSha256 === "string" &&
      typeof record.material === "object" &&
      record.material !== null
    );
  });
}

/**
 * The registry of the run context is exempt from the redaction, at the top
 * level of the value only. A key of that name below the top level is data, and
 * the redaction walks it.
 */
function isSecretRedactionRegistry(
  key: string,
  depth: number,
  value: unknown,
): boolean {
  if (depth !== 0) return false;
  if (key !== RUN_SECRET_REDACTION_REGISTRY_KEY) return false;
  return looksLikeSecretRedactionRegistry(value);
}

/**
 * Redact a value that sits below the depth limit. The value is kept, because
 * dropping it would lose data. The text of the value is checked with the same
 * rule, so a credential that hides below the depth limit is still removed.
 * The value is marked as not inspected, because its structure was not walked.
 */
function redactBelowDepthLimit(value: unknown): unknown {
  if (typeof value === "string") return redactPersistedRunText(value);
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  let text: string | null = null;
  try {
    text = JSON.stringify(value);
  } catch {
    text = null;
  }
  if (typeof text !== "string") return markNotInspected(value);
  const redactedText = redactPersistedRunText(text);
  if (redactedText === text) return markNotInspected(value);
  try {
    return markNotInspected(JSON.parse(redactedText));
  } catch {
    return markNotInspected(value);
  }
}

/**
 * Redact every string inside a value that Paperclip stores in the board
 * database. The function walks objects and arrays. It keeps numbers, booleans
 * and null values. It stops at a fixed depth. A value below that depth is
 * kept, and it is marked as not inspected.
 */
export function redactPersistedRunOutput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactPersistedRunText(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  // A date carries no redactable text. Rebuilding it with object entries
  // would turn it into an empty object.
  if (value instanceof Date) return value;
  if (depth >= MAX_REDACTED_RUN_OUTPUT_DEPTH) {
    return redactBelowDepthLimit(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPersistedRunOutput(item, depth + 1));
  }
  if (!isPlainRecord(value)) {
    // A class instance, a typed array, a map or a set. The redaction keeps the
    // value, because rebuilding it would lose its prototype or its data. It
    // marks the value, because the structure below it was not walked.
    return markNotInspected(value);
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).map(([key, item]): [string, unknown] => [
    key,
    isSecretRedactionRegistry(key, depth, item)
      ? item
      : redactPersistedRunOutput(item, depth + 1),
  ]);
  if (Object.getPrototypeOf(record) === null) {
    // An object without a prototype keeps that prototype.
    const copy: Record<string, unknown> = Object.create(null);
    for (const [key, item] of entries) copy[key] = item;
    return copy;
  }
  return Object.fromEntries(entries);
}

/**
 * Redact the context snapshot of a run before Paperclip stores it. The
 * snapshot carries the issue, the wake comment and the task markdown of the
 * run. A credential pasted into any of them reaches the column as it is, so
 * the snapshot is redacted with the same rule as the run output.
 */
export function redactContextSnapshotForPersistence<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return redactPersistedRunOutput(value) as T;
}

/** Redact the result object of an adapter before Paperclip stores it. */
export function redactPersistedRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (resultJson === null || resultJson === undefined) return resultJson;
  return redactPersistedRunOutput(resultJson) as Record<string, unknown>;
}

/**
 * Redact the output of an adapter before Paperclip stores it in the board
 * database. The adapter returns the raw output of the provider process. That
 * output can hold a credential that the seat printed.
 */
export function redactAdapterResultForPersistence(
  result: AdapterExecutionResult,
): AdapterExecutionResult {
  return {
    ...result,
    errorMessage:
      typeof result.errorMessage === "string"
        ? redactPersistedRunText(result.errorMessage)
        : result.errorMessage,
    summary:
      typeof result.summary === "string"
        ? redactPersistedRunText(result.summary)
        : result.summary,
    errorMeta: redactPersistedRunOutput(result.errorMeta) as
      | Record<string, unknown>
      | undefined,
    resultJson: redactPersistedRunResultJson(result.resultJson),
    nativeFinalization: redactPersistedRunOutput(result.nativeFinalization) as
      | AdapterExecutionResult["nativeFinalization"]
      | undefined,
    runtimeServices: redactPersistedRunOutput(result.runtimeServices) as
      | AdapterExecutionResult["runtimeServices"]
      | undefined,
    referencedProjectStagingFailures: redactPersistedRunOutput(
      result.referencedProjectStagingFailures,
    ) as AdapterExecutionResult["referencedProjectStagingFailures"],
    question: redactPersistedRunOutput(result.question) as
      | AdapterExecutionResult["question"]
      | undefined,
  };
}
