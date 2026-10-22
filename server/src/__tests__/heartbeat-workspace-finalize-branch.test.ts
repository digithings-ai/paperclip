import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Finalization branch guard test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat workspace finalize branch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-finalize-branch-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "finalization branch guard\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForRuntimeStateLastRun(db: Db, agentId: string, runId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await db
      .select({ lastRunId: agentRuntimeState.lastRunId })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    if (state?.lastRunId === runId) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function deleteHeartbeatRowsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function readAdapterWorkspace(input: unknown) {
  const context = (input as { context?: Record<string, unknown> }).context ?? {};
  const workspace = context.paperclipWorkspace as Record<string, unknown> | undefined;
  const cwd = typeof workspace?.cwd === "string" ? workspace.cwd : null;
  const branchName = typeof workspace?.branchName === "string" ? workspace.branchName : null;
  const executionWorkspaceId =
    typeof context.executionWorkspaceId === "string" ? context.executionWorkspaceId : null;
  if (!cwd || !branchName || !executionWorkspaceId) {
    throw new Error("Adapter input is missing the realized execution workspace context");
  }
  return { cwd, branchName, executionWorkspaceId };
}

async function gitStdout(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function prepareDivergedReviewHead(repoRoot: string, options?: { publishRemote?: boolean }) {
  const baseBranch = await gitStdout(repoRoot, ["branch", "--show-current"]);
  const initial = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repoRoot, "branch-tip.txt"), "recorded tip\n", "utf8");
  await runGit(repoRoot, ["add", "branch-tip.txt"]);
  await runGit(repoRoot, ["commit", "-m", "recorded branch tip"]);
  const recordedTip = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);

  await runGit(repoRoot, ["checkout", "--detach", initial]);
  await writeFile(path.join(repoRoot, "reviewed.txt"), "reviewed head\n", "utf8");
  await runGit(repoRoot, ["add", "reviewed.txt"]);
  await runGit(repoRoot, ["commit", "-m", "reviewed pull request head"]);
  const reviewedSha = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);
  await runGit(repoRoot, ["checkout", baseBranch]);

  let origin: string | null = null;
  if (options?.publishRemote !== false) {
    origin = await mkdtemp(path.join(os.tmpdir(), "paperclip-finalize-origin-"));
    await runGit(origin, ["init", "--bare"]);
    await runGit(repoRoot, ["remote", "add", "origin", origin]);
    await runGit(repoRoot, ["push", "origin", `${reviewedSha}:refs/heads/reviewed-pr`]);
  }

  const recordedPrefix = recordedTip.slice(0, 8);
  const wrongPrefix = reviewedSha.startsWith(recordedPrefix) ? "deadbeef1" : recordedPrefix;
  return {
    reviewedSha,
    reviewedPrefix: reviewedSha.slice(0, 8),
    recordedTip,
    wrongPrefix,
    origin,
  };
}

function reviewTitle(prefix: string) {
  return `Review: example#1 at ${prefix}`;
}

async function seedRunTarget(
  db: Db,
  repoRoot: string,
  overrides?: { title?: string; description?: string | null },
) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();

  await instanceSettingsService(db).updateExperimental({
    enableIsolatedWorkspaces: true,
  });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Workspace Finalize Branch Guard",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: repoRoot,
    isPrimary: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    permissions: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    projectWorkspaceId,
    title: overrides?.title ?? "Publish without drifting managed workspace",
    description: overrides?.description ?? null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: agentId,
    identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    executionWorkspaceSettings: {
      mode: "isolated_workspace",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { companyId, projectId, projectWorkspaceId, issueId, agentId };
}

async function wakeIssue(heartbeat: Heartbeat, agentId: string, issueId: string) {
  return heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      skipIssueComment: true,
    },
  });
}

async function listFinalizeOperations(db: Db, runId: string) {
  return db
    .select()
    .from(workspaceOperations)
    .where(and(
      eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize"),
    ))
    .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt));
}

async function listRunWorkspaceOperations(db: Db, runId: string) {
  return db
    .select()
    .from(workspaceOperations)
    .where(eq(workspaceOperations.heartbeatRunId, runId))
    .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt));
}

