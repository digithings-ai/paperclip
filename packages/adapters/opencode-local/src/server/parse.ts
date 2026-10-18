import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

// The DCP (dynamic context pruning) plugin injects <dcp-system-reminder>
// blocks into the model transcript. They are harness bookkeeping, not
// assistant output, and must never reach a persisted run summary or a board
// comment. Remove the whole block, then any dangling container token left when
// an opening or closing tag is split across JSONL events. The bare @N@
// message-id annotation is left alone: OpenCode uses it as a real message id.
export function stripDcpSystemReminders(text: string): string {
  return text
    .replace(/<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g, "")
    .replace(/<\/?dcp-system-reminder>/g, "")
    .trim();
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const recoveredErrors: string[] = [];
  const toolErrors: string[] = [];
  // An `error` frame is fatal only while no assistant output follows it. A transient
  // transport fault (ECONNRESET, a dropped socket) surfaces as an error frame, but the
  // run often carries on and finishes its work. Whether an error is fatal is therefore a
  // property of the whole stream, not of any single frame: we track it as "did assistant
  // output arrive after the most recent error". A later error frame re-arms the fatal
  // state, so a run that dies mid-stream after producing partial output stays failed.
  let outputAfterError = false;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) {
        messages.push(text);
        if (errors.length > 0) outputAfterError = true;
      }
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      if (errors.length > 0) outputAfterError = true;
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) {
        errors.push(text);
        // A fresh error after recovered output is the last word: re-arm the fatal state.
        outputAfterError = false;
      }
      continue;
    }
  }

  if (outputAfterError) recoveredErrors.push(...errors);

  return {
    sessionId,
    summary: stripDcpSystemReminders(messages.join("\n\n")),
    usage,
    costUsd,
    errorMessage: errors.length > 0 && !outputAfterError ? errors.join("\n") : null,
    recoveredErrors,
    toolErrors,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
