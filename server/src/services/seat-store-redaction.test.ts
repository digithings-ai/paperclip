import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "../__tests__/helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "./heartbeat.js";
import {
  repairDamagedJsonDocument,
  resolveSeatSessionStorePath,
  scrubSeatSessionStoreForAgent,
  seatDataHome,
  seatSessionStorePath,
  scrubSeatStoreInPlace,
  updateValueIfUnchanged,
} from "./seat-store-redaction.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudCIsInNjb3BlIjoiYWdlbnQ6cnVuIn0.c2lnbmF0dXJlLXZhbHVl";

const temporaryDirectories: string[] = [];

/** A time in the past, so that the overlap of the watermark does not reach it. */
const OLD_TIME = 1_600_000_000_000;

/** A time of now, in milliseconds. */
function now(): number {
  return Date.now();
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/** A store with the shape that OpenCode gives a seat. */
function createSeatStore(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-seat-store-"));
  temporaryDirectories.push(directory);
  const store = path.join(directory, "opencode.db");
  const db = new DatabaseSync(store);
  db.exec(`
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL,
      seq integer NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE session_v2 (
      id text PRIMARY KEY,
      title text,
      metadata text
    );
    CREATE TABLE credential (
      id text PRIMARY KEY,
      label text NOT NULL,
      value text NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg-1",
    "session-1",
    "tool",
    1,
    OLD_TIME,
    OLD_TIME,
    JSON.stringify({
      type: "tool",
      output: `the seat printed its environment: PAPERCLIP_API_KEY=${JWT}`,
    }),
  );
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg-2",
    "session-1",
    "text",
    2,
    OLD_TIME,
    OLD_TIME,
    JSON.stringify({ type: "text", text: "the run finished without an error" }),
  );
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg-3",
    "session-1",
    "text",
    3,
    now(),
    now(),
    JSON.stringify({ type: "text", text: "the latest message of the session" }),
  );
  db.prepare("INSERT INTO session_v2 (id, title, metadata) VALUES (?, ?, ?)").run(
    "session-1",
    `session about PAPERCLIP_API_KEY=${JWT}`,
    JSON.stringify({ note: "no secret here" }),
  );
  db.prepare("INSERT INTO credential (id, label, value) VALUES (?, ?, ?)").run(
    "cred-1",
    "provider",
    JWT,
  );
  db.close();
  return store;
}

/**
 * A store that holds a row that an earlier redaction broke. The redaction took
 * the escape of the quote with it, so the row is not a document any more.
 */
function createSeatStoreWithBrokenRow(brokenData: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-seat-store-"));
  temporaryDirectories.push(directory);
  const store = path.join(directory, "opencode.db");
  const db = new DatabaseSync(store);
  db.exec(`
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL,
      seq integer NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("msg-broken", "session-1", "text", 1, OLD_TIME, OLD_TIME, brokenData);
  db.close();
  return store;
}

/** A store with a table that the scrub cannot write to. */
function createSeatStoreWithFailingTable(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-seat-store-"));
  temporaryDirectories.push(directory);
  const store = path.join(directory, "opencode.db");
  const db = new DatabaseSync(store);
  db.exec(`
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL,
      seq integer NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE zz_broken (
      id text PRIMARY KEY,
      value text NOT NULL CHECK (value NOT LIKE '%REDACTED%')
    );
  `);
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg-1",
    "session-1",
    "text",
    1,
    OLD_TIME,
    OLD_TIME,
    JSON.stringify({ type: "text", text: "nothing secret here" }),
  );
  db.prepare("INSERT INTO zz_broken (id, value) VALUES (?, ?)").run(
    "b-1",
    `PAPERCLIP_API_KEY=${JWT}`,
  );
  db.close();
  return store;
}

function readMessage(store: string, id: string): { data: string } {
  const db = new DatabaseSync(store, { readOnly: true });
  const row = db
    .prepare("SELECT data FROM session_message WHERE id = ?")
    .get(id) as { data: string };
  db.close();
  return row;
}

describe("scrubSeatStoreInPlace", () => {
  it("removes the credential value from the session store", () => {
    const store = createSeatStore();
    const counts = scrubSeatStoreInPlace(store);

    expect(counts.skipped).toBeNull();
    expect(counts.fieldsChanged).toBeGreaterThan(0);

    const db = new DatabaseSync(store, { readOnly: true });
    const messages = db
      .prepare("SELECT data FROM session_message ORDER BY seq")
      .all() as Array<{ data: string }>;
    const sessions = db
      .prepare("SELECT title FROM session_v2")
      .all() as Array<{ title: string }>;
    db.close();

    for (const message of messages) {
      expect(message.data).not.toContain(JWT);
    }
    for (const session of sessions) {
      expect(session.title).not.toContain(JWT);
    }
  });

  it("keeps the text around the value and the rows it read", () => {
    const store = createSeatStore();
    scrubSeatStoreInPlace(store);

    const db = new DatabaseSync(store, { readOnly: true });
    const rows = db
      .prepare("SELECT data FROM session_message ORDER BY seq")
      .all() as Array<{ data: string }>;
    db.close();

    expect(rows).toHaveLength(3);
    expect(rows[0].data).toContain("PAPERCLIP_API_KEY=");
    expect(rows[1].data).toContain("the run finished without an error");
  });

  it("leaves the authentication material of the seat alone", () => {
    const store = createSeatStore();
    scrubSeatStoreInPlace(store);

    const db = new DatabaseSync(store, { readOnly: true });
    const credentials = db
      .prepare("SELECT value FROM credential")
      .all() as Array<{ value: string }>;
    db.close();

    expect(credentials).toHaveLength(1);
    expect(credentials[0].value).toBe(JWT);
  });

  it("changes nothing on a dry run", () => {
    const store = createSeatStore();
    const counts = scrubSeatStoreInPlace(store, { dryRun: true });

    expect(counts.fieldsChanged).toBeGreaterThan(0);

    const db = new DatabaseSync(store, { readOnly: true });
    const messages = db
      .prepare("SELECT data FROM session_message ORDER BY seq")
      .all() as Array<{ data: string }>;
    db.close();

    expect(messages[0].data).toContain(JWT);
  });

  it("reports the reason instead of throwing when the store cannot be opened", () => {
    const counts = scrubSeatStoreInPlace(
      path.join(tmpdir(), "paperclip-seat-store-missing", "opencode.db"),
    );
    expect(counts.skipped).not.toBeNull();
    expect(counts.fieldsChanged).toBe(0);
  });

  it("keeps the state of the scrub next to the store", () => {
    const store = createSeatStore();
    scrubSeatStoreInPlace(store);

    const statePath = `${store}.redaction-state.json`;
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      version: number;
      tables: Record<string, { column: string | null; value: number }>;
    };
    expect(state.version).toBe(1);
    expect(state.tables.session_message.column).toBe("time_updated");
    expect(state.tables.session_message.value).toBeGreaterThan(OLD_TIME);
    expect(JSON.stringify(state)).not.toContain(JWT);
  });

  it("reads only the rows that changed since the last scrub", () => {
    const store = createSeatStore();
    const first = scrubSeatStoreInPlace(store);
    expect(first.fieldsChanged).toBeGreaterThan(0);

    const db = new DatabaseSync(store);
    const stamp = now();
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "msg-4",
      "session-1",
      "tool",
      4,
      stamp,
      stamp,
      JSON.stringify({ type: "tool", output: `PAPERCLIP_API_KEY=${JWT}` }),
    );
    db.close();

    const second = scrubSeatStoreInPlace(store);
    expect(second.fieldsChanged).toBe(1);
    expect(second.rowsChanged).toBe(1);
    // The rows of the first scrub are older than the overlap of the watermark,
    // so the second scrub reads the rows of the last minute only.
    expect(second.valuesScanned).toBeLessThan(first.valuesScanned);
    expect(second.valuesScanned).toBe(8);

    const check = new DatabaseSync(store, { readOnly: true });
    const messages = check
      .prepare("SELECT data FROM session_message ORDER BY seq")
      .all() as Array<{ data: string }>;
    check.close();
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message.data).not.toContain(JWT);
    }
  });

  it("reads the whole store again when the scrub is told to", () => {
    const store = createSeatStore();
    const first = scrubSeatStoreInPlace(store);
    const second = scrubSeatStoreInPlace(store, { full: true });

    expect(second.valuesScanned).toBe(first.valuesScanned);
    expect(second.fieldsChanged).toBe(0);
  });

  it("leaves a column that holds a document a document that a reader can parse", () => {
    const store = createSeatStore();
    scrubSeatStoreInPlace(store);

    const db = new DatabaseSync(store, { readOnly: true });
    const messages = db
      .prepare("SELECT data FROM session_message ORDER BY seq")
      .all() as Array<{ data: string }>;
    db.close();

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(() => JSON.parse(message.data)).not.toThrow();
      expect(message.data).not.toContain(JWT);
    }
  });

  it("redacts the value under a key that names a secret", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paperclip-seat-store-"));
    temporaryDirectories.push(directory);
    const store = path.join(directory, "opencode.db");
    const db = new DatabaseSync(store);
    db.exec(`
      CREATE TABLE session_message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        type text NOT NULL,
        seq integer NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "msg-key",
      "session-1",
      "text",
      1,
      OLD_TIME,
      OLD_TIME,
      JSON.stringify({ type: "text", authToken: JWT, usage: 42 }),
    );
    db.close();

    scrubSeatStoreInPlace(store);

    const row = readMessage(store, "msg-key");
    const document = JSON.parse(row.data) as Record<string, unknown>;
    expect(document.authToken).toBe("***REDACTED***");
    expect(document.usage).toBe(42);
    expect(row.data).not.toContain(JWT);
  });

  it("repairs a row that an earlier redaction broke", () => {
    const broken = '{"text":"the token ***REDACTED***"quoted\\" here"}';
    const store = createSeatStoreWithBrokenRow(broken);
    const counts = scrubSeatStoreInPlace(store, { repair: true });

    expect(counts.repaired).toBe(1);
    const row = readMessage(store, "msg-broken");
    expect(() => JSON.parse(row.data)).not.toThrow();
    expect(row.data).not.toContain(JWT);
  });

  it("leaves a row that it cannot repair alone and counts it", () => {
    // A control character cannot be escaped by putting an escape back, so the
    // repair cannot make this row a document again.
    const broken = `{"text":"broken ${String.fromCharCode(1)} value"}`;
    const store = createSeatStoreWithBrokenRow(broken);
    const counts = scrubSeatStoreInPlace(store, { repair: true });

    expect(counts.unrepairable).toBe(1);
    expect(counts.repaired).toBe(0);
    expect(counts.dropped).toBe(0);
    expect(readMessage(store, "msg-broken").data).toBe(broken);
  });

  it("removes a row that it cannot repair when a manual repair run asks for it", () => {
    const broken = `{"text":"broken ${String.fromCharCode(1)} value"}`;
    const store = createSeatStoreWithBrokenRow(broken);
    const counts = scrubSeatStoreInPlace(store, {
      repair: true,
      dropUnrepairable: true,
      allowRowDeletion: true,
    });

    expect(counts.unrepairable).toBe(1);
    expect(counts.dropped).toBe(1);
    const db = new DatabaseSync(store, { readOnly: true });
    const rows = db
      .prepare("SELECT id FROM session_message")
      .all() as Array<{ id: string }>;
    db.close();
    expect(rows).toHaveLength(0);
  });

  it("never removes a row when the caller does not allow the removal", () => {
    const broken = `{"text":"broken ${String.fromCharCode(1)} value"}`;
    const store = createSeatStoreWithBrokenRow(broken);
    const counts = scrubSeatStoreInPlace(store, {
      repair: true,
      dropUnrepairable: true,
    });

    expect(counts.unrepairable).toBe(1);
    expect(counts.dropped).toBe(0);
    const db = new DatabaseSync(store, { readOnly: true });
    const rows = db
      .prepare("SELECT id FROM session_message")
      .all() as Array<{ id: string }>;
    db.close();
    expect(rows).toHaveLength(1);
  });

  it("leaves the store of a seat that is running alone", () => {
    const store = createSeatStore();
    const counts = scrubSeatStoreInPlace(store, { isStoreLive: () => true });

    expect(counts.live).toBe(true);
    expect(counts.skipped).toBe("the seat is running");
    expect(counts.fieldsChanged).toBe(0);
    expect(readMessage(store, "msg-1").data).toContain(JWT);
  });

  it("keeps the state of the tables that it read when a later table fails", () => {
    const store = createSeatStoreWithFailingTable();
    const counts = scrubSeatStoreInPlace(store);

    expect(counts.skipped).toContain("zz_broken");
    const statePath = `${store}.redaction-state.json`;
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      version: number;
      tables: Record<string, { column: string | null; value: number }>;
    };
    expect(state.tables.session_message).toBeDefined();
    expect(state.tables.zz_broken).toBeUndefined();
  });
});

describe("updateValueIfUnchanged", () => {
  it("writes the value when the row still holds the value it read", () => {
    const store = createSeatStore();
    const db = new DatabaseSync(store);
    const row = db
      .prepare("SELECT rowid AS rid, data FROM session_message WHERE id = ?")
      .get("msg-1") as { rid: number; data: string };

    const changed = updateValueIfUnchanged(
      db,
      "session_message",
      "data",
      row.rid,
      row.data,
      '{"text":"the new value"}',
    );
    db.close();

    expect(changed).toBe(true);
    expect(readMessage(store, "msg-1").data).toBe('{"text":"the new value"}');
  });

  it("does not overwrite a value that a seat changed in the meantime", () => {
    const store = createSeatStore();
    const db = new DatabaseSync(store);
    const row = db
      .prepare("SELECT rowid AS rid, data FROM session_message WHERE id = ?")
      .get("msg-1") as { rid: number; data: string };

    const changed = updateValueIfUnchanged(
      db,
      "session_message",
      "data",
      row.rid,
      "the value that the service read",
      '{"text":"the new value"}',
    );
    db.close();

    expect(changed).toBe(false);
    expect(readMessage(store, "msg-1").data).toBe(row.data);
  });
});

describe("repairDamagedJsonDocument", () => {
  it("puts the escape back that a redaction took with it", () => {
    const broken = '{"text":"the token ***REDACTED***"quoted\\" here"}';
    const repaired = repairDamagedJsonDocument(broken);

    expect(repaired).not.toBeNull();
    expect(() => JSON.stringify(repaired)).not.toThrow();
    expect(JSON.stringify(repaired)).toContain("quoted");
  });

  it("gives a document that is already a document back", () => {
    const document = { text: "nothing broken here" };
    expect(repairDamagedJsonDocument(JSON.stringify(document))).toEqual(document);
  });

  it("gives nothing back for a text that is not a document", () => {
    expect(repairDamagedJsonDocument("the seat printed its environment")).toBeNull();
  });
});

describe("seatSessionStorePath", () => {
  it("builds the path of the store from the data home of the seat", () => {
    expect(seatSessionStorePath("/home/seats/cto/data")).toBe(
      "/home/seats/cto/data/opencode/opencode.db",
    );
    expect(seatSessionStorePath("/home/seats/cto/data/")).toBe(
      "/home/seats/cto/data/opencode/opencode.db",
    );
    expect(seatSessionStorePath("  ")).toBe("");
  });
});

describe("seatDataHome", () => {
  it("reads a plain value and a binding", () => {
    expect(seatDataHome({ XDG_DATA_HOME: "/home/seats/cto/data" })).toBe(
      "/home/seats/cto/data",
    );
    expect(
      seatDataHome({
        XDG_DATA_HOME: { type: "plain", value: "/home/seats/cto/data" },
      }),
    ).toBe("/home/seats/cto/data");
    expect(seatDataHome({})).toBe("");
    expect(seatDataHome(null)).toBe("");
  });
});

describe("resolveSeatSessionStorePath", () => {
  it("builds the path of the store from the adapter configuration", () => {
    const resolved = resolveSeatSessionStorePath({
      env: { XDG_DATA_HOME: "/home/seats/cto/data" },
    });
    expect(resolved.store).toBe("/home/seats/cto/data/opencode/opencode.db");
    expect(resolved.reason).toBeNull();
  });

  it("says why the path is unknown", () => {
    expect(resolveSeatSessionStorePath(null).reason).toBe(
      "the agent has no adapter configuration",
    );
    expect(resolveSeatSessionStorePath({}).reason).toBe(
      "the adapter configuration of the agent has no environment",
    );
    expect(resolveSeatSessionStorePath({ env: {} }).reason).toBe(
      "the environment of the agent has no data home",
    );
  });
});

describe("scrubSeatSessionStoreForAgent", () => {
  it("reports a seat that it could not scrub", () => {
    const outcome = scrubSeatSessionStoreForAgent({ env: {} });
    expect(outcome.scrubbed).toBe(false);
    expect(outcome.notScrubbed).toBe(true);
    expect(outcome.store).toBeNull();
    expect(outcome.counts).toBeNull();
    expect(outcome.reason).toBe("the environment of the agent has no data home");
  });

  it("never removes a row", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paperclip-seat-store-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "opencode"), { recursive: true });
    const store = path.join(directory, "opencode", "opencode.db");
    const db = new DatabaseSync(store);
    db.exec(`
      CREATE TABLE session_message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        type text NOT NULL,
        seq integer NOT NULL,
        data text NOT NULL,
        created_at integer NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "msg-1",
      "session-1",
      "text",
      1,
      `{"text":"broken ${String.fromCharCode(1)} value"}`,
      now(),
    );
    db.close();

    const outcome = scrubSeatSessionStoreForAgent(
      { env: { XDG_DATA_HOME: directory } },
      { repair: true, dropUnrepairable: true },
    );
    expect(outcome.scrubbed).toBe(true);
    expect(outcome.counts?.dropped).toBe(0);
    expect(outcome.counts?.unrepairable).toBe(1);

    const reader = new DatabaseSync(store, { readOnly: true });
    const rows = reader
      .prepare("SELECT id FROM session_message")
      .all() as Array<{ id: string }>;
    reader.close();
    expect(rows).toHaveLength(1);
  });
});

