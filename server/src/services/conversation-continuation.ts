import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { assessRecordedExecutionLiveness } from "./process-identity.js";

// These adapters accept a conversation turn. Retrying a process or webhook can
// replay the action itself, so those adapters retain their recovery contract.
export const CONVERSATION_ADAPTER_TYPES = [
  "claude_local", "codex_local", "cursor", "gemini_local", "opencode_local",
  "pi_local", "grok_local", "kimi_local", "hermes_local",
] as const;

export function isConversationAdapter(adapterType: string): boolean {
  return (CONVERSATION_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export const CONVERSATION_CONTINUATION_POLICY = "continue_conversation_v1";

export function hasConversationContinuationPolicy(result: Record<string, unknown> | null | undefined): boolean {
  return result?.workspaceRestoreFailure !== "restore_unsafe_archive" && result?.conversationContinuation === CONVERSATION_CONTINUATION_POLICY;
}

/** Persisted by the server when it claims the run, before remote provisioning. */
export function claimedAdapterType(run: Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson">): string | null {
  const dispatch = run.runnerProfileJson?.adapterDispatch as Record<string, unknown> | undefined;
  return typeof dispatch?.adapterType === "string" ? dispatch.adapterType : null;
}

function conversationRunPredicate() {
  return or(
    inArray(sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES]),
    sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
    sql`exists (
      select 1 from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
        and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        and ${heartbeatRunEvents.eventType} = 'adapter.invoke'
        and ${inArray(sql`${heartbeatRunEvents.payload}->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES])}
    )`,
  );
}

/** Recovery must not infer the old adapter from the agent's mutable settings. */
export async function historicalAdapterType(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string | null> {
  const selected = claimedAdapterType(run);
  if (selected) return selected;
  const [invocation] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke")))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const adapterType = invocation?.payload?.adapterType;
  return typeof adapterType === "string" ? adapterType : null;
}

export async function runUsedConversationAdapter(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive") return false;
  if (hasConversationContinuationPolicy(run.resultJson)) return true;
  const adapterType = await historicalAdapterType(db, run);
  return adapterType !== null && isConversationAdapter(adapterType);
}

/** Only immutable run evidence can retire a historical conversation hold.
 * An agent's current adapter can differ from the one that executed this run.
 * Missing evidence retains the hold; the current agent is never a fallback.
 */
export function conversationRecoveryActionPredicate() {
  return and(
    eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
    sql`exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        and ${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'
        and coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text
        and ${heartbeatRuns.runtimeMode} = 'legacy'
        and coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
        and ${inArray(heartbeatRuns.status, ['failed', 'timed_out', 'interrupted', 'cancelled'])}
        and ${conversationRunPredicate()}
        and ${or(
          sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
          eq(heartbeatRuns.status, "interrupted"),
          inArray(heartbeatRuns.errorCode, ["process_lost", "server_shutdown_interrupted", "execution_reconciliation_required"]),
          and(eq(heartbeatRuns.status, "cancelled"), sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' = 'acknowledged'`),
        )}
    )`,
  );
}

/** A terminal conversation row does not prove that its execution authority ended.
 * Other adapters keep their existing bootstrap and ownership protocols.
 */
export async function getConversationOwnershipBlocker(db: Db, companyId: string, issueId: string) {
  const activeLease = sql`exists (select 1 from ${environmentLeases}
    where ${environmentLeases.companyId} = "heartbeat_runs"."company_id"
      and ${environmentLeases.heartbeatRunId} = "heartbeat_runs"."id"
      and (${environmentLeases.releasedAt} is null
        or ${environmentLeases.status} = 'pending_cleanup'
        or ${environmentLeases.cleanupStatus} = 'failed'))`;
  const candidates = await db.select({ run: heartbeatRuns, activeLease }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
      conversationRunPredicate(),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), activeLease),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const { run, activeLease: leaseHeld } of candidates) {
    // Pids are reused. The recorded start time and the process group decide
    // whether the provider of this run still holds execution authority.
    const assessment = await assessRecordedExecutionLiveness({
      processPid: run.processPid,
      processGroupId: run.processGroupId,
      processStartedAt: run.processStartedAt,
      finishedAt: run.finishedAt,
    });
    if (assessment.alive || leaseHeld) {
      return {
        runId: run.id,
        agentId: run.agentId,
        cause: "execution_owner_active",
        nextAction: assessment.alive
          ? "The previous provider process is still running. Stop it before continuing this task."
          : "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
      };
    }
    // The recorded provider is provably gone. Dropping the identity keeps a
    // reused pid from holding this issue again.
    await clearStaleProcessIdentity(db, run);
  }
  return null;
}

/** The recorded provider is gone: drop the identity that a reused pid could revive. */
async function clearStaleProcessIdentity(
  db: Db,
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "id" | "processPid" | "processGroupId" | "processStartedAt"
  >,
) {
  if (
    run.processPid === null &&
    run.processGroupId === null &&
    run.processStartedAt === null
  )
    return;
  try {
    await db
      .update(heartbeatRuns)
      .set({
        processPid: null,
        processGroupId: null,
        processStartedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.runtimeMode, "legacy"),
          run.processPid === null
            ? isNull(heartbeatRuns.processPid)
            : eq(heartbeatRuns.processPid, run.processPid),
          run.processGroupId === null
            ? isNull(heartbeatRuns.processGroupId)
            : eq(heartbeatRuns.processGroupId, run.processGroupId),
        ),
      );
  } catch {
    // The hold is already released by the assessment. The next assessment
    // repairs a failed cleanup.
  }
}
