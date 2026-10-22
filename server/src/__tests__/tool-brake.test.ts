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
import { boundedMcpToolName, MAX_GATEWAY_TOOL_NAME_LENGTH } from "../services/mcp-tool-names.js";
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
 * The 41 raw tool_catalog_entries.tool_name values from the DIG-2745 fixture
 * dig2745-atlassian-tools-fixture-2026-10-22.json. The allowlist keys on these
 * spellings. The string the gateway hands the model is a different one.
 */
const ATLASSIAN_RAW_TOOL_NAMES = [
  "addCommentToJiraIssue",
  "addTeamworkGraphContext",
  "addWorklogToJiraIssue",
  "atlassianUserInfo",
  "createCompassComponent",
  "createCompassComponentRelationship",
  "createCompassCustomFieldDefinition",
  "createConfluenceFooterComment",
  "createConfluenceInlineComment",
  "createConfluencePage",
  "createIssueLink",
  "createJiraIssue",
  "editJiraIssue",
  "fetch",
  "getAccessibleAtlassianResources",
  "getCompassComponent",
  "getCompassComponents",
  "getCompassCustomFieldDefinitions",
  "getConfluenceCommentChildren",
  "getConfluencePage",
  "getConfluencePageDescendants",
  "getConfluencePageFooterComments",
  "getConfluencePageInlineComments",
  "getConfluenceSpaces",
  "getContentFormatGuide",
  "getIssueLinkTypes",
  "getJiraIssue",
  "getJiraIssueRemoteIssueLinks",
  "getJiraIssueTypeMetaWithFields",
  "getJiraProjectIssueTypesMetadata",
  "getPagesInConfluenceSpace",
  "getTeamworkGraphContext",
  "getTeamworkGraphObject",
  "getTransitionsForJiraIssue",
  "getVisibleJiraProjects",
  "lookupJiraAccountId",
  "search",
  "searchConfluenceUsingCql",
  "searchJiraIssuesUsingJql",
  "transitionJiraIssue",
  "updateConfluencePage",
] as const;

const MEASURED_APPLICATION_KEY = "app-gallery-jira-ea4753df-3235-4f68-89cb-ccf3e80bf479";
const MEASURED_CONNECTION_ID = "b20116ec-a6fd-41f1-9c70-ef341b9bbcc7";
const MEASURED_PRESENTED_ADD_COMMENT = "mcp.app-gallery-jira-ea4753df-3235-4f68-89cb-ccf3e80bf479-b20116ec:addcommenttojiraissue";
const MEASURED_PRESENTED_LONGEST = "mcp.app-gallery-jira-ea4753df-3235-4f68-89cb-ccf3e80bf479-b20116ec:createcompasscomponentrelationship";
const LONGEST_RAW_NAME = "createCompassComponentRelationship";
const GATEWAY_RESOURCE_TOOLS = ["paperclip_list_resources", "paperclip_read_resource"] as const;

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
  applicationId: string;
  applicationKey: string;
  gatewayProfileId: string;
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
  connectionId: string,
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
  await db.insert(toolProfileEntries).values({
    companyId,
    profileId: profile!.id,
    selectorType: "connection",
    effect: "include",
    connectionId,
  });
  return profile!;
}

