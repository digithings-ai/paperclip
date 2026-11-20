import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../../__tests__/helpers/truncate-with-deadlock-retry.js";
import { LEGACY_RECOVERY_CAUSE } from "../legacy-execution-recovery.js";
import { recoveryService } from "./service.js";

// DIG-4075 / DIG-2152 design item 4. The legacy terminalize loop is a
// board-owned `active_run_watchdog` at `maxAttempts`: the recovery sweep's
// `ownerType === "board"` rung matches it on every tick, so the issue never
// reaches a decision. And a `routine_execution` issue skipped for any reason
// that does not mean "somebody competent owns this" is a silent abandonment.
// Both must resolve to `blocked`.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routine-execution stranded tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Past the Leaf 2 liveness grace window (5 min), so a signal-free issue reads
// stranded rather than live.
const PAST_GRACE_MS = 30 * 60 * 1000;

describeEmbeddedPostgres("routine execution stranded escalation (DIG-4075)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async () => null);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-stranded-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    enqueueWakeup.mockReset();
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
          "issue_recovery_actions",
          "company_skills",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `,
      { attempts: 10, delayMs: () => 100 },
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RoutineStranded",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRoutineExecutionIssue(input: {
    companyId: string;
    agentId: string;
    status?: "todo" | "in_progress" | "in_review";
    originKind?: string;
    updatedAt?: Date;
    executionRunId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Routine execution",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      assigneeUserId: null,
      originKind: input.originKind ?? "routine_execution",
      updatedAt: input.updatedAt ?? new Date(Date.now() - PAST_GRACE_MS),
      executionRunId: input.executionRunId ?? null,
    });
    return issueId;
  }

  // The exact shape the legacy terminalize loop leaves behind: a board-owned
  // watchdog that has spent its automatic budget (`maxAttempts`).
  async function seedExhaustedBoardWatchdog(input: {
    companyId: string;
    issueId: string;
    agentId: string;
  }) {
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      kind: "active_run_watchdog",
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
      returnOwnerAgentId: input.agentId,
      cause: LEGACY_RECOVERY_CAUSE,
      fingerprint: `legacy-execution:${randomUUID()}`,
      evidence: {
        recoveryBudget: {
          state: "exhausted",
          attemptsUsed: 3,
          maxAttempts: 3,
          exhaustedAt: new Date().toISOString(),
          cause: LEGACY_RECOVERY_CAUSE,
        },
      },
      nextAction: "Board operator: inspect the stopped provider.",
      attemptCount: 3,
      maxAttempts: 3,
      outcome: "escalated",
    });
  }

  function skippedTotal(result: { skipped: number; skippedReasons: Record<string, number> }) {
    return Object.values(result.skippedReasons).reduce((a, b) => a + b, 0);
  }

  async function readIssueStatus(issueId: string) {
    const [row] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row?.status ?? null;
  }

  async function readRecoveryCause(issueId: string) {
    const rows = await db
      .select({ cause: issueRecoveryActions.cause })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return rows.map((row) => row.cause);
  }

  async function readNoticeTitles(issueId: string) {
    const rows = await db
      .select({ presentation: issueComments.presentation })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows
      .map((row) => (row.presentation as { title?: string } | null)?.title ?? null)
      .filter((title): title is string => Boolean(title));
  }

  async function readNoticeBodies(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.map((row) => row.body ?? "").filter((body) => body.length > 0);
  }

  async function readActivityRecoveryCauses(issueId: string) {
    const rows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    return rows
      .map((row) => (row.details as { recoveryCause?: string } | null)?.recoveryCause ?? null)
      .filter((cause): cause is string => Boolean(cause));
  }

  it("escalates a routine execution whose board watchdog reached maxAttempts with no live path", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedRoutineExecutionIssue({ companyId, agentId });
    await seedExhaustedBoardWatchdog({ companyId, issueId, agentId });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    // The loop is closed: the issue is decided, not re-skipped.
    expect(await readIssueStatus(issueId)).toBe("blocked");
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toContain(issueId);
    expect(skippedTotal(result)).toBe(result.skipped);

    // First-class reason: the escalation is logged with the stranded cause and
    // posts the routine-execution notice naming the skip reason that abandoned
    // it.
    expect(await readActivityRecoveryCauses(issueId)).toContain("routine_execution_stranded");
    expect(await readNoticeTitles(issueId)).toContain("Routine execution stranded");
    expect(
      (await readNoticeBodies(issueId)).some((body) =>
        body.includes("board_owned_recovery_action"),
      ),
    ).toBe(true);
  });

  it("does not escalate a non-routine_execution issue whose board watchdog reached maxAttempts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      originKind: "manual",
    });
    await seedExhaustedBoardWatchdog({ companyId, issueId, agentId });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(await readIssueStatus(issueId)).toBe("in_progress");
    expect(result.escalated).toBe(0);
    expect(result.skippedReasons["board_owned_recovery_action"]).toBe(1);
    expect(skippedTotal(result)).toBe(result.skipped);
  });

  it("keeps a routine execution with a live execution path skipped, not blocked", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedRoutineExecutionIssue({ companyId, agentId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, updatedAt: new Date(Date.now() - PAST_GRACE_MS) })
      .where(eq(issues.id, issueId));
    await seedExhaustedBoardWatchdog({ companyId, issueId, agentId });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(await readIssueStatus(issueId)).toBe("in_progress");
    expect(result.escalated).toBe(0);
    expect(result.skippedReasons["active_execution_path"]).toBe(1);
    expect(skippedTotal(result)).toBe(result.skipped);
  });

  it("holds a board watchdog escalation inside the Leaf 2 liveness grace window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      updatedAt: new Date(),
    });
    await seedExhaustedBoardWatchdog({ companyId, issueId, agentId });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(await readIssueStatus(issueId)).toBe("in_progress");
    expect(result.escalated).toBe(0);
    expect(result.skippedReasons["board_owned_recovery_action"]).toBe(1);
    expect(skippedTotal(result)).toBe(result.skipped);
  });

  it("resolves a routine execution skipped for a non-owner reason to blocked", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedRoutineExecutionIssue({ companyId, agentId });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(await readIssueStatus(issueId)).toBe("blocked");
    expect(result.escalated).toBe(1);
    expect(await readRecoveryCause(issueId)).toContain("routine_execution_stranded");
    const notice = await readNoticeTitles(issueId);
    expect(notice).toContain("Routine execution stranded");
    expect(skippedTotal(result)).toBe(result.skipped);
  });

  it("leaves a non-routine_execution issue on the same non-owner skip exactly as before", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedRoutineExecutionIssue({
      companyId,
      agentId,
      originKind: "manual",
    });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(await readIssueStatus(issueId)).toBe("in_progress");
    expect(result.escalated).toBe(0);
    expect(result.skippedReasons["no_run_no_checkout"]).toBe(1);
    expect(skippedTotal(result)).toBe(result.skipped);
  });
});
