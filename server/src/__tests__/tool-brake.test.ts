import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  projects,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { CONNECTION_GATEWAY_TOOL_BRAKE } from "@paperclipai/shared/constants";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-tool-action-signing-secret";
const BRAKE = CONNECTION_GATEWAY_TOOL_BRAKE;

/**
 * Byte-exact camelCase names published in DIG-2745 section 7.
 * The attachment records 41 Atlassian tools and prints these 12.
 * The other 29 are not in the attachment, so they are not in this catalogue.
 */
const PUBLISHED_ATLASSIAN_TOOL_NAMES = [
  "createJiraIssue",
  "addCommentToJiraIssue",
  "transitionJiraIssue",
  "editJiraIssue",
  "getJiraIssue",
  "getAccessibleAtlassianResources",
  "atlassianUserInfo",
  "getVisibleJiraProjects",
  "searchJiraIssuesUsingJql",
  "getJiraProjectIssueTypesMetadata",
  "fetch",
  "search",
] as const;

const META_TOOL_NAMES = ["discover", "executeRead", "executeWrite", "executeDestructive"] as const;
const ALLOWED_TOOL = "addCommentToJiraIssue";
const OTHER_TOOL = "getJiraIssue";

type Db = ReturnType<typeof createDb>;
type Allowlist = readonly string[] | "absent";

type FakeMcpRequest = {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
};

type Seat = {
  agentId: string;
  runId: string;
  issueId: string;
  projectId: string;
  gatewayId: string;
  token: string;
  endpointPath: string;
};

type Opened = {
  companyId: string;
  connectionId: string;
  applicationKey: string;
  remote: {
    requests: FakeMcpRequest[];
    close: () => Promise<void>;
  };
  gateway: ReturnType<typeof createTestToolGatewayService>;
  app: ReturnType<typeof express>;
  seats: Seat[];
};

function createTestToolGatewayService(db: Db) {
  return createToolGatewayService(db, { toolActionSigningSecret: testToolActionSigningSecret });
}

