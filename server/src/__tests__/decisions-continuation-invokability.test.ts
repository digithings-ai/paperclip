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
  async function seedOriginAgent(companyId: string, status: AgentStatus) {
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
  async function seedPendingExpiredDecision(origin: Origin) {
    const [row] = await db.insert(decisions).values({
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

      expect(result).toMatchObject({
        expired: 1,
        resumed: 0,
        continuationsDelivered: 0,
        continuationsNotInvokableSkipped: 2,
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
        expect.objectContaining({ decisionId: pendingExpired.id, agentId: parked.agentId, reason: status }),
        SKIP_MESSAGE,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ continuationsNotInvokableSkipped: 2 }),
        SUMMARY_MESSAGE,
      );

      // The startup call completes too, and the continuations stay pending
      // for a later sweep once the agent is invokable again.
      await expect(runStartupDecisionSweep({ decisions: service, logger })).resolves.toBe(true);
      expect(error).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("startup decision expiry sweep failed"));
      expect(await storedMetadata(pendingExpired.id)).toMatchObject({ metadata: { continuationPending: true } });
      expect(await storedMetadata(openPastExpiry.id)).toMatchObject({ metadata: { continuationPending: true } });
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

    expect(result).toMatchObject({
      expired: 1,
      continuationsDelivered: 2,
      continuationsNotInvokableSkipped: 1,
      continuationsFailed: 0,
    });
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
});
