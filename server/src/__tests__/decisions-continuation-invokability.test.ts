import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  decisions,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged decision continuation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { decisionService } from "../services/decisions.ts";
import { createDecisionWakeOriginAgent } from "../services/decision-wakeup.ts";
import { runStartupDecisionSweep } from "../startup-heartbeat-recovery.ts";
import { runningProcesses } from "../adapters/index.ts";
import { logger } from "../middleware/logger.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SKIP_MESSAGE = "decision continuation skipped for non-invokable origin agent - continuation stays pending";
const FAILED_MESSAGE = "decision continuation delivery failed - continuation stays pending";
const SUMMARY_MESSAGE = "decision expiry sweep left continuations pending";

type AgentStatus = "idle" | "paused" | "terminated" | "pending_approval";

describeEmbeddedPostgres("decision expiry sweep with non-invokable origin agents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-continuation-invokability-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    vi.restoreAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(decisions);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(agentTaskSessions);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      membershipRole: "owner",
      status: "active",
    });
    return companyId;
  }

  let issueNumber = 0;
  async function seedOriginAgent(companyId: string, status: AgentStatus, reportsTo: string | null = null) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    issueNumber += 1;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Origin agent ${status}`,
      role: "engineer",
      status,
      reportsTo,
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Synthetic origin issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber,
      identifier: `DEC-${issueNumber}`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    return { companyId, agentId, issueId, runId };
  }

  type Origin = Awaited<ReturnType<typeof seedOriginAgent>>;

  // An expired decision whose continuation was never delivered (for example,
  // the wake failed before a restart).
  async function seedPendingExpiredDecision(origin: Origin, updatedAt?: Date) {
    const [row] = await db.insert(decisions).values({
      ...(updatedAt ? { updatedAt } : {}),
      companyId: origin.companyId,
      originAgentId: origin.agentId,
      originIssueId: origin.issueId,
      originRunId: origin.runId,
      title: "Expired decision",
      body: "Body",
      options: [],
      status: "expired",
      expiresAt: new Date(Date.now() - 60_000),
      signedSpec: "unused-by-the-sweep",
      targetSnapshots: {},
      continuationPolicy: "wake_origin_agent",
      metadata: { expiredReason: "ttl", continuationPending: true },
    }).returning();
    return row!;
  }

  // An open decision past its expiresAt: the sweep expires it and then wakes
  // the origin agent in the same pass.
  async function seedOpenPastExpiryDecision(origin: Origin) {
    const [row] = await db.insert(decisions).values({
      companyId: origin.companyId,
      originAgentId: origin.agentId,
      originIssueId: origin.issueId,
      originRunId: origin.runId,
      title: "Open decision past its expiry",
      body: "Body",
      options: [],
      status: "open",
      expiresAt: new Date(Date.now() - 60_000),
      signedSpec: "unused-by-the-sweep",
      targetSnapshots: {},
      continuationPolicy: "wake_origin_agent",
      metadata: {},
    }).returning();
    return row!;
  }

  function realWake() {
    const heartbeat = heartbeatService(db);
    return createDecisionWakeOriginAgent((agentId, options) => heartbeat.wakeup(agentId, options));
  }

  async function storedMetadata(decisionId: string) {
    const [row] = await db
      .select({ status: decisions.status, metadata: decisions.metadata })
      .from(decisions)
      .where(eq(decisions.id, decisionId));
    return row!;
  }

  async function wakeCount(agentId: string) {
    const rows = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return rows.length;
  }

  for (const status of ["paused", "terminated", "pending_approval"] as const) {
    it(`keeps a ${status} origin agent's continuations pending and lets the startup sweep complete`, async () => {
      const warn = vi.spyOn(logger, "warn");
      const error = vi.spyOn(logger, "error");
      const companyId = await seedCompany();
      const parked = await seedOriginAgent(companyId, status);
      const pendingExpired = await seedPendingExpiredDecision(parked);
      const openPastExpiry = await seedOpenPastExpiryDecision(parked);
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const result = await service.sweepExpired();

      // The already-pending continuation is left out of the query (parked
      // origin), and the newly expired one is caught by the pre-check.
      expect(result).toMatchObject({
        expired: 1,
        resumed: 0,
        continuationsDelivered: 0,
        continuationsNotInvokableSkipped: 1,
        continuationsFailed: 0,
      });
      expect(await storedMetadata(pendingExpired.id)).toMatchObject({
        status: "expired",
        metadata: { continuationPending: true },
      });
      expect(await storedMetadata(openPastExpiry.id)).toMatchObject({
        status: "expired",
        metadata: { continuationPending: true, expiredReason: "ttl" },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ decisionId: openPastExpiry.id, agentId: parked.agentId, reason: status }),
        SKIP_MESSAGE,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ continuationsNotInvokableSkipped: 1 }),
        SUMMARY_MESSAGE,
      );
      // The skip happens before the wake, so no wakeup-request row is written.
      expect(await wakeCount(parked.agentId)).toBe(0);

      // The startup call completes too, and the continuations stay pending
      // for a later sweep once the agent is invokable again.
      await expect(runStartupDecisionSweep({ decisions: service, logger })).resolves.toBe(true);
      expect(error).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("startup decision expiry sweep failed"));
      expect(await storedMetadata(pendingExpired.id)).toMatchObject({ metadata: { continuationPending: true } });
      expect(await storedMetadata(openPastExpiry.id)).toMatchObject({ metadata: { continuationPending: true } });
      expect(await wakeCount(parked.agentId)).toBe(0);
    });
  }

  it("still wakes and acknowledges an active origin agent in the same sweep as a paused one", async () => {
    const companyId = await seedCompany();
    const parked = await seedOriginAgent(companyId, "paused");
    const active = await seedOriginAgent(companyId, "idle");
    const parkedDecision = await seedPendingExpiredDecision(parked);
    const activeDecision = await seedPendingExpiredDecision(active);
    const activeOpenDecision = await seedOpenPastExpiryDecision(active);

    const result = await decisionService(db, { wakeOriginAgent: realWake() }).sweepExpired();

    // The paused agent's pending continuation is left out of the query.
    expect(result).toMatchObject({
      expired: 1,
      continuationsDelivered: 2,
      continuationsNotInvokableSkipped: 0,
      continuationsFailed: 0,
    });
    expect(await wakeCount(parked.agentId)).toBe(0);
    expect(await storedMetadata(parkedDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
    expect(await storedMetadata(activeOpenDecision.id)).toMatchObject({
      status: "expired",
      metadata: { continuationPending: false },
    });
    expect((await storedMetadata(activeDecision.id)).metadata).toHaveProperty("continuationDeliveredAt");
    expect(await wakeCount(active.agentId)).toBeGreaterThanOrEqual(1);
  });

  it("logs a non-409 wake error on one decision and still delivers the others", async () => {
    const error = vi.spyOn(logger, "error");
    const companyId = await seedCompany();
    const broken = await seedOriginAgent(companyId, "idle");
    const active = await seedOriginAgent(companyId, "idle");
    const brokenDecision = await seedPendingExpiredDecision(broken);
    const activeDecision = await seedPendingExpiredDecision(active);
    const wake = realWake();

    const result = await decisionService(db, {
      wakeOriginAgent: async (input) => {
        if (input.agentId === broken.agentId) throw new Error("simulated wake failure");
        return wake(input);
      },
    }).sweepExpired();

    expect(result).toMatchObject({
      continuationsDelivered: 1,
      continuationsNotInvokableSkipped: 0,
      continuationsFailed: 1,
    });
    expect(await storedMetadata(brokenDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: brokenDecision.id, agentId: broken.agentId }),
      FAILED_MESSAGE,
    );
  });
  describe("with a small sweep batch", () => {
    const previousBatchSize = process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
    beforeAll(() => {
      process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "3";
    });
    afterAll(() => {
      if (previousBatchSize === undefined) delete process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
      else process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = previousBatchSize;
    });

    it("does not let more than a batch of parked continuations starve an active one", async () => {
      const warn = vi.spyOn(logger, "warn");
      const companyId = await seedCompany();
      const statuses = ["paused", "terminated", "pending_approval", "paused", "terminated"] as const;
      const parkedOrigins: Origin[] = [];
      const parkedDecisions: Array<{ id: string }> = [];
      for (const [index, status] of statuses.entries()) {
        const origin = await seedOriginAgent(companyId, status);
        parkedOrigins.push(origin);
        // Older than the active row, so they sort first by updated_at.
        parkedDecisions.push(await seedPendingExpiredDecision(origin, new Date(Date.now() - (60 - index) * 60_000)));
      }
      const active = await seedOriginAgent(companyId, "idle");
      const activeDecision = await seedPendingExpiredDecision(active, new Date());
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const result = await service.sweepExpired();

      expect(result).toMatchObject({
        continuationsDelivered: 1,
        continuationsNotInvokableSkipped: 0,
        continuationsFailed: 0,
      });
      expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
      for (const decision of parkedDecisions) {
        expect(await storedMetadata(decision.id)).toMatchObject({ metadata: { continuationPending: true } });
      }

      // Repeated ticks write no wake rows and no WARN for the parked rows.
      await service.sweepExpired();
      await service.sweepExpired();
      for (const origin of parkedOrigins) expect(await wakeCount(origin.agentId)).toBe(0);
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), SKIP_MESSAGE);
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), SUMMARY_MESSAGE);
    });
  });

  it("pre-checks a broken reporting chain: no wake row, and the skip log is throttled", async () => {
    const warn = vi.spyOn(logger, "warn");
    const companyId = await seedCompany();
    const manager = await seedOriginAgent(companyId, "terminated");
    const orphan = await seedOriginAgent(companyId, "idle", manager.agentId);
    const orphanDecision = await seedPendingExpiredDecision(orphan);
    const service = decisionService(db, { wakeOriginAgent: realWake() });

    const first = await service.sweepExpired();
    const second = await service.sweepExpired();

    expect(first).toMatchObject({ continuationsDelivered: 0, continuationsNotInvokableSkipped: 1, continuationsFailed: 0 });
    expect(second).toMatchObject({ continuationsDelivered: 0, continuationsNotInvokableSkipped: 1, continuationsFailed: 0 });
    expect(await storedMetadata(orphanDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    expect(await wakeCount(orphan.agentId)).toBe(0);
    const skipLines = warn.mock.calls.filter(([, message]) => message === SKIP_MESSAGE);
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]![0]).toMatchObject({ decisionId: orphanDecision.id, reason: "manager_terminated" });
    expect(warn.mock.calls.filter(([, message]) => message === SUMMARY_MESSAGE)).toHaveLength(1);
  });

  it("isolates runEffects per resumed decision: one failure is logged and the rest still run", async () => {
    const error = vi.spyOn(logger, "error");
    const companyId = await seedCompany();
    const brokenOrigin = await seedOriginAgent(companyId, "idle");
    const healthyOrigin = await seedOriginAgent(companyId, "idle");
    const staleUpdatedAt = new Date(Date.now() - 10 * 60_000);
    const runningDecision = (origin: Origin, chosenOptionId: string, updatedAt: Date) => ({
      companyId: origin.companyId,
      originAgentId: origin.agentId,
      originIssueId: origin.issueId,
      originRunId: origin.runId,
      title: "Decided decision with effects in flight",
      body: "Body",
      options: [{ id: "ok", label: "OK", effects: [] }] as unknown as (typeof decisions.$inferInsert)["options"],
      status: "decided" as const,
      executionStatus: "running" as const,
      chosenOptionId,
      decidedByUserId: "owner-user",
      decidedAt: updatedAt,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      signedSpec: "unused-by-the-sweep",
      targetSnapshots: {},
      continuationPolicy: "wake_origin_agent" as const,
      metadata: { continuationPending: true },
      updatedAt,
    });
    // The broken row sorts first and its stored option is gone, so runEffects throws.
    const [broken] = await db.insert(decisions)
      .values(runningDecision(brokenOrigin, "missing-option", new Date(staleUpdatedAt.getTime() - 60_000))).returning();
    const [healthy] = await db.insert(decisions)
      .values(runningDecision(healthyOrigin, "ok", staleUpdatedAt)).returning();

    const result = await decisionService(db, { wakeOriginAgent: realWake() }).sweepExpired();

    expect(result).toMatchObject({ resumed: 1, resumeFailed: 1, continuationsDelivered: 1, continuationsFailed: 0 });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: broken!.id }),
      "decision effect recovery failed - decision stays running, continuing with the next one",
    );
    const [brokenRow] = await db.select({ executionStatus: decisions.executionStatus }).from(decisions).where(eq(decisions.id, broken!.id));
    expect(brokenRow).toMatchObject({ executionStatus: "running" });
    expect(await storedMetadata(healthy!.id)).toMatchObject({ metadata: { continuationPending: false } });
    expect(await wakeCount(healthyOrigin.agentId)).toBeGreaterThanOrEqual(1);
  });
});