async function createCompany(db: Db) {
  const [company] = await db.insert(companies).values({
    name: `Brake ${randomUUID()}`,
    issuePrefix: `BR${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning();
  return company!;
}

async function createAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function createIssueAndRun(db: Db, companyId: string, agentId: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name: `Project ${randomUUID()}`,
  }).returning();
  const [issue] = await db.insert(issues).values({
    companyId,
    projectId: project!.id,
    title: `Brake issue ${randomUUID()}`,
    status: "in_progress",
    assigneeAgentId: agentId,
  }).returning();
  const [run] = await db.insert(heartbeatRuns).values({
    companyId,
    agentId,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot: { issueId: issue!.id, projectId: project!.id },
  }).returning();
  return { project: project!, issue: issue!, run: run! };
}

async function startFakeRemoteMcpServer() {
  const requests: FakeMcpRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      } catch {
        body = null;
      }
      requests.push({ headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body?.id ?? "test",
        result: { content: [{ type: "text", text: "ok" }] },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fake MCP server address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function expectedConnectedToolName(input: { applicationKey: string; connectionId: string; toolName: string }) {
  const applicationSegment = input.applicationKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "mcp";
  const toolSegment = input.toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "tool";
  return `mcp.${applicationSegment}-${input.connectionId.replace(/-/g, "").slice(0, 8)}:${toolSegment}`;
}

async function insertCatalogTool(db: Db, companyId: string, applicationId: string, connectionId: string, toolName: string) {
  const [entry] = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId,
    connectionId,
    entryKind: "tool",
    name: toolName,
    toolName,
    title: toolName,
    description: toolName,
    inputSchema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: true },
    annotations: {},
    riskLevel: "write",
    isReadOnly: false,
    isWrite: true,
    isDestructive: false,
    status: "active",
    versionHash: randomUUID(),
  }).returning();
  return entry!;
}

async function insertBrake(
  db: Db,
  companyId: string,
  targetType: "agent" | "company",
  targetId: string,
  allowlist: Allowlist,
) {
  const metadata: Record<string, unknown> = { [BRAKE.profileFlag]: true };
  if (allowlist !== "absent") metadata[BRAKE.allowlistKey] = [...allowlist];
  const [profile] = await db.insert(toolProfiles).values({
    companyId,
    profileKey: `brake-${randomUUID()}`,
    name: `Brake ${randomUUID()}`,
    defaultAction: "deny",
    metadata,
  }).returning();
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile!.id,
    targetType,
    targetId,
  });
  return profile!;
}

async function openCatalogue(
  db: Db,
  toolNames: readonly string[],
  options: {
    seats?: Array<{ allowlist?: Allowlist }>;
    companyAllowlist?: Allowlist;
  } = {},
): Promise<Opened> {
  const company = await createCompany(db);
  const remote = await startFakeRemoteMcpServer();
  const applicationKey = "atlassian";
  const [application] = await db.insert(toolApplications).values({
    companyId: company.id,
    applicationKey,
    name: `Atlassian ${randomUUID()}`,
    type: "mcp_http",
    status: "active",
  }).returning();
  const [connection] = await db.insert(toolConnections).values({
    companyId: company.id,
    applicationId: application!.id,
    name: `Atlassian ${randomUUID()}`,
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    config: { url: remote.url },
    transportConfig: { url: remote.url },
    credentialRefs: [],
    credentialSecretRefs: [],
  }).returning();
  await db.insert(connectionGrants).values({
    companyId: company.id,
    connectionId: connection!.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });
  for (const toolName of toolNames) {
    await insertCatalogTool(db, company.id, application!.id, connection!.id, toolName);
  }
  const [gatewayProfile] = await db.insert(toolProfiles).values({
    companyId: company.id,
    profileKey: `gateway-${randomUUID()}`,
    name: `Gateway ${randomUUID()}`,
    defaultAction: "deny",
  }).returning();
  await db.insert(toolProfileEntries).values({
    companyId: company.id,
    profileId: gatewayProfile!.id,
    selectorType: "connection",
    effect: "include",
    applicationId: application!.id,
    connectionId: connection!.id,
  });
  if (options.companyAllowlist !== undefined) {
    await insertBrake(db, company.id, "company", company.id, options.companyAllowlist);
  }
  const gateway = createTestToolGatewayService(db);
  const seatSpecs = options.seats ?? [{ allowlist: [ALLOWED_TOOL] as Allowlist }];
  const seats: Seat[] = [];
  for (const spec of seatSpecs) {
    const agent = await createAgent(db, company.id);
    const { issue, project, run } = await createIssueAndRun(db, company.id, agent.id);
    if (spec.allowlist !== undefined) {
      await insertBrake(db, company.id, "agent", agent.id, spec.allowlist);
    }
    const named = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Seat ${randomUUID()}`,
        profileId: gatewayProfile!.id,
        defaultProfileMode: "gateway_only",
        agentId: agent.id,
        contextScopeType: "agent",
        contextScopeId: agent.id,
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: named.id,
      body: { name: "seat", subjectType: "heartbeat_run", subjectId: run.id },
    });
    seats.push({
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
      projectId: project.id,
      gatewayId: named.id,
      token: token.token,
      endpointPath: named.endpointPath,
    });
  }
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  app.use("/api", toolGatewayRoutes(db, gateway));
  return {
    companyId: company.id,
    connectionId: connection!.id,
    applicationKey,
    remote,
    gateway,
    app,
    seats,
  };
}

async function upstreamNames(opened: Opened, seat: Seat = opened.seats[0]!, callerHeaders?: Record<string, string>) {
  const tools = await opened.gateway.listToolsForNamedGateway({
    gatewayId: seat.gatewayId,
    bearerToken: seat.token,
    callerHeaders,
  });
  return tools.map((tool) => tool.upstreamToolName ?? tool.name).sort();
}

function mangled(opened: Opened, toolName: string) {
  return expectedConnectedToolName({
    applicationKey: opened.applicationKey,
    connectionId: opened.connectionId,
    toolName,
  });
}

async function callTool(opened: Opened, toolName: string, parameters: Record<string, unknown> = {}, seat: Seat = opened.seats[0]!) {
  const before = opened.remote.requests.length;
  const response = await request(opened.app)
    .post(seat.endpointPath)
    .set("authorization", `Bearer ${seat.token}`)
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: mangled(opened, toolName), arguments: parameters },
    });
  return {
    status: response.status,
    reasonCode: (response.body as { error?: { data?: { reasonCode?: string } } }).error?.data?.reasonCode,
    upstreamDelta: opened.remote.requests.length - before,
  };
}

async function reasonCount(db: Db, companyId: string, reasonCode: string) {
  const rows = await db.select({ id: toolCallEvents.id }).from(toolCallEvents).where(and(
    eq(toolCallEvents.companyId, companyId),
    eq(toolCallEvents.reasonCode, reasonCode),
  ));
  return rows.length;
}

