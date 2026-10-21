import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSecretPayloadKey } from "../redaction.js";
import {
  REDACTED_RUN_OUTPUT_VALUE,
  redactPersistedRunText,
} from "./run-output-redaction.js";

/**
 * A seat keeps the history of its own sessions in an OpenCode database. A seat
 * that prints its environment writes the raw token into that database. The
 * board redacts the copy of the run output that Paperclip keeps. The copy that
 * the seat keeps is not the board's copy, and this service is what removes the
 * value from it.
 *
 * The service works in place. It never copies the database. It never prints a
 * value. It counts the rows and the fields that it changed.
 *
 * Three rules keep the service from breaking a store that a seat reads:
 *
 * 1. A column that holds a JSON document is never changed by a substitution in
 *    the raw text. A substitution can take the escape of the next quote with
 *    it, and the document stops being a document. The service reads the
 *    document, redacts the values inside it, and writes the document back.
 * 2. A write lands only when the row still holds the value that the service
 *    read. A seat that writes the same row at the same time keeps its value.
 * 3. A store of a seat that is running is left alone. The seat writes to that
 *    store while it runs.
 */

/**
 * The tables that hold the authentication material of the seat itself. The
 * seat needs those values to talk to its provider. They are not run output and
 * the scrub leaves them alone.
 */
const PROTECTED_TABLES = new Set([
  "account",
  "account_state",
  "control_account",
  "credential",
]);

/** The number of rows that one statement reads. */
const READ_BATCH = 500;

/** How long a statement waits for the lock that the seat process holds. */
const BUSY_TIMEOUT_MS = 10_000;

/**
 * The columns that hold the time of a row. The scrub uses one of them to read
 * only the rows that changed since the last scrub. A table without one is read
 * from its row id.
 */
const TIME_COLUMNS = ["time_updated", "time_created", "updated_at", "created_at"];

/**
 * The overlap of the watermark. A row can be written while the scrub reads the
 * table. The scrub reads the last minute of rows again, so such a row is
 * never left behind.
 */
const WATERMARK_OVERLAP_MS = 60_000;

/** How deep the service reads a document. A deeper value is kept as it is. */
const MAX_JSON_DEPTH = 64;

/** How many repairs one document may take. */
const MAX_REPAIR_STEPS = 64;

/**
 * The window of a document that the repair looks at. A damage site sits next
 * to the marker that the redaction left behind.
 */
const REPAIR_WINDOW = 800;

/**
 * The characters that the repair puts back. A redaction that took the escape
 * of a quote with it leaves a document that needs the escape again.
 */
const REPAIR_INSERTIONS = ["\\", '"', "\\\\"];

export type SeatStoreScrubCounts = {
  store: string;
  tables: number;
  valuesScanned: number;
  fieldsChanged: number;
  rowsChanged: number;
  protectedTables: string[];
  skipped: string | null;
  /** The store belongs to a seat that is running. Nothing was written. */
  live: boolean;
  /** The values that held a JSON document. */
  jsonValues: number;
  /** The rows that were broken and are a document again. */
  repaired: number;
  /** The rows that are broken and that the repair could not fix. */
  unrepairable: number;
  /** The rows that were removed because they could not be repaired. */
  dropped: number;
  /** The rows that a seat wrote while the service read them. */
  conflicts: number;
  /** The rows that the service left alone on purpose. */
  rowsSkipped: number;
  perTable: Array<{
    table: string;
    valuesScanned: number;
    fieldsChanged: number;
    rowsChanged: number;
    incremental: boolean;
    repaired: number;
    unrepairable: number;
    dropped: number;
    conflicts: number;
    rowsSkipped: number;
  }>;
};

export type SeatStoreScrubOptions = {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Read every row again and ignore the state of the last pass. */
  full?: boolean;
  /** Also repair the rows that an earlier redaction broke. */
  repair?: boolean;
  /** Remove the rows that the repair could not fix. */
  dropUnrepairable?: boolean;
  /** The tables that a removal may touch. */
  dropTables?: string[];
  /** The store belongs to a seat that is running. The store is left alone. */
  isStoreLive?: (storePath: string) => boolean;
};

/**
 * How far the scrub of one table reached. The value is the time of the last
 * row that the scrub read, or the row id of the last row that it read. It
 * never holds a value of the seat.
 */
