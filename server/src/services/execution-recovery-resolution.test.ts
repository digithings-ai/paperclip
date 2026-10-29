import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { settleUnrecoverableExecutions, deliverRecoveryUnblockNotifications } from "./execution-recovery-resolution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-recovery resolution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution recovery resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-recovery-resolution-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** A legacy run that ended without a recorded cancellation request and whose
   * own reconciliation still has to be settled. */
  async function seedLegacyRunRequiringReconciliation(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    issueStatus: string;
    statusWrittenByRun?: string | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "cancelled",
      error: "Cancelled",
      errorCode: "cancelled",
      exitCode: 0,
      runtimeMode: "legacy",
      contextSnapshot: { issueId: input.issueId },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: input.issueId,
      companyId: input.companyId,
      title: "Run recorded a status on its own issue",
      status: input.issueStatus,
      priority: "medium",
      assigneeAgentId: input.agentId,
    });
    if (input.statusWrittenByRun) {
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: input.issueId,
        agentId: input.agentId,
        runId,
        details: { status: input.statusWrittenByRun },
      });
    }
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: input.companyId,
        sourceIssueId: input.issueId,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: input.agentId,
        cause: "legacy_execution_requires_reconciliation",
        status: "active",
        evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
        fingerprint: `legacy-execution:${runId}`,
        nextAction: "Inspect the stopped run.",
      })
      .returning();
    return { runId, actionId: action!.id };
  }

  it("keeps the review status the run recorded on its own issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const { actionId } = await seedLegacyRunRequiringReconciliation({
      companyId,
      agentId,
      issueId,
      issueStatus: "in_review",
      statusWrittenByRun: "in_review",
    });

    await settleUnrecoverableExecutions(db);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_review");
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "cancelled" });
    expect(action?.evidence).toMatchObject({ preservedIssueStatus: "in_review" });
    expect(action?.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    const settlements = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.execution_recovery_settled"),
        ),
      );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      action: "issue.execution_recovery_settled",
      details: { outcome: "cancelled", preservedIssueStatus: "in_review" },
    });
  });

  it("keeps the done status the run recorded on its own issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const { actionId } = await seedLegacyRunRequiringReconciliation({
      companyId,
      agentId,
      issueId,
      issueStatus: "done",
      statusWrittenByRun: "done",
    });

    await settleUnrecoverableExecutions(db);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("done");
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "cancelled" });
  });

  it("blocks an issue whose status the run did not record", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const { actionId } = await seedLegacyRunRequiringReconciliation({
      companyId,
      agentId,
      issueId,
      issueStatus: "in_progress",
      statusWrittenByRun: null,
    });

    await settleUnrecoverableExecutions(db);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    // The block names who can clear it and what clears it. Without this the
    // API's own blocked invariant is bypassed and the issue cannot be woken.
    expect(issue?.unblockDescriptor).toEqual({
      owner: { agentId },
      action: expect.stringContaining("Review the recorded work"),
    });
    expect(issue?.blockedTransitionAt).toBeInstanceOf(Date);
    expect(issue?.blockedOwnerNotifiedAt).toBeNull();
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
    expect(action?.evidence).not.toHaveProperty("preservedIssueStatus");
  });

  it("blocks an issue another run moved to review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const otherRunId = randomUUID();
    const { actionId } = await seedLegacyRunRequiringReconciliation({
      companyId,
      agentId,
      issueId,
      issueStatus: "in_review",
      statusWrittenByRun: null,
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      agentId,
      runId: otherRunId,
      details: { status: "in_review" },
    });

    await settleUnrecoverableExecutions(db);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.unblockDescriptor).toEqual({
      owner: { agentId },
      action: expect.stringContaining("Review the recorded work"),
    });
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
  });

  it("delivers one unblock wake for a recovery block", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const { actionId } = await seedLegacyRunRequiringReconciliation({
      companyId,
      agentId,
      issueId,
      issueStatus: "in_progress",
      statusWrittenByRun: null,
    });

    await settleUnrecoverableExecutions(db);

    const [before] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(before?.evidence).toMatchObject({ unblockDelivery: "pending" });
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked?.blockedOwnerNotifiedAt).toBeNull();

    const wakes: Array<{ agentId: string; options: any }> = [];
    const wake = async (agentId: string, options: any) => {
      wakes.push({ agentId, options });
      return { id: "unblock-wake-run" };
    };
    await deliverRecoveryUnblockNotifications(db, wake);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.options).toMatchObject({
      source: "automation",
      triggerDetail: "system",
      reason: "issue_unblock_requested",
      payload: { issueId, action: expect.stringContaining("Review the recorded work") },
    });
    const [notified] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(notified?.blockedOwnerNotifiedAt).toBeInstanceOf(Date);
    const [delivered] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(delivered?.evidence).toMatchObject({ unblockDelivery: "delivered" });

    // A second sweep must not wake the same hold again.
    await deliverRecoveryUnblockNotifications(db, wake);
    expect(wakes).toHaveLength(1);
  });

  it("keeps the unblock descriptor an already-blocked issue carries", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const existingDescriptor = {
      owner: { userId: "responsible-user" },
      action: "Approve the exception",
    };
    const { actionId } = await seedLegacyRunRequiringReconciliation({
      companyId,
      agentId,
      issueId,
      issueStatus: "in_progress",
      statusWrittenByRun: null,
    });
    await db.update(issues).set({
      status: "blocked",
      unblockDescriptor: existingDescriptor,
      blockedTransitionAt: new Date("2026-10-01T00:00:00.000Z"),
    }).where(eq(issues.id, issueId));

    await settleUnrecoverableExecutions(db);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.unblockDescriptor).toEqual(existingDescriptor);
    expect(issue?.blockedTransitionAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
  });
});
