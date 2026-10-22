import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

// DIG-2422: an issue-thread interaction records the creating run as sourceRunId.
// buildExecutionContinuation() later resolves that run SCOPED to the interaction's
// own issue (contextSnapshot->>'issueId' = issueId), so a sourceRunId bound to a
// different task can never resolve and the continuation dies at setup with
// continuation_source_context_missing. This suite pins that such a write is
// refused at POST, for every interaction kind, and that a run bound to the same
// task is still accepted -- a guard that rejected everything would pass the first
// half without the second.
const INTERACTION_KINDS = [
  {
    kind: "suggest_tasks",
    payload: { version: 1, tasks: [{ clientKey: "task-1", title: "Do the thing" }] },
  },
  {
    kind: "ask_user_questions",
    payload: {
      version: 1,
      questions: [
        { id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "target", label: "Target" }] },
      ],
    },
  },
  {
    kind: "request_confirmation",
    payload: { version: 1, prompt: "Proceed?", acceptLabel: "Yes", rejectLabel: "No" },
  },
  {
    kind: "request_checkbox_confirmation",
    payload: {
      version: 1,
      prompt: "Delete the selected files?",
      options: [{ id: "file-a", label: "a.txt" }, { id: "file-b", label: "b.txt" }],
    },
  },
  {
    kind: "request_item_verdicts",
    payload: {
      version: 1,
      prompt: "Review the generated artifacts.",
      items: [{ id: "api", label: "API route" }, { id: "docs", label: "Docs" }],
    },
  },
] as const;

