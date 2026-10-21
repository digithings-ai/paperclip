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
      issue: { id: ISSUE_ID, title: "a long issue title" },
      comments: [{ id: "comment-1", body: "a comment body" }],
      commentIds: ["comment-1"],
      executionContinuation: { messages: [{ role: "user", content: "a long message" }] },
      continuationSummary: { body: "a long continuation summary" },
      externalChatProvider: "chat-provider",
      checkedOutByHarness: true,
      externalChatExecutionBound: false,
      externalInteractionContinuation: { id: "interaction-1" },
      reason: "scheduled_wake",
      recovery: { cause: "timeout" },
      truncated: false,
    },
    executionContinuation: { messages: [{ role: "user", content: "a long message" }] },
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

describeEmbeddedPostgres("heartbeat run context columns", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("mirrors the issue and task ids into the new columns", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-columns-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`insert into companies (id, name) values (${COMPANY_ID}, 'context columns')`;
    await sql`insert into agents (id, company_id, name, status) values (${AGENT_ID}, ${COMPANY_ID}, 'agent', 'active')`;

    const runId = await insertRun(sql, fatSnapshot());
    const rows = await sql<
      { context_issue_id: string | null; context_task_id: string | null }[]
    >`select context_issue_id, context_task_id from heartbeat_runs where id = ${runId}`;
    expect(rows[0]!.context_issue_id).toBe(ISSUE_ID);
    expect(rows[0]!.context_task_id).toBe(TASK_ID);
  }, 60_000);

  it("slims the stored snapshot and keeps the proof fields of the wake payload", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-columns-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`insert into companies (id, name) values (${COMPANY_ID}, 'context columns')`;
    await sql`insert into agents (id, company_id, name, status) values (${AGENT_ID}, ${COMPANY_ID}, 'agent', 'active')`;

    const runId = await insertRun(sql, fatSnapshot());
    const rows = await sql<{ context_snapshot: Record<string, any> }[]>`
      select context_snapshot from heartbeat_runs where id = ${runId}
    `;
    const snapshot = rows[0]!.context_snapshot;

    // The rendered text must not be stored a second time.
    expect(snapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(snapshot.paperclipTaskMarkdownCompact).toBeUndefined();
    expect(snapshot.paperclipTaskMarkdownAssignment).toBeUndefined();
    expect(snapshot.paperclipTaskMarkdownAssignmentCompact).toBeUndefined();
    expect(snapshot.paperclipWakeComment).toBeUndefined();
    expect(snapshot.paperclipFreshSessionHandoffMarkdown).toBeUndefined();

    // The copies of the issue, of the continuation and of the summary are gone.
    expect(snapshot.paperclipWake.executionContinuation).toBeUndefined();
    expect(snapshot.paperclipWake.continuationSummary).toBeUndefined();
    expect(snapshot.paperclipWake.issue).toEqual({ id: ISSUE_ID });

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
  }, 60_000);

  it("slims an updated snapshot and refreshes the mirrored ids", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-columns-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`insert into companies (id, name) values (${COMPANY_ID}, 'context columns')`;
    await sql`insert into agents (id, company_id, name, status) values (${AGENT_ID}, ${COMPANY_ID}, 'agent', 'active')`;

    const runId = await insertRun(sql, fatSnapshot());
    const nextIssueId = "66666666-6666-6666-6666-666666666666";
    await sql`
      update heartbeat_runs
      set context_snapshot = ${sql.json({ issueId: nextIssueId, paperclipTaskMarkdown: "a long task markdown" } as never)}
      where id = ${runId}
    `;
    const rows = await sql<
      { context_issue_id: string | null; context_snapshot: Record<string, any> }[]
    >`select context_issue_id, context_snapshot from heartbeat_runs where id = ${runId}`;
    expect(rows[0]!.context_issue_id).toBe(nextIssueId);
    expect(rows[0]!.context_snapshot.paperclipTaskMarkdown).toBeUndefined();
  }, 60_000);

  it("creates the indexes of the scheduler and of the liveness read", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-columns-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where indexname in (
        'dt_perf_hr_company_agent_created_ctx_idx',
        'heartbeat_runs_company_context_issue_created_idx',
        'dt_perf_hre_company_type_run_msg_idx'
      )
    `;
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      "dt_perf_hr_company_agent_created_ctx_idx",
      "dt_perf_hre_company_type_run_msg_idx",
      "heartbeat_runs_company_context_issue_created_idx",
    ]);
  }, 60_000);
});
