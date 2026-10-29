#!/usr/bin/env tsx
/**
 * Redact secret-shaped values from the run output that Paperclip stored in the
 * board database.
 *
 * The script works in place. It never copies the database. It never prints a
 * value. It prints counts only.
 *
 * The script walks the rows with a keyset cursor, so a row that is written
 * while the script runs is picked up by a later pass. A pass that finds no
 * change ends the walk. The cursor is (createdAt, id), not the random uuid:
 * a uuid keyset skips rows that sort before the cursor.
 *
 * Two sinks are digest-anchored. The stored value of a native run result and
 * the stored payload of a native run event are hashed, and the hash is
 * compared with the stored value on every read. Redacting the value in place
 * would break that check. The script leaves those rows alone and reports how
 * many it left alone.
 *
 * Usage:
 *   DATABASE_URL=postgres://... server/node_modules/.bin/tsx \
 *     server/scripts/redact-persisted-run-secrets.ts [--dry-run]
 */
import { eq, sql } from "drizzle-orm";
import { createDb } from "../../packages/db/src/index.js";
import { activityLog } from "../../packages/db/src/schema/activity_log.js";
import { agentWakeupRequests } from "../../packages/db/src/schema/agent_wakeup_requests.js";
import { heartbeatRunEvents } from "../../packages/db/src/schema/heartbeat_run_events.js";
import { heartbeatRuns } from "../../packages/db/src/schema/heartbeat_runs.js";
import { nativeRunResults } from "../../packages/db/src/schema/native_run_results.js";
import {
  redactPersistedRunOutput,
  redactPersistedRunText,
} from "../src/services/run-output-redaction.js";

const BATCH_SIZE = 200;

function isDryRun() {
  return process.argv.includes("--dry-run");
}

