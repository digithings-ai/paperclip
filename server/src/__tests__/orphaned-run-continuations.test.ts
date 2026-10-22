import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
  DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS,
  ORPHANED_RUN_CONTINUATION_ERROR_CODE,
  ORPHANED_RUN_ISSUE_TERMINAL_ERROR_CODE,
  buildOrphanedRunContinuationIdempotencyKey,
  buildRunLivenessContinuationIdempotencyKey,
  decideRunLivenessContinuation,
  evaluateOrphanedRunContinuationEligibility,
  evaluateOrphanedRunContinuationPreflight,
  readOrphanedRunContinuationGraceMs,
  readOrphanedRunWorkStopAt,
} from "../services/run-continuations.ts";
import { readHostHealth } from "../services/host-health.ts";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";
const runId = "run-1";

const orphanedSource = {
  kind: "orphaned_run" as const,
  errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    companyId,
    agentId,
    status: "interrupted",
    errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
    continuationAttempt: 0,
    livenessState: null,
    livenessReason: null,
    nextAction: null,
    lastOutputAt: new Date("2026-10-21T01:11:06.099Z"),
    finishedAt: new Date("2026-10-21T07:01:25.163Z"),
    startedAt: new Date("2026-10-21T00:40:00.000Z"),
    createdAt: new Date("2026-10-21T00:40:00.000Z"),
    ...overrides,
  } as never;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "PAP-4933",
    title: "Land the bounded continuation for terminalized runs",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionState: null,
    projectId: null,
    ...overrides,
  } as never;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    status: "idle",
    ...overrides,
  } as never;
}

