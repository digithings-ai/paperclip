import { and, eq, gt, inArray, like, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { RECOVERY_REASON_KINDS } from "./origins.js";

// Bounded continuation for runs the recovery backstop terminalized.
//
// The backstop in services/recovery/service.ts terminalizes a run whose
// process and sandbox are gone (error code "orphaned_running_run") and never
// re-dispatches it. On 21 Oct 2026 three runs were terminalized that way; two
// were picked up again by hand or by the wake queue, one was not, and that
// work was lost.
//
// This module is the eligibility half of the fix. It does not extend the
// actionable liveness states: "needs_followup" is also produced by two cases
// that are not safe to auto-continue, so the gate is on the error code, which
// only the backstop's process-death authority writes. The backstop itself
// keeps terminalizing and never re-dispatches; the continuation is a separate,
// bounded, gated path that reuses the existing liveness continuation.

export const ORPHANED_RUN_CONTINUATION_ERROR_CODE = "orphaned_running_run";
// The other authority of the same backstop. It means the issue already
// reached a terminal status, so the work is finished, not lost. It is never
// continued.
export const ORPHANED_RUN_ISSUE_TERMINAL_ERROR_CODE =
  "orphaned_running_run_issue_terminal";
// Key segment for the error-code-gated continuation. It is not a liveness
// state, so the error-code path can never share an idempotency key with the
// liveness path.
export const ORPHANED_RUN_CONTINUATION_KEY_SEGMENT = "orphaned_run";
// The decisions the sweep takes about an orphaned run. A decided run is never
// a candidate again, so the candidate window is bounded by the runs the sweep
// has not decided yet instead of by the age of the table. Without this marker
// a row the sweep skipped keeps its old timestamp forever, and once enough
// such rows exist the sweep only ever sees those and a fresh orphan is never
// reached.
export const ORPHANED_RUN_CONTINUATION_DECISION_CONTINUED = "continued";
export const ORPHANED_RUN_CONTINUATION_DECISION_EXHAUSTED = "exhausted";
export const ORPHANED_RUN_CONTINUATION_DECISION_DISPATCHED_AGAIN =
  "dispatched_again";
export type OrphanedRunContinuationDecision =
  | typeof ORPHANED_RUN_CONTINUATION_DECISION_CONTINUED
  | typeof ORPHANED_RUN_CONTINUATION_DECISION_EXHAUSTED
  | typeof ORPHANED_RUN_CONTINUATION_DECISION_DISPATCHED_AGAIN;
// Grace period after the work stopped, before the continuation may fire.
// The measured re-dispatch lag on 21 Oct 2026 was 1540s and 7016s, so the
// grace must exceed the larger one.
export const DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS = 3 * 60 * 60 * 1000;
// The instruction the continued seat receives. It says what happened and
// what to do, without inventing a state the backstop never wrote.
export const ORPHANED_RUN_CONTINUATION_INSTRUCTION =
  "The recovery backstop terminalized this run: its process and sandbox were gone while the run still looked alive, so the work stopped without a result. Read the issue and the interrupted run output, check what already landed, and continue the work from that point.";

export type OrphanedRunContinuationRun = {
  status: string;
  errorCode: string | null;
  lastOutputAt: Date | null;
  finishedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
};

export type OrphanedRunContinuationPreflight =
  | { eligible: true; workStoppedAt: Date }
  | { eligible: false; reason: string };

export type OrphanedRunContinuationEligibility =
  | { eligible: true; workStoppedAt: Date; elapsedMs: number; graceMs: number }
  | { eligible: false; reason: string };

export function buildOrphanedRunContinuationIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  errorCode: string;
  nextAttempt: number;
}) {
  return [
    RECOVERY_REASON_KINDS.runLivenessContinuation,
    input.issueId,
    input.sourceRunId,
    ORPHANED_RUN_CONTINUATION_KEY_SEGMENT,
    input.errorCode,
    String(input.nextAttempt),
  ].join(":");
}

// The key prefix every attempt of one source run shares. It lets the sweep
// see a continuation that is still in flight, whatever attempt number it
// carries.
export function buildOrphanedRunContinuationKeyPrefix(input: {
  issueId: string;
  sourceRunId: string;
}) {
  return [
    RECOVERY_REASON_KINDS.runLivenessContinuation,
    input.issueId,
    input.sourceRunId,
    ORPHANED_RUN_CONTINUATION_KEY_SEGMENT,
  ].join(":");
}

