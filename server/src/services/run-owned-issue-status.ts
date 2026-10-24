import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";

/**
 * Statuses a run may legitimately record on its own issue before the run
 * ends. Recovery must never overwrite a status the same run wrote: the run
 * already told the board what the work reached.
 */
export const RUN_OWNED_ISSUE_STATUSES = [
  "in_review",
  "done",
  "cancelled",
] as const;

export type RunOwnedIssueStatus = (typeof RUN_OWNED_ISSUE_STATUSES)[number];

export function isRunOwnedIssueStatus(
  status: string | null | undefined,
): status is RunOwnedIssueStatus {
  return (
    typeof status === "string" &&
    (RUN_OWNED_ISSUE_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Evidence that this run wrote the issue's current status.
 *
 * A terminal status alone is not enough evidence: a different run or a
 * different actor could have closed it. The activity log records the run that
 * wrote each status change, so the same run's write is the proof.
 */
export async function findRunOwnedIssueStatusEvidence(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    status: string;
  },
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: activityLog.id, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, "issue.updated"),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        sql`${activityLog.details} ->> 'status' = ${input.status}`,
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return row ?? null;
}
