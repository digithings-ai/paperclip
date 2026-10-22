import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";
import {
  ORPHANED_RUN_CONTINUATION_ERROR_CODE,
  buildOrphanedRunContinuationIdempotencyKey,
  buildOrphanedRunContinuationKeyPrefix,
} from "../services/run-continuations.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphaned-run sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// The sweep reads the host through an injected gate, so the test never depends
// on the load of the machine that runs it.
const NOW = new Date("2026-10-22T12:00:00.000Z");
const GRACE_MS = 3 * 60 * 60 * 1000;
// The work stopped one grace period plus a minute ago, so the grace has elapsed.
const WORK_STOPPED_AT = new Date(NOW.getTime() - GRACE_MS - 60_000);
const HEALTHY_HOST = {
  saturated: false,
  reason: "the test host is healthy",
  source: "override" as const,
  loadAverage1m: 0.4,
  cpuCount: 8,
  loadPerCore: 0.05,
  thresholdLoadPerCore: 3,
};

describeEmbeddedPostgres("heartbeat sweepOrphanedRunContinuations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphaned-run-sweep-");
    db = createDb(tempDb.connectionString);
    // The continuation enqueues a wake and a queued run. The task drain keeps
    // the queued run from being started, so the test never invokes an adapter.
    startTaskDrain();
  }, 30_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, so
    // the runs go first.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    stopTaskDrain();
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphaned run continuation fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
      // A queued run needs a responsible user, otherwise the dispatch is
      // refused before the continuation can be enqueued.
      responsibleUserId: "board-user",
    });
    return issueId;
  }

  async function seedOrphan(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    continuationAttempt?: number;
    orphanedContinuationDecision?: string;
    updatedAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "interrupted",
      invocationSource: "manual",
      errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
      lastOutputAt: WORK_STOPPED_AT,
      // The backstop terminalizes the row hours after the work stopped.
      finishedAt: new Date(WORK_STOPPED_AT.getTime() + 30 * 60 * 1000),
      createdAt: new Date(WORK_STOPPED_AT.getTime() - 60 * 60 * 1000),
      updatedAt: input.updatedAt ?? new Date(WORK_STOPPED_AT.getTime() + 30 * 60 * 1000),
      ...(input.continuationAttempt === undefined
        ? {}
        : { continuationAttempt: input.continuationAttempt }),
      ...(input.orphanedContinuationDecision === undefined
        ? {}
        : { orphanedContinuationDecision: input.orphanedContinuationDecision }),
      contextSnapshot: { issueId: input.issueId },
    });
    return id;
  }

  function heartbeat() {
    return heartbeatService(db, {});
  }

  function sweep(options?: { limit?: number }) {
    return heartbeat().sweepOrphanedRunContinuations({
      now: NOW,
      graceMs: GRACE_MS,
      hostHealth: HEALTHY_HOST,
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  async function wakesFor(sourceRunId: string, issueId: string) {
    const prefix = buildOrphanedRunContinuationKeyPrefix({
      issueId,
      sourceRunId,
    });
    return db
      .select()
      .from(agentWakeupRequests)
      .where(like(agentWakeupRequests.idempotencyKey, `${prefix}:%`));
  }

  async function readRun(runId: string) {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return rows[0] ?? null;
  }

  it("continues an orphaned run and enqueues the wake with the orphaned idempotency key", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const sourceRunId = await seedOrphan({ companyId, agentId, issueId });

    const result = await sweep();

    expect(result.continued).toBe(1);
    expect(result.eligible).toBe(1);

    const wakes = await wakesFor(sourceRunId, issueId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].idempotencyKey).toBe(
      buildOrphanedRunContinuationIdempotencyKey({
        issueId,
        sourceRunId,
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        nextAttempt: 1,
      }),
    );
    expect(wakes[0].status).toBe("queued");

    // The attempt counter is written back to the source run, so the cap of 2
    // holds across the chain.
    const source = await readRun(sourceRunId);
    expect(source?.continuationAttempt).toBe(1);
  });

  it("does not continue an orphan whose issue was dispatched again", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const sourceRunId = await seedOrphan({ companyId, agentId, issueId });

    // The seat was dispatched again 1540s after the work stopped.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      createdAt: new Date(WORK_STOPPED_AT.getTime() + 1540 * 1000),
      contextSnapshot: { issueId },
    });

    const result = await sweep();

    expect(result.continued).toBe(0);
    expect(await wakesFor(sourceRunId, issueId)).toHaveLength(0);

    // The decision is recorded, so the row stops filling the candidate window.
    const source = await readRun(sourceRunId);
    expect(source?.orphanedContinuationDecision).toBe("dispatched_again");
  });

  it("does not continue an orphan while a continuation of it is already in flight", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    // The production state right after a continuation was enqueued: the wake
    // of attempt 1 is queued and the source run row already carries the
    // attempt counter. The sweep runs again before the continued seat produced
    // a run, so the next attempt (2) has no idempotency key of its own yet.
    // Only the in-flight gate stops the second wake.
    const sourceRunId = await seedOrphan({
      companyId,
      agentId,
      issueId,
      continuationAttempt: 1,
    });

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      status: "queued",
      idempotencyKey: buildOrphanedRunContinuationIdempotencyKey({
        issueId,
        sourceRunId,
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        nextAttempt: 1,
      }),
    });

    const result = await sweep();

    expect(result.continued).toBe(0);
    // The wake that was already in flight is still the only one.
    expect(await wakesFor(sourceRunId, issueId)).toHaveLength(1);
  });

  it("refuses a second continuation of the same orphan as exhausted", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    // The cap of 2 attempts is already used up on this run.
    const sourceRunId = await seedOrphan({
      companyId,
      agentId,
      issueId,
      continuationAttempt: 2,
    });

    const result = await sweep();

    expect(result.continued).toBe(0);
    expect(result.skippedReasons.join("\n")).toContain("exhausted");
    expect(await wakesFor(sourceRunId, issueId)).toHaveLength(0);

    const source = await readRun(sourceRunId);
    expect(source?.orphanedContinuationDecision).toBe("exhausted");
  });

  // More decided rows than the candidate window holds: the sweep reads at most
  // 200 candidates per tick. They are bulk seeded because the property is
  // about the window size, not about the number of rows.
  async function seedDecidedOrphans(companyId: string, agentId: string, count: number) {
    const issueIds = Array.from({ length: count }, () => randomUUID());
    await db.insert(issues).values(
      issueIds.map((issueId) => ({
        id: issueId,
        companyId,
        title: "Decided orphan fixture",
        status: "in_progress" as const,
        assigneeAgentId: agentId,
        responsibleUserId: "board-user",
      })),
    );
    const runIds = issueIds.map(() => randomUUID());
    await db.insert(heartbeatRuns).values(
      runIds.map((runId, index) => ({
        id: runId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        lastOutputAt: WORK_STOPPED_AT,
        finishedAt: new Date(WORK_STOPPED_AT.getTime() + 30 * 60 * 1000),
        createdAt: new Date(WORK_STOPPED_AT.getTime() - 60 * 60 * 1000),
        // Older than the fresh orphan, so a window that is not filtered by the
        // decision marker never reaches it.
        updatedAt: new Date(WORK_STOPPED_AT.getTime() + index * 1000),
        // The sweep already decided about these rows: the issue was dispatched
        // again, so they are never continued.
        orphanedContinuationDecision: "dispatched_again",
        contextSnapshot: { issueId: issueIds[index] },
      })),
    );
    return runIds.map((runId, index) => ({ runId, issueId: issueIds[index] }));
  }

  // Rows the sweep can never act on: the process-death authority of the
  // backstop does not require an issue, so a run can carry no issue id. Such
  // a run can never be continued, so the sweep skips it without deciding
  // about it and the row keeps its old timestamp. They are bulk seeded
  // because the property is about the window size, not about the rows.
  async function seedUndecidableOrphans(companyId: string, agentId: string, count: number) {
    const runIds = Array.from({ length: count }, () => randomUUID());
    await db.insert(heartbeatRuns).values(
      runIds.map((runId, index) => ({
        id: runId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        lastOutputAt: WORK_STOPPED_AT,
        finishedAt: new Date(WORK_STOPPED_AT.getTime() + 30 * 60 * 1000),
        createdAt: new Date(WORK_STOPPED_AT.getTime() - 60 * 60 * 1000),
        // Older than the fresh orphan, so a window that never moves on sees
        // only these rows.
        updatedAt: new Date(WORK_STOPPED_AT.getTime() + index * 1000),
        // No issue id in the context: the run can never be continued.
        contextSnapshot: {},
      })),
    );
    return runIds;
  }

  it("reaches a fresh orphan behind rows the sweep can never act on", async () => {
    const { companyId, agentId } = await seed();

    // More rows the sweep skips without deciding than the candidate window
    // holds (the default limit is 200). They are older than the fresh orphan,
    // so a sweep whose window never moves on sees only these and never
    // reaches the fresh one.
    await seedUndecidableOrphans(companyId, agentId, 201);

    const freshIssueId = await seedIssue(companyId, agentId);
    const freshRunId = await seedOrphan({
      companyId,
      agentId,
      issueId: freshIssueId,
      updatedAt: NOW,
    });

    // The window is a scan over an unbounded set, so the sweep keeps its
    // position between ticks: one service instance, two ticks.
    const service = heartbeat();
    const first = await service.sweepOrphanedRunContinuations({
      now: NOW,
      graceMs: GRACE_MS,
      hostHealth: HEALTHY_HOST,
    });
    expect(first.scanned).toBe(200);
    expect(first.continued).toBe(0);

    const second = await service.sweepOrphanedRunContinuations({
      now: NOW,
      graceMs: GRACE_MS,
      hostHealth: HEALTHY_HOST,
    });
    expect(second.continued).toBe(1);

    const wakes = await wakesFor(freshRunId, freshIssueId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      buildOrphanedRunContinuationIdempotencyKey({
        issueId: freshIssueId,
        sourceRunId: freshRunId,
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        nextAttempt: 1,
      }),
    );
  });

  it("reaches a fresh orphan however many decided rows the table holds", async () => {
    const { companyId, agentId } = await seed();

    // More decided rows than the candidate window holds (the default limit is
    // 200). They are older than the fresh orphan, so a sweep that does not
    // exclude decided rows sees only these and never reaches the fresh one.
    const decided = await seedDecidedOrphans(companyId, agentId, 201);

    const freshIssueId = await seedIssue(companyId, agentId);
    const freshRunId = await seedOrphan({
      companyId,
      agentId,
      issueId: freshIssueId,
      updatedAt: NOW,
    });

    const result = await sweep();

    expect(result.continued).toBe(1);
    const wakes = await wakesFor(freshRunId, freshIssueId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      buildOrphanedRunContinuationIdempotencyKey({
        issueId: freshIssueId,
        sourceRunId: freshRunId,
        errorCode: ORPHANED_RUN_CONTINUATION_ERROR_CODE,
        nextAttempt: 1,
      }),
    );

    // The decided rows are not continued again.
    const allWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        like(agentWakeupRequests.idempotencyKey, "run_liveness_continuation:%"),
      );
    expect(allWakes).toHaveLength(1);
    for (const row of decided) {
      expect(
        allWakes.some((wake) => wake.idempotencyKey?.includes(row.runId)),
      ).toBe(false);
    }
  });
});