type TableProgress = {
  column: string | null;
  value: number;
};

type ScrubState = {
  version: number;
  tables: Record<string, TableProgress>;
};

/** The name of an SQLite identifier, quoted for a statement. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The state file of one store. It sits next to the store. It holds the name of
 * a column and a number. It never holds a value of the seat.
 */
function scrubStatePath(storePath: string): string {
  return `${storePath}.redaction-state.json`;
}

/** The state of the scrub of one store. A store without a state file starts over. */
function readScrubState(storePath: string): ScrubState {
  const statePath = scrubStatePath(storePath);
  if (!existsSync(statePath)) return { version: 1, tables: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as ScrubState;
    if (parsed?.version !== 1 || typeof parsed.tables !== "object") {
      return { version: 1, tables: {} };
    }
    return parsed;
  } catch {
    return { version: 1, tables: {} };
  }
}

/** Write the state of the scrub. The write is atomic, so a crash keeps the old state. */
function writeScrubState(storePath: string, state: ScrubState): void {
  const statePath = scrubStatePath(storePath);
  const tempPath = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tempPath, statePath);
  } catch {
    // The state is a speed-up, not the fix itself. A store without a state
    // file is scrubbed from the start.
  }
}

/**
 * The text columns of a table. A value that is not text cannot hold a
 * credential.
 */
function textColumns(
  db: DatabaseSync,
  tableName: string,
): Array<{ name: string; type: string }> {
  const columns = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all() as Array<{ name: string; type: string | null }>;
  return columns
    .filter((column) => /text|clob|char/i.test(column.type ?? ""))
    .map((column) => ({ name: column.name, type: column.type ?? "" }));
}

/** The time column of a table, when the table has one. */
function timeColumn(
  db: DatabaseSync,
  tableName: string,
): string | null {
  const columns = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const candidate of TIME_COLUMNS) {
    if (names.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The document that a value holds, when the value holds one. A value that is
 * a plain text never parses as a document.
 */
function parseJsonDocument(value: string): unknown | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Redact the values inside a document. A string value is redacted as text. A
 * value under a key that names a secret is redacted as a whole, whatever shape
 * it has.
 */
function redactJsonNode(node: unknown, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) return node;
  if (typeof node === "string") return redactPersistedRunText(node);
  if (Array.isArray(node)) {
    return node.map((item) => redactJsonNode(item, depth + 1));
  }
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (isSecretPayloadKey(key)) {
        result[key] = REDACTED_RUN_OUTPUT_VALUE;
        continue;
      }
      result[key] = redactJsonNode(item, depth + 1);
    }
    return result;
  }
  return node;
}

/** The number of backslashes in a text. */
function countBackslashes(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") count += 1;
  }
  return count;
}

/**
 * Where a document stops being a document. The position is the index of the
 * character that the reader rejects. A value of minus one means that the
 * document is valid.
 */
function jsonErrorPosition(value: string): number {
  try {
    JSON.parse(value);
    return -1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /position (\d+)/.exec(message);
    if (match) return Number(match[1]);
    if (/unexpected end of json input/i.test(message)) return value.length;
    return -1;
  }
}

/** The places where a marker ends in a text. */
function markerEnds(value: string): number[] {
  const ends: number[] = [];
  let at = -1;
  while ((at = value.indexOf(REDACTED_RUN_OUTPUT_VALUE, at + 1)) >= 0) {
    ends.push(at + REDACTED_RUN_OUTPUT_VALUE.length);
  }
  return ends;
}

/**
 * Repair a document that a redaction broke.
 *
 * A redaction that ended on the escape of the next quote took the escape with
 * it. The document then ends its string early and the reader rejects it. The
 * repair puts the escape back, one damage site at a time, and it accepts a
 * repair only when the whole document is a document again.
 */
