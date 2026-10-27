#!/usr/bin/env tsx
/**
 * Redact the credential values that a seat printed into its own session store.
 *
 * A seat that prints its environment writes the raw token into the OpenCode
 * database of the seat. The board redacts its own copy of the run output. This
 * script redacts the copy that the seat keeps.
 *
 * The script works in place. It never copies a database. It never prints a
 * value. It prints counts only.
 *
 * Usage:
 *   DATABASE_URL=postgres://... server/node_modules/.bin/tsx \
 *     server/scripts/redact-seat-store-secrets.ts \
 *     [--dry-run] [--full] [--repair] [--drop-unrepairable] [--store <path>]
 *
 * Without `--store` the script reads the seat homes from the board database,
 * so the list of seats is the list that Paperclip runs.
 *
 * The script keeps the state of its last pass next to each store, so a later
 * pass reads only the rows that changed since then. The option `--full` reads
 * every row again.
 *
 * The store of a seat that is running is left alone. The seat writes to that
 * store while it runs.
 *
 * The option `--repair` also fixes the rows that an earlier redaction broke.
 * Those rows are not documents any more, and a seat cannot read a session that
 * holds one of them. The option `--drop-unrepairable` removes the rows that
 * the repair cannot fix. It touches the message table of the seat only.
 */
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../../packages/db/src/index.js";
import { agents } from "../../packages/db/src/schema/agents.js";
import { heartbeatRuns } from "../../packages/db/src/schema/heartbeat_runs.js";
import {
  seatDataHome,
  seatSessionStorePath,
  scrubSeatStoreInPlace,
} from "../src/services/seat-store-redaction.js";

/**
 * The run statuses that mean that the seat of the agent writes to its store,
 * or is about to write to it. A run that runs now writes; a run that waits for
 * a retry is created as `queued` and writes on the next attempt. The store of
 * such a seat is left alone.
 */
const LIVE_RUN_STATUSES = ["running", "queued"];

function isDryRun() {
  return process.argv.includes("--dry-run");
}

function isFull() {
  return process.argv.includes("--full");
}

function isRepair() {
  return process.argv.includes("--repair");
}

function isDropUnrepairable() {
  return process.argv.includes("--drop-unrepairable");
}

function storeArgument(): string | null {
  const index = process.argv.indexOf("--store");
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function seatStorePaths(
  db: ReturnType<typeof createDb>,
): Promise<Array<{ seat: string; store: string }>> {
  const rows = await db
    .select({ name: agents.name, adapterConfig: agents.adapterConfig })
    .from(agents);
  const paths: Array<{ seat: string; store: string }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const config = (row.adapterConfig ?? {}) as { env?: Record<string, unknown> };
    const store = seatSessionStorePath(seatDataHome(config.env));
    if (!store || seen.has(store)) continue;
    seen.add(store);
    paths.push({ seat: row.name, store });
  }
  return paths;
}

/**
 * The stores of the seats that are busy. A run that runs now writes to its
 * store now. A run that waits for a retry is created as `queued` and writes on
 * the next attempt. Either status means that the store is left alone.
 */
async function liveStorePaths(
  db: ReturnType<typeof createDb>,
  paths: Array<{ seat: string; store: string }>,
): Promise<Set<string>> {
  const live = new Set<string>();
  if (paths.length === 0) return live;
  const rows = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, LIVE_RUN_STATUSES));
  const busyAgents = new Set(rows.map((row) => row.agentId));
  if (busyAgents.size === 0) return live;
  const agentsById = await db
    .select({ id: agents.id, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(inArray(agents.id, [...busyAgents]));
  for (const row of agentsById) {
    const config = (row.adapterConfig ?? {}) as { env?: Record<string, unknown> };
    const store = seatSessionStorePath(seatDataHome(config.env));
    if (store) live.add(store);
  }
  return live;
}

async function main() {
  const dryRun = isDryRun();
  const full = isFull();
  const repair = isRepair();
  const dropUnrepairable = isDropUnrepairable();
  const directStore = storeArgument();
  const targets: Array<{ seat: string; store: string }> = [];

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = createDb(dbUrl);

  const seats = await seatStorePaths(db);
  if (directStore) {
    const known = seats.find((seat) => seat.store === directStore);
    targets.push({ seat: known?.seat ?? "explicit", store: directStore });
  } else {
    targets.push(...seats);
  }

  const liveStores = await liveStorePaths(db, seats);
  const isStoreLive = (store: string) => liveStores.has(store);

  const results = [];
  for (const target of targets) {
    const counts = scrubSeatStoreInPlace(target.store, {
      dryRun,
      full,
      repair,
      dropUnrepairable,
      isStoreLive,
    });
    results.push({
      seat: target.seat,
      store: target.store,
      tables: counts.tables,
      valuesScanned: counts.valuesScanned,
      fieldsChanged: counts.fieldsChanged,
      rowsChanged: counts.rowsChanged,
      jsonValues: counts.jsonValues,
      repaired: counts.repaired,
      unrepairable: counts.unrepairable,
      dropped: counts.dropped,
      conflicts: counts.conflicts,
      rowsSkipped: counts.rowsSkipped,
      live: counts.live,
      changedTables: counts.perTable
        .filter((table) => table.fieldsChanged > 0 || table.dropped > 0)
        .map((table) => `${table.table}:${table.fieldsChanged}/${table.dropped}`),
      protectedTables: counts.protectedTables,
      skipped: counts.skipped,
    });
    process.stderr.write(
      `${target.seat}: scanned ${counts.valuesScanned} values, changed ${counts.fieldsChanged} fields in ${counts.rowsChanged} rows` +
        `${counts.repaired ? `, repaired ${counts.repaired} rows` : ""}` +
        `${counts.unrepairable ? `, ${counts.unrepairable} rows still broken` : ""}` +
        `${counts.dropped ? `, dropped ${counts.dropped} rows` : ""}` +
        `${counts.live ? ", the seat is running" : ""}\n`,
    );
  }

  console.log(
    JSON.stringify(
      { dryRun, full, repair, dropUnrepairable, stores: results },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
