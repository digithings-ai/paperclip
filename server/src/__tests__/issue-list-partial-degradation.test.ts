import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  issueRoutes,
} from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

// DIG-934: a failure scoped to one row (or to an auxiliary enrichment map)
// must degrade the company issues list to a partial result with a warning,
// never 500 the whole response.
const poison = vi.hoisted(() => ({ issueId: null as string | null }));

vi.mock("../services/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/index.js")>();
  const realFactory = mod.issueRecoveryActionService as (db: unknown) => {
    listActiveForIssues: (companyId: string, ids: string[]) => Promise<unknown>;
  };
  return {
    ...mod,
    issueRecoveryActionService: (db: unknown) => {
      const svc = realFactory(db);
      return {
        ...svc,
        listActiveForIssues: async (companyId: string, ids: string[]) => {
          if (poison.issueId && ids.includes(poison.issueId)) {
            throw new Error(
              "poisoned recovery map (DIG-934 regression probe)",
            );
          }
          return svc.listActiveForIssues(companyId, ids);
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-list degradation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list partial degradation (DIG-934)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-degraded-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    poison.issueId = null;
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(
    companyId: string,
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id") ?? "cloud-user-1";
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompanyWithIssues(companyId: string, titles: string[]) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const ids = titles.map(() => randomUUID());
    await db.insert(issues).values(
      ids.map((id, index) => ({
        id,
        companyId,
        title: titles[index],
        status: "todo",
        priority: "medium",
      })),
    );
    return ids;
  }

  it("returns the full list with no degradation signal when every stage reads cleanly", async () => {
    const companyId = randomUUID();
    const ids = await seedCompanyWithIssues(companyId, ["Alpha", "Beta"]);

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id).sort()).toEqual([...ids].sort());
    expect(res.headers["x-paperclip-issue-list-degraded"]).toBeUndefined();
  });

  it("degrades to a partial list when the recovery enrichment map throws", async () => {
    const companyId = randomUUID();
    const ids = await seedCompanyWithIssues(companyId, ["Alpha", "Beta", "Gamma"]);
    poison.issueId = ids[2];

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id).sort()).toEqual([...ids].sort());
    expect(res.headers["x-paperclip-issue-list-degraded"]).toMatch(/auxiliary=unavailable/);
  });

  it("still serves the list when a diagnostics hook throws", async () => {
    const companyId = randomUUID();
    const ids = await seedCompanyWithIssues(companyId, ["Alpha"]);

    const res = await request(
      createApp(companyId, {
        issueListDiagnostics: {
          onComputeStart: () => {
            throw new Error("poisoned diagnostics hook (DIG-934)");
          },
        },
      }),
    )
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual(ids);
  });

  it("settleIssueAccessDecisions excludes a throwing row without rejecting", async () => {
    const mod = await import("../routes/issues.js");
    expect(typeof mod.settleIssueAccessDecisions).toBe("function");
    const report = { skippedRows: 0, auxiliaryUnavailable: false };
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const kept = await mod.settleIssueAccessDecisions(
      rows,
      async (row: { id: string }) => {
        if (row.id === "b") throw new Error("poisoned row (DIG-934)");
        return { allowed: row.id === "a" };
      },
      report,
    );
    expect(kept).toEqual([{ id: "a" }]);
    expect(report.skippedRows).toBe(1);
  });
});
