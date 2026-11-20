import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSchedulerPlan,
  extractSchedulerPlan,
  REQUIRED_INDEX,
  SCHEDULER_SECTION_HEADER,
} from "../check-heartbeat-run-context-columns-plan.mjs";

const INDEX_ONLY_PLAN = `Index Only Scan using ${REQUIRED_INDEX} on heartbeat_runs
  Index Cond: ((company_id = '22222222-2222-2222-2222-222222222222'::uuid) AND (created_at > '2026-10-19 00:00:00+00'::timestamp with time zone) AND (agent_id = ANY (ARRAY['33333333333333333333333333333333'::uuid])))
  Heap Fetches: 0
  Buffers: shared hit=1 read=279
  Execution Time: 13.337 ms`;

const BITMAP_HEAP_PLAN = `Bitmap Heap Scan on heartbeat_runs
  Recheck Cond: ((created_at > '2026-10-19 00:00:00+00'::timestamp with time zone) AND (company_id = '22222222-2222-2222-2222-222222222222'::uuid))
  Rows Removed by Index Recheck: 0
  Filter: (agent_id = ANY (ARRAY['33333333333333333333333333333333'::uuid]))
  Buffers: shared hit=343703 read=189931
  Execution Time: 615.134 ms`;

function benchmarkOutput(schedulerPlan, jsonbPlan) {
  return [
    "target rows=2000 background rows=4000 snapshot=55123 bytes",
    "background rows written",
    "target rows written",
    "",
    SCHEDULER_SECTION_HEADER,
    schedulerPlan,
    "",
    "=== scheduler query with the jsonb projection ===",
    jsonbPlan,
    "",
    "=== liveness query, context arm ===",
    "Index Scan using heartbeat_runs_company_context_issue_created_idx on heartbeat_runs",
    "  Heap Fetches: 3",
    "",
  ].join("\n");
}

test("the index-only plan passes the check", () => {
  const result = checkSchedulerPlan(INDEX_ONLY_PLAN);
  assert.equal(result.ok, true, result.problems.join(" "));
  assert.deepEqual(result.problems, []);
});

test("the plan with a bitmap heap scan fails the check", () => {
  const result = checkSchedulerPlan(BITMAP_HEAP_PLAN);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.match(result.problems.join(" "), /index-only scan on dt_perf_hr_company_agent_created_ctx_idx/);
  assert.match(result.problems.join(" "), /bitmap heap scan on heartbeat_runs/);
});

test("a plan that fetches heap rows fails the check", () => {
  const plan = INDEX_ONLY_PLAN.replace("Heap Fetches: 0", "Heap Fetches: 12");
  const result = checkSchedulerPlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /read rows from the heap/);
});

test("the check reads only the plan of the scheduler query", () => {
  const output = benchmarkOutput(INDEX_ONLY_PLAN, BITMAP_HEAP_PLAN);
  const plan = extractSchedulerPlan(output);
  assert.ok(plan);
  assert.match(plan, /Index Only Scan using dt_perf_hr_company_agent_created_ctx_idx on heartbeat_runs/);
  assert.doesNotMatch(plan, /Bitmap Heap Scan/);
  const result = checkSchedulerPlan(plan);
  assert.equal(result.ok, true, result.problems.join(" "));
});

test("the check fails when the scheduler query uses the jsonb projection", () => {
  const output = benchmarkOutput(BITMAP_HEAP_PLAN, INDEX_ONLY_PLAN);
  const result = checkSchedulerPlan(extractSchedulerPlan(output));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /bitmap heap scan on heartbeat_runs/);
});

test("the check fails when the benchmark prints no scheduler plan", () => {
  assert.equal(extractSchedulerPlan("target rows=2000 background rows=4000"), null);
  const result = checkSchedulerPlan(null);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /did not print the plan of the scheduler query/);
});