describeEmbeddedPostgres("connection gateway tool brake", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const remotes: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-brake-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await Promise.all(remotes.splice(0).map((remote) => remote.close()));
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolGatewaySessions);
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolPolicies);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function open(toolNames: readonly string[], options: Parameters<typeof openCatalogue>[2] = {}) {
    const opened = await openCatalogue(db, toolNames, options);
    remotes.push(opened.remote);
    return opened;
  }

  it("offers exactly the one allowlisted raw name from the published Atlassian catalogue plus meta tools", async () => {
    const catalogue = [...PUBLISHED_ATLASSIAN_TOOL_NAMES, ...META_TOOL_NAMES];
    const opened = await open(catalogue, { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
    const allowed = await callTool(opened, ALLOWED_TOOL, { message: "ok" });
    expect(allowed.status).toBe(200);
    expect(allowed.upstreamDelta).toBe(1);
  });

  it("refuses an absent allowlist loudly and records allowlist_absent per tool", async () => {
    const opened = await open(PUBLISHED_ATLASSIAN_TOOL_NAMES, { seats: [{ allowlist: "absent" }] });
    const response = await request(opened.app)
      .post(opened.seats[0]!.endpointPath)
      .set("authorization", `Bearer ${opened.seats[0]!.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(403);
    expect(response.body.error.data.reasonCode).toBe(BRAKE.reasonAllowlistAbsent);
    expect(response.body.result?.tools).toBeUndefined();
    expect(await reasonCount(db, opened.companyId, BRAKE.reasonAllowlistAbsent)).toBe(PUBLISHED_ATLASSIAN_TOOL_NAMES.length);
  });

  it("refuses an empty allowlist loudly and records allowlist_empty per tool", async () => {
    const opened = await open(PUBLISHED_ATLASSIAN_TOOL_NAMES, { seats: [{ allowlist: [] }] });
    const response = await request(opened.app)
      .post(opened.seats[0]!.endpointPath)
      .set("authorization", `Bearer ${opened.seats[0]!.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(403);
    expect(response.body.error.data.reasonCode).toBe(BRAKE.reasonAllowlistEmpty);
    expect(await reasonCount(db, opened.companyId, BRAKE.reasonAllowlistEmpty)).toBe(PUBLISHED_ATLASSIAN_TOOL_NAMES.length);
    expect(await reasonCount(db, opened.companyId, BRAKE.reasonAllowlistAbsent)).toBe(0);
  });

  it("matches the raw upstream name exactly, so a different case is not offered", async () => {
    const opened = await open([ALLOWED_TOOL, "AddCommentToJiraIssue"], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
  });

  it("does not treat a snake_case spelling as the raw name", async () => {
    const opened = await open([ALLOWED_TOOL, "add_comment_to_jira_issue"], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
  });

  it("does not let the mangled gateway name satisfy a raw-name allowlist entry", async () => {
    const opened = await open([ALLOWED_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const mangledName = mangled(opened, ALLOWED_TOOL);
    const profiles = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, opened.companyId));
    for (const profile of profiles) {
      const metadata = (profile.metadata ?? {}) as Record<string, unknown>;
      if (metadata[BRAKE.profileFlag] !== true) continue;
      await db.update(toolProfiles).set({
        metadata: { ...metadata, [BRAKE.allowlistKey]: [mangledName] },
      }).where(eq(toolProfiles.id, profile.id));
    }
    expect(await upstreamNames(opened)).toEqual([]);
  });

  it("refuses meta tools even when the allowlist names them", async () => {
    const aliases = ["executeWrite", "atlassian.executeWrite", "confluence-executeWrite", "x.y.discover"];
    const opened = await open(
      [ALLOWED_TOOL, ...aliases],
      { seats: [{ allowlist: [ALLOWED_TOOL, ...aliases] }] },
    );
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
  });

  it("refuses a meta tool added to the catalogue after the allowlist was written", async () => {
    const opened = await open([ALLOWED_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.companyId, opened.companyId));
    await insertCatalogTool(db, opened.companyId, application!.id, opened.connectionId, "atlassian.executeWrite");
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
  });

  it("does not treat a name that merely contains a meta segment as a meta tool", async () => {
    const neighbour = "notesOnExecuteWrite";
    const opened = await open(
      [ALLOWED_TOOL, neighbour],
      { seats: [{ allowlist: [ALLOWED_TOOL, neighbour] }] },
    );
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL, neighbour].sort());
  });

  it("intersects company and agent allowlists instead of unioning them", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], {
      companyAllowlist: [OTHER_TOOL],
      seats: [{ allowlist: [ALLOWED_TOOL] }],
    });
    expect(await upstreamNames(opened)).toEqual([]);
    expect(await reasonCount(db, opened.companyId, BRAKE.reasonAllowlistDenied)).toBeGreaterThan(0);
  });

  it("does not apply a company allowlist to an agent that has its own", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], {
      companyAllowlist: [ALLOWED_TOOL, OTHER_TOOL],
      seats: [
        { allowlist: [ALLOWED_TOOL] },
        {},
      ],
    });
    expect(await upstreamNames(opened, opened.seats[0]!)).toEqual([ALLOWED_TOOL]);
    expect(await upstreamNames(opened, opened.seats[1]!)).toEqual([ALLOWED_TOOL, OTHER_TOOL].sort());
  });

  it("does not let a request or session parameter widen the allowlist", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const seat = opened.seats[0]!;
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId: seat.issueId,
        projectId: seat.projectId,
        allowedTools: [OTHER_TOOL],
        connectionToolAllowlist: [ALLOWED_TOOL, OTHER_TOOL],
      },
    }).where(eq(heartbeatRuns.id, seat.runId));
    expect(await upstreamNames(opened, seat, { "x-connection-tool-allowlist": OTHER_TOOL })).toEqual([ALLOWED_TOOL]);
    const denied = await callTool(opened, OTHER_TOOL, {
      connectionToolAllowlist: [ALLOWED_TOOL, OTHER_TOOL],
      allowTools: [OTHER_TOOL],
    });
    expect(denied.status).toBe(403);
    expect(denied.reasonCode).toBe(BRAKE.reasonAllowlistDenied);
    expect(denied.upstreamDelta).toBe(0);
  });

  it("does not let an allow policy add a tool the allowlist does not name", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    await db.insert(toolPolicies).values({
      companyId: opened.companyId,
      name: `Allow all ${randomUUID()}`,
      policyType: "allow",
      selectors: {},
    });
    const names = await upstreamNames(opened);
    expect(names).toContain(ALLOWED_TOOL);
    expect(names).not.toContain(OTHER_TOOL);
  });

  it("does not let a tools:use principal grant add a tool the allowlist does not name", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    await db.insert(principalPermissionGrants).values({
      companyId: opened.companyId,
      principalType: "agent",
      principalId: opened.seats[0]!.agentId,
      permissionKey: "tools:use",
      scope: null,
      grantedByUserId: "owner",
    });
    const names = await upstreamNames(opened);
    expect(names).toContain(ALLOWED_TOOL);
    expect(names).not.toContain(OTHER_TOOL);
  });

  it("does not let a trust rule add a tool the allowlist does not name", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    await db.insert(toolPolicies).values({
      companyId: opened.companyId,
      name: `Trust all ${randomUUID()}`,
      policyType: "trust_rule",
      selectors: {},
      config: { trustRule: { hitCount: 0 } },
    });
    const names = await upstreamNames(opened);
    expect(names).toContain(ALLOWED_TOOL);
    expect(names).not.toContain(OTHER_TOOL);
  });

  it("re-checks the allowlist at call time", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
    const denied = await callTool(opened, OTHER_TOOL, { message: "forged" });
    expect(denied.status).toBe(403);
    expect(denied.reasonCode).toBe(BRAKE.reasonAllowlistDenied);
    expect(denied.upstreamDelta).toBe(0);
  });

  it("refuses a meta tool at call time even when the allowlist names it", async () => {
    const opened = await open(
      [ALLOWED_TOOL, "executeWrite"],
      { seats: [{ allowlist: [ALLOWED_TOOL, "executeWrite"] }] },
    );
    const denied = await callTool(opened, "executeWrite", { message: "meta" });
    expect(denied.status).toBe(403);
    expect(denied.reasonCode).toBe(BRAKE.reasonMetaTool);
    expect(denied.upstreamDelta).toBe(0);
  });

  it("keeps today's behaviour when the connection has no brake profile", async () => {
    const catalogue = [...PUBLISHED_ATLASSIAN_TOOL_NAMES, ...META_TOOL_NAMES];
    const opened = await open(catalogue, { seats: [{}] });
    expect(await upstreamNames(opened)).toEqual([...catalogue].sort());
  });

  it("refuses a catalogue tool that was not on the allowlist when the catalogue grew", async () => {
    const opened = await open([ALLOWED_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.companyId, opened.companyId));
    await insertCatalogTool(db, opened.companyId, application!.id, opened.connectionId, OTHER_TOOL);
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
  });
});

