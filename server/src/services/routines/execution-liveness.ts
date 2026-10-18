import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  nativeRunFinalizations,
} from "@paperclipai/db";

// DIG-4067 (Leaf 2 of DIG-2168; DIG-2152 design item 2).
//
// Execution-liveness classifier for open routine execution issues. The live
// union semantics are lifted from hasActiveExecutionPath in
// server/src/services/recovery/service.ts (re-anchored at chrizefan/paperclip
// master bf15499ec; see UNION_SOURCE_ANCHOR below): a bound run, a deferred
// wake, or an open native finalization each constitute a live execution path.
// This module adds the one thing that source lacks: a grace window, so a
// freshly minted issue with no observable signal yet still reads live instead
// of flapping to stranded on its first read.
//
// UNION_SOURCE_ANCHOR (master bf15499ec):
// - server/src/services/recovery/service.ts ~L157: EXECUTION_PATH_HEARTBEAT_RUN_STATUSES
// - server/src/services/recovery/service.ts ~L1072-1135: hasActiveExecutionPath
//   (bound run via contextSnapshot->>'issueId' + deferred wake via
//   payload->>'issueId' + native finalization join, Promise.all, limit 1 each,
//   Boolean(run || deferredWake || nativeRecovery); no grace window).
// Do not carry old line numbers; re-anchor on read.

export const ROUTINE_STRANDED_GATE_ENV_VAR = "ROUTINE_STRANDED_GATE_ENABLED";

export function isRoutineStrandedGateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ROUTINE_STRANDED_GATE_ENV_VAR] === "true";
}

export type ExecutionLiveness = "live" | "stranded" | "finished";

export const TERMINAL_EXECUTION_ISSUE_STATUSES = new Set([
  "done",
  "cancelled",
]);

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

const OPEN_NATIVE_RECOVERY_STATES = [
  "awaiting_evidence",
  "awaiting_runner_reattach",
  "resuming_session",
  "bootstrap_incomplete",
] as const;

// Grace window: an open issue with no observable signal still reads live
// while its last activity is this fresh. Keeps a just-dispatched issue from
// reading stranded before its run, wake, or finalization row exists.
export const DEFAULT_EXECUTION_LIVENESS_GRACE_MS = 5 * 60 * 1000;

export interface ExecutionLivenessSignals {
  boundRunLive: boolean;
  deferredWakePending: boolean;
  nativeFinalizationOpen: boolean;
  lastActivityAtMs: number;
}

export function classifyOpenExecutionIssue(args: {
  status: string;
  signals: ExecutionLivenessSignals;
  nowMs?: number;
  graceWindowMs?: number;
}): ExecutionLiveness {
  if (TERMINAL_EXECUTION_ISSUE_STATUSES.has(args.status)) {
    return "finished";
  }
  const {
    boundRunLive,
    deferredWakePending,
    nativeFinalizationOpen,
    lastActivityAtMs,
  } = args.signals;
  if (boundRunLive || deferredWakePending || nativeFinalizationOpen) {
    return "live";
  }
  const nowMs = args.nowMs ?? Date.now();
  const graceWindowMs = args.graceWindowMs ?? DEFAULT_EXECUTION_LIVENESS_GRACE_MS;
  if (nowMs - lastActivityAtMs <= graceWindowMs) {
    return "live";
  }
  return "stranded";
}

export interface LivenessSignalReads {
  boundRunLive: boolean;
  deferredWakePending: boolean;
  nativeFinalizationOpen: boolean;
}

// Reads the three live-path signals for one issue, lifting the union from
// recovery/service.ts hasActiveExecutionPath. Bound-run covers both bindings:
// the executionRunId join (routines.ts legacy fast path) and the
// contextSnapshot->>'issueId' match (recovery union arm).
export async function readExecutionLivenessSignals(
  executor: Db,
  args: {
    companyId: string;
    issueId: string;
    executionRunId?: string | null;
    agentId?: string | null;
  },
): Promise<LivenessSignalReads> {
  const agentFilter = args.agentId
    ? eq(heartbeatRuns.agentId, args.agentId)
    : sql`true`;
  const [executionBoundRun, contextBoundRun, deferredWake, nativeRecovery] =
    await Promise.all([
      args.executionRunId
        ? executor
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, args.executionRunId),
                inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
                agentFilter,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      executor
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, args.companyId),
            inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${args.issueId}`,
            agentFilter,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      executor
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, args.companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${args.issueId}`,
            args.agentId
              ? eq(agentWakeupRequests.agentId, args.agentId)
              : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      executor
        .select({ id: nativeRunFinalizations.runId })
        .from(nativeRunFinalizations)
        .innerJoin(
          heartbeatRuns,
          eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        )
        .where(
          and(
            eq(nativeRunFinalizations.companyId, args.companyId),
            eq(nativeRunFinalizations.issueId, args.issueId),
            isNull(nativeRunFinalizations.resultId),
            args.agentId
              ? eq(heartbeatRuns.agentId, args.agentId)
              : sql`true`,
            or(
              inArray(nativeRunFinalizations.recoveryState, [
                ...OPEN_NATIVE_RECOVERY_STATES,
              ]),
              eq(nativeRunFinalizations.phase, "retryable_failure"),
            ),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

  return {
    boundRunLive: Boolean(executionBoundRun ?? contextBoundRun),
    deferredWakePending: Boolean(deferredWake),
    nativeFinalizationOpen: Boolean(nativeRecovery),
  };
}

export interface ClassifiableExecutionIssue {
  companyId: string;
  id: string;
  status: string;
  updatedAt: Date;
  executionRunId: string | null;
}

// DB-backed entry point: reads the union signals for one open issue and
// classifies it. Returns true only for live; stranded and finished both read
// false so the legacy call sites keep their existing null behavior.
export async function isRoutineExecutionIssueLive(
  executor: Db,
  issue: ClassifiableExecutionIssue,
  opts?: {
    agentId?: string | null;
    nowMs?: number;
    graceWindowMs?: number;
  },
): Promise<boolean> {
  const signals = await readExecutionLivenessSignals(executor, {
    companyId: issue.companyId,
    issueId: issue.id,
    executionRunId: issue.executionRunId,
    agentId: opts?.agentId,
  });
  return (
    classifyOpenExecutionIssue({
      status: issue.status,
      signals: {
        ...signals,
        lastActivityAtMs: issue.updatedAt.getTime(),
      },
      nowMs: opts?.nowMs,
      graceWindowMs: opts?.graceWindowMs,
    }) === "live"
  );
}
