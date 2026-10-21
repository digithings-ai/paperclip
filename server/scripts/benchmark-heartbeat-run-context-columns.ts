/**
 * Reproducible load probe for the heartbeat run context columns. Uses a
 * throwaway embedded PostgreSQL database that is built from the migration
 * chain. No production data and no model inference.
 * node --import tsx scripts/benchmark-heartbeat-run-context-columns.ts
 *   --target-rows 10000 --background-rows 60000
 *
 * The probe fills the table with runs that carry a large context snapshot. It
 * then reports the plan of the scheduler query, the plan of the liveness
 * query, and the size of the TOAST table with and without the slimming
 * trigger.
 */
import { randomBytes } from "node:crypto";
import { createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";

function option(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Expected a positive integer for ${name}`);
  return value;
}

const TARGET_ROWS = option("--target-rows", 10_000);
const BACKGROUND_ROWS = option("--background-rows", 60_000);
const AGENTS = 33;

/** Text that does not compress, so the measured sizes match the real ones. */
function noise(size: number): string {
  return randomBytes(Math.ceil(size / 3) * 4).toString("base64").slice(0, size);
}

function buildSnapshot(issueId: string) {
  const continuationMessages = Array.from({ length: 20 }, (_, i) => ({
    id: `comment-${i}`,
    authorId: `author-${i}`,
    authorType: "user",
    body: noise(950),
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    deleted: false,
    createdByRunId: null,
    sourceTrust: null,
  }));
  return {
    issueId,
    taskId: null,
    paperclipWake: {
      issue: { id: issueId, title: noise(3300), workMode: "standard" },
      comments: Array.from({ length: 12 }, (_, i) => ({ id: `comment-${i}`, body: noise(2500) })),
      executionContinuation: {
        messages: continuationMessages,
        objective: noise(2000),
        completedWork: [noise(2300)],
      },
      continuationSummary: { body: noise(2200) },
      commentIds: Array.from({ length: 12 }, (_, i) => `comment-${i}`),
      externalChatProvider: null,
      checkedOutByHarness: false,
      externalChatExecutionBound: false,
      reason: "scheduled_wake",
      recovery: { cause: "timeout" },
      truncated: false,
    },
    executionContinuation: {
      issueId,
      messages: continuationMessages,
      objective: noise(2000),
    },
    paperclipTaskMarkdown: noise(6000),
    paperclipIssue: { id: issueId, title: noise(3300) },
    projectId: "11111111-1111-1111-1111-111111111111",
  };
}

const scratch = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-benchmark-");
const db = createDb(scratch.connectionString);
const sql = db.$client;

async function run(query: string, params: unknown[] = []) {
  return sql.unsafe(query, params as never[]);
}

function planText(rows: unknown[]): string {
  return rows.map((r) => (r as Record<string, string>)["QUERY PLAN"]).join("\n");
}

try {
  const companyId = "22222222-2222-2222-2222-222222222222";
  const agentIds = Array.from(
    { length: AGENTS },
    (_, i) => `33333333-3333-3333-3333-3333333333${String(i).padStart(2, "0")}`,
  );
  const backgroundAgentId = "55555555-5555-5555-5555-555555555555";

  await run("insert into companies (id, name) values ($1, 'dig4762') on conflict do nothing", [companyId]);
  await run(
    "insert into agents (id, company_id, name, status) select unnest($2::uuid[]), $1, 'agent-' || gen_random_uuid()::text, 'active' on conflict do nothing",
    [companyId, [...agentIds, backgroundAgentId]],
  );

  const issueId = "44444444-4444-4444-4444-444444444444";
  const backgroundIssueId = "66666666-6666-6666-6666-666666666666";
  const snapshot = JSON.stringify(buildSnapshot(issueId));
  const backgroundSnapshot = JSON.stringify(buildSnapshot(backgroundIssueId));
  console.log(`target rows=${TARGET_ROWS} background rows=${BACKGROUND_ROWS} snapshot=${Buffer.byteLength(snapshot)} bytes`);

  const insertSql = `
    insert into heartbeat_runs (id, company_id, agent_id, status, invocation_source, context_snapshot, created_at, updated_at)
    select gen_random_uuid(), $1, $2::uuid, 'failed', 'automation', $3::jsonb,
      now() - (random() * interval '3 days'), now()
    from generate_series(1, $4)`;

  // The background rows make the table look like the live one: many runs, and
  // the scheduler filter selects a small part of them.
  await run(insertSql, [companyId, backgroundAgentId, backgroundSnapshot, BACKGROUND_ROWS]);
  console.log("background rows written");

  // The new behaviour: the trigger slims every row that is written.
  await run(insertSql, [companyId, agentIds[0], snapshot, TARGET_ROWS]);
  await run("vacuum analyze heartbeat_runs");
  console.log("target rows written");

  const sizeSql = `
    select
      (select count(*) from heartbeat_runs) as rows,
      (select avg(pg_column_size(context_snapshot))::bigint from heartbeat_runs where agent_id = $1) as avg_bytes,
      (select sum(pg_column_size(context_snapshot)) from heartbeat_runs where agent_id = $1) as total_bytes,
      pg_relation_size('heartbeat_runs') as heap_bytes,
      pg_total_relation_size('heartbeat_runs') - pg_relation_size('heartbeat_runs') as toast_bytes`;
  const slim = (await run(sizeSql, [agentIds[0]]))[0];
  console.log("slimmed:", JSON.stringify(slim));

  // The old behaviour: the same rows without the trigger.
  await run("alter table heartbeat_runs disable trigger heartbeat_runs_context_snapshot_sync_trg");
  await run(insertSql, [companyId, agentIds[1], snapshot, TARGET_ROWS]);
  await run("alter table heartbeat_runs enable trigger heartbeat_runs_context_snapshot_sync_trg");
  await run("vacuum analyze heartbeat_runs");
  const fat = (await run(sizeSql, [agentIds[1]]))[0];
  console.log("unslimmed:", JSON.stringify(fat));
  console.log("bytes per row, slimmed vs unslimmed:", Number(slim.avg_bytes), "vs", Number(fat.avg_bytes));

  // What the trigger kept and what it removed.
  const kept = (await run(
    `select
       context_issue_id,
       context_snapshot->'paperclipWake'->'comments' is not null as keeps_comments,
       context_snapshot->'paperclipWake'->'issue'->>'workMode' is not null as keeps_wake_issue,
       context_snapshot->'paperclipWake'->'continuationSummary' is not null as keeps_continuation_summary,
       context_snapshot->'paperclipTaskMarkdown' is not null as keeps_task_markdown,
       context_snapshot->'executionContinuation' is not null as keeps_top_level_continuation,
       context_snapshot->'executionContinuation'->'messages'->0->>'body' is null as drops_comment_body,
       context_snapshot->'executionContinuation'->'messages'->0->>'bodyDigest' is not null as keeps_comment_body_digest,
       context_snapshot->'paperclipWake'->>'reason' as keeps_reason,
       context_snapshot->'paperclipWake'->'recovery'->>'cause' as keeps_recovery_cause
     from heartbeat_runs where agent_id = $1 limit 1`,
    [agentIds[0]],
  ))[0];
  console.log("kept:", JSON.stringify(kept));

  console.log("indexes:", JSON.stringify(await run(
    "select indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) as size from pg_indexes where tablename in ('heartbeat_runs','heartbeat_run_events') and indexname like 'dt_perf%' or indexname = 'heartbeat_runs_company_context_issue_created_idx'",
  )));

  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const placeholders = agentIds.map((_, i) => `$${i + 2}`).join(", ");
  const sinceParam = `$${agentIds.length + 2}`;
  const params = [companyId, ...agentIds, since];

  // The scheduler query, as the code reads it now.
  const newQuery = `
    select agent_id, created_at, context_issue_id, context_task_id
    from heartbeat_runs
    where company_id = $1 and agent_id in (${placeholders}) and created_at > ${sinceParam}`;
  const oldQuery = `
    select agent_id, created_at, context_snapshot ->> 'issueId', context_snapshot ->> 'taskId'
    from heartbeat_runs
    where company_id = $1 and agent_id in (${placeholders}) and created_at > ${sinceParam}`;

  console.log("\n=== scheduler query with the real columns ===");
  console.log(planText(await run(`explain (analyze, buffers) ${newQuery}`, params)));

  console.log("\n=== scheduler query with the jsonb projection ===");
  console.log(planText(await run(`explain (analyze, buffers) ${oldQuery}`, params)));

  console.log("\n=== liveness query, context arm ===");
  console.log(planText(await run(
    `explain (analyze, buffers)
     select id from heartbeat_runs where company_id = $1 and context_issue_id = $2`,
    [companyId, issueId],
  )));

  // The liveness read of the code. The run ids of the activity arm are read
  // first, and the two arms are read with one statement over the run table.
  const activityRunIds = (await run(
    "select id from heartbeat_runs where company_id = $1 and context_issue_id = $2 limit 50",
    [companyId, issueId],
  )).map((row) => (row as unknown as { id: string }).id);
  const activityPlaceholders = activityRunIds.map((_, i) => `$${i + 3}`).join(", ");
  console.log("\n=== liveness query, both arms ===");
  console.log(planText(await run(
    `explain (analyze, buffers)
     select id from heartbeat_runs
     where company_id = $1 and (context_issue_id = $2 or id in (${activityPlaceholders}))`,
    [companyId, issueId, ...activityRunIds],
  )));

  console.log("\n=== exhaustion query ===");
  console.log(planText(await run(
    `explain (analyze, buffers)
     select distinct on (run_id) run_id, id, message
     from heartbeat_run_events
     where company_id = $1 and event_type = 'lifecycle' and message like 'Bounded retry exhausted%'
     order by run_id asc, id desc`,
    [companyId],
  )));
} finally {
  await scratch.cleanup();
}
