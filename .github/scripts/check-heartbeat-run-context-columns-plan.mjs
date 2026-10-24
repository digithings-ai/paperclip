#!/usr/bin/env node
/**
 * Checks the plan that the heartbeat run context benchmark prints.
 *
 * The scheduler read of heartbeat_runs must stay an index-only scan on
 * dt_perf_hr_company_agent_created_ctx_idx. A scan of the TOASTed
 * context_snapshot column is a regression: it reads the snapshot of every row
 * of the table.
 *
 * Usage:
 *   node .github/scripts/check-heartbeat-run-context-columns-plan.mjs <plan-file>
 *
 * The plan file is the output of
 * server/scripts/benchmark-heartbeat-run-context-columns.ts. Without an
 * argument the script reads the output from the standard input.
 *
 * The script exits with 0 when the plan is the expected one. It exits with 1
 * when the plan is a regression. It exits with 2 when the plan cannot be read.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SCHEDULER_SECTION_HEADER = "=== scheduler query with the real columns ===";
export const REQUIRED_INDEX = "dt_perf_hr_company_agent_created_ctx_idx";
export const TABLE = "heartbeat_runs";

/**
 * Reads the plan of the scheduler query from the output of the benchmark.
 * The benchmark prints one section per query. Only the section of the
 * scheduler query counts. The plan of the query with the jsonb projection is
 * the old plan and it is not a failure of the new one.
 */
export function extractSchedulerPlan(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SCHEDULER_SECTION_HEADER);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("==="));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Checks the plan of the scheduler query.
 * Returns the list of problems. An empty list means that the plan is good.
 */
export function checkSchedulerPlan(plan) {
  const problems = [];
  if (!plan) {
    return { ok: false, problems: ["the benchmark did not print the plan of the scheduler query"] };
  }
  const indexOnlyScan = new RegExp(`Index Only Scan using ${REQUIRED_INDEX} on ${TABLE}`).test(plan);
  if (!indexOnlyScan) {
    problems.push(`the scheduler query did not use an index-only scan on ${REQUIRED_INDEX}`);
  }
  if (!/Heap Fetches:\s*0\b/.test(plan)) {
    problems.push("the scheduler query still read rows from the heap");
  }
  if (new RegExp(`Bitmap Heap Scan on ${TABLE}`).test(plan)) {
    problems.push(
      `the scheduler query went back to a bitmap heap scan on ${TABLE}, so it reads the TOASTed context_snapshot column`,
    );
  }
  if (new RegExp(`Seq Scan on ${TABLE}`).test(plan)) {
    problems.push(`the scheduler query went back to a sequential scan on ${TABLE}`);
  }
  return { ok: problems.length === 0, problems };
}

function readOutput() {
  const file = process.argv[2];
  if (file) return readFileSync(file, "utf8");
  return readFileSync(0, "utf8");
}

function main() {
  let output;
  try {
    output = readOutput();
  } catch (error) {
    console.error(`Could not read the output of the benchmark: ${error.message}`);
    return 2;
  }

  const plan = extractSchedulerPlan(output);
  const result = checkSchedulerPlan(plan);
  if (plan) {
    console.log("Plan of the scheduler query:");
    console.log(plan);
    console.log("");
  }

  if (!result.ok) {
    console.error("The scheduler query does not use the index-only scan.");
    for (const problem of result.problems) console.error(`- ${problem}`);
    return 1;
  }

  console.log(`The scheduler query uses an index-only scan on ${REQUIRED_INDEX} and reads no heap row.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
