import { describe, expect, it } from "vitest";
import {
  TOOL_CONNECTION_ATTENTION_HEALTH_STATUSES,
  TOOL_CONNECTION_HEALTH_STATUSES,
  isToolConnectionAttentionHealth,
} from "./constants.js";

describe("tool connection health statuses", () => {
  it("knows the status of a failed background probe", () => {
    expect(TOOL_CONNECTION_HEALTH_STATUSES).toContain("probe_failed");
    expect(TOOL_CONNECTION_HEALTH_STATUSES).toContain("tool_timeout");
  });

  it("does not treat a failed background probe as a hide-gate", () => {
    // The attention list is a hide-gate. A native run does not get the MCP
    // server of a connection with an attention status, a connection intent
    // cannot select it, and the UI filters it out of the usable connections.
    // A status that must stay discoverable must not be in this list.
    expect(isToolConnectionAttentionHealth("probe_failed")).toBe(false);
    expect(isToolConnectionAttentionHealth("tool_timeout")).toBe(false);
  });

  it("keeps the attention list on the statuses that hide a connection", () => {
    expect([...TOOL_CONNECTION_ATTENTION_HEALTH_STATUSES].sort()).toEqual([
      "degraded",
      "error",
      "failed",
      "missing_secret",
    ]);
  });
});