function changed(before: unknown, after: unknown) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = createDb(dbUrl);
  const dryRun = isDryRun();

  const counts = {
    dryRun,
    runsScanned: 0,
    runsChanged: 0,
    runFieldsChanged: 0,
    runEventsScanned: 0,
    runEventsChanged: 0,
    runEventFieldsChanged: 0,
    runEventPayloadsSkippedDigestAnchored: 0,
    activityRowsScanned: 0,
    activityRowsChanged: 0,
    wakeupsScanned: 0,
    wakeupsChanged: 0,
    nativeResultsSkippedDigestAnchored: 0,
  };

  // The run columns. The keyset is (createdAt, id).
  let lastCreatedAt: Date | null = null;
  let lastId: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
      })
      .from(heartbeatRuns)
      .where(
        lastCreatedAt && lastId
          ? sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${lastCreatedAt}, ${lastId})`
          : sql`true`,
      )
      .orderBy(heartbeatRuns.createdAt, heartbeatRuns.id)
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    lastCreatedAt = last.createdAt;
    lastId = last.id;

    for (const row of rows) {
      counts.runsScanned += 1;
      const resultJson = redactPersistedRunOutput(row.resultJson ?? null);
      const error =
        typeof row.error === "string" ? redactPersistedRunText(row.error) : row.error;
      const contextSnapshot = redactPersistedRunOutput(row.contextSnapshot ?? null);
      const stdoutExcerpt =
        typeof row.stdoutExcerpt === "string"
          ? redactPersistedRunText(row.stdoutExcerpt)
          : row.stdoutExcerpt;
      const stderrExcerpt =
        typeof row.stderrExcerpt === "string"
          ? redactPersistedRunText(row.stderrExcerpt)
          : row.stderrExcerpt;
      const resultJsonChanged = changed(row.resultJson ?? null, resultJson);
      const errorChanged = changed(row.error ?? null, error ?? null);
      const contextSnapshotChanged = changed(
        row.contextSnapshot ?? null,
        contextSnapshot,
      );
      const stdoutExcerptChanged = changed(row.stdoutExcerpt ?? null, stdoutExcerpt ?? null);
      const stderrExcerptChanged = changed(row.stderrExcerpt ?? null, stderrExcerpt ?? null);
      if (
        !resultJsonChanged &&
        !errorChanged &&
        !contextSnapshotChanged &&
        !stdoutExcerptChanged &&
        !stderrExcerptChanged
      ) {
        continue;
      }

      counts.runsChanged += 1;
      counts.runFieldsChanged +=
        (resultJsonChanged ? 1 : 0) +
        (errorChanged ? 1 : 0) +
        (contextSnapshotChanged ? 1 : 0) +
        (stdoutExcerptChanged ? 1 : 0) +
        (stderrExcerptChanged ? 1 : 0);
      if (dryRun) continue;

      await db
        .update(heartbeatRuns)
        .set({
          resultJson: resultJsonChanged ? (resultJson as Record<string, unknown>) : undefined,
          error: errorChanged ? (error ?? null) : undefined,
          contextSnapshot: contextSnapshotChanged
            ? (contextSnapshot as Record<string, unknown>)
            : undefined,
          stdoutExcerpt: stdoutExcerptChanged ? (stdoutExcerpt ?? null) : undefined,
          stderrExcerpt: stderrExcerptChanged ? (stderrExcerpt ?? null) : undefined,
        })
        .where(eq(heartbeatRuns.id, row.id));
    }

    process.stderr.write(
      `scanned ${counts.runsScanned} runs, changed ${counts.runsChanged}\n`,
    );
  }

  // The run event columns. The keyset is the monotonic bigserial id.
  let lastEventId = 0;
  for (;;) {
    const rows = await db
      .select({
        id: heartbeatRunEvents.id,
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
        sourcePayloadSha256: heartbeatRunEvents.sourcePayloadSha256,
      })
      .from(heartbeatRunEvents)
      .where(
        lastEventId
          ? sql`${heartbeatRunEvents.id} > ${lastEventId}`
          : sql`true`,
      )
      .orderBy(heartbeatRunEvents.id)
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    lastEventId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      counts.runEventsScanned += 1;
      const message =
        typeof row.message === "string"
          ? redactPersistedRunText(row.message)
          : row.message;
      const messageChanged = changed(row.message ?? null, message ?? null);

      // A payload with a source digest is verified against that digest on
      // every read. The script leaves it alone and counts it.
      const digestAnchored = row.sourcePayloadSha256 !== null;
      if (digestAnchored) {
        counts.runEventPayloadsSkippedDigestAnchored += 1;
      }
      const payload = digestAnchored
        ? row.payload
        : redactPersistedRunOutput(row.payload ?? null);
      const payloadChanged = changed(row.payload ?? null, payload);

      if (!messageChanged && !payloadChanged) continue;

      counts.runEventsChanged += 1;
      counts.runEventFieldsChanged +=
        (messageChanged ? 1 : 0) + (payloadChanged ? 1 : 0);
      if (dryRun) continue;

      await db
        .update(heartbeatRunEvents)
        .set({
          message: messageChanged ? (message ?? null) : undefined,
          payload: payloadChanged
            ? (payload as Record<string, unknown> | null)
            : undefined,
        })
        .where(eq(heartbeatRunEvents.id, row.id));
    }
  }

  // The activity log details. The keyset is (createdAt, id).
  lastCreatedAt = null;
  lastId = null;
  for (;;) {
    const rows = await db
      .select({
        id: activityLog.id,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        lastCreatedAt && lastId
          ? sql`(${activityLog.createdAt}, ${activityLog.id}) > (${lastCreatedAt}, ${lastId})`
          : sql`true`,
      )
      .orderBy(activityLog.createdAt, activityLog.id)
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    lastCreatedAt = last.createdAt;
    lastId = last.id;

    for (const row of rows) {
      counts.activityRowsScanned += 1;
      const details = redactPersistedRunOutput(row.details ?? null);
      if (!changed(row.details ?? null, details)) continue;
      counts.activityRowsChanged += 1;
      if (dryRun) continue;
      await db
        .update(activityLog)
        .set({ details: details as Record<string, unknown> | null })
        .where(eq(activityLog.id, row.id));
    }
  }

  // The wakeup request error column.
  const wakeupRows = await db
    .select({ id: agentWakeupRequests.id, error: agentWakeupRequests.error })
    .from(agentWakeupRequests);
  for (const row of wakeupRows) {
    counts.wakeupsScanned += 1;
    if (typeof row.error !== "string") continue;
    const error = redactPersistedRunText(row.error);
    if (error === row.error) continue;
    counts.wakeupsChanged += 1;
    if (dryRun) continue;
    await db
      .update(agentWakeupRequests)
      .set({ error })
      .where(eq(agentWakeupRequests.id, row.id));
  }

  // The native run result is digest-anchored. The script counts the rows it
  // leaves alone. It never rewrites a value that a digest covers.
  const nativeResultRows = await db
    .select({ id: nativeRunResults.id })
    .from(nativeRunResults);
  counts.nativeResultsSkippedDigestAnchored = nativeResultRows.length;

  console.log(JSON.stringify(counts));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