describePg("issue-thread interaction sourceRunId is bound to the interaction's own issue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dig2422-scope-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const cleanup of [
      () => db.delete(issueThreadInteractions),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(agents),
      () => db.delete(companies),
    ]) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function boardApp(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: randomUUID(),
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const targetIssueId = randomUUID();
    const producerIssueId = randomUUID();
    const producerRunId = randomUUID();
    const targetRunId = randomUUID();
    const unboundRunId = randomUUID();
    const nativeOnlyRunId = randomUUID();
    const taskOnlyRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "DIG-2422 sourceRunId scope",
      issuePrefix: `D242${companyId.slice(0, 4)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Edge",
      role: "engineer",
      adapterType: "paperclip_runner",
    });
    await db.insert(issues).values([
      { id: targetIssueId, companyId, title: "Target task", status: "in_progress", assigneeAgentId: agentId },
      { id: producerIssueId, companyId, title: "Producer task", status: "in_progress", assigneeAgentId: agentId },
    ]);
    // producerRunId is bound to producerIssueId -- a DIFFERENT task than the one
    // the interaction is posted on. targetRunId is bound to targetIssueId.
    await db.insert(heartbeatRuns).values([
      {
        id: producerRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: producerIssueId },
        resultJson: { summary: "Work done on the other task." },
      },
      {
        id: targetRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: targetIssueId },
        resultJson: { summary: "Work done on this task." },
      },
      {
        // An agent-level wake carries no issue binding at all: no issueId, no
        // taskId and no nativeIssueId. This is the shape that let a card be
        // written with a sourceRunId that can never resolve for any issue.
        id: unboundRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { wakeSource: "on_demand", wakeTriggerDetail: "manual" },
        resultJson: { summary: "Manual board watch." },
      },
      {
        // A native run carries its issue in the nativeIssueId column and in no
        // snapshot key. The guard must accept it: the native continuation path
        // resolves the run through that column.
        id: nativeOnlyRunId,
        companyId,
        agentId,
        status: "running",
        nativeIssueId: targetIssueId,
        contextSnapshot: { wakeSource: "native", wakeTriggerDetail: "system" },
        resultJson: { summary: "Native run." },
      },
      {
        // A run whose only binding is the snapshot taskId. The guard must
        // accept it: readRunSourceIssueId() reads taskId as the source issue.
        id: taskOnlyRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { taskId: targetIssueId, wakeSource: "timer" },
        resultJson: { summary: "Timer run." },
      },
    ]);
    return {
      companyId,
      agentId,
      targetIssueId,
      producerIssueId,
      producerRunId,
      targetRunId,
      unboundRunId,
      nativeOnlyRunId,
      taskOnlyRunId,
    };
  }

  it.each(INTERACTION_KINDS)(
    "refuses a $kind whose sourceRunId names a run bound to another task",
    async ({ kind, payload }) => {
      const { companyId, targetIssueId, producerRunId } = await seed();
      const res = await request(boardApp(companyId))
        .post(`/api/issues/${targetIssueId}/interactions`)
        .send({ kind, payload, title: `DIG-2422 ${kind}`, sourceRunId: producerRunId });

      expect(res.status).toBe(422);
      expect(res.body?.error).toBe("sourceRunId must belong to the same issue");

      const rows = await db
        .select({ id: issueThreadInteractions.id, sourceRunId: issueThreadInteractions.sourceRunId })
        .from(issueThreadInteractions);
      // The refusal must not have half-written the interaction.
      expect(rows).toHaveLength(0);
    },
  );

  it.each(INTERACTION_KINDS)(
    "accepts a $kind whose sourceRunId names a run bound to this task",
    async ({ kind, payload }) => {
      const { companyId, targetIssueId, targetRunId } = await seed();
      const res = await request(boardApp(companyId))
        .post(`/api/issues/${targetIssueId}/interactions`)
        .send({ kind, payload, title: `DIG-2422 same-task ${kind}`, sourceRunId: targetRunId });

      expect(res.status).toBe(201);

      const rows = await db
        .select({ id: issueThreadInteractions.id, sourceRunId: issueThreadInteractions.sourceRunId })
        .from(issueThreadInteractions);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sourceRunId).toBe(targetRunId);
    },
  );

  it("still refuses an agent actor posting on a task its run is not bound to", async () => {
    const { companyId, agentId, targetIssueId, producerRunId } = await seed();
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId: producerRunId };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);

    const res = await request(testApp)
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "ask_user_questions",
        payload: INTERACTION_KINDS[1].payload,
        title: "DIG-2422 agent ownership",
      });

    expect(res.status).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");

    const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
    expect(rows).toHaveLength(0);
  });

  it("refuses a run whose nativeIssueId matches this task but snapshot.issueId does not", async () => {
    const { companyId, targetIssueId, producerIssueId, targetRunId } = await seed();
    await db
      .update(heartbeatRuns)
      .set({
        nativeIssueId: targetIssueId,
        contextSnapshot: { issueId: producerIssueId },
      })
      .where(eq(heartbeatRuns.id, targetRunId));

    const res = await request(boardApp(companyId))
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "DIG-2422 first-id match",
        sourceRunId: targetRunId,
      });

    expect(res.status).toBe(422);
    expect(res.body?.error).toBe("sourceRunId must belong to the same issue");

    const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
    expect(rows).toHaveLength(0);
  });

  it.each(INTERACTION_KINDS)(
    "refuses a $kind whose sourceRunId names a run that is bound to no issue at all",
    async ({ kind, payload }) => {
      const { companyId, targetIssueId, unboundRunId } = await seed();
      const res = await request(boardApp(companyId))
        .post(`/api/issues/${targetIssueId}/interactions`)
        .send({ kind, payload, title: `unbound source run ${kind}`, sourceRunId: unboundRunId });

      expect(res.status).toBe(422);
      expect(res.body?.error).toBe("sourceRunId must belong to the same issue");

      const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
      // The refusal must not have half-written the interaction.
      expect(rows).toHaveLength(0);
    },
  );

  it("accepts a board card that carries no sourceRunId", async () => {
    const { companyId, targetIssueId } = await seed();
    // A board actor may post a card without a source run. The route passes
    // req.body.sourceRunId ?? null for a non-agent actor, so the service sees
    // a null sourceRunId and the scope check must not run. This test pins the
    // PLACEMENT of the check: if the check is later moved out of the
    // `if (data.sourceRunId)` block, every board card without a source run
    // is refused and this test fails.
    const res = await request(boardApp(companyId))
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "board card without a source run",
      });

    expect(res.status).toBe(201);

    const rows = await db
      .select({ id: issueThreadInteractions.id, sourceRunId: issueThreadInteractions.sourceRunId })
      .from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceRunId).toBeNull();
  });

  it("accepts an agent actor's card after the checkout adoption records the run's source issue", async () => {
    const { companyId, agentId, targetIssueId, unboundRunId } = await seed();
    // The target task is in_progress, assigned to this agent and holds no
    // checkout, so the agent's own run adopts the checkout. Adoption is a
    // checkout by another name, so it records the run's source issue exactly
    // as the checkout route does. Without that step the run owns the issue
    // with no source issue, and the scope guard would refuse the card it
    // posts on the very issue it owns.
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId: unboundRunId };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);

    const res = await request(testApp)
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "adopted checkout records the source issue",
      });

    expect(res.status).toBe(201);

    const rows = await db
      .select({ id: issueThreadInteractions.id, sourceRunId: issueThreadInteractions.sourceRunId })
      .from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceRunId).toBe(unboundRunId);

    // The scope is recorded, so the continuation resolves the run scoped to
    // this issue instead of missing it.
    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, unboundRunId));
    expect((runs[0]!.contextSnapshot as Record<string, unknown>).issueId).toBe(targetIssueId);
  });

  it("refuses an agent actor whose own run is bound to no issue and holds no checkout", async () => {
    const { companyId, agentId, targetIssueId, unboundRunId } = await seed();
    // The issue is not in_progress, so the agent's run never adopts a
    // checkout and its scope is never recorded. This is the shape of the live
    // instances: a card minted by a scopeless run on an issue that run does
    // not own, so the card can never resolve a continuation.
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, targetIssueId));
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId: unboundRunId };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);

    const res = await request(testApp)
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "unbound source run without a checkout",
      });

    expect(res.status).toBe(422);
    expect(res.body?.error).toBe("sourceRunId must belong to the same issue");

    const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
    expect(rows).toHaveLength(0);
  });

  it("accepts a source run whose only binding is the nativeIssueId column", async () => {
    const { companyId, targetIssueId, nativeOnlyRunId } = await seed();
    const res = await request(boardApp(companyId))
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "native issue binding",
        sourceRunId: nativeOnlyRunId,
      });

    expect(res.status).toBe(201);

    const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
  });

  it("accepts a source run whose only binding is the snapshot taskId", async () => {
    const { companyId, targetIssueId, taskOnlyRunId } = await seed();
    const res = await request(boardApp(companyId))
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "task id binding",
        sourceRunId: taskOnlyRunId,
      });

    expect(res.status).toBe(201);

    const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
  });

  it("refuses a source run owned by another company", async () => {
    const { companyId, targetIssueId } = await seed();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other company",
      issuePrefix: `OTH${otherCompanyId.slice(0, 4)}`,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other",
      role: "engineer",
      adapterType: "paperclip_runner",
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: otherCompanyId,
      agentId: otherAgentId,
      status: "running",
      contextSnapshot: { issueId: targetIssueId },
    });

    const res = await request(boardApp(companyId))
      .post(`/api/issues/${targetIssueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: INTERACTION_KINDS[2].payload,
        title: "cross company source run",
        sourceRunId: otherRunId,
      });

    expect(res.status).toBe(422);
    expect(res.body?.error).toBe("sourceRunId must belong to the same company");

    const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions);
    expect(rows).toHaveLength(0);
  });
});
