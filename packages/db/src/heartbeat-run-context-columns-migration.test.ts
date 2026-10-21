import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const COMPANY_ID = "22222222-2222-2222-2222-222222222222";
const AGENT_ID = "33333333-3333-3333-3333-333333333333";
const ISSUE_ID = "44444444-4444-4444-4444-444444444444";
const TASK_ID = "55555555-5555-5555-5555-555555555555";

function fatSnapshot() {
  return {
    issueId: ISSUE_ID,
    taskId: TASK_ID,
    paperclipWake: {
      issue: { id: ISSUE_ID, title: "a long issue title", workMode: "standard" },
      comments: [{ id: "comment-1", body: "a comment body" }],
      commentIds: ["comment-1"],
      executionContinuation: { messages: [{ role: "user", content: "a long message" }] },
      continuationSummary: { body: "a long continuation summary", bodyTruncated: false },
      externalChatProvider: "chat-provider",
      checkedOutByHarness: true,
      externalChatExecutionBound: false,
      externalInteractionContinuation: { id: "interaction-1" },
      reason: "scheduled_wake",
      recovery: { cause: "timeout" },
      truncated: false,
    },
    executionContinuation: {
      issueId: ISSUE_ID,
      objective: "a long objective",
      messages: [
        {
          id: "comment-1",
          authorId: "author-1",
          authorType: "user",
          body: "a long comment body",
          createdAt: "2026-10-21T00:00:00.000Z",
          updatedAt: "2026-10-21T00:00:00.000Z",
          deleted: false,
          createdByRunId: null,
          sourceTrust: null,
        },
      ],
    },
    paperclipTaskMarkdown: "a long task markdown",
    paperclipTaskMarkdownCompact: "a long task markdown",
    paperclipTaskMarkdownAssignment: "a long task markdown",
    paperclipTaskMarkdownAssignmentCompact: "a long task markdown",
    paperclipWakeComment: "a long wake comment",
    paperclipFreshSessionHandoffMarkdown: "a long handoff",
    paperclipIssue: { id: ISSUE_ID, title: "a long issue title" },
  };
}

async function insertRun(sql: ReturnType<typeof postgres>, contextSnapshot: unknown) {
  const rows = await sql<{ id: string }[]>`
    insert into heartbeat_runs (company_id, agent_id, status, invocation_source, context_snapshot)
    values (${COMPANY_ID}, ${AGENT_ID}, 'failed', 'automation', ${sql.json(contextSnapshot as never)})
    returning id
  `;
  return rows[0]!.id;
}

async function startDatabase(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1 });
  cleanups.push(async () => sql.end());
  await sql`insert into companies (id, name) values (${COMPANY_ID}, 'context columns')`;
  await sql`insert into agents (id, company_id, name, status) values (${AGENT_ID}, ${COMPANY_ID}, 'agent', 'active')`;
  return sql;
}

