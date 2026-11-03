import { describe, expect, it, vi } from "vitest";
import { conflict } from "../errors.ts";
import {
  runStartupDecisionSweep,
  runStartupNativeRecoveryFailClosed,
  runStartupRecoverableSteps,
  type StartupRecoveryHeartbeat,
} from "../startup-heartbeat-recovery.ts";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createHeartbeat(overrides: Partial<Record<keyof StartupRecoveryHeartbeat, () => Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const ok = <T>(name: string, value: T) => vi.fn(async () => {
    calls.push(name);
    const override = overrides[name as keyof StartupRecoveryHeartbeat];
    if (override) return override() as Promise<T>;
    return value;
  });
  const heartbeat = {
    promoteDueScheduledRetries: ok("promoteDueScheduledRetries", { promoted: 0, runIds: [] }),
    resumeQueuedRuns: ok("resumeQueuedRuns", undefined),
    recoverPendingSessionGoalActions: ok("recoverPendingSessionGoalActions", {
      scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0, notInvokableSkipped: 0,
    }),
    recoverActiveSessionGoals: ok("recoverActiveSessionGoals", { scanned: 0, enqueued: 0, notInvokableSkipped: 0 }),
    reconcileStrandedAssignedIssues: ok("reconcileStrandedAssignedIssues", {
      dispatchRequeued: 0, continuationRequeued: 0, escalated: 0, skipped: 0, issueIds: [],
    }),
    reconcileResolvedDependencyWakes: ok("reconcileResolvedDependencyWakes", { healed: 0 }),
    reconcileTaskWatchdogs: ok("reconcileTaskWatchdogs", { checked: 0, triggered: 0 }),
    scanSilentActiveRuns: ok("scanSilentActiveRuns", { created: 0 }),
    sweepStaleIssueLocks: ok("sweepStaleIssueLocks", { cleared: 0 }),
    sweepOrphanedRunContinuations: ok("sweepOrphanedRunContinuations", { requeued: 0 }),
  } as unknown as StartupRecoveryHeartbeat;
  return { heartbeat, calls };
}

const ALL_STEPS = [
  "promoteDueScheduledRetries",
  "resumeQueuedRuns",
  "recoverPendingSessionGoalActions",
  "recoverActiveSessionGoals",
  "reconcileStrandedAssignedIssues",
  "reconcileResolvedDependencyWakes",
  "reconcileTaskWatchdogs",
  "scanSilentActiveRuns",
  "sweepStaleIssueLocks",
  "sweepOrphanedRunContinuations",
];

describe("runStartupRecoverableSteps", () => {
  it("runs every recoverable step in order", async () => {
    const { heartbeat, calls } = createHeartbeat();
    const logger = createLogger();

    const outcomes = await runStartupRecoverableSteps({ heartbeat, logger });

    expect(calls).toEqual(ALL_STEPS);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a not-invokable 409 from one step and still runs every later step", async () => {
    const { heartbeat, calls } = createHeartbeat({
      recoverActiveSessionGoals: async () => {
        throw conflict("Agent is not invokable in its current state", { status: "paused", reason: "paused" });
      },
      reconcileTaskWatchdogs: async () => {
        throw new Error("watchdog pass failed");
      },
    });
    const logger = createLogger();

    const outcomes = await runStartupRecoverableSteps({ heartbeat, logger });

    expect(calls).toEqual(ALL_STEPS);
    expect(outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.step)).toEqual([
      "recover_active_session_goals",
      "reconcile_task_watchdogs",
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "recover_active_session_goals" }),
      "startup heartbeat recovery step failed - continuing with the next step",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failedSteps: ["recover_active_session_goals", "reconcile_task_watchdogs"],
      }),
      "startup heartbeat recovery finished with failed steps",
    );
  });

  it("keeps going when the first step fails", async () => {
    const { heartbeat, calls } = createHeartbeat({
      promoteDueScheduledRetries: async () => {
        throw new Error("promotion failed");
      },
    });

    await expect(runStartupRecoverableSteps({ heartbeat, logger: createLogger() })).resolves.toBeDefined();
    expect(calls).toEqual(ALL_STEPS);
  });
});

describe("runStartupNativeRecoveryFailClosed", () => {
  it("rethrows a native runner recovery failure so startup stays fail-closed", async () => {
    const logger = createLogger();
    const failure = new Error("native recovery failed");
    const heartbeat = { recoverNativeRunsAfterRestart: vi.fn(async () => { throw failure; }) };

    await expect(
      runStartupNativeRecoveryFailClosed({ heartbeat: heartbeat as never, logger }),
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure },
      "startup native runner restart recovery failed closed",
    );
  });

  it("logs classified dispositions and resolves on success", async () => {
    const logger = createLogger();
    const heartbeat = {
      recoverNativeRunsAfterRestart: vi.fn(async () => ({
        restartKind: "cold",
        dispositions: [{}],
        claims: [{ runId: "run-1", kind: "resume", controllerGeneration: 2 }],
        awaitingEvidenceRunIds: [],
        blockedRunIds: [],
      })),
    };

    await expect(
      runStartupNativeRecoveryFailClosed({ heartbeat: heartbeat as never, logger }),
    ).resolves.toMatchObject({ restartKind: "cold" });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ claims: [{ runId: "run-1", disposition: "resume", controllerGeneration: 2 }] }),
      "startup native runner restart recovery classified",
    );
  });
});

describe("runStartupDecisionSweep", () => {
  it("logs and resolves when the decision sweep throws a not-invokable 409", async () => {
    const logger = createLogger();
    const err = conflict("Agent is not invokable", { reason: "paused" });
    const decisions = { sweepExpired: vi.fn(async () => { throw err; }) };

    await expect(runStartupDecisionSweep({ decisions, logger })).resolves.toBe(false);

    expect(decisions.sweepExpired).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err },
      "startup decision expiry sweep failed - continuing startup; the scheduler tick retries it",
    );
  });

  it("resolves true and logs nothing when the sweep completes", async () => {
    const logger = createLogger();
    const decisions = { sweepExpired: vi.fn(async () => ({ expired: 0, resumed: 0 })) };

    await expect(runStartupDecisionSweep({ decisions, logger })).resolves.toBe(true);

    expect(logger.error).not.toHaveBeenCalled();
  });
});
