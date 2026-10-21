import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import {
  buildOrphanedRunContinuationIdempotencyKey,
  findLaterRunOnIssue,
  findPendingOrphanedRunContinuationWake,
} from "../services/run-continuations.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphaned-run continuation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("orphaned run continuation database gates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphaned-run-continuation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
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
    });
    return issueId;
  }

  it("finds a run that was created on the same issue after the work stopped", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const workStoppedAt = new Date("2026-10-21T01:11:06.099Z");
    const sourceRunId = randomUUID();
    const laterRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: sourceRunId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: "orphaned_running_run",
        lastOutputAt: workStoppedAt,
        finishedAt: new Date("2026-10-21T07:01:25.163Z"),
        createdAt: new Date("2026-10-21T00:40:00.000Z"),
        contextSnapshot: { issueId },
      },
      {
        id: laterRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        createdAt: new Date("2026-10-21T01:59:41.411Z"),
        contextSnapshot: { issueId },
      },
    ]);

    const later = await findLaterRunOnIssue(db, {
      companyId,
      issueId,
      sourceRunId,
      after: workStoppedAt,
    });

    expect(later?.id).toBe(laterRunId);
  });

  it("finds a run that is bound to the issue through taskId", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const workStoppedAt = new Date("2026-10-21T01:11:06.099Z");
    const sourceRunId = randomUUID();
    const laterRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: sourceRunId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: "orphaned_running_run",
        lastOutputAt: workStoppedAt,
        createdAt: new Date("2026-10-21T00:40:00.000Z"),
        contextSnapshot: { issueId },
      },
      {
        id: laterRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        createdAt: new Date("2026-10-21T02:58:53.921Z"),
        contextSnapshot: { taskId: issueId },
      },
    ]);

    const later = await findLaterRunOnIssue(db, {
      companyId,
      issueId,
      sourceRunId,
      after: workStoppedAt,
    });

    expect(later?.id).toBe(laterRunId);
  });

  it("ignores runs that started before the work stopped, other issues and other companies", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const otherIssueId = await seedIssue(companyId, agentId);
    const workStoppedAt = new Date("2026-10-21T01:11:06.099Z");
    const sourceRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: sourceRunId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: "orphaned_running_run",
        lastOutputAt: workStoppedAt,
        createdAt: new Date("2026-10-21T00:40:00.000Z"),
        contextSnapshot: { issueId },
      },
      {
        // Same issue, but created before the work stopped: not a re-dispatch.
        id: randomUUID(),
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        createdAt: new Date("2026-10-21T01:05:00.000Z"),
        contextSnapshot: { issueId },
      },
      {
        // Another issue, created after the work stopped.
        id: randomUUID(),
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        createdAt: new Date("2026-10-21T02:00:00.000Z"),
        contextSnapshot: { issueId: otherIssueId },
      },
    ]);

    const later = await findLaterRunOnIssue(db, {
      companyId,
      issueId,
      sourceRunId,
      after: workStoppedAt,
    });

    expect(later).toBeNull();
  });

  it("finds a pending continuation wake for the source run and ignores finished ones", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const sourceRunId = randomUUID();
    const key = buildOrphanedRunContinuationIdempotencyKey({
      issueId,
      sourceRunId,
      errorCode: "orphaned_running_run",
      nextAttempt: 1,
    });

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      status: "queued",
      idempotencyKey: key,
    });

    const pending = await findPendingOrphanedRunContinuationWake(db, {
      companyId,
      issueId,
      sourceRunId,
    });
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("queued");

    await db.update(agentWakeupRequests)
      .set({ status: "completed" })
      .where(eq(agentWakeupRequests.idempotencyKey, key));

    const afterCompletion = await findPendingOrphanedRunContinuationWake(db, {
      companyId,
      issueId,
      sourceRunId,
    });
    expect(afterCompletion).toBeNull();
  });

  it("ignores a continuation wake that belongs to another source run", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const otherSourceRunId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      status: "queued",
      idempotencyKey: buildOrphanedRunContinuationIdempotencyKey({
        issueId,
        sourceRunId: otherSourceRunId,
        errorCode: "orphaned_running_run",
        nextAttempt: 1,
      }),
    });

    const pending = await findPendingOrphanedRunContinuationWake(db, {
      companyId,
      issueId,
      sourceRunId: randomUUID(),
    });

    expect(pending).toBeNull();
  });

  it("reproduces the measured night: two orphans were picked up again, one was not", async () => {
    const { companyId, agentId } = await seed();
    const workStoppedAt = new Date("2026-10-21T01:11:06.099Z");

    // 93e5a19e: re-dispatched 1540s after the work stopped, before the
    // backstop terminalized the row.
    const hostIssueId = await seedIssue(companyId, agentId);
    const hostRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: hostRunId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: "orphaned_running_run",
        lastOutputAt: new Date("2026-10-21T01:34:01.933Z"),
        createdAt: new Date("2026-10-21T01:00:00.000Z"),
        contextSnapshot: { issueId: hostIssueId },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        createdAt: new Date("2026-10-21T01:59:41.411Z"),
        contextSnapshot: { issueId: hostIssueId },
      },
    ]);

    // 90913a8f: re-dispatched 7016s after the work stopped.
    const edgeIssueId = await seedIssue(companyId, agentId);
    const edgeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: edgeRunId,
        companyId,
        agentId,
        status: "interrupted",
        invocationSource: "manual",
        errorCode: "orphaned_running_run",
        lastOutputAt: new Date("2026-10-21T01:01:57.050Z"),
        createdAt: new Date("2026-10-21T00:30:00.000Z"),
        contextSnapshot: { issueId: edgeIssueId },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        createdAt: new Date("2026-10-21T02:58:53.921Z"),
        contextSnapshot: { issueId: edgeIssueId },
      },
    ]);

    // 79132d30: never dispatched again. This is the lost work.
    const reviewerIssueId = await seedIssue(companyId, agentId);
    const reviewerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: reviewerRunId,
      companyId,
      agentId,
      status: "interrupted",
      invocationSource: "manual",
      errorCode: "orphaned_running_run",
      lastOutputAt: workStoppedAt,
      createdAt: new Date("2026-10-21T00:40:00.000Z"),
      contextSnapshot: { issueId: reviewerIssueId },
    });

    const host = await findLaterRunOnIssue(db, {
      companyId,
      issueId: hostIssueId,
      sourceRunId: hostRunId,
      after: new Date("2026-10-21T01:34:01.933Z"),
    });
    const edge = await findLaterRunOnIssue(db, {
      companyId,
      issueId: edgeIssueId,
      sourceRunId: edgeRunId,
      after: new Date("2026-10-21T01:01:57.050Z"),
    });
    const reviewer = await findLaterRunOnIssue(db, {
      companyId,
      issueId: reviewerIssueId,
      sourceRunId: reviewerRunId,
      after: workStoppedAt,
    });

    expect(host).not.toBeNull();
    expect(edge).not.toBeNull();
    expect(reviewer).toBeNull();
  });
});
