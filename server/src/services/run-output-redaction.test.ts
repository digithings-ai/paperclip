import { describe, expect, it } from "vitest";
import {
  redactAdapterResultForPersistence,
  redactPersistedRunOutput,
  redactPersistedRunText,
} from "./run-output-redaction.js";

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudCIsInNjb3BlIjoiYWdlbnQ6cnVuIn0.c2lnbmF0dXJlLXZhbHVl";

describe("redactPersistedRunText", () => {
  it("removes the value of a secret assignment and keeps the name", () => {
    const redacted = redactPersistedRunText(`PAPERCLIP_API_KEY=${JWT}`);
    expect(redacted).not.toContain(JWT);
    expect(redacted).toContain("PAPERCLIP_API_KEY=");
  });

  it("removes a bare token", () => {
    const redacted = redactPersistedRunText(`token: ${JWT}`);
    expect(redacted).not.toContain(JWT);
  });

  it("keeps text without a secret", () => {
    const text = "the run finished without an error";
    expect(redactPersistedRunText(text)).toBe(text);
  });

  it("removes the value of the shapes a seat prints when it dumps its environment", () => {
    const shapes = [
      `export PAPERCLIP_API_KEY=${JWT}`,
      `PAPERCLIP_RUNTIME_TOOLS_TOKEN=${JWT}`,
      `OPENCODE_API_KEY=sk-synthetic-not-a-real-key-0123456789`,
      `The value of the key is ${JWT}.`,
      `PAPERCLIP_API_KEY="${JWT}"`,
    ];
    for (const shape of shapes) {
      const redacted = redactPersistedRunText(shape);
      expect(redacted, shape).not.toContain(JWT);
      expect(redacted, shape).not.toContain("sk-synthetic-not-a-real-key-0123456789");
    }
  });

  it("removes a token that follows a JSON escape sequence", () => {
    const shapes = [
      `{"output":"PAPERCLIP_API_KEY set: yes\\n${JWT}"}`,
      `{"output":"key\\t${JWT}"}`,
      `{"output":"key\\"${JWT}"}`,
      `{"output":"key\\u0009${JWT}"}`,
    ];
    for (const shape of shapes) {
      const redacted = redactPersistedRunText(shape);
      expect(redacted, shape).not.toContain(JWT);
    }
  });

  it("removes a token that stands at the start of a line", () => {
    const redacted = redactPersistedRunText(`set: yes\n${JWT}\ndone`);
    expect(redacted).not.toContain(JWT);
  });

  it("removes a token with five segments", () => {
    const five = `${JWT}.${JWT}`;
    const redacted = redactPersistedRunText(`key: ${five}`);
    expect(redacted).not.toContain(five);
  });

  it("keeps a dotted identifier that is not a token", () => {
    const text = "session_v2.part.0123456789abcdef";
    expect(redactPersistedRunText(text)).toBe(text);
  });

  it("removes a token that a seat glues to a word", () => {
    const redacted = redactPersistedRunText(`KEYSET=yes${JWT}`);
    expect(redacted).not.toContain(JWT);
    expect(redacted).toContain("KEYSET=yes");
  });

  it("removes a token that touches a letter", () => {
    const redacted = redactPersistedRunText(`key\\u0041${JWT}`);
    expect(redacted).not.toContain(JWT);
  });

  it("keeps the sentence period after a token", () => {
    const redacted = redactPersistedRunText(`The value is ${JWT}.`);
    expect(redacted).not.toContain(JWT);
    expect(redacted.endsWith(".")).toBe(true);
  });
});

describe("redactPersistedRunOutput", () => {
  it("removes a secret inside a nested object", () => {
    const redacted = redactPersistedRunOutput({
      stdout: `PAPERCLIP_API_KEY=${JWT}`,
      nested: { list: [`other=${JWT}`] },
    }) as { stdout: string; nested: { list: string[] } };
    expect(redacted.stdout).not.toContain(JWT);
    expect(redacted.nested.list[0]).not.toContain(JWT);
  });

  it("keeps values that carry no text", () => {
    const redacted = redactPersistedRunOutput({
      exitCode: 0,
      timedOut: false,
      missing: null,
    });
    expect(redacted).toEqual({ exitCode: 0, timedOut: false, missing: null });
  });

  it("drops a value below the depth limit", () => {
    let deep: unknown = "PAPERCLIP_API_KEY=secret";
    for (let index = 0; index < 40; index += 1) deep = { deep };
    const redacted = JSON.stringify(redactPersistedRunOutput(deep));
    expect(redacted).not.toContain("PAPERCLIP_API_KEY");
  });

  it("keeps the secret registry of the run context", () => {
    const registry = { fingerprintSha256: "abc123", material: "encrypted-material" };
    const redacted = redactPersistedRunOutput({
      paperclipSecretRedactions: [registry],
    }) as { paperclipSecretRedactions: unknown[] };
    expect(redacted.paperclipSecretRedactions).toEqual([registry]);
  });
});

describe("redactAdapterResultForPersistence", () => {
  it("removes a secret from the stored output, the error and the summary", () => {
    const redacted = redactAdapterResultForPersistence({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `failed with PAPERCLIP_API_KEY=${JWT}`,
      summary: `printed PAPERCLIP_API_KEY=${JWT}`,
      resultJson: {
        stdout: `PAPERCLIP_API_KEY=${JWT}`,
        stderr: "",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain(JWT);
    expect(redacted.resultJson?.stdout).toContain("PAPERCLIP_API_KEY=");
  });

  it("keeps the fields that carry no text", () => {
    const redacted = redactAdapterResultForPersistence({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(redacted.exitCode).toBe(0);
    expect(redacted.signal).toBeNull();
    expect(redacted.timedOut).toBe(false);
    expect(redacted.resultJson).toBeUndefined();
  });
});
