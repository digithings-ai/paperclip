import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres conversation notice tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * DIG-4948: a notice from another task must be able to reach a conversation
 * issue, and the conversation identity rule must still hold for real replies.
 */
describeEmbeddedPostgres("conversation notice", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let conversationAgentId: string;
  let posterAgentId: string;
  let otherAgentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase(
      "paperclip-conversation-notice-",
    );
    db = createDb(database.connectionString);
    companyId = randomUUID();
    conversationAgentId = randomUUID();
    posterAgentId = randomUUID();
    otherAgentId = randomUUID();
    await db
      .insert(authUsers)
      .values({
        id: "local-board",
        name: "Local Board",
        email: "local@paperclip.test",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(companies).values({
      id: companyId,
      name: "Notices",
      issuePrefix: "NOTE",
      defaultResponsibleUserId: "local-board",
    });
    await db.insert(agents).values([
      {
        id: conversationAgentId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "process",
      },
      {
        id: posterAgentId,
        companyId,
        name: "Coordinator",
        role: "coordinator",
        status: "idle",
        adapterType: "process",
      },
      {
        id: otherAgentId,
        companyId,
        name: "Reviewer",
        role: "reviewer",
        status: "idle",
        adapterType: "process",
      },
    ]);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-conversation-notice-secret";
  }, 90000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  const app = () => {
    const server = express();
    server.use(express.json());
    server.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    server.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    server.use(errorHandler);
    return server;
  };

  async function createConversation() {
    const chat = await issueService(db).create(companyId, {
      title: "Chat with CEO",
      conversationAgentId,
      conversationUserId: "local-board",
      assigneeAgentId: conversationAgentId,
      status: "in_review",
      conversationState: "waiting",
    });
    await db
      .update(issues)
      .set({ conversationSessionGeneration: 2 })
      .where(eq(issues.id, chat.id));
    return chat;
  }

  async function runFor(agentId: string, issueId: string, contextSnapshot: Record<string, unknown>) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        contextSnapshot,
      })
      .returning();
    return run!;
  }

  async function waitForWake(agentId: string, commentId: string) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId' = ${commentId}`,
          ),
        );
      if (rows.length) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  }

  it("accepts a notice from another task and wakes the conversation agent", async () => {
    const chat = await createConversation();
    const posterTask = await issueService(db).create(companyId, {
      title: "Sit-down packet",
      status: "in_progress",
      assigneeAgentId: posterAgentId,
    });
    const posterRun = await runFor(posterAgentId, posterTask.id, {
      issueId: posterTask.id,
      taskKey: posterTask.id,
      wakeReason: "issue_assigned",
    });
    const token = createLocalAgentJwt(
      posterAgentId,
      companyId,
      "process",
      posterRun.id,
    )!;

    const response = await request(app())
      .post(`/api/issues/${chat.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Sit-down packet ready: DIG-4947" });
    expect(response.status).toBe(201);
    expect(response.body.authorAgentId).toBe(posterAgentId);
    expect(response.body.authorType).toBe("agent");

    const [comment] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, response.body.id as string));
    expect(comment.authorAgentId).toBe(posterAgentId);
    expect(comment.createdByRunId).toBe(posterRun.id);
    // The notice is not a session boundary of the conversation.
    expect(comment.conversationSessionGeneration).toBeNull();

    // The notice must not settle the turn or move the conversation session.
    const [current] = await db.select().from(issues).where(eq(issues.id, chat.id));
    expect(current.conversationSessionGeneration).toBe(2);
    expect(current.conversationState).toBe("waiting");
    expect(current.status).toBe("in_review");

    // The conversation agent is woken for the notice.
    const wakes = await waitForWake(conversationAgentId, comment.id);
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes[0]!.contextSnapshot?.issueId).toBe(chat.id);
  });

  it("still refuses a stale reply from an earlier conversation session", async () => {
    const chat = await createConversation();
    const staleRun = await runFor(conversationAgentId, chat.id, {
      issueId: chat.id,
      taskKey: chat.id,
      conversationMode: true,
      conversationSessionGeneration: 1,
      wakeCommentId: randomUUID(),
    });
    const token = createLocalAgentJwt(
      conversationAgentId,
      companyId,
      "process",
      staleRun.id,
    )!;

    const response = await request(app())
      .post(`/api/issues/${chat.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Late reply from an earlier session" });
    expect(response.status).toBe(409);
    expect(String(response.body.error)).toMatch(/Conversation session changed/);
  });

  it("refuses a reply from a cancelled conversation turn", async () => {
    const chat = await createConversation();
    const cancelledRun = await runFor(conversationAgentId, chat.id, {
      issueId: chat.id,
      taskKey: chat.id,
      conversationMode: true,
      conversationSessionGeneration: 2,
      wakeCommentId: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled" })
      .where(eq(heartbeatRuns.id, cancelledRun.id));

    await expect(
      issueService(db).addComment(chat.id, "Reply from a cancelled turn", {
        agentId: conversationAgentId,
        runId: cancelledRun.id,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it("refuses a reply from a turn of another conversation", async () => {
    const chat = await createConversation();
    const otherChat = await issueService(db).create(companyId, {
      title: "Chat with somebody else",
      conversationAgentId: otherAgentId,
      conversationUserId: "local-board",
      assigneeAgentId: otherAgentId,
      status: "in_review",
      conversationState: "waiting",
    });
    const foreignTurn = await runFor(conversationAgentId, otherChat.id, {
      issueId: otherChat.id,
      taskKey: otherChat.id,
      conversationMode: true,
      conversationSessionGeneration: 2,
      wakeCommentId: randomUUID(),
    });
    const token = createLocalAgentJwt(
      conversationAgentId,
      companyId,
      "process",
      foreignTurn.id,
    )!;

    const response = await request(app())
      .post(`/api/issues/${chat.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Reply from another conversation" });
    expect(response.status).toBe(409);
    expect(String(response.body.error)).toMatch(/another conversation session/);
  });

  it("refuses a reply from a run of this conversation without a conversation marker", async () => {
    const chat = await createConversation();
    const unmarkedRun = await runFor(conversationAgentId, chat.id, {
      issueId: chat.id,
      taskKey: chat.id,
    });
    const token = createLocalAgentJwt(
      conversationAgentId,
      companyId,
      "process",
      unmarkedRun.id,
    )!;

    const response = await request(app())
      .post(`/api/issues/${chat.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Reply without a session marker" });
    expect(response.status).toBe(409);
    expect(String(response.body.error)).toMatch(/Conversation session changed/);
  });

  it("does not expire a pending card on the conversation issue", async () => {
    const chat = await createConversation();
    const posterTask = await issueService(db).create(companyId, {
      title: "Sit-down packet",
      status: "in_progress",
      assigneeAgentId: posterAgentId,
    });
    const posterRun = await runFor(posterAgentId, posterTask.id, {
      issueId: posterTask.id,
      taskKey: posterTask.id,
    });
    const token = createLocalAgentJwt(
      posterAgentId,
      companyId,
      "process",
      posterRun.id,
    )!;

    const [noticeCard] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId: chat.id,
        kind: "request_confirmation",
        title: "Approve the sit-down packet",
        payload: {
          version: 1,
          prompt: "Approve the sit-down packet?",
          supersedeOnUserComment: true,
        },
      })
      .returning();

    const response = await request(app())
      .post(`/api/issues/${chat.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Sit-down packet ready" });
    expect(response.status).toBe(201);

    // Control: the same card on another issue IS expired by a human comment.
    const controlTask = await issueService(db).create(companyId, {
      title: "Control task",
      status: "in_progress",
      assigneeAgentId: posterAgentId,
    });
    const [controlCard] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId: controlTask.id,
        kind: "request_confirmation",
        title: "Approve the control",
        payload: {
          version: 1,
          prompt: "Approve the control?",
          supersedeOnUserComment: true,
        },
      })
      .returning();
    await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      { id: controlTask.id, companyId, status: "in_progress" },
      {
        id: randomUUID(),
        createdAt: new Date(),
        authorUserId: "local-board",
        createdByRunId: null,
      },
      { agentId: null, userId: "local-board" },
    );

    const [afterNotice] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, noticeCard!.id));
    const [afterControl] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, controlCard!.id));
    expect(afterNotice!.status).toBe("pending");
    expect(afterNotice!.resolvedAt).toBeNull();
    expect(afterControl!.status).toBe("expired");
  });

  it("wakes the conversation agent with a wake context that carries no message body", async () => {
    // A fresh conversation agent: a wake for an agent that already has a run
    // is queued behind that run, which would make this test depend on the
    // order of the tests in this file.
    const freshAgentId = randomUUID();
    await db.insert(agents).values({
      id: freshAgentId,
      companyId,
      name: "Fresh CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
    });
    const chat = await issueService(db).create(companyId, {
      title: "Chat with the fresh CEO",
      conversationAgentId: freshAgentId,
      conversationUserId: "local-board",
      assigneeAgentId: freshAgentId,
      status: "in_review",
      conversationState: "waiting",
    });
    await db
      .update(issues)
      .set({ conversationSessionGeneration: 2 })
      .where(eq(issues.id, chat.id));
    const posterTask = await issueService(db).create(companyId, {
      title: "Sit-down packet",
      status: "in_progress",
      assigneeAgentId: posterAgentId,
    });
    const posterRun = await runFor(posterAgentId, posterTask.id, {
      issueId: posterTask.id,
      taskKey: posterTask.id,
    });
    const token = createLocalAgentJwt(
      posterAgentId,
      companyId,
      "process",
      posterRun.id,
    )!;

    const body = "Sit-down packet ready: the conversation agent has to read it";
    const response = await request(app())
      .post(`/api/issues/${chat.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body });
    expect(response.status).toBe(201);

    const wakes = await waitForWake(freshAgentId, response.body.id);
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes[0]!.contextSnapshot?.issueId).toBe(chat.id);
    // The wake carries ids only: the body stays in the comment.
    expect(JSON.stringify(wakes[0]!.contextSnapshot)).not.toContain(body);
    const [stored] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, response.body.id as string));
    expect(stored!.body).toBe(body);
  });
});
