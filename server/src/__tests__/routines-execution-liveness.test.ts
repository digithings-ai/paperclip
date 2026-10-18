import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_LIVENESS_GRACE_MS,
  classifyOpenExecutionIssue,
  isRoutineStrandedGateEnabled,
  type ExecutionLivenessSignals,
} from "../services/routines/execution-liveness.ts";

const NOW = 1_790_000_000_000;

function signals(
  overrides: Partial<ExecutionLivenessSignals> = {},
): ExecutionLivenessSignals {
  return {
    boundRunLive: false,
    deferredWakePending: false,
    nativeFinalizationOpen: false,
    lastActivityAtMs: NOW - DEFAULT_EXECUTION_LIVENESS_GRACE_MS - 1,
    ...overrides,
  };
}

describe("classifyOpenExecutionIssue", () => {
  it("reads finished for terminal statuses even with live signals", () => {
    for (const status of ["done", "cancelled"]) {
      expect(
        classifyOpenExecutionIssue({
          status,
          signals: signals({ boundRunLive: true }),
          nowMs: NOW,
        }),
      ).toBe("finished");
    }
  });

  it("reads live for each arm of the lifted union", () => {
    const liveArms: Array<Partial<ExecutionLivenessSignals>> = [
      { boundRunLive: true },
      { deferredWakePending: true },
      { nativeFinalizationOpen: true },
    ];
    expect(liveArms).not.toHaveLength(0);
    for (const arm of liveArms) {
      expect(
        classifyOpenExecutionIssue({
          status: "in_progress",
          signals: signals(arm),
          nowMs: NOW,
        }),
      ).toBe("live");
    }
  });

  it("reads live inside the grace window with no signals", () => {
    expect(
      classifyOpenExecutionIssue({
        status: "in_progress",
        signals: signals({ lastActivityAtMs: NOW - 60_000 }),
        nowMs: NOW,
      }),
    ).toBe("live");
  });

  it("reads stranded for a stale open issue with no signals", () => {
    expect(
      classifyOpenExecutionIssue({
        status: "in_progress",
        signals: signals({
          lastActivityAtMs:
            NOW - DEFAULT_EXECUTION_LIVENESS_GRACE_MS - 60_000,
        }),
        nowMs: NOW,
      }),
    ).toBe("stranded");
  });

  it("honours an explicit grace window", () => {
    const lastActivityAtMs = NOW - 10_000;
    expect(
      classifyOpenExecutionIssue({
        status: "todo",
        signals: signals({ lastActivityAtMs }),
        nowMs: NOW,
        graceWindowMs: 5_000,
      }),
    ).toBe("stranded");
    expect(
      classifyOpenExecutionIssue({
        status: "todo",
        signals: signals({ lastActivityAtMs }),
        nowMs: NOW,
        graceWindowMs: 30_000,
      }),
    ).toBe("live");
  });
});

describe("isRoutineStrandedGateEnabled", () => {
  it("is off by default", () => {
    expect(
      isRoutineStrandedGateEnabled({} as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("is on only for the exact true string", () => {
    expect(
      isRoutineStrandedGateEnabled({
        ROUTINE_STRANDED_GATE_ENABLED: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isRoutineStrandedGateEnabled({
        ROUTINE_STRANDED_GATE_ENABLED: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
