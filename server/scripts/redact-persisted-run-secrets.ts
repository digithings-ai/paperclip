#!/usr/bin/env tsx
/**
 * Redact secret-shaped values from the run output that Paperclip stored in the
 * board database.
 *
 * The script works in place. It never copies the database. It never prints a
 * value. It prints counts only.
 *
 * Usage:
 *   DATABASE_URL=postgres://... server/node_modules/.bin/tsx \
 *     server/scripts/redact-persisted-run-secrets.ts [--dry-run]
 */
import { eq, sql } from "drizzle-orm";
import { createDb } from "../../packages/db/src/index.js";
import { agentWakeupRequests } from "../../packages/db/src/schema/agent_wakeup_requests.js";
import { heartbeatRuns } from "../../packages/db/src/schema/heartbeat_runs.js";
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

  let runsScanned = 0;
  let runsChanged = 0;
  let runFieldsChanged = 0;
  let wakeupsScanned = 0;
  let wakeupsChanged = 0;
  let lastRunId: string | null = null;

  for (;;) {
    // The rows are read in id order. The cursor keeps the memory use flat and
    // lets the script stop after every batch.
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        lastRunId
          ? sql`${heartbeatRuns.id} > ${lastRunId}`
          : sql`true`,
      )
      .orderBy(heartbeatRuns.id)
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    lastRunId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      runsScanned += 1;
      const resultJson = redactPersistedRunOutput(row.resultJson ?? null);
      const error =
        typeof row.error === "string" ? redactPersistedRunText(row.error) : row.error;
      const contextSnapshot = redactPersistedRunOutput(row.contextSnapshot ?? null);
      const resultJsonChanged = changed(row.resultJson ?? null, resultJson);
      const errorChanged = changed(row.error ?? null, error ?? null);
      const contextSnapshotChanged = changed(
        row.contextSnapshot ?? null,
        contextSnapshot,
      );
      if (!resultJsonChanged && !errorChanged && !contextSnapshotChanged) continue;

      runsChanged += 1;
      runFieldsChanged +=
        (resultJsonChanged ? 1 : 0) +
        (errorChanged ? 1 : 0) +
        (contextSnapshotChanged ? 1 : 0);
      if (dryRun) continue;

      await db
        .update(heartbeatRuns)
        .set({
          resultJson: resultJsonChanged ? (resultJson as Record<string, unknown>) : undefined,
          error: errorChanged ? (error ?? null) : undefined,
          contextSnapshot: contextSnapshotChanged
            ? (contextSnapshot as Record<string, unknown>)
            : undefined,
        })
        .where(eq(heartbeatRuns.id, row.id));
    }

    process.stderr.write(
      `scanned ${runsScanned} runs, changed ${runsChanged}\n`,
    );
  }

  const wakeupRows = await db
    .select({ id: agentWakeupRequests.id, error: agentWakeupRequests.error })
    .from(agentWakeupRequests);
  for (const row of wakeupRows) {
    wakeupsScanned += 1;
    if (typeof row.error !== "string") continue;
    const error = redactPersistedRunText(row.error);
    if (error === row.error) continue;
    wakeupsChanged += 1;
    if (dryRun) continue;
    await db
      .update(agentWakeupRequests)
      .set({ error })
      .where(eq(agentWakeupRequests.id, row.id));
  }

  console.log(
    JSON.stringify({
      dryRun,
      runsScanned,
      runsChanged,
      runFieldsChanged,
      wakeupsScanned,
      wakeupsChanged,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