describe("orphaned run continuation decision", () => {
  it("enqueues one continuation for the process-death authority", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      // The backstop never writes a liveness state.
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: orphanedSource,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.idempotencyKey).toBe(
      buildOrphanedRunContinuationIdempotencyKey({
        issueId,
        sourceRunId: runId,
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        nextAttempt: 1,
      }),
    );
    expect(decision.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      continuationAttempt: 1,
      maxContinuationAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
    });
    expect(decision.contextSnapshot).toMatchObject({
      issueId,
      livenessContinuationAttempt: 1,
      livenessContinuationMaxAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      livenessContinuationSourceRunId: runId,
      livenessContinuationSource: "orphaned_run",
      livenessContinuationErrorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
    });
  });

  it("does not enqueue a second continuation for the same attempt", () => {
    const first = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: orphanedSource,
    });
    const second = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      // The wake of the first attempt is already recorded.
      idempotentWakeExists: true,
      source: orphanedSource,
    });

    expect(first.kind).toBe("enqueue");
    expect(second).toEqual({
      kind: "skip",
      reason: "continuation wake already exists for this source run and attempt",
    });
    if (first.kind !== "enqueue") return;
    // The same attempt always produces the same key, so the wake is found.
    const sameAttempt = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: orphanedSource,
    });
    expect(sameAttempt.kind).toBe("enqueue");
    if (sameAttempt.kind !== "enqueue") return;
    expect(sameAttempt.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("does not continue the issue-terminal authority", () => {
    const bySource = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: {
        kind: "orphaned_run",
        errorCode: ORPHANED_RUN_ISSUE_TERMINAL_ERROR_CODE,
      },
    });
    expect(bySource.kind).toBe("skip");

    const byRun = decideRunLivenessContinuation({
      run: run({ errorCode: ORPHANED_RUN_ISSUE_TERMINAL_ERROR_CODE }),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: orphanedSource,
    });
    expect(byRun.kind).toBe("skip");
  });

  it("keeps the two authorities on separate idempotency keys", () => {
    const processDeath = buildOrphanedRunContinuationIdempotencyKey({
      issueId,
      sourceRunId: runId,
      errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
      nextAttempt: 1,
    });
    const issueTerminal = buildOrphanedRunContinuationIdempotencyKey({
      issueId,
      sourceRunId: runId,
      errorCode: ORPHANED_RUN_ISSUE_TERMINAL_ERROR_CODE,
      nextAttempt: 1,
    });
    const liveness = buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      nextAttempt: 1,
    });

    expect(processDeath).not.toBe(issueTerminal);
    expect(processDeath).not.toBe(liveness);
    expect(liveness).toBe(`run_liveness_continuation:${issueId}:${runId}:plan_only:1`);
  });

  it("does not continue while the host gate is closed", () => {
    const preflight = evaluateOrphanedRunContinuationPreflight({
      run: run(),
      now: new Date("2026-10-21T10:00:00.000Z"),
      hostSaturated: true,
    });

    expect(preflight.eligible).toBe(false);
    if (preflight.eligible) return;
    expect(preflight.reason).toContain("host is saturated");
  });

  it("does not continue when the issue was dispatched again", () => {
    const eligibility = evaluateOrphanedRunContinuationEligibility({
      run: run(),
      now: new Date("2026-10-21T10:00:00.000Z"),
      hostSaturated: false,
      laterRunOnIssue: true,
      continuationInFlight: false,
    });

    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toContain("dispatched again");
  });

  it("does not continue while a continuation of the same run is in flight", () => {
    const eligibility = evaluateOrphanedRunContinuationEligibility({
      run: run(),
      now: new Date("2026-10-21T10:00:00.000Z"),
      hostSaturated: false,
      laterRunOnIssue: false,
      continuationInFlight: true,
    });

    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toContain("already in flight");
  });

  it("continues when both at-most-one gates are open", () => {
    const eligibility = evaluateOrphanedRunContinuationEligibility({
      run: run(),
      now: new Date("2026-10-21T10:00:00.000Z"),
      hostSaturated: false,
      laterRunOnIssue: false,
      continuationInFlight: false,
    });

    expect(eligibility.eligible).toBe(true);
  });

  it("holds the attempt cap on the orphaned path", () => {
    // The attempt counter is read from the source run row, so the cap holds
    // across a chain of orphans on the same issue.
    const second = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 1 }),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: orphanedSource,
    });
    expect(second.kind).toBe("enqueue");
    if (second.kind !== "enqueue") return;
    expect(second.nextAttempt).toBe(2);
    expect(second.idempotencyKey).toBe(
      buildOrphanedRunContinuationIdempotencyKey({
        issueId,
        sourceRunId: runId,
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        nextAttempt: 2,
      }),
    );

    const third = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 2 }),
      issue: issue(),
      agent: agent(),
      livenessState: null,
      livenessReason: null,
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      source: orphanedSource,
    });
    expect(third.kind).toBe("exhausted");
    if (third.kind !== "exhausted") return;
    expect(third.attempt).toBe(2);
    expect(third.maxAttempts).toBe(DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS);
  });

  it("waits for the grace period after the work stopped", () => {
    // One hour after the work stopped: inside the default grace (3h).
    const now = new Date("2026-10-21T02:11:06.099Z");
    const withinGrace = evaluateOrphanedRunContinuationPreflight({
      run: run(),
      now,
      hostSaturated: false,
    });
    expect(withinGrace.eligible).toBe(false);
    if (withinGrace.eligible) return;
    expect(withinGrace.reason).toContain("grace period");

    // Same moment, a grace that has passed.
    const afterGrace = evaluateOrphanedRunContinuationPreflight({
      run: run(),
      now,
      graceMs: 60_000,
      hostSaturated: false,
    });
    expect(afterGrace.eligible).toBe(true);
  });

  it("measures the grace from the work stop, not from the terminal write", () => {
    // The measured orphan: the work stopped at 01:11:06 and the backstop
    // terminalized the row at 07:01:25, almost six hours later.
    const runRow = run();
    expect(readOrphanedRunWorkStopAt(runRow).toISOString()).toBe(
      "2026-10-21T01:11:06.099Z",
    );
    // The default grace must exceed the largest measured re-dispatch lag
    // (7016s), otherwise a seat that was picked up again gets a second run.
    expect(DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS).toBeGreaterThan(7016 * 1000);
  });

  it("reads the grace period from the environment with a safe default", () => {
    expect(readOrphanedRunContinuationGraceMs({})).toBe(
      DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS,
    );
    expect(
      readOrphanedRunContinuationGraceMs({
        PAPERCLIP_ORPHANED_RUN_CONTINUATION_GRACE_MS: "60000",
      }),
    ).toBe(60_000);
    expect(
      readOrphanedRunContinuationGraceMs({
        PAPERCLIP_ORPHANED_RUN_CONTINUATION_GRACE_MS: "not-a-number",
      }),
    ).toBe(DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS);
  });

  it("keeps the liveness path on the actionable states only", () => {
    // "needs_followup" is also produced by two cases that are not safe to
    // auto-continue, so a blanket extension of the liveness states is wrong.
    const decision = decideRunLivenessContinuation({
      run: run({ status: "succeeded", errorCode: null, livenessState: "needs_followup" }),
      issue: issue(),
      agent: agent(),
      livenessState: "needs_followup",
      livenessReason: "Run described future work that is not safe to auto-continue",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "liveness state is not actionable for continuation",
    });
  });
});

describe("host health gate", () => {
  it("closes the gate on a saturated host", () => {
    const health = readHostHealth({
      env: {},
      loadAverage1m: 128.5,
      cpuCount: 18,
    });
    expect(health.saturated).toBe(true);
    expect(health.source).toBe("load_average");
  });

  it("opens the gate on a recovered host", () => {
    const health = readHostHealth({
      env: {},
      loadAverage1m: 21.04,
      cpuCount: 18,
    });
    expect(health.saturated).toBe(false);
  });

  it("honours the operator override", () => {
    expect(
      readHostHealth({ env: { PAPERCLIP_HOST_SATURATED: "1" } }).saturated,
    ).toBe(true);
    expect(
      readHostHealth({ env: { PAPERCLIP_HOST_SATURATED: "0" } }).saturated,
    ).toBe(false);
  });

  it("stays open when the host load cannot be read", () => {
    const health = readHostHealth({
      env: {},
      loadAverage1m: null,
      cpuCount: 18,
    });
    expect(health.saturated).toBe(false);
    expect(health.source).toBe("unavailable");
  });
});