export function repairDamagedJsonDocument(value: string): unknown | null {
  let current = value;
  for (let step = 0; step < MAX_REPAIR_STEPS; step += 1) {
    const position = jsonErrorPosition(current);
    if (position < 0) {
      try {
        return JSON.parse(current);
      } catch {
        return null;
      }
    }
    const anchored: Array<{ at: number; insertion: string }> = [];
    for (const end of markerEnds(current)) {
      if (end > position) break;
      if (position - end > REPAIR_WINDOW) continue;
      for (const insertion of REPAIR_INSERTIONS) {
        anchored.push({ at: end, insertion });
      }
    }
    const nearby: Array<{ at: number; insertion: string }> = [];
    for (let offset = -2; offset <= 2; offset += 1) {
      const at = position + offset;
      if (at < 0 || at > current.length) continue;
      for (const insertion of REPAIR_INSERTIONS) {
        nearby.push({ at, insertion });
      }
    }
    let best: { value: string; next: number } | null = null;
    for (const candidate of [...anchored, ...nearby]) {
      const next = `${current.slice(0, candidate.at)}${candidate.insertion}${current.slice(candidate.at)}`;
      const nextPosition = jsonErrorPosition(next);
      if (nextPosition < 0) {
        try {
          return JSON.parse(next);
        } catch {
          continue;
        }
      }
      if (!best || nextPosition > best.next) {
        best = { value: next, next: nextPosition };
      }
    }
    if (!best || best.next <= position) return null;
    current = best.value;
  }
  return null;
}

/** What the service did with one value. */
type ValueOutcome = {
  /** The value to write. The old value when nothing changed. */
  value: string;
  /** The value changes and the change is safe. */
  changed: boolean;
  /** The value was broken and is a document again. */
  repaired: boolean;
  /** The value holds a document. */
  json: boolean;
  /** The service left the value alone on purpose. */
  skipped: boolean;
};

/**
 * Redact one value of a store.
 *
 * A value that holds a document is read, redacted and written back. A value
 * that a redaction broke is repaired first. A value that is plain text is
 * redacted as text, but only when the redaction does not take an escape with
 * it: a value that a reader parses must not lose a character that the reader
 * needs.
 */
function redactStoredValue(value: string): ValueOutcome {
  const document = parseJsonDocument(value);
  if (document !== null) {
    const redacted = redactJsonNode(document, 0);
    const serialized = JSON.stringify(redacted);
    if (typeof serialized !== "string") {
      return { value, changed: false, repaired: false, json: true, skipped: true };
    }
    if (serialized === JSON.stringify(document)) {
      return { value, changed: false, repaired: false, json: true, skipped: false };
    }
    // The guard: what the service writes must still be a document.
    try {
      JSON.parse(serialized);
    } catch {
      return { value, changed: false, repaired: false, json: true, skipped: true };
    }
    return { value: serialized, changed: true, repaired: false, json: true, skipped: false };
  }

  if (value.includes(REDACTED_RUN_OUTPUT_VALUE)) {
    const repaired = repairDamagedJsonDocument(value);
    if (repaired !== null) {
      const redacted = redactJsonNode(repaired, 0);
      const serialized = JSON.stringify(redacted);
      if (typeof serialized === "string") {
        try {
          JSON.parse(serialized);
          return { value: serialized, changed: true, repaired: true, json: true, skipped: false };
        } catch {
          // The repair did not hold. The value stays as it is.
        }
      }
    }
  }

  const redacted = redactPersistedRunText(value);
  if (redacted === value) {
    return { value, changed: false, repaired: false, json: false, skipped: false };
  }
  if (countBackslashes(redacted) < countBackslashes(value)) {
    // The redaction would take an escape with it. The value stays as it is.
    return { value, changed: false, repaired: false, json: false, skipped: true };
  }
  return { value: redacted, changed: true, repaired: false, json: false, skipped: false };
}

/**
 * Write a value only when the row still holds the value that the service
 * read. A seat that wrote the row in the meantime keeps its value.
 */
export function updateValueIfUnchanged(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  rowId: number,
  expected: string,
  next: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${quoteIdentifier(tableName)}
       SET ${quoteIdentifier(columnName)} = ?
       WHERE rowid = ? AND ${quoteIdentifier(columnName)} = ?`,
    )
    .run(next, rowId, expected);
  return result.changes > 0;
}

/** Remove a row only when it still holds the value that the service read. */
export function deleteRowIfUnchanged(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  rowId: number,
  expected: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM ${quoteIdentifier(tableName)}
       WHERE rowid = ? AND ${quoteIdentifier(columnName)} = ?`,
    )
    .run(rowId, expected);
  return result.changes > 0;
}

/** One row of a table that the scrub reads. */
type ScrubRow = {
  rid: number;
  value: string | null;
  stamp?: number | null;
};

