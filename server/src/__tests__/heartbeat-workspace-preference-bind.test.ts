import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
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
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
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

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "workspace-preference-session" },
  sessionDisplayId: "workspace-preference-session",
  summary: "Workspace preference bind test run.",
  provider: "test",
  model: "test-model",
})));

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
    `Skipping embedded Postgres workspace preference bind tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createGitRepoWithOrigin() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-preference-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["checkout", "-B", "master"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "workspace preference bind\n");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  const originRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-preference-origin-"));
  await runGit(originRoot, ["init", "--bare"]);
  await runGit(repoRoot, ["remote", "add", "origin", originRoot]);
  await runGit(repoRoot, ["push", "-u", "origin", "master"]);
  await runGit(repoRoot, ["fetch", "origin", "master"]);
  return { repoRoot, originRoot };
}

describeEmbeddedPostgres("workspace preference bind", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-preference-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(agentTaskSessions);
    await db.delete(executionWorkspaces);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(workspaceOperations);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedIsolatedIssue(args: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    issueId: string;
    agentId: string;
    identifier: string;
  }) {
    await db.insert(issues).values({
      id: args.issueId,
      companyId: args.companyId,
      projectId: args.projectId,
      projectWorkspaceId: args.projectWorkspaceId,
      title: "Keep the isolated preference on the issue",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: args.agentId,
      identifier: args.identifier,
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/master",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function wakeAndWait(agentId: string, issueId: string) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        skipIssueComment: true,
      },
    });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 20_000 });
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const { repoRoot, originRoot } = await createGitRepoWithOrigin();
    tempRoots.push(repoRoot, originRoot);

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
      name: "Workspace Preference Bind",
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
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, projectId, projectWorkspaceId, agentId, repoRoot };
  }

  async function seedSharedIssue(args: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    issueId: string;
    agentId: string;
    identifier: string;
    workspaceId: string;
  }) {
    await db.insert(issues).values({
      id: args.issueId,
      companyId: args.companyId,
      projectId: args.projectId,
      projectWorkspaceId: args.projectWorkspaceId,
      title: `Watchdog review for ${args.identifier}`,
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: args.agentId,
      identifier: args.identifier,
      executionWorkspaceId: args.workspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/master",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("keeps the isolated preference on the issue after the runtime binds its own workspace", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const { repoRoot, originRoot } = await createGitRepoWithOrigin();
    tempRoots.push(repoRoot, originRoot);

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
      name: "Workspace Preference Bind",
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
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await seedIsolatedIssue({
      companyId,
      projectId,
      projectWorkspaceId,
      issueId,
      agentId,
      identifier: "PAP-9201",
    });

    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "workspace-preference-session" },
        sessionDisplayId: "workspace-preference-session",
        summary: "Bound the issue to its own workspace.",
        provider: "test",
        model: "test-model",
      };
    });

    await wakeAndWait(agentId, issueId);

    const boundIssue = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    // The runtime bound the issue to the workspace it owns. The preference must
    // still name the mode the settings name: the pair
    // reuse_existing + isolated_workspace is the trap DIG-1636 forbids.
    expect(boundIssue?.executionWorkspaceId).toBeTruthy();
    expect(boundIssue?.executionWorkspacePreference).toBe("isolated_workspace");
    expect(boundIssue?.executionWorkspaceSettings).toMatchObject({
      mode: "isolated_workspace",
    });

    const ownedWorkspaces = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(ownedWorkspaces).toHaveLength(1);
    expect(ownedWorkspaces[0]?.id).toBe(boundIssue?.executionWorkspaceId);
    expect(ownedWorkspaces[0]).toMatchObject({
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      sourceIssueId: issueId,
    });
  }, 40_000);

  it("restores the issue's own workspace on the next run instead of realizing a second row", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const { repoRoot, originRoot } = await createGitRepoWithOrigin();
    tempRoots.push(repoRoot, originRoot);

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
      name: "Workspace Preference Restore",
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
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await seedIsolatedIssue({
      companyId,
      projectId,
      projectWorkspaceId,
      issueId,
      agentId,
      identifier: "PAP-9202",
    });

    adapterExecute.mockImplementation(async () => {
      await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "workspace-preference-session" },
        sessionDisplayId: "workspace-preference-session",
        summary: "Ran in the issue's own workspace.",
        provider: "test",
        model: "test-model",
      };
    });

    await wakeAndWait(agentId, issueId);

    const afterFirstRun = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(afterFirstRun?.executionWorkspaceId).toBeTruthy();

    await wakeAndWait(agentId, issueId);

    const afterSecondRun = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    // One worktree, one workspace row: the second run restored the workspace the
    // issue owns instead of realizing the same path again.
    expect(afterSecondRun?.executionWorkspaceId).toBe(
      afterFirstRun?.executionWorkspaceId,
    );
    expect(afterSecondRun?.executionWorkspacePreference).toBe("isolated_workspace");

    const ownedWorkspaces = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(ownedWorkspaces).toHaveLength(1);
    expect(ownedWorkspaces[0]?.id).toBe(afterFirstRun?.executionWorkspaceId);
  }, 60_000);
  it("keeps the reuse preference on an issue bound to another issue's workspace", async () => {
    const { companyId, projectId, projectWorkspaceId, agentId } = await seedFixture();
    const ownerIssueId = randomUUID();
    const sharedIssueId = randomUUID();

    await seedIsolatedIssue({
      companyId,
      projectId,
      projectWorkspaceId,
      issueId: ownerIssueId,
      agentId,
      identifier: "PAP-9201",
    });

    adapterExecute.mockImplementationOnce(async () => {
      await db
        .update(issues)
        .set({ status: "todo", updatedAt: new Date() })
        .where(eq(issues.id, ownerIssueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "owner-session" },
        sessionDisplayId: "owner-session",
        summary: "Bound the owner issue to its own workspace.",
        provider: "test",
        model: "test-model",
      };
    });

    await wakeAndWait(agentId, ownerIssueId);

    const ownerIssue = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, ownerIssueId))
      .then((rows) => rows[0] ?? null);
    const sharedWorkspaceId = ownerIssue?.executionWorkspaceId;
    expect(sharedWorkspaceId).toBeTruthy();

    // The second issue is bound to the first issue's workspace, the shape the
    // task-watchdog create path produces with
    // inheritExecutionWorkspaceFromIssueId.
    await seedSharedIssue({
      companyId,
      projectId,
      projectWorkspaceId,
      issueId: sharedIssueId,
      agentId,
      identifier: "PAP-9202",
      workspaceId: sharedWorkspaceId!,
    });

    adapterExecute.mockImplementationOnce(async () => {
      await db
        .update(issues)
        .set({ status: "todo", updatedAt: new Date() })
        .where(eq(issues.id, sharedIssueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "shared-session" },
        sessionDisplayId: "shared-session",
        summary: "Ran in the shared workspace.",
        provider: "test",
        model: "test-model",
      };
    });

    await wakeAndWait(agentId, sharedIssueId);

    const sharedIssue = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, sharedIssueId))
      .then((rows) => rows[0] ?? null);

    // A workspace another issue owns keeps the reuse preference: the binding
    // is the only honest description of it, and it must stay visible so the
    // cross-issue binding can be repaired.
    expect(sharedIssue?.executionWorkspaceId).toBe(sharedWorkspaceId);
    expect(sharedIssue?.executionWorkspacePreference).toBe("reuse_existing");

    const sharedWorkspace = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, sharedWorkspaceId!))
      .then((rows) => rows[0] ?? null);
    expect(sharedWorkspace?.sourceIssueId).toBe(ownerIssueId);

    // The owner of the workspace keeps its own isolated preference.
    const ownerAfter = await db
      .select({ executionWorkspacePreference: issues.executionWorkspacePreference })
      .from(issues)
      .where(eq(issues.id, ownerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(ownerAfter?.executionWorkspacePreference).toBe("isolated_workspace");
  }, 60_000);
});