describeEmbeddedPostgres("heartbeat workspace finalization branch guard", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-finalize-branch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and finalization success can dispatch a follow-up
    // wakeup, so a run or wakeup can still write heartbeat_runs and issues rows
    // when teardown starts. The shared drain also awaits an in-flight wakeup
    // that is still before run registration, which a plain run table status
    // poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Finalization branch guard test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issuePlanDecompositions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(workspaceOperations);
    await deleteHeartbeatRowsAfterActivityLogDrains(db);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  it("repairs clean unrecorded branch drift before recording workspace finalization", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    const publishBranch = `publish-${issueId.slice(0, 8)}`;
    let recordedBranch: string | null = null;
    let executionWorkspaceId: string | null = null;
    let workspaceCwd: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      executionWorkspaceId = workspace.executionWorkspaceId;
      workspaceCwd = workspace.cwd;
      await runGit(workspace.cwd, ["checkout", "-b", publishBranch]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after switching to a publish branch.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    await expect(execFileAsync("git", ["branch", "--show-current"], { cwd: workspaceCwd! }))
      .resolves.toMatchObject({ stdout: `${recordedBranch}\n` });

    const operations = await listRunWorkspaceOperations(db, run!.id);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "worktree_prepare",
          command: `git checkout ${recordedBranch}`,
          status: "succeeded",
          executionWorkspaceId,
          metadata: expect.objectContaining({
            branchIncoherenceRepair: true,
            expectedBranchName: recordedBranch,
            actualBranchName: publishBranch,
            executionWorkspaceId,
            sourceIssueId: issueId,
          }),
        }),
      ]),
    );

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: {
        executionWorkspaceId,
        valid: true,
        reasonCode: null,
        expectedBranchName: recordedBranch,
        actualBranchName: recordedBranch,
      },
      managedGitWorktreeBranchRepair: {
        attempted: true,
        succeeded: true,
        initial: expect.objectContaining({
          valid: false,
          reasonCode: "branch_mismatch",
          expectedBranchName: recordedBranch,
          actualBranchName: publishBranch,
        }),
      },
    });
  }, 20_000);

  it("adopts unrecorded forward branch drift for finalization without persisting it", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    const publishBranch = `publish-${issueId.slice(0, 8)}`;
    let recordedBranch: string | null = null;
    let executionWorkspaceId: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      executionWorkspaceId = workspace.executionWorkspaceId;
      await runGit(workspace.cwd, ["checkout", "-b", publishBranch]);
      await writeFile(path.join(workspace.cwd, "publish.txt"), "publish branch work\n", "utf8");
      await runGit(workspace.cwd, ["add", "publish.txt"]);
      await runGit(workspace.cwd, ["commit", "-m", "Add publish branch work"]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after switching to a publish branch with commits.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const finalizedWorkspace = await db
      .select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId!))
      .then((rows) => rows[0] ?? null);
    expect(finalizedWorkspace?.branchName).toBe(recordedBranch);

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: expect.objectContaining({
        executionWorkspaceId,
        valid: true,
        reasonCode: null,
        expectedBranchName: publishBranch,
        actualBranchName: publishBranch,
      }),
      managedGitWorktreeBranchRepair: expect.objectContaining({
        attempted: true,
        succeeded: true,
      }),
    });
    expect(recordedBranch).not.toBe(publishBranch);
  }, 20_000);

  it("allows a successful adapter run when the branch transition is recorded before finalization", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    const publishBranch = `publish-${issueId.slice(0, 8)}`;
    let executionWorkspaceId: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      executionWorkspaceId = workspace.executionWorkspaceId;
      await runGit(workspace.cwd, ["checkout", "-b", publishBranch]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      await db
        .update(executionWorkspaces)
        .set({
          branchName: publishBranch,
          updatedAt: new Date(),
        })
        .where(eq(executionWorkspaces.id, workspace.executionWorkspaceId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after recording a branch transition.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const finalizedWorkspace = await db
      .select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId!))
      .then((rows) => rows[0] ?? null);
    expect(finalizedWorkspace?.branchName).toBe(publishBranch);

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: {
        executionWorkspaceId,
        valid: true,
        reasonCode: null,
        expectedBranchName: publishBranch,
        actualBranchName: publishBranch,
      },
    });
  }, 20_000);

  it("finalizes a run when the managed worktree path is already gone", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot);
    let executionWorkspaceId: string | null = null;
    let workspaceCwd: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      executionWorkspaceId = workspace.executionWorkspaceId;
      workspaceCwd = workspace.cwd;
      await rm(workspace.cwd, { recursive: true, force: true });
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after the worktree directory was removed.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
      error: null,
    });
    expect(finishedRun?.error ?? "").not.toContain("does not exist");
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    await expect(rm(workspaceCwd!, { recursive: true, force: true })).resolves.toBeUndefined();

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps).toHaveLength(1);
    expect(finalizeOps[0]).toMatchObject({
      status: "succeeded",
      executionWorkspaceId,
    });
    expect(finalizeOps[0]?.metadata).toMatchObject({
      managedGitWorktreeBranch: expect.objectContaining({
        executionWorkspaceId,
        valid: false,
        reasonCode: "missing_worktree",
      }),
      deadWorktree: {
        reasonCode: "missing_worktree",
        archiveRoute: `PATCH /api/execution-workspaces/${executionWorkspaceId}`,
        archiveBody: { status: "archived" },
      },
    });
    expect(JSON.stringify(finalizeOps[0]?.metadata)).not.toContain("reconcile-branch");
  }, 20_000);

  async function detachAtReviewHead(cwd: string, reviewedSha: string, branchName: string) {
    const tipBefore = await gitStdout(cwd, ["rev-parse", `refs/heads/${branchName}`]);
    await runGit(cwd, ["checkout", "--detach", reviewedSha]);
    return tipBefore;
  }

  function assertNoForcedCheckout(
    operations: Array<{ command: string | null }>,
    recordedBranch: string,
  ) {
    const commands = operations.map((operation) => operation.command ?? "").join("\n");
    expect(commands).not.toContain(`git checkout ${recordedBranch}`);
    expect(commands).not.toMatch(/checkout -B|checkout -f|branch -D|--force/);
  }

  it("reattaches a clean detached review read at the named sha and leaves the branch tip", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const review = await prepareDivergedReviewHead(repoRoot);
    if (review.origin) tempRoots.push(review.origin);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot, {
      title: reviewTitle(review.reviewedPrefix),
    });
    let recordedBranch: string | null = null;
    let executionWorkspaceId: string | null = null;
    let workspaceCwd: string | null = null;
    let tipBefore: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      executionWorkspaceId = workspace.executionWorkspaceId;
      workspaceCwd = workspace.cwd;
      tipBefore = await detachAtReviewHead(workspace.cwd, review.reviewedSha, workspace.branchName);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after a detached review read.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    expect(run).not.toBeNull();
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({ status: "succeeded", errorCode: null, error: null });
    await waitForRuntimeStateLastRun(db, agentId, run!.id);
    expect(tipBefore).not.toBe(review.reviewedSha);
    expect(await gitStdout(workspaceCwd!, ["branch", "--show-current"])).toBe(recordedBranch);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);

    const workspaceRow = await db
      .select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId!))
      .then((rows) => rows[0] ?? null);
    expect(workspaceRow?.branchName).toBe(recordedBranch);

    const operations = await listRunWorkspaceOperations(db, run!.id);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: `git checkout ${recordedBranch}`,
        status: "succeeded",
        metadata: expect.objectContaining({
          reason: "detached_review_head",
          detachedHeadSha: review.reviewedSha,
          branchTipSha: tipBefore,
        }),
      }),
    ]));
    const commands = operations.map((operation) => operation.command ?? "").join("\n");
    expect(commands).not.toMatch(/checkout -B|checkout -f|branch -D|--force/);

    const finalizeOps = await listFinalizeOperations(db, run!.id);
    expect(finalizeOps.map((operation) => operation.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          managedGitWorktreeBranchRepair: expect.objectContaining({
            attempted: true,
            succeeded: true,
            reason: "detached_review_head",
          }),
        }),
      ]),
    );

    await db.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issueId));
    let secondBranch: string | null = null;
    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      expect(workspace.cwd).toBe(workspaceCwd);
      secondBranch = await gitStdout(workspace.cwd, ["branch", "--show-current"]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Second run starts on the recorded branch.",
        provider: "test",
        model: "test-model",
      };
    });
    const secondRun = await wakeIssue(heartbeat, agentId, issueId);
    expect(secondRun).not.toBeNull();
    const finishedSecond = await waitForRunToFinish(heartbeat, secondRun!.id);
    expect(finishedSecond).toMatchObject({ status: "succeeded", errorCode: null, error: null });
    expect(secondBranch).toBe(recordedBranch);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);
    const secondFinalize = await listFinalizeOperations(db, secondRun!.id);
    expect(JSON.stringify(secondFinalize)).not.toContain("detached_review_head");
    expect(secondFinalize.map((operation) => operation.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          managedGitWorktreeBranch: expect.objectContaining({
            valid: true,
            expectedBranchName: recordedBranch,
            actualBranchName: recordedBranch,
          }),
        }),
      ]),
    );
  }, 40_000);

  it("reattaches a clean detached review read named only in the issue body", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const review = await prepareDivergedReviewHead(repoRoot);
    if (review.origin) tempRoots.push(review.origin);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot, {
      description: `Read the pull request at ${review.reviewedPrefix} before signing off.`,
    });
    let recordedBranch: string | null = null;
    let workspaceCwd: string | null = null;
    let tipBefore: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      workspaceCwd = workspace.cwd;
      tipBefore = await detachAtReviewHead(workspace.cwd, review.reviewedSha, workspace.branchName);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed after a detached review read named in the body.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun).toMatchObject({ status: "succeeded", errorCode: null, error: null });
    expect(await gitStdout(workspaceCwd!, ["branch", "--show-current"])).toBe(recordedBranch);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);
    const operations = await listRunWorkspaceOperations(db, run!.id);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: `git checkout ${recordedBranch}`,
        metadata: expect.objectContaining({ reason: "detached_review_head" }),
      }),
    ]));
  }, 30_000);

  it("fails a detached read when the issue does not name that sha", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const review = await prepareDivergedReviewHead(repoRoot);
    if (review.origin) tempRoots.push(review.origin);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot, {
      title: reviewTitle(review.wrongPrefix),
    });
    let recordedBranch: string | null = null;
    let workspaceCwd: string | null = null;
    let tipBefore: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      workspaceCwd = workspace.cwd;
      tipBefore = await detachAtReviewHead(workspace.cwd, review.reviewedSha, workspace.branchName);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed on an unnamed detached sha.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.error ?? "").toContain('found "<detached>"');
    expect(await gitStdout(workspaceCwd!, ["rev-parse", "HEAD"])).toBe(review.reviewedSha);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);
    assertNoForcedCheckout(await listRunWorkspaceOperations(db, run!.id), recordedBranch!);
  }, 30_000);

  it("fails a detached read at the named sha when the tree is dirty", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const review = await prepareDivergedReviewHead(repoRoot);
    if (review.origin) tempRoots.push(review.origin);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot, {
      title: reviewTitle(review.reviewedPrefix),
    });
    let recordedBranch: string | null = null;
    let workspaceCwd: string | null = null;
    let tipBefore: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      workspaceCwd = workspace.cwd;
      tipBefore = await detachAtReviewHead(workspace.cwd, review.reviewedSha, workspace.branchName);
      await writeFile(path.join(workspace.cwd, "reviewed.txt"), "seat work still in the tree\n", "utf8");
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed with a dirty detached review tree.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.error ?? "").toContain('found "<detached>"');
    expect(await gitStdout(workspaceCwd!, ["rev-parse", "HEAD"])).toBe(review.reviewedSha);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);
    assertNoForcedCheckout(await listRunWorkspaceOperations(db, run!.id), recordedBranch!);
  }, 30_000);

  it("fails a detached review read when the recorded branch is checked out elsewhere", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const review = await prepareDivergedReviewHead(repoRoot);
    if (review.origin) tempRoots.push(review.origin);
    const { agentId, issueId } = await seedRunTarget(db, repoRoot, {
      title: reviewTitle(review.reviewedPrefix),
    });
    let recordedBranch: string | null = null;
    let workspaceCwd: string | null = null;
    let tipBefore: string | null = null;
    let otherWorktree: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      workspaceCwd = workspace.cwd;
      tipBefore = await detachAtReviewHead(workspace.cwd, review.reviewedSha, workspace.branchName);
      otherWorktree = await mkdtemp(path.join(os.tmpdir(), "paperclip-finalize-other-"));
      tempRoots.push(otherWorktree);
      await runGit(repoRoot, ["worktree", "add", otherWorktree, workspace.branchName]);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed while the recorded branch was checked out elsewhere.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.error ?? "").toContain('found "<detached>"');
    expect(await gitStdout(workspaceCwd!, ["rev-parse", "HEAD"])).toBe(review.reviewedSha);
    expect(await gitStdout(otherWorktree!, ["branch", "--show-current"])).toBe(recordedBranch);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);
    assertNoForcedCheckout(await listRunWorkspaceOperations(db, run!.id), recordedBranch!);
  }, 30_000);

  it("fails a detached review read when the named sha is not on a remote ref", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const review = await prepareDivergedReviewHead(repoRoot, { publishRemote: false });
    const { agentId, issueId } = await seedRunTarget(db, repoRoot, {
      title: reviewTitle(review.reviewedPrefix),
    });
    let recordedBranch: string | null = null;
    let workspaceCwd: string | null = null;
    let tipBefore: string | null = null;

    adapterExecute.mockImplementationOnce(async (input) => {
      const workspace = readAdapterWorkspace(input);
      recordedBranch = workspace.branchName;
      workspaceCwd = workspace.cwd;
      tipBefore = await detachAtReviewHead(workspace.cwd, review.reviewedSha, workspace.branchName);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Adapter completed on a named sha that was never pushed.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await wakeIssue(heartbeat, agentId, issueId);
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.error ?? "").toContain('found "<detached>"');
    expect(await gitStdout(workspaceCwd!, ["rev-parse", "HEAD"])).toBe(review.reviewedSha);
    expect(await gitStdout(repoRoot, ["rev-parse", `refs/heads/${recordedBranch}`])).toBe(tipBefore);
    assertNoForcedCheckout(await listRunWorkspaceOperations(db, run!.id), recordedBranch!);
  }, 30_000);
});