/**
 * The board scrubs the session store of a seat after a run, on the success
 * path and on the failure path (`scrubSeatSessionStoreAfterRun` in
 * `heartbeat.ts`). The unit tests above call the scrub directly, so they stay
 * green when a heartbeat call site is removed. This test runs a heartbeat that
 * fails, so the failure-path call site is covered.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping the heartbeat failure-path seat store test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("the failure path of a heartbeat run", () => {
  const ADAPTER_TYPE = "seat_store_failure_test";
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-seat-store-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER_TYPE,
      execute: async () => {
        throw new Error(`the provider failed with PAPERCLIP_API_KEY=${JWT}`);
      },
      testEnvironment: async () => ({
        adapterType: ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "heartbeat_run_events",
        "agent_wakeup_requests",
        "heartbeat_runs",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  it("scrubs the session store of a seat whose run failed", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paperclip-seat-store-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "opencode"), { recursive: true });
    const storePath = path.join(directory, "opencode", "opencode.db");
    const seatDb = new DatabaseSync(storePath);
    seatDb.exec(`
      CREATE TABLE session_message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        type text NOT NULL,
        seq integer NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `);
    seatDb.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "msg-1",
      "session-1",
      "tool",
      1,
      now(),
      now(),
      JSON.stringify({
        output: `the seat printed its environment: PAPERCLIP_API_KEY=${JWT}`,
      }),
    );
    seatDb.close();

    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Seat store failure company",
      issuePrefix: `S${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Failing seat",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER_TYPE,
      adapterConfig: { env: { XDG_DATA_HOME: directory } },
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const deadline = Date.now() + 10_000;
    let finished = await heartbeat.getRun(queued!.id);
    while (
      finished &&
      ["queued", "running"].includes(finished.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = await heartbeat.getRun(queued!.id);
    }
    expect(finished?.status).toBe("failed");

    const readStoredData = (): string | null => {
      const reader = new DatabaseSync(storePath, { readOnly: true });
      const rows = reader
        .prepare("SELECT data FROM session_message")
        .all() as Array<{ data: string }>;
      reader.close();
      return rows[0]?.data ?? null;
    };

    // The run row reaches its terminal status before the scrub of the seat
    // store finishes, so the store is read until the redacted value lands.
    const scrubDeadline = Date.now() + 10_000;
    let stored = readStoredData();
    while (
      stored !== null &&
      stored.includes(JWT) &&
      Date.now() < scrubDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stored = readStoredData();
    }
    if (stored === null) throw new Error("the session store row is missing");
    // The row is redacted in place: no credential text survives, and the rest
    // of the document is still there.
    expect(stored).not.toContain(JWT);
    expect(stored).toContain("PAPERCLIP_API_KEY=");
  });
});

