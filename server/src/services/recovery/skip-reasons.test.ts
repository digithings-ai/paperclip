import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../../__tests__/helpers/truncate-with-deadlock-retry.js";
import { recoveryService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping recovery skip-reasons tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery skip ladder reason codes (DIG-4064)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async () => null);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skip-reasons-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    enqueueWakeup.mockReset();
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
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
      name: "SkipReasons",
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

  function skippedTotal(result: { skipped: number; skippedReasons: Record<string, number> }) {
    return Object.values(result.skippedReasons).reduce((a, b) => a + b, 0);
  }

  it("reason-codes an in_review issue with no participant state and keeps skipped == sum(reasons)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Review with no participant",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.skippedReasons).toBeDefined();
    expect(result.skipped).toBe(1);
    expect(skippedTotal(result)).toBe(result.skipped);
    expect(result.skippedReasons["review_participant_or_state_missing"]).toBe(1);
  });

  it("keeps skipped == sum(reasons) on a quiet board with no candidates", async () => {
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.skippedReasons).toBeDefined();
    expect(skippedTotal(result)).toBe(result.skipped);
    expect(result.skipped).toBe(0);
  });
});