/**
 * Redact one column of one table.
 *
 * The rows are read in the order of the table, so the memory use stays flat on
 * a store that holds a long session history. When the table has a time column,
 * the scrub reads only the rows that changed since the last scrub.
 */
function scrubColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  counts: SeatStoreScrubCounts,
  tableCounts: SeatStoreScrubCounts["perTable"][number],
  dryRun: boolean,
  options: { timeColumn: string | null; fromTime: number; fromRowId: number },
): { maxTime: number; maxRowId: number } {
  let maxTime = options.fromTime;
  let maxRowId = options.fromRowId;
  const useTime = options.timeColumn !== null;
  const timeColumnName = options.timeColumn ?? "";
  for (;;) {
    const rows = (
      useTime
        ? db
            .prepare(
              `SELECT rowid AS rid, ${quoteIdentifier(columnName)} AS value,
                      ${quoteIdentifier(timeColumnName)} AS stamp
               FROM ${quoteIdentifier(tableName)}
               WHERE ${quoteIdentifier(timeColumnName)} > ?
               ORDER BY ${quoteIdentifier(timeColumnName)}
               LIMIT ?`,
            )
            .all(options.fromTime, READ_BATCH)
        : db
            .prepare(
              `SELECT rowid AS rid, ${quoteIdentifier(columnName)} AS value
               FROM ${quoteIdentifier(tableName)}
               WHERE rowid > ?
               ORDER BY rowid
               LIMIT ?`,
            )
            .all(options.fromRowId, READ_BATCH)
    ) as ScrubRow[];

    if (rows.length === 0) break;

    const updates: Array<{ rid: number; value: string; previous: string }> = [];
    for (const row of rows) {
      if (useTime && typeof row.stamp === "number" && row.stamp > maxTime) {
        maxTime = row.stamp;
      }
      const rid = row.rid;
      if (rid > maxRowId) maxRowId = rid;
      if (typeof row.value !== "string" || row.value.length === 0) continue;
      counts.valuesScanned += 1;
      tableCounts.valuesScanned += 1;
      const outcome = redactStoredValue(row.value);
      if (outcome.json) {
        counts.jsonValues += 1;
      }
      if (outcome.skipped) {
        counts.rowsSkipped += 1;
        tableCounts.rowsSkipped += 1;
      }
      if (outcome.repaired) {
        counts.repaired += 1;
        tableCounts.repaired += 1;
      }
      if (!outcome.changed) continue;
      counts.fieldsChanged += 1;
      tableCounts.fieldsChanged += 1;
      updates.push({ rid, value: outcome.value, previous: row.value });
    }

    // The cursor moves to the last row of the batch, so the next batch starts
    // after it.
    const lastRow = rows[rows.length - 1];
    if (useTime) {
      if (typeof lastRow.stamp === "number") options.fromTime = lastRow.stamp;
    } else {
      options.fromRowId = lastRow.rid;
    }

    if (updates.length === 0 || dryRun) {
      if (dryRun) {
        counts.rowsChanged += updates.length;
        tableCounts.rowsChanged += updates.length;
      }
      continue;
    }

    let applied = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of updates) {
        const changed = updateValueIfUnchanged(
          db,
          tableName,
          columnName,
          item.rid,
          item.previous,
          item.value,
        );
        if (changed) applied += 1;
        else {
          counts.conflicts += 1;
          tableCounts.conflicts += 1;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone. The original error is the one that
        // matters.
      }
      throw error;
    }
    counts.rowsChanged += applied;
    tableCounts.rowsChanged += applied;
  }
  return { maxTime, maxRowId };
}

/**
 * Repair the rows of one column that a redaction broke.
 *
 * The pass reads every row of the column. A row that is a document is left
 * alone. A row that is broken is repaired, and the repair is accepted only
 * when the whole row is a document again. A row that the repair cannot fix is
 * counted, and it is removed only when the caller asks for it.
 */
function repairColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  counts: SeatStoreScrubCounts,
  tableCounts: SeatStoreScrubCounts["perTable"][number],
  dryRun: boolean,
  options: { dropUnrepairable: boolean; dropAllowed: boolean },
): void {
  let fromRowId = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT rowid AS rid, ${quoteIdentifier(columnName)} AS value
         FROM ${quoteIdentifier(tableName)}
         WHERE rowid > ?
         ORDER BY rowid
         LIMIT ?`,
      )
      .all(fromRowId, READ_BATCH) as ScrubRow[];

    if (rows.length === 0) break;

    const updates: Array<{ rid: number; value: string; previous: string }> = [];
    const removals: Array<{ rid: number; previous: string }> = [];
    for (const row of rows) {
      const rid = row.rid;
      if (rid > fromRowId) fromRowId = rid;
      if (typeof row.value !== "string" || row.value.length === 0) continue;
      const trimmed = row.value.trimStart();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      counts.valuesScanned += 1;
      tableCounts.valuesScanned += 1;
      if (jsonErrorPosition(row.value) < 0) continue;

      const repaired = repairDamagedJsonDocument(row.value);
      if (repaired !== null) {
        const redacted = redactJsonNode(repaired, 0);
        const serialized = JSON.stringify(redacted);
        if (typeof serialized === "string") {
          try {
            JSON.parse(serialized);
            counts.repaired += 1;
            tableCounts.repaired += 1;
            counts.fieldsChanged += 1;
            tableCounts.fieldsChanged += 1;
            updates.push({ rid, value: serialized, previous: row.value });
            continue;
          } catch {
            // The repair did not hold. The row is counted as broken.
          }
        }
      }

      counts.unrepairable += 1;
      tableCounts.unrepairable += 1;
      if (options.dropUnrepairable && options.dropAllowed) {
        removals.push({ rid, previous: row.value });
      }
    }

    if (dryRun) {
      counts.rowsChanged += updates.length + removals.length;
      tableCounts.rowsChanged += updates.length + removals.length;
      continue;
    }

    if (updates.length > 0 || removals.length > 0) {
      let applied = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of updates) {
          const changed = updateValueIfUnchanged(
            db,
            tableName,
            columnName,
            item.rid,
            item.previous,
            item.value,
          );
          if (changed) applied += 1;
          else {
            counts.conflicts += 1;
            tableCounts.conflicts += 1;
          }
        }
        for (const item of removals) {
          const changed = deleteRowIfUnchanged(
            db,
            tableName,
            columnName,
            item.rid,
            item.previous,
          );
          if (changed) {
            counts.dropped += 1;
            tableCounts.dropped += 1;
            applied += 1;
          } else {
            counts.conflicts += 1;
            tableCounts.conflicts += 1;
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction is already gone. The original error is the one
          // that matters.
        }
        throw error;
      }
      counts.rowsChanged += applied;
      tableCounts.rowsChanged += applied;
    }
  }
}

/**
 * Redact the credential values in one seat store, in place.
 *
 * The function never throws for a store that it cannot open or that it cannot
 * lock. It reports the reason in `skipped` and the caller decides what to do
 * with it. A seat store that stays locked must not fail a run.
 *
 * The scrub keeps the state of its last pass, so a later pass reads only the
 * rows that changed since then. The option `full` ignores that state. The
 * state is written after every table, so a pass that stops halfway does not
 * read the whole store again.
 */
export function scrubSeatStoreInPlace(
  storePath: string,
  options: SeatStoreScrubOptions = {},
): SeatStoreScrubCounts {
  const dryRun = options.dryRun === true;
  const full = options.full === true;
  const repair = options.repair === true;
  const dropUnrepairable = options.dropUnrepairable === true;
  const dropTables = new Set(options.dropTables ?? ["session_message"]);
  const counts: SeatStoreScrubCounts = {
    store: storePath,
    tables: 0,
    valuesScanned: 0,
    fieldsChanged: 0,
    rowsChanged: 0,
    protectedTables: [],
    skipped: null,
    live: false,
    jsonValues: 0,
    repaired: 0,
    unrepairable: 0,
    dropped: 0,
    conflicts: 0,
    rowsSkipped: 0,
    perTable: [],
  };

  if (options.isStoreLive?.(storePath) === true) {
    // The seat writes to this store while it runs. Nothing is written here.
    counts.live = true;
    counts.skipped = "the seat is running";
    return counts;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(storePath, { readOnly: dryRun });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const state = full ? { version: 1, tables: {} } : readScrubState(storePath);
    const nextState: ScrubState = { version: 1, tables: {} };
    for (const table of tables) {
      if (PROTECTED_TABLES.has(table.name)) {
        counts.protectedTables.push(table.name);
        continue;
      }
      counts.tables += 1;
      const tableCounts: SeatStoreScrubCounts["perTable"][number] = {
        table: table.name,
        valuesScanned: 0,
        fieldsChanged: 0,
        rowsChanged: 0,
        incremental: false,
        repaired: 0,
        unrepairable: 0,
        dropped: 0,
        conflicts: 0,
        rowsSkipped: 0,
      };
      counts.perTable.push(tableCounts);
      try {
        const columns = textColumns(db, table.name);
        const time = timeColumn(db, table.name);
        const previous = state.tables[table.name] ?? null;
        const useTime = time !== null;
        // A table that was rebuilt has a row id that starts over. The scrub
        // reads it from the start again.
        const previousTime =
          useTime && previous?.column === time && typeof previous.value === "number"
            ? previous.value - WATERMARK_OVERLAP_MS
            : 0;
        const previousRowId =
          !useTime && previous?.column === null && typeof previous.value === "number"
            ? previous.value
            : 0;
        tableCounts.incremental = useTime ? previousTime > 0 : previousRowId > 0;
        let maxTime = previousTime;
        let maxRowId = previousRowId;

        if (repair) {
          for (const column of columns) {
            repairColumn(db, table.name, column.name, counts, tableCounts, dryRun, {
              dropUnrepairable,
              dropAllowed: dropTables.has(table.name),
            });
          }
        }

        for (const column of columns) {
          const result = scrubColumn(db, table.name, column.name, counts, tableCounts, dryRun, {
            timeColumn: time,
            fromTime: previousTime,
            fromRowId: previousRowId,
          });
          if (result.maxTime > maxTime) maxTime = result.maxTime;
          if (result.maxRowId > maxRowId) maxRowId = result.maxRowId;
        }
        nextState.tables[table.name] = useTime
          ? { column: time, value: maxTime }
          : { column: null, value: maxRowId };
      } catch (error) {
        // A table without a rowid, or one that the seat process holds, is
        // skipped. The other tables still get scrubbed.
        counts.skipped = `${table.name}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      // The state is written after every table, so a pass that stops halfway
      // does not read the whole store again.
      if (!dryRun) writeScrubState(storePath, nextState);
    }
    if (!dryRun) {
      writeScrubState(storePath, nextState);
      // The write-ahead log keeps the old page of every row that the scrub
      // changed. A checkpoint folds the log into the database file and empties
      // it, so the log does not keep a copy of the value.
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // The checkpoint is a cleanup. It must not fail the scrub.
      }
    }
  } catch (error) {
    counts.skipped = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      db?.close();
    } catch {
      // The store is closed already.
    }
  }
  return counts;
}