async function openCatalogue(
  db: Db,
  toolNames: readonly string[],
  options: {
    seats?: Array<{ allowlist?: Allowlist }>;
    companyAllowlist?: Allowlist;
    applicationKey?: string;
    connectionId?: string;
  } = {},
): Promise<Opened> {
  const company = await createCompany(db);
  const remote = await startFakeRemoteMcpServer();
  const applicationKey = options.applicationKey ?? "atlassian";
  const [application] = await db.insert(toolApplications).values({
    companyId: company.id,
    applicationKey,
    name: `Atlassian ${randomUUID()}`,
    type: "mcp_http",
    status: "active",
  }).returning();
  const [connection] = await db.insert(toolConnections).values({
    ...(options.connectionId ? { id: options.connectionId } : {}),
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
    await insertBrake(db, company.id, "company", company.id, options.companyAllowlist, connection!.id);
  }
  const gateway = createTestToolGatewayService(db);
  const seatSpecs = options.seats ?? [{ allowlist: [ALLOWED_TOOL] as Allowlist }];
  const seats: Seat[] = [];
  for (const spec of seatSpecs) {
    const agent = await createAgent(db, company.id);
    const { issue, project, run } = await createIssueAndRun(db, company.id, agent.id);
    if (spec.allowlist !== undefined) {
      await insertBrake(db, company.id, "agent", agent.id, spec.allowlist, connection!.id);
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
    applicationId: application!.id,
    applicationKey,
    gatewayProfileId: gatewayProfile!.id,
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

  it("offers exactly the one allowlisted raw name from the 41-tool catalogue plus meta tools", async () => {
    const catalogue = [...ATLASSIAN_RAW_TOOL_NAMES, ...META_TOOL_NAMES];
    const opened = await open(catalogue, { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const tools = await opened.gateway.listToolsForNamedGateway({
      gatewayId: opened.seats[0]!.gatewayId,
      bearerToken: opened.seats[0]!.token,
    });
    expect(tools.map((tool) => tool.upstreamToolName).sort()).toEqual([ALLOWED_TOOL]);
    expect(tools.map((tool) => tool.name)).toEqual([mangled(opened, ALLOWED_TOOL)]);
    for (const resource of GATEWAY_RESOURCE_TOOLS) {
      expect(tools.map((tool) => tool.name)).not.toContain(resource);
      expect(tools.map((tool) => tool.upstreamToolName)).not.toContain(resource);
    }
    const allowed = await callTool(opened, ALLOWED_TOOL, { message: "ok" });
    expect(allowed.status).toBe(200);
    expect(allowed.upstreamDelta).toBe(1);
  });

  it("hands the model the prefixed presented name and matches the allowlist on the raw name", async () => {
    const opened = await open([ALLOWED_TOOL, LONGEST_RAW_NAME], {
      applicationKey: MEASURED_APPLICATION_KEY,
      connectionId: MEASURED_CONNECTION_ID,
      seats: [{ allowlist: [ALLOWED_TOOL, LONGEST_RAW_NAME] }],
    });
    const tools = await opened.gateway.listToolsForNamedGateway({
      gatewayId: opened.seats[0]!.gatewayId,
      bearerToken: opened.seats[0]!.token,
    });
    const byRaw = new Map(tools.map((tool) => [tool.upstreamToolName, tool.name]));
    expect(byRaw.get(ALLOWED_TOOL)).toBe(MEASURED_PRESENTED_ADD_COMMENT);
    expect(byRaw.get(LONGEST_RAW_NAME)).toBe(MEASURED_PRESENTED_LONGEST);
    expect(MEASURED_PRESENTED_LONGEST.length).toBe(101);
    expect(MEASURED_PRESENTED_LONGEST.length).toBeLessThanOrEqual(MAX_GATEWAY_TOOL_NAME_LENGTH);
    expect(MEASURED_PRESENTED_LONGEST).toBe(boundedMcpToolName(MEASURED_PRESENTED_LONGEST, [MEASURED_CONNECTION_ID]));
  });

  it("does not let the presented name or its lower-case tail satisfy a raw-name entry", async () => {
    const opened = await open([ALLOWED_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const presented = mangled(opened, ALLOWED_TOOL);
    const tail = "addcommenttojiraissue";
    expect(presented.endsWith(`:${tail}`)).toBe(true);
    expect(await upstreamNames(opened)).toEqual([ALLOWED_TOOL]);
    const profiles = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, opened.companyId));
    for (const profile of profiles) {
      const metadata = (profile.metadata ?? {}) as Record<string, unknown>;
      if (metadata[BRAKE.profileFlag] !== true) continue;
      await db.update(toolProfiles).set({
        metadata: { ...metadata, [BRAKE.allowlistKey]: [presented, tail, "add_comment_to_jira_issue", "AddCommentToJiraIssue"] },
      }).where(eq(toolProfiles.id, profile.id));
    }
    expect(await upstreamNames(opened)).toEqual([]);
  });

  it("does not let a truncated hashed presented name satisfy a raw-name entry", async () => {
    const opened = await open([ALLOWED_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const overlong = `${"m".repeat(MAX_GATEWAY_TOOL_NAME_LENGTH)}:addcommenttojiraissue`;
    const hashed = boundedMcpToolName(overlong, [opened.connectionId, ALLOWED_TOOL]);
    expect(overlong.length).toBeGreaterThan(MAX_GATEWAY_TOOL_NAME_LENGTH);
    expect(hashed).not.toBe(overlong);
    expect(hashed).not.toBe(ALLOWED_TOOL);
    const profiles = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, opened.companyId));
    for (const profile of profiles) {
      const metadata = (profile.metadata ?? {}) as Record<string, unknown>;
      if (metadata[BRAKE.profileFlag] !== true) continue;
      await db.update(toolProfiles).set({
        metadata: { ...metadata, [BRAKE.allowlistKey]: [hashed] },
      }).where(eq(toolProfiles.id, profile.id));
    }
    expect(await upstreamNames(opened)).toEqual([]);
  });

  it("intersects allowlists per connection, so a second connection on the same seat keeps its own names", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const [existing] = await db.select().from(toolConnections).where(eq(toolConnections.id, opened.connectionId));
    const url = (existing!.config as { url: string }).url;
    const [second] = await db.insert(toolConnections).values({
      companyId: opened.companyId,
      applicationId: opened.applicationId,
      name: `Second ${randomUUID()}`,
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { url },
      transportConfig: { url },
      credentialRefs: [],
      credentialSecretRefs: [],
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: opened.companyId,
      connectionId: second!.id,
      kind: "organization",
      credentialSecretRefs: [],
      status: "active",
      isDefault: false,
    });
    for (const toolName of [ALLOWED_TOOL, OTHER_TOOL]) {
      await insertCatalogTool(db, opened.companyId, opened.applicationId, second!.id, toolName);
    }
    await db.insert(toolProfileEntries).values({
      companyId: opened.companyId,
      profileId: opened.gatewayProfileId,
      selectorType: "connection",
      effect: "include",
      applicationId: opened.applicationId,
      connectionId: second!.id,
    });
    await insertBrake(db, opened.companyId, "agent", opened.seats[0]!.agentId, [OTHER_TOOL], second!.id);
    const [unscoped] = await db.insert(toolProfiles).values({
      companyId: opened.companyId,
      profileKey: `unscoped-${randomUUID()}`,
      name: `Unscoped ${randomUUID()}`,
      defaultAction: "deny",
      metadata: { [BRAKE.profileFlag]: true, [BRAKE.allowlistKey]: [] },
    }).returning();
    await db.insert(toolProfileBindings).values({
      companyId: opened.companyId,
      profileId: unscoped!.id,
      targetType: "agent",
      targetId: opened.seats[0]!.agentId,
    });
    const tools = await opened.gateway.listToolsForNamedGateway({
      gatewayId: opened.seats[0]!.gatewayId,
      bearerToken: opened.seats[0]!.token,
    });
    const namesOn = (connectionId: string) => tools
      .filter((tool) => tool.connectionId === connectionId)
      .map((tool) => tool.upstreamToolName)
      .sort();
    expect(namesOn(opened.connectionId)).toEqual([ALLOWED_TOOL]);
    expect(namesOn(second!.id)).toEqual([OTHER_TOOL]);
  });

  it("returns the same presented names for the same seat, connection, and catalogue", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], { seats: [{ allowlist: [ALLOWED_TOOL] }] });
    const read = async () => {
      const tools = await opened.gateway.listToolsForNamedGateway({
        gatewayId: opened.seats[0]!.gatewayId,
        bearerToken: opened.seats[0]!.token,
      });
      return tools.map((tool) => `${tool.connectionId}:${tool.upstreamToolName}:${tool.name}`).sort();
    };
    expect(await read()).toEqual(await read());
  });

  // DIG-5208 publishes the fleet inventory and enables this assertion.
  it.todo("matches the DIG-5208 inventory byte-exact on the raw name after the flip");

  it("refuses an absent allowlist loudly and records allowlist_absent per tool", async () => {
    const opened = await open(ATLASSIAN_RAW_TOOL_NAMES, { seats: [{ allowlist: "absent" }] });
    const response = await request(opened.app)
      .post(opened.seats[0]!.endpointPath)
      .set("authorization", `Bearer ${opened.seats[0]!.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(403);
    expect(response.body.error.data.reasonCode).toBe(BRAKE.reasonAllowlistAbsent);
    expect(response.body.result?.tools).toBeUndefined();
    expect(await reasonCount(db, opened.companyId, BRAKE.reasonAllowlistAbsent)).toBe(ATLASSIAN_RAW_TOOL_NAMES.length);
  });

  it("refuses an empty allowlist loudly and records allowlist_empty per tool", async () => {
    const opened = await open(ATLASSIAN_RAW_TOOL_NAMES, { seats: [{ allowlist: [] }] });
    const response = await request(opened.app)
      .post(opened.seats[0]!.endpointPath)
      .set("authorization", `Bearer ${opened.seats[0]!.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(403);
    expect(response.body.error.data.reasonCode).toBe(BRAKE.reasonAllowlistEmpty);
    expect(await reasonCount(db, opened.companyId, BRAKE.reasonAllowlistEmpty)).toBe(ATLASSIAN_RAW_TOOL_NAMES.length);
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
    const opened = await open([ALLOWED_TOOL], {
      seats: [{ allowlist: [ALLOWED_TOOL, "atlassian.executeWrite"] }],
    });
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

  it("re-checks the allowlist before an approved call reaches upstream", async () => {
    const opened = await open([ALLOWED_TOOL, OTHER_TOOL], {
      seats: [{ allowlist: [ALLOWED_TOOL, OTHER_TOOL] }],
    });
    const otherName = mangled(opened, OTHER_TOOL);
    await db.insert(toolPolicies).values({
      companyId: opened.companyId,
      name: `Review ${randomUUID()}`,
      policyType: "require_approval",
      selectors: { toolName: otherName },
    });
    const pending = await callTool(opened, OTHER_TOOL, { message: "reviewed" });
    expect([pending.status, pending.reasonCode]).toEqual([409, "approval_required"]);
    const [actionRequest] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, opened.companyId));
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, opened.companyId));
    await db.update(issueThreadInteractions).set({
      status: "accepted",
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(issueThreadInteractions.id, interaction!.id));
    const profiles = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, opened.companyId));
    for (const profile of profiles) {
      const metadata = (profile.metadata ?? {}) as Record<string, unknown>;
      if (metadata[BRAKE.profileFlag] !== true) continue;
      await db.update(toolProfiles).set({
        metadata: { ...metadata, [BRAKE.allowlistKey]: [ALLOWED_TOOL] },
      }).where(eq(toolProfiles.id, profile.id));
    }
    const before = opened.remote.requests.length;
    await expect(opened.gateway.executeTool({
      sessionToken: opened.seats[0]!.token,
      tool: otherName,
      approvedActionRequestId: actionRequest!.id,
      parameters: { message: "reviewed" },
    })).rejects.toMatchObject({ reasonCode: BRAKE.reasonAllowlistDenied });
    expect(opened.remote.requests.length - before).toBe(0);
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
    const catalogue = [...ATLASSIAN_RAW_TOOL_NAMES, ...META_TOOL_NAMES];
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

