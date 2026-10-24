import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { redactPersistedRunText } from "./run-output-redaction.js";

/**
 * The issue a run is working on, read from its admission context.
 *
 * The cross-issue influence cap uses this to tell an own-issue write (exempt)
 * from a write that reaches another issue (counted). A run admitted without an
 * issue carries neither key, and its issue writes then fail closed.
 */
export function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Record `issueId` as the run's source issue, but only when the run has none.
 *
 * Checking an issue out is a run declaring the scope it works in, so it is the
 * one point where filling a missing source issue cannot widen anything: an
 * own-issue write becomes exempt and every other issue's write is counted
 * against `CROSS_ISSUE_INFLUENCE_LIMIT`.
 *
 * The `case` is the containment argument. A plain jsonb `||` would *overwrite*
 * an existing `issueId`, so a run admitted for one issue could claim another
 * issue's own-issue exemption by checking that issue out. A run that already
 * names a source issue keeps it here. `nullif(btrim(...))` treats a blank key as
 * absent, which a bare `is not null` test would leave unbound for the life of
 * the run.
 */
export async function bindRunSourceIssueToCheckout(
  db: Db,
  input: { runId: string; companyId: string; issueId: string; agentId: string },
) {
  const [bound] = await db
    .update(heartbeatRuns)
    .set({
      contextSnapshot: sql`case
        when nullif(btrim(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) ->> 'issueId'), '') is not null
          or nullif(btrim(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) ->> 'taskId'), '') is not null
        then coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
        else coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${redactPersistedRunText(JSON.stringify({ issueId: input.issueId }))}::jsonb
      end`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .returning({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot });
  return bound ?? null;
}
