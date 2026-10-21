import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueCommentRunAttributionQuery,
  mapIssueCommentRunAttributionRow,
} from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run attribution index tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const WINDOW_START = "2026-06-04T00:00:00.000Z";
const WINDOW_END = "2026-06-04T01:00:00.000Z";

describeEmbeddedPostgres("issue comment run attribution query", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-comment-run-attribution-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("finds the runs of every branch and skips the runs outside the window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Attribution Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Attribution Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const contextRunId = randomUUID();
    const activityRunId = randomUUID();
    const ownRunId = randomUUID();
    const otherIssueRunId = randomUUID();
    const oldContextRunId = randomUUID();
    const oldActivityRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: contextRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-06-04T00:10:00.000Z"),
        finishedAt: new Date("2026-06-04T00:20:00.000Z"),
        createdAt: new Date("2026-06-04T00:10:00.000Z"),
        logStore: "local_file",
        logRef: "logs/context.log",
        logBytes: 1234,
      },
      {
        id: activityRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { taskId: "other" },
        startedAt: new Date("2026-06-04T00:15:00.000Z"),
        finishedAt: new Date("2026-06-04T00:25:00.000Z"),
        createdAt: new Date("2026-06-04T00:15:00.000Z"),
      },
      {
        id: ownRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { taskId: "other" },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      {
        id: otherIssueRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { issueId: otherIssueId },
        startedAt: new Date("2026-06-04T00:30:00.000Z"),
        finishedAt: new Date("2026-06-04T00:40:00.000Z"),
        createdAt: new Date("2026-06-04T00:30:00.000Z"),
      },
      {
        id: oldContextRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-05-01T00:10:00.000Z"),
        finishedAt: new Date("2026-05-01T00:20:00.000Z"),
        createdAt: new Date("2026-05-01T00:10:00.000Z"),
      },
      {
        id: oldActivityRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { taskId: "other" },
        startedAt: new Date("2026-05-01T00:15:00.000Z"),
        finishedAt: new Date("2026-05-01T00:25:00.000Z"),
        createdAt: new Date("2026-05-01T00:15:00.000Z"),
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "comment.created",
        entityType: "issue",
        entityId: issueId,
        runId: activityRunId,
        createdAt: new Date("2026-06-04T00:16:00.000Z"),
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "comment.created",
        entityType: "issue",
        entityId: issueId,
        runId: oldActivityRunId,
        createdAt: new Date("2026-05-01T00:16:00.000Z"),
      },
    ]);

    const query = buildIssueCommentRunAttributionQuery({
      companyId,
      issueId,
      minCommentCreatedAt: WINDOW_START,
      maxCommentCreatedAt: WINDOW_END,
      ownRunIds: [ownRunId],
    });

    const rows = Array.from(
      await db.execute(query),
    ) as Array<Record<string, unknown>>;
    const runs = rows.map((row) =>
      mapIssueCommentRunAttributionRow(row as never),
    );

    expect(runs.map((run) => run.runId)).toEqual([
      activityRunId,
      contextRunId,
      ownRunId,
    ]);
    expect(runs.find((run) => run.runId === contextRunId)?.logBytes).toBe(1234);
    expect(runs.find((run) => run.runId === contextRunId)?.logStore).toBe("local_file");
    expect(runs.find((run) => run.runId === contextRunId)?.logRef).toBe("logs/context.log");
  });

  it("reads the runs through an index and never scans the run table", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    const query = buildIssueCommentRunAttributionQuery({
      companyId,
      issueId,
      minCommentCreatedAt: WINDOW_START,
      maxCommentCreatedAt: WINDOW_END,
      ownRunIds: [],
    });

    const plan = await db.transaction(async (tx) => {
      // A scan of the run table gets a huge cost. The plan then shows if the
      // query needs one. The old `OR` form needed one on every board listing.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const rows = Array.from(
        await tx.execute(sql`explain (costs off) ${query}`),
      ) as Array<Record<string, unknown>>;
      return rows.map((row) => String(Object.values(row)[0] ?? "")).join("\n");
    });

    // The issue-context index must serve the first branch. The old `OR` form
    // could not use it, so it read every run row. That read held a database
    // connection for minutes and starved the pool.
    expect(plan).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    // Every read of the run table must go through an index.
    expect(plan).not.toMatch(/(?:Seq Scan|Bitmap Heap Scan) on heartbeat_runs/);
    expect(plan).toContain("Index Scan");
  });
});
