// Shared wake-reason and retry-reason constants, and the pure classifiers
// that read them off a run's context snapshot. `heartbeat.ts` and this
// module's own Postgres adapter both decide on the same context snapshot
// shape, so this file is their one shared source for it: a second,
// independently maintained copy in either file could silently drift out of
// sync with the other and change only one of the two gates that read it.

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turns_continuation";
export const WORKSPACE_BUSY_RETRY_REASON = "workspace_busy";
export const AI_CONNECTION_POOL_WAIT_RETRY_REASON = "ai_connection_pool_wait";
export const AI_CONNECTION_BUSY_RETRY_REASON = "ai_connection_busy";
export const INTERACTION_CONTINUATION_INFRA_RETRY_REASON = "interaction_continuation_infra_retry";
export const INTERACTION_CONTINUATION_INFRA_WAKE_REASON = "interaction_continuation_infra_retry";
export const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
/**
 * Wake reason the platform stamps on the run it queues for a card's
 * addressee when an issue-thread interaction is created (the `heartbeat
 * .wakeup` call in `routes/issues.ts`). It lives here so the producer and
 * every classifier below read one copy of the literal: a second copy in
 * either file can drift and then change only one of the gates.
 */
export const INTERACTION_PENDING_WAKE_REASON = "interaction_pending";

/**
 * Wake reason the platform stamps on the run it queues for the agent named
 * in an issue's `unblockDescriptor.owner` (`deliverAgentUnblockNotification`
 * in `services/routable-blocked.ts`). The owner is never the assignee: the
 * route guard refuses `board` and any `userId` for an agent actor
 * ("Agents may only name themselves as an unblock owner",
 * `routes/issues.ts`), so an agent can only name itself, and the agent that
 * blocked the issue is by construction not its assignee.
 */
export const ISSUE_UNBLOCK_REQUESTED_WAKE_REASON = "issue_unblock_requested";

/**
 * Wake reasons the platform itself emits, where a run agent that is not the
 * issue assignee is the intended shape of the wake rather than evidence of a
 * reassignment. Both producers route to a non-assignee on purpose, so the
 * queued-run ownership check must read the mismatch as design.
 *
 * Kept as one set because the policy question is one question. A separate
 * predicate per signal is how the next machine reason gets added to one and
 * forgotten in the other.
 *
 * NOT in this set: reasons a human or agent typed into the `wakeReason`
 * string. That field is a machine channel and prose there is a separate
 * defect (a guard keyed on English text would be wrong).
 */
export const NON_ASSIGNEE_BY_DESIGN_WAKE_REASONS: ReadonlySet<string> = new Set([
  INTERACTION_PENDING_WAKE_REASON,
  ISSUE_UNBLOCK_REQUESTED_WAKE_REASON,
]);

export const RESOLVED_INTERACTION_CONTINUATION_STATUSES = new Set([
  "accepted",
  "answered",
  "cancelled",
  "rejected",
]);

/**
 * True for a resource-wait retry whose original run did not
 * execute under assignee-ship (a comment or review-participant wake). Such a
 * retry has an expected assignee mismatch, so the scheduled-retry gate and
 * the queued-run staleness check must not treat it as a reassignment.
 */
export function isNonAssigneeWorkspaceBusyRetry(
  retryReason: string | null | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  return (
    (retryReason === WORKSPACE_BUSY_RETRY_REASON &&
      contextSnapshot.workspaceBusyDeferredWhileAssignee === false) ||
    ((retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) &&
      contextSnapshot.aiConnectionBusyDeferredWhileAssignee === false)
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload?: Record<string, unknown> | null,
): string | null {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

/**
 * `allowedWakeReasons` is the issue-tree-control module's own set of wake
 * reasons that excuse an interaction wake. This file stays free of service
 * imports, so the caller passes the set in rather than this function reading
 * it from the service directly.
 */
export function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
  allowedWakeReasons: ReadonlySet<string>,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !allowedWakeReasons.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot));
}

/**
 * True when this wake is one the platform routes to an agent who is not the
 * issue assignee on purpose: a question card's addressee
 * (`interaction_pending`) or an unblock descriptor's owner
 * (`issue_unblock_requested`). See NON_ASSIGNEE_BY_DESIGN_WAKE_REASONS.
 *
 * Deliberately separate from `allowsIssueInteractionWake`. That helper also
 * requires a derived comment id, and every one of its callers scopes the
 * exception to human comment/mention wakes via
 * ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS — including two bypasses of the
 * dependency-blocked gate. A card addressee carries no comment id and is
 * chosen by the card author, so widening that helper would silently hand
 * interaction wakes two further exemptions nobody has reviewed.
 *
 * This predicate answers only the queued-run ownership question: the run's
 * agent differs from the assignee by design, and the assignee never changed.
 */
export function isNonAssigneeByDesignWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  return wakeReason !== null && NON_ASSIGNEE_BY_DESIGN_WAKE_REASONS.has(wakeReason);
}

export function isResolvedInteractionContinuationWakeContext(contextSnapshot: unknown): boolean {
  const context = parseObject(contextSnapshot);
  const interactionId = readNonEmptyString(context.interactionId);
  const interactionStatus = readNonEmptyString(context.interactionStatus);
  if (!interactionId || !interactionStatus) return false;
  const retiredConnection = interactionStatus === "expired"
    && context.interactionKind === "connection_intent"
    && context.connectionIntentResolution === "existing_connection";
  if (!retiredConnection && !RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus)) return false;

  const mutation = readNonEmptyString(context.mutation);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const retryReason = readNonEmptyString(context.retryReason);
  return (
    (mutation === "interaction" && wakeReason === "issue_commented") ||
    wakeReason === INTERACTION_CONTINUATION_INFRA_WAKE_REASON ||
    retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
  );
}
