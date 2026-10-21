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

/** Redact a text value that Paperclip stores in the board database. */
export function redactPersistedRunText(value: string): string {
  return redactSensitiveText(value);
}

/** Redact a text value that can be empty. */
export function redactPersistedRunTextOrNull(value: string | null): string | null {
  return typeof value === "string" ? redactSensitiveText(value) : null;
}

/**
 * Redact every string inside a value that Paperclip stores in the board
 * database. The function walks objects and arrays. It keeps numbers, booleans
 * and null values. It stops at a fixed depth. A value below that depth is
 * dropped.
 */
export function redactPersistedRunOutput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth >= MAX_REDACTED_RUN_OUTPUT_DEPTH) return null;
  // A date carries no redactable text. Rebuilding it with object entries
  // would turn it into an empty object.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactPersistedRunOutput(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      redactPersistedRunOutput(item, depth + 1),
    ]),
  );
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
