import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentSessionGoalActions,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  executionWorkspaces,
  issueRecoveryActions,
  projectWorkspaces,
  projects,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
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
    summary: "Acknowledged goal recovery.",
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
import { runningProcesses } from "../adapters/index.ts";
import { logger } from "../middleware/logger.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session-goal recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SKIP_MESSAGE = "heartbeat recovery skipped wake for non-invokable agent";
const SUMMARY_MESSAGE = "heartbeat recovery pass skipped non-invokable agents";

describeEmbeddedPostgres("session-goal recovery skips non-invokable agents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-session-goal-invokability-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    vi.restoreAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(agentSessionGoalActions);
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
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
  async function seedAgentWithGoalSession(
    companyId: string,
    status: "idle" | "paused" | "terminated" | "pending_approval",
  ) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    issueNumber += 1;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Goal agent ${status}`,
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
      title: "Synthetic goal issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber,
      identifier: `GOAL-${issueNumber}`,
    });
    const [session] = await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "test_adapter",
      taskKey: issueId,
      goalJson: { objective: "Keep going.", status: "active" },
      goalStatus: "active",
      goalDesiredState: "active",
      goalRevision: 1,
    }).returning();
    return { agentId, issueId, sessionId: session!.id };
  }

  async function wakeCount(agentId: string) {
    const rows = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return rows.length;
  }

  describe("recoverActiveSessionGoals", () => {
    for (const status of ["paused", "terminated", "pending_approval"] as const) {
      it(`skips a ${status} agent with an active goal, logs it, and completes`, async () => {
        const warn = vi.spyOn(logger, "warn");
        const companyId = await seedCompany();
        const parked = await seedAgentWithGoalSession(companyId, status);

        const result = await heartbeatService(db).recoverActiveSessionGoals();

        expect(result).toMatchObject({ scanned: 1, enqueued: 0, notInvokableSkipped: 1 });
        expect(await wakeCount(parked.agentId)).toBe(0);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: parked.agentId,
            agentStatus: status,
            reason: status,
            sessionId: parked.sessionId,
            pass: "session_goal_recovery",
          }),
          SKIP_MESSAGE,
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ notInvokableSkipped: 1, pass: "session_goal_recovery" }),
          SUMMARY_MESSAGE,
        );
      });
    }

    it("still wakes an active agent in the same pass as a paused one", async () => {
      const companyId = await seedCompany();
      const parked = await seedAgentWithGoalSession(companyId, "paused");
      const active = await seedAgentWithGoalSession(companyId, "idle");

      const result = await heartbeatService(db).recoverActiveSessionGoals();

      expect(result).toMatchObject({ scanned: 2, enqueued: 1, notInvokableSkipped: 1 });
      expect(await wakeCount(parked.agentId)).toBe(0);
      expect(await wakeCount(active.agentId)).toBe(1);
    });
  });

  describe("recoverPendingSessionGoalActions", () => {
    async function seedPendingAction(companyId: string, sessionId: string) {
      const requestId = randomUUID();
      const [action] = await db.insert(agentSessionGoalActions).values({
        companyId,
        sessionId,
        requestId,
        action: "pause",
        payloadJson: { requestId, action: "pause" },
        status: "pending",
      }).returning();
      return action!;
    }

    it("skips a paused agent's pending goal action, keeps it pending, logs it, and completes", async () => {
      const warn = vi.spyOn(logger, "warn");
      const companyId = await seedCompany();
      const parked = await seedAgentWithGoalSession(companyId, "paused");
      const action = await seedPendingAction(companyId, parked.sessionId);

      const result = await heartbeatService(db).recoverPendingSessionGoalActions();

      expect(result).toMatchObject({ scanned: 1, enqueued: 0, invalid: 0, notInvokableSkipped: 1 });
      expect(await wakeCount(parked.agentId)).toBe(0);
      const [stored] = await db
        .select({ status: agentSessionGoalActions.status })
        .from(agentSessionGoalActions)
        .where(eq(agentSessionGoalActions.id, action.id));
      expect(stored?.status).toBe("pending");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: parked.agentId,
          agentStatus: "paused",
          reason: "paused",
          actionId: action.id,
          pass: "session_goal_action_recovery",
        }),
        SKIP_MESSAGE,
      );
    });

    it("still delivers an active agent's pending goal action in the same pass", async () => {
      const companyId = await seedCompany();
      const parked = await seedAgentWithGoalSession(companyId, "paused");
      const active = await seedAgentWithGoalSession(companyId, "idle");
      await seedPendingAction(companyId, parked.sessionId);
      await seedPendingAction(companyId, active.sessionId);

      const result = await heartbeatService(db).recoverPendingSessionGoalActions();

      expect(result).toMatchObject({ scanned: 2, enqueued: 1, notInvokableSkipped: 1 });
      expect(await wakeCount(parked.agentId)).toBe(0);
      expect(await wakeCount(active.agentId)).toBe(1);
    });
  });
});