describeEmbeddedPostgres("heartbeat run context columns", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("mirrors the issue and task ids into the new columns", async () => {
    const sql = await startDatabase("paperclip-heartbeat-context-columns-");

    const runId = await insertRun(sql, fatSnapshot());
    const rows = await sql<
      { context_issue_id: string | null; context_task_id: string | null }[]
    >`select context_issue_id, context_task_id from heartbeat_runs where id = ${runId}`;
    expect(rows[0]!.context_issue_id).toBe(ISSUE_ID);
    expect(rows[0]!.context_task_id).toBe(TASK_ID);
  }, 60_000);

  it("keeps the stored snapshot and stores a digest of the body of a comment", async () => {
    const sql = await startDatabase("paperclip-heartbeat-context-columns-");

    const runId = await insertRun(sql, fatSnapshot());
    const rows = await sql<{ context_snapshot: Record<string, any> }[]>`
      select context_snapshot from heartbeat_runs where id = ${runId}
    `;
    const snapshot = rows[0]!.context_snapshot;

    // The stored snapshot keeps every key. The rendered text is read back by
    // the code that reads a stored run.
    expect(snapshot.paperclipTaskMarkdown).toBe("a long task markdown");
    expect(snapshot.paperclipTaskMarkdownCompact).toBe("a long task markdown");
    expect(snapshot.paperclipTaskMarkdownAssignment).toBe("a long task markdown");
    expect(snapshot.paperclipTaskMarkdownAssignmentCompact).toBe("a long task markdown");
    expect(snapshot.paperclipWakeComment).toBe("a long wake comment");
    expect(snapshot.paperclipFreshSessionHandoffMarkdown).toBe("a long handoff");

    // The wake payload stays as it is. The external chat contract reads the
    // work mode and the summary from the stored wake payload.
    expect(snapshot.paperclipWake.issue).toEqual({
      id: ISSUE_ID,
      title: "a long issue title",
      workMode: "standard",
    });
    expect(snapshot.paperclipWake.continuationSummary).toEqual({
      body: "a long continuation summary",
      bodyTruncated: false,
    });
    expect(snapshot.paperclipWake.executionContinuation).toBeDefined();

    // The proof fields of the wake payload stay.
    expect(snapshot.paperclipWake.comments).toHaveLength(1);
    expect(snapshot.paperclipWake.commentIds).toEqual(["comment-1"]);
    expect(snapshot.paperclipWake.externalChatProvider).toBe("chat-provider");
    expect(snapshot.paperclipWake.checkedOutByHarness).toBe(true);
    expect(snapshot.paperclipWake.externalChatExecutionBound).toBe(false);
    expect(snapshot.paperclipWake.externalInteractionContinuation).toEqual({ id: "interaction-1" });
    expect(snapshot.paperclipWake.reason).toBe("scheduled_wake");
    expect(snapshot.paperclipWake.recovery).toEqual({ cause: "timeout" });

    // The continuation of the run itself stays. The next run reads it.
    expect(snapshot.executionContinuation).toBeDefined();
    expect(snapshot.executionContinuation.objective).toBe("a long objective");

    // The body of a comment is stored as a digest. The next run compares the
    // digest with the body of the comment.
    const message = snapshot.executionContinuation.messages[0];
    expect(message.body).toBeUndefined();
    expect(message.id).toBe("comment-1");
    expect(message.updatedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(message.bodyDigest).toBe(
      createHash("sha256").update("a long comment body", "utf8").digest("hex"),
    );
  }, 60_000);

  it("refreshes the mirrored ids when the snapshot changes", async () => {
    const sql = await startDatabase("paperclip-heartbeat-context-columns-");

    const runId = await insertRun(sql, fatSnapshot());
    const nextIssueId = "66666666-6666-6666-6666-666666666666";
    await sql`
      update heartbeat_runs
      set context_snapshot = ${sql.json({ issueId: nextIssueId, paperclipTaskMarkdown: "a long task markdown" } as never)}
      where id = ${runId}
    `;
    const rows = await sql<
      { context_issue_id: string | null; context_task_id: string | null; context_snapshot: Record<string, any> }[]
    >`select context_issue_id, context_task_id, context_snapshot from heartbeat_runs where id = ${runId}`;
    expect(rows[0]!.context_issue_id).toBe(nextIssueId);
    // The new snapshot names no task. The old task id must not stay.
    expect(rows[0]!.context_task_id).toBeNull();
    expect(rows[0]!.context_snapshot.paperclipTaskMarkdown).toBe("a long task markdown");
  }, 60_000);

  it("keeps an empty issue id, so the read paths see the same value", async () => {
    const sql = await startDatabase("paperclip-heartbeat-context-columns-");

    const runId = await insertRun(sql, { issueId: "", taskId: TASK_ID });
    const rows = await sql<
      { context_issue_id: string | null; context_task_id: string | null }[]
    >`select context_issue_id, context_task_id from heartbeat_runs where id = ${runId}`;
    // The old read of the snapshot returned an empty string. The read paths
    // use the value as it is, so the mirrored value must be the same.
    expect(rows[0]!.context_issue_id).toBe("");
    expect(rows[0]!.context_task_id).toBe(TASK_ID);
  }, 60_000);

  it("clears the mirrored ids when the snapshot is not a JSON object", async () => {
    const sql = await startDatabase("paperclip-heartbeat-context-columns-");

    const runId = await insertRun(sql, fatSnapshot());
    // A JSON null, an array, and a scalar are valid jsonb values. The write
    // must not fail and the mirrored ids must be empty.
    for (const value of [null, [1, 2, 3], "a string"]) {
      await sql`
        update heartbeat_runs
        set context_snapshot = ${sql.json(value as never)}
        where id = ${runId}
      `;
      const rows = await sql<
        { context_issue_id: string | null; context_task_id: string | null }[]
      >`select context_issue_id, context_task_id from heartbeat_runs where id = ${runId}`;
      expect(rows[0]!.context_issue_id).toBeNull();
      expect(rows[0]!.context_task_id).toBeNull();
    }
  }, 60_000);

  it("creates the indexes of the scheduler and of the liveness read", async () => {
    const sql = await startDatabase("paperclip-heartbeat-context-columns-");

    const rows = await sql<{ name: string; definition: string }[]>`
      select c.relname as name, pg_get_indexdef(i.indexrelid) as definition
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname in (
        'dt_perf_hr_company_agent_created_ctx_idx',
        'heartbeat_runs_company_context_issue_created_idx',
        'dt_perf_hre_company_type_run_msg_idx'
      )
    `;
    const definitions = new Map(rows.map((row) => [row.name, row.definition]));
    expect([...definitions.keys()].sort()).toEqual([
      "dt_perf_hr_company_agent_created_ctx_idx",
      "dt_perf_hre_company_type_run_msg_idx",
      "heartbeat_runs_company_context_issue_created_idx",
    ]);

    // The scheduler index reads the real columns. It must not read the
    // snapshot, because the snapshot is a large toasted document.
    const schedulerIndex = definitions.get("dt_perf_hr_company_agent_created_ctx_idx")!;
    expect(schedulerIndex).toContain("context_issue_id");
    expect(schedulerIndex).toContain("context_task_id");
    expect(schedulerIndex).toContain("created_at DESC");
    expect(schedulerIndex).not.toContain("context_snapshot");

    const livenessIndex = definitions.get("heartbeat_runs_company_context_issue_created_idx")!;
    expect(livenessIndex).toContain("context_issue_id");
    expect(livenessIndex).toContain("created_at DESC");
    expect(livenessIndex).not.toContain("context_snapshot");

    const exhaustionIndex = definitions.get("dt_perf_hre_company_type_run_msg_idx")!;
    expect(exhaustionIndex).toContain("event_type");
    expect(exhaustionIndex).toContain("id DESC");
    expect(exhaustionIndex).toContain("Bounded retry exhausted%");
  }, 60_000);
});