export function readOrphanedRunContinuationGraceMs(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.PAPERCLIP_ORPHANED_RUN_CONTINUATION_GRACE_MS;
  if (raw === undefined) return DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS;
  }
  return parsed;
}

// The work-stop time is the last output the run produced, not the time the
// backstop terminalized the row: the backstop can fire hours later (one
// measured orphan was terminalized 5h50m after its work stopped).
export function readOrphanedRunWorkStopAt(
  run: OrphanedRunContinuationRun,
): Date | null {
  return run.lastOutputAt ?? run.finishedAt ?? run.startedAt ?? run.createdAt ?? null;
}

// Cheap gates: the run shape, the work-stop time, the grace period and the
// host-health gate. The "was the issue dispatched again" gate needs the
// database and lives in the caller.
export function evaluateOrphanedRunContinuationPreflight(input: {
  run: OrphanedRunContinuationRun;
  now: Date;
  graceMs?: number;
  hostSaturated: boolean;
}): OrphanedRunContinuationPreflight {
  const { run, now, hostSaturated } = input;
  const graceMs = input.graceMs ?? DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS;

  if (run.status !== "interrupted") {
    return {
      eligible: false,
      reason: `run status ${run.status} is not an orphaned-running-run candidate`,
    };
  }
  if (run.errorCode !== ORPHANED_RUN_CONTINUATION_ERROR_CODE) {
    return {
      eligible: false,
      reason: `error code ${run.errorCode ?? "none"} is not eligible for continuation`,
    };
  }
  const workStoppedAt = readOrphanedRunWorkStopAt(run);
  if (!workStoppedAt) {
    return {
      eligible: false,
      reason: "run has no work-stop timestamp",
    };
  }
  const elapsedMs = now.getTime() - workStoppedAt.getTime();
  if (elapsedMs < graceMs) {
    return {
      eligible: false,
      reason: `continuation grace period has not elapsed (${Math.floor(elapsedMs / 1000)}s of ${Math.floor(graceMs / 1000)}s)`,
    };
  }
  if (hostSaturated) {
    return {
      eligible: false,
      reason: "host is saturated",
    };
  }
  return { eligible: true, workStoppedAt };
}

// The full gate, including the two "at most one" gates: the seat was not
// dispatched again on this issue, and no continuation of this run is already
// in flight. Production calls this helper, so the gates it holds are the
// gates that decide.
export function evaluateOrphanedRunContinuationEligibility(input: {
  run: OrphanedRunContinuationRun;
  now: Date;
  graceMs?: number;
  hostSaturated: boolean;
  laterRunOnIssue: boolean;
  continuationInFlight: boolean;
}): OrphanedRunContinuationEligibility {
  const preflight = evaluateOrphanedRunContinuationPreflight(input);
  if (!preflight.eligible) return preflight;
  if (input.continuationInFlight) {
    return {
      eligible: false,
      reason: "a continuation of this run is already in flight",
    };
  }
  if (input.laterRunOnIssue) {
    return {
      eligible: false,
      reason: "the issue was dispatched again after the run stopped",
    };
  }
  const graceMs = input.graceMs ?? DEFAULT_ORPHANED_RUN_CONTINUATION_GRACE_MS;
  return {
    eligible: true,
    workStoppedAt: preflight.workStoppedAt,
    elapsedMs: input.now.getTime() - preflight.workStoppedAt.getTime(),
    graceMs,
  };
}

// A run on the same issue that was created after the work stopped. It covers
// both re-dispatch paths: a hand dispatch and a wake-queue dispatch.
export async function findLaterRunOnIssue(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    sourceRunId: string;
    after: Date;
  },
) {
  return db
    .select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        ne(heartbeatRuns.id, input.sourceRunId),
        gt(heartbeatRuns.createdAt, input.after),
        sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId} or ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${input.issueId})`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// A continuation of this source run that is queued but not finished yet.
// The sweep can run again before the continued seat produced a run row, so
// without this gate the same orphan could be continued twice.
export async function findPendingOrphanedRunContinuationWake(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    sourceRunId: string;
  },
) {
  const keyPrefix = buildOrphanedRunContinuationKeyPrefix({
    issueId: input.issueId,
    sourceRunId: input.sourceRunId,
  });
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        like(agentWakeupRequests.idempotencyKey, `${keyPrefix}:%`),
        inArray(agentWakeupRequests.status, [
          "queued",
          "deferred_issue_execution",
        ]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