/**
 * The path of the session store of a seat, from the data home that the seat
 * runs with. The seat runs OpenCode with its data home under the seat home,
 * and OpenCode keeps the session store inside it.
 */
export function seatSessionStorePath(dataHome: string): string {
  const trimmed = dataHome.trim();
  if (!trimmed) return "";
  return `${trimmed.replace(/\/+$/, "")}/opencode/opencode.db`;
}

/**
 * The data home of a seat, from the environment that the agent runs with. The
 * value is a plain string or a binding that carries the plain value.
 */
export function seatDataHome(env: Record<string, unknown> | null | undefined): string {
  if (!env) return "";
  const value = env.XDG_DATA_HOME;
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const binding = value as { value?: unknown; type?: unknown };
    if (typeof binding.value === "string") return binding.value.trim();
  }
  return "";
}

/**
 * The session store of a seat, from the adapter configuration of the agent.
 * The configuration holds the environment of the seat, and the environment
 * holds the data home of the seat.
 */
export function seatSessionStorePathForAgent(
  adapterConfig: unknown,
): string {
  if (!adapterConfig || typeof adapterConfig !== "object") return "";
  const env = (adapterConfig as { env?: unknown }).env;
  if (!env || typeof env !== "object") return "";
  return seatSessionStorePath(seatDataHome(env as Record<string, unknown>));
}

/**
 * The directory that holds the session store of a seat. The state file of the
 * scrub sits next to the store.
 */
export function seatStoreDirectory(storePath: string): string {
  return path.dirname(storePath);
}
