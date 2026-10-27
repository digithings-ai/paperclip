import { describe, expect, it } from "vitest";
import {
  FINALIZATION_DEADLINE_ERROR_CODE,
  FINALIZATION_DEADLINE_NEXT_ACTION,
  finalizationDeadlineError,
  finalizationDeadlineResultJson,
  type FinalizationDeadlineRunFacts,
} from "./finalization-deadline-failure.js";

const deadlineAt = new Date("2026-10-26T23:57:40.309Z");
const recordedAt = new Date("2026-10-26T23:57:43.290Z");

function facts(overrides: Partial<FinalizationDeadlineRunFacts> = {}): FinalizationDeadlineRunFacts {
  return {
    lastOutputAt: new Date("2026-10-26T23:56:40.309Z"),
    lastOutputSeq: 39,
    lastOutputBytes: 218791,
    processPid: null,
    ...overrides,
  };
}

describe("finalizationDeadlineError", () => {
  it("names the last output, the deadline and the recorded time", () => {
    const message = finalizationDeadlineError(facts(), deadlineAt, recordedAt);
    expect(message).toContain("Finalization deadline exceeded");
    expect(message).toContain("2026-10-26T23:56:40.309Z");
    expect(message).toContain("seq 39");
    expect(message).toContain("218791 bytes");
    expect(message).toContain("2026-10-26T23:57:40.309Z");
    expect(message).toContain("2026-10-26T23:57:43.290Z");
  });

  it("never repeats the board instruction as the cause", () => {
    const message = finalizationDeadlineError(facts(), deadlineAt, recordedAt);
    expect(message).not.toContain("Inspect the failed run");
    expect(message).not.toBe(FINALIZATION_DEADLINE_NEXT_ACTION);
  });

  it("says the provider had stopped when the run records no pid", () => {
    expect(finalizationDeadlineError(facts({ processPid: null }), deadlineAt, recordedAt))
      .toContain("provider had already stopped");
  });

  it("asks for a process check when the run still records a pid", () => {
    const message = finalizationDeadlineError(facts({ processPid: 4242 }), deadlineAt, recordedAt);
    expect(message).toContain("pid 4242");
    expect(message).toContain("check that process");
  });

  it("handles a run that never produced output", () => {
    const message = finalizationDeadlineError(
      facts({ lastOutputAt: null, lastOutputSeq: 0, lastOutputBytes: null }),
      deadlineAt,
      recordedAt,
    );
    expect(message).toContain("produced no output");
    expect(message).toContain("2026-10-26T23:57:40.309Z");
  });

  it("falls back when the deadline was already cleared", () => {
    const message = finalizationDeadlineError(facts(), null, recordedAt);
    expect(message).toContain("an earlier sweep");
    expect(message).toContain("Finalization deadline exceeded");
  });

  it("stays inside the 512 character bound and one line", () => {
    const message = finalizationDeadlineError(
      facts({ lastOutputBytes: null }),
      deadlineAt,
      recordedAt,
    );
    expect(message.length).toBeLessThanOrEqual(512);
    expect(message).not.toContain("\n");
  });
});

describe("finalizationDeadlineResultJson", () => {
  it("records the facts instead of a null result", () => {
    const marker = finalizationDeadlineResultJson(facts(), deadlineAt, recordedAt, null);
    expect(marker.finalization).toMatchObject({
      cause: FINALIZATION_DEADLINE_ERROR_CODE,
      deadlineAt: "2026-10-26T23:57:40.309Z",
      lastOutputAt: "2026-10-26T23:56:40.309Z",
      lastOutputSeq: 39,
      lastOutputBytes: 218791,
      providerProcessRecorded: false,
      recordedAt: "2026-10-26T23:57:43.290Z",
    });
  });

  it("keeps facts an earlier writer already put on the run", () => {
    const marker = finalizationDeadlineResultJson(facts(), deadlineAt, recordedAt, {
      workspaceRestoreFailure: { code: "restore_failed" },
    });
    expect(marker.workspaceRestoreFailure).toEqual({ code: "restore_failed" });
    expect(marker.finalization).toBeTruthy();
  });
});
