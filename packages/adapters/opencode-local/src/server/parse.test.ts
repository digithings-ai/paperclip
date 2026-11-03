import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodeSessionReadError,
  isOpenCodeUnknownSessionError,
  stripDcpSystemReminders,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("does not fail a run that produced output after an error frame", () => {
    const econnreset =
      "Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.";
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "session_123", part: {} }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: econnreset },
      }),
      JSON.stringify({ type: "step_start", sessionID: "session_123", part: {} }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered after the socket dropped and finished the task" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: { reason: "done", cost: 0.001, tokens: { input: 10, output: 5, cache: {} } },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.summary).toBe("Recovered after the socket dropped and finished the task");
    expect(parsed.recoveredErrors).toEqual([econnreset]);
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps a trailing error fatal after partial output", () => {
    // Deliberately not "the error frame is last" in general: a run that emits a partial
    // answer and then dies still lost its work, so the last error outranks earlier output.
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Partial answer: the invoice now waits on exactly two" },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "Connection lost while reading the response: ECONNRESET" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toContain("ECONNRESET");
    expect(parsed.recoveredErrors).toEqual([]);
  });

  it("treats the last error as fatal when the run errors again after recovering", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "first ECONNRESET" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Back up and retrying" },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "second ECONNRESET" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toContain("second ECONNRESET");
    expect(parsed.summary).toBe("Back up and retrying");
    expect(parsed.recoveredErrors).toEqual([]);
  });

  it("stays fatal when the run opens a step after an error and then dies", () => {
    // This is the case that rules out the tempting one-liner ("the last frame is not an
    // error, so the run recovered"). A step_start is neither assistant output nor
    // completion: the run errored and then died without producing a result.
    const stdout = [
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "Connection lost while reading the response: ECONNRESET" },
      }),
      JSON.stringify({ type: "step_start", sessionID: "session_123", part: {} }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.errorMessage).toContain("ECONNRESET");
    expect(parsed.summary).toBe("");
    expect(parsed.recoveredErrors).toEqual([]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("isOpenCodeSessionReadError", () => {
  // The error text OpenCode prints when a stored session holds a message row it
  // cannot decode: the storage read of `session_message` fails and the client
  // reports the reason as UnsupportedContentType.
  const sessionReadFailure =
    'UnsupportedContentType: Failed query: select "id", "session_id", "type", "seq", "time_created", "time_updated", "data" from "session_message" where "session_message"."session_id" = ? order by "session_message"."seq" asc\nparams: ["ses_1"]';

  it("detects a session storage read failure in the output, the error log, or the error message", () => {
    expect(isOpenCodeSessionReadError(sessionReadFailure, "")).toBe(true);
    expect(isOpenCodeSessionReadError("", sessionReadFailure)).toBe(true);
    expect(isOpenCodeSessionReadError("", "", sessionReadFailure)).toBe(true);
  });

  it("detects a storage read failure that names the session table", () => {
    expect(
      isOpenCodeSessionReadError(
        'Failed query: select "id" from "session_message" where "session_id" = ?',
        "",
      ),
    ).toBe(true);
  });

  it("does not match failures that are not a session read", () => {
    expect(isOpenCodeSessionReadError("model unavailable", "")).toBe(false);
    expect(isOpenCodeSessionReadError("UnsupportedContentType", "")).toBe(false);
    expect(isOpenCodeSessionReadError('Failed query: select "id" from "kv"', "")).toBe(false);
    expect(isOpenCodeSessionReadError("", "", "connection reset")).toBe(false);
  });
});

describe("DCP system reminders", () => {
it("removes DCP system reminders from the run summary but keeps @N@ ids", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Working on the task" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: {
          text:
            "note @42@ <dcp-system-reminder>CRITICAL WARNING: MAX CONTEXT LIMIT REACHED</dcp-system-reminder>",
        },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("Working on the task\n\nnote @42@");
    expect(parsed.summary).not.toContain("dcp-system-reminder");
    expect(parsed.summary).not.toContain("MAX CONTEXT LIMIT");
  });
});

describe("stripDcpSystemReminders", () => {
  it("removes whole blocks and dangling container tokens but keeps @N@ ids", () => {
    expect(
      stripDcpSystemReminders("a <dcp-system-reminder>x</dcp-system-reminder> b"),
    ).toBe("a  b");
    expect(stripDcpSystemReminders("a </dcp-system-reminder> b")).toBe("a  b");
    expect(stripDcpSystemReminders("keep @42@")).toBe("keep @42@");
  });
});
