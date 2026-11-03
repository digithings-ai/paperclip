import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  decisions,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged decision continuation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import {
  createSweepLogThrottle,
  decisionService,
  decodeSweepCursorTimestamp,
  encodeSweepCursorTimestamp,
} from "../services/decisions.ts";
import { createDecisionWakeOriginAgent } from "../services/decision-wakeup.ts";
import { runStartupDecisionSweep } from "../startup-heartbeat-recovery.ts";
import { runningProcesses } from "../adapters/index.ts";
import { logger } from "../middleware/logger.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SKIP_MESSAGE = "decision continuation skipped for non-invokable origin agent - continuation stays pending";
const FAILED_MESSAGE = "decision continuation delivery failed - continuation stays pending";
const SUMMARY_MESSAGE = "decision expiry sweep left continuations pending";

type AgentStatus = "idle" | "paused" | "terminated" | "pending_approval";

describeEmbeddedPostgres("decision expiry sweep with non-invokable origin agents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-continuation-invokability-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    vi.restoreAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(decisions);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(agentTaskSessions);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      membershipRole: "owner",
      status: "active",
    });
    return companyId;
  }

  let issueNumber = 0;
  async function seedOriginAgent(companyId: string, status: AgentStatus, reportsTo: string | null = null) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    issueNumber += 1;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Origin agent ${status}`,
      role: "engineer",
      status,
      reportsTo,
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Synthetic origin issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber,
      identifier: `DEC-${issueNumber}`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    return { companyId, agentId, issueId, runId };
  }

  type Origin = Awaited<ReturnType<typeof seedOriginAgent>>;

  // An expired decision whose continuation was never delivered (for example,
  // the wake failed before a restart).
  async function seedPendingExpiredDecision(origin: Origin, updatedAt?: Date) {
    const [row] = await db.insert(decisions).values({
      ...(updatedAt ? { updatedAt } : {}),
      companyId: origin.companyId,
      originAgentId: origin.agentId,
      originIssueId: origin.issueId,
      originRunId: origin.runId,
      title: "Expired decision",
      body: "Body",
      options: [],
      status: "expired",
      expiresAt: new Date(Date.now() - 60_000),
      signedSpec: "unused-by-the-sweep",
      targetSnapshots: {},
      continuationPolicy: "wake_origin_agent",
      metadata: { expiredReason: "ttl", continuationPending: true },
    }).returning();
    return row!;
  }

  // An open decision past its expiresAt: the sweep expires it and then wakes
  // the origin agent in the same pass.
  async function seedOpenPastExpiryDecision(origin: Origin) {
    const [row] = await db.insert(decisions).values({
      companyId: origin.companyId,
      originAgentId: origin.agentId,
      originIssueId: origin.issueId,
      originRunId: origin.runId,
      title: "Open decision past its expiry",
      body: "Body",
      options: [],
      status: "open",
      expiresAt: new Date(Date.now() - 60_000),
      signedSpec: "unused-by-the-sweep",
      targetSnapshots: {},
      continuationPolicy: "wake_origin_agent",
      metadata: {},
    }).returning();
    return row!;
  }

  function realWake() {
    const heartbeat = heartbeatService(db);
    return createDecisionWakeOriginAgent((agentId, options) => heartbeat.wakeup(agentId, options));
  }

  async function storedMetadata(decisionId: string) {
    const [row] = await db
      .select({ status: decisions.status, metadata: decisions.metadata })
      .from(decisions)
      .where(eq(decisions.id, decisionId));
    return row!;
  }

  async function wakeCount(agentId: string) {
    const rows = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return rows.length;
  }

  for (const status of ["paused", "terminated", "pending_approval"] as const) {
    it(`keeps a ${status} origin agent's continuations pending and lets the startup sweep complete`, async () => {
      const warn = vi.spyOn(logger, "warn");
      const error = vi.spyOn(logger, "error");
      const companyId = await seedCompany();
      const parked = await seedOriginAgent(companyId, status);
      const pendingExpired = await seedPendingExpiredDecision(parked);
      const openPastExpiry = await seedOpenPastExpiryDecision(parked);
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const result = await service.sweepExpired();

      // The already-pending continuation is left out of the query (parked
      // origin), and the newly expired one is caught by the pre-check.
      expect(result).toMatchObject({
        expired: 1,
        resumed: 0,
        continuationsDelivered: 0,
        continuationsNotInvokableSkipped: 1,
        continuationsFailed: 0,
      });
      expect(await storedMetadata(pendingExpired.id)).toMatchObject({
        status: "expired",
        metadata: { continuationPending: true },
      });
      expect(await storedMetadata(openPastExpiry.id)).toMatchObject({
        status: "expired",
        metadata: { continuationPending: true, expiredReason: "ttl" },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ decisionId: openPastExpiry.id, agentId: parked.agentId, reason: status }),
        SKIP_MESSAGE,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ continuationsNotInvokableSkipped: 1 }),
        SUMMARY_MESSAGE,
      );
      // The skip happens before the wake, so no wakeup-request row is written.
      expect(await wakeCount(parked.agentId)).toBe(0);

      // The startup call completes too, and the continuations stay pending
      // for a later sweep once the agent is invokable again.
      await expect(runStartupDecisionSweep({ decisions: service, logger })).resolves.toBe(true);
      expect(error).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("startup decision expiry sweep failed"));
      expect(await storedMetadata(pendingExpired.id)).toMatchObject({ metadata: { continuationPending: true } });
      expect(await storedMetadata(openPastExpiry.id)).toMatchObject({ metadata: { continuationPending: true } });
      expect(await wakeCount(parked.agentId)).toBe(0);
    });
  }

  it("still wakes and acknowledges an active origin agent in the same sweep as a paused one", async () => {
    const companyId = await seedCompany();
    const parked = await seedOriginAgent(companyId, "paused");
    const active = await seedOriginAgent(companyId, "idle");
    const parkedDecision = await seedPendingExpiredDecision(parked);
    const activeDecision = await seedPendingExpiredDecision(active);
    const activeOpenDecision = await seedOpenPastExpiryDecision(active);

    const result = await decisionService(db, { wakeOriginAgent: realWake() }).sweepExpired();

    // The paused agent's pending continuation is left out of the query.
    expect(result).toMatchObject({
      expired: 1,
      continuationsDelivered: 2,
      continuationsNotInvokableSkipped: 0,
      continuationsFailed: 0,
    });
    expect(await wakeCount(parked.agentId)).toBe(0);
    expect(await storedMetadata(parkedDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
    expect(await storedMetadata(activeOpenDecision.id)).toMatchObject({
      status: "expired",
      metadata: { continuationPending: false },
    });
    expect((await storedMetadata(activeDecision.id)).metadata).toHaveProperty("continuationDeliveredAt");
    expect(await wakeCount(active.agentId)).toBeGreaterThanOrEqual(1);
  });

  it("logs a non-409 wake error on one decision and still delivers the others", async () => {
    const error = vi.spyOn(logger, "error");
    const companyId = await seedCompany();
    const broken = await seedOriginAgent(companyId, "idle");
    const active = await seedOriginAgent(companyId, "idle");
    const brokenDecision = await seedPendingExpiredDecision(broken);
    const activeDecision = await seedPendingExpiredDecision(active);
    const wake = realWake();

    const result = await decisionService(db, {
      wakeOriginAgent: async (input) => {
        if (input.agentId === broken.agentId) throw new Error("simulated wake failure");
        return wake(input);
      },
    }).sweepExpired();

    expect(result).toMatchObject({
      continuationsDelivered: 1,
      continuationsNotInvokableSkipped: 0,
      continuationsFailed: 1,
    });
    expect(await storedMetadata(brokenDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: brokenDecision.id, agentId: broken.agentId }),
      FAILED_MESSAGE,
    );
  });

  it("throttles the non-409 delivery ERROR per decision across sweeps", async () => {
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const companyId = await seedCompany();
    const broken = await seedOriginAgent(companyId, "idle");
    const brokenDecision = await seedPendingExpiredDecision(broken);
    const service = decisionService(db, {
      wakeOriginAgent: async () => {
        throw new Error("simulated wake failure");
      },
    });

    const first = await service.sweepExpired();
    const second = await service.sweepExpired();

    expect(first).toMatchObject({ continuationsDelivered: 0, continuationsFailed: 1 });
    expect(second).toMatchObject({ continuationsDelivered: 0, continuationsFailed: 1 });
    expect(await storedMetadata(brokenDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    const failureLines = error.mock.calls.filter(([, message]) => message === FAILED_MESSAGE);
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]![0]).toMatchObject({ decisionId: brokenDecision.id });
    expect(warn.mock.calls.filter(([, message]) => message === SUMMARY_MESSAGE)).toHaveLength(1);
  });

  describe("sweep cursor timestamp encoding", () => {
    async function inSession<T>(dateStyle: string, timeZone: string, query: ReturnType<typeof sql>) {
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL DateStyle = '${dateStyle}'`));
        await tx.execute(sql.raw(`SET LOCAL TimeZone = '${timeZone}'`));
        const rows = await tx.execute(query);
        return (rows as unknown as Array<Record<string, T>>)[0]!;
      });
    }

    it("encodes the same UTC ISO string under any DateStyle and TimeZone, with microseconds", async () => {
      const literal = sql`'2026-11-03 14:00:00.123456+00'::timestamptz`;
      const expected = "2026-11-03T14:00:00.123456Z";
      for (const [dateStyle, timeZone] of [["ISO, MDY", "UTC"], ["SQL, DMY", "America/New_York"], ["German, DMY", "Asia/Tokyo"], ["Postgres, MDY", "Europe/Rome"]]) {
        const row = await inSession<string>(dateStyle!, timeZone!, sql`select ${encodeSweepCursorTimestamp(literal)} as encoded, (${literal})::text as plain`);
        expect(row.encoded).toBe(expected);
        if (dateStyle !== "ISO, MDY") expect(row.plain).not.toBe(row.encoded);
      }
      const whole = await inSession<string>("SQL, DMY", "UTC", sql`select ${encodeSweepCursorTimestamp(sql`'2026-11-03 14:00:00+00'::timestamptz`)} as encoded`);
      expect(whole.encoded).toBe("2026-11-03T14:00:00.000000Z");
    });

    it("decodes back to the exact timestamp in another DateStyle, and keeps equal timestamps ordered by id", async () => {
      const encoded = (await inSession<string>("SQL, DMY", "America/New_York",
        sql`select ${encodeSweepCursorTimestamp(sql`'2026-11-03 14:00:00.000001+00'::timestamptz`)} as encoded`)).encoded!;
      expect(encoded).toBe("2026-11-03T14:00:00.000001Z");
      const lowId = "00000000-0000-0000-0000-000000000001";
      const highId = "00000000-0000-0000-0000-000000000002";
      for (const [dateStyle, timeZone] of [["ISO, MDY", "UTC"], ["German, DMY", "Asia/Tokyo"], ["SQL, DMY", "Pacific/Auckland"]]) {
        const row = await inSession<boolean>(dateStyle!, timeZone!, sql`select
          ${decodeSweepCursorTimestamp(encoded)} = '2026-11-03 14:00:00.000001+00'::timestamptz as exact,
          ${decodeSweepCursorTimestamp(encoded)} > '2026-11-03 14:00:00+00'::timestamptz as after_previous_microsecond,
          ('2026-11-03 14:00:00.000001+00'::timestamptz, ${highId}::uuid) > (${decodeSweepCursorTimestamp(encoded)}, ${lowId}::uuid) as equal_ts_higher_id_after,
          ('2026-11-03 14:00:00.000001+00'::timestamptz, ${lowId}::uuid) > (${decodeSweepCursorTimestamp(encoded)}, ${lowId}::uuid) as equal_ts_same_id_after`);
        expect(row).toMatchObject({
          exact: true,
          after_previous_microsecond: true,
          equal_ts_higher_id_after: true,
          equal_ts_same_id_after: false,
        });
      }
    });
  });
  describe("with a small sweep batch", () => {
    const previousBatchSize = process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
    beforeAll(() => {
      process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "3";
    });
    afterAll(() => {
      if (previousBatchSize === undefined) delete process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
      else process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = previousBatchSize;
    });

    it("does not let more than a batch of parked continuations starve an active one", async () => {
      const warn = vi.spyOn(logger, "warn");
      const companyId = await seedCompany();
      const statuses = ["paused", "terminated", "pending_approval", "paused", "terminated"] as const;
      const parkedOrigins: Origin[] = [];
      const parkedDecisions: Array<{ id: string }> = [];
      for (const [index, status] of statuses.entries()) {
        const origin = await seedOriginAgent(companyId, status);
        parkedOrigins.push(origin);
        // Older than the active row, so they sort first by updated_at.
        parkedDecisions.push(await seedPendingExpiredDecision(origin, new Date(Date.now() - (60 - index) * 60_000)));
      }
      const active = await seedOriginAgent(companyId, "idle");
      const activeDecision = await seedPendingExpiredDecision(active, new Date());
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const result = await service.sweepExpired();

      expect(result).toMatchObject({
        continuationsDelivered: 1,
        continuationsNotInvokableSkipped: 0,
        continuationsFailed: 0,
      });
      expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
      for (const decision of parkedDecisions) {
        expect(await storedMetadata(decision.id)).toMatchObject({ metadata: { continuationPending: true } });
      }

      // Repeated ticks write no wake rows and no WARN for the parked rows.
      await service.sweepExpired();
      await service.sweepExpired();
      for (const origin of parkedOrigins) expect(await wakeCount(origin.agentId)).toBe(0);
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), SKIP_MESSAGE);
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), SUMMARY_MESSAGE);
    });

    it("pages rows that share one microsecond updated_at by id, and still reaches the active one within 2 sweeps", async () => {
      const companyId = await seedCompany();
      const manager = await seedOriginAgent(companyId, "terminated");
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const orphan = await seedOriginAgent(companyId, "idle", manager.agentId);
        ids.push((await seedPendingExpiredDecision(orphan)).id);
      }
      const active = await seedOriginAgent(companyId, "idle");
      const activeDecision = await seedPendingExpiredDecision(active);
      ids.push(activeDecision.id);
      for (const id of ids) {
        await db.update(decisions).set({ updatedAt: sql`'2026-11-03 13:00:00.654321+00'::timestamptz` }).where(eq(decisions.id, id));
      }
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const first = await service.sweepExpired();
      const second = await service.sweepExpired();

      expect(first.continuationsDelivered + second.continuationsDelivered).toBe(1);
      expect(first.continuationsNotInvokableSkipped + second.continuationsNotInvokableSkipped).toBe(3);
      expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });
    });

    function runningDecisionValues(origin: Origin, chosenOptionId: string, updatedAt: Date) {
      return {
        companyId: origin.companyId,
        originAgentId: origin.agentId,
        originIssueId: origin.issueId,
        originRunId: origin.runId,
        title: "Decided decision with effects in flight",
        body: "Body",
        options: [{ id: "ok", label: "OK", effects: [] }] as unknown as (typeof decisions.$inferInsert)["options"],
        status: "decided" as const,
        executionStatus: "running" as const,
        chosenOptionId,
        decidedByUserId: "owner-user",
        decidedAt: updatedAt,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        signedSpec: "unused-by-the-sweep",
        targetSnapshots: {},
        continuationPolicy: "wake_origin_agent" as const,
        metadata: { continuationPending: true },
        updatedAt,
      };
    }

    it("moves the pending-continuation cursor past broken-chain rows so an active one is delivered within 2 sweeps", async () => {
      const companyId = await seedCompany();
      const manager = await seedOriginAgent(companyId, "terminated");
      const orphans: Origin[] = [];
      const orphanDecisions: Array<{ id: string }> = [];
      for (let index = 0; index < 4; index += 1) {
        const orphan = await seedOriginAgent(companyId, "idle", manager.agentId);
        orphans.push(orphan);
        orphanDecisions.push(await seedPendingExpiredDecision(orphan, new Date(Date.now() - (60 - index) * 60_000)));
      }
      const active = await seedOriginAgent(companyId, "idle");
      const activeDecision = await seedPendingExpiredDecision(active, new Date());
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const first = await service.sweepExpired();
      expect(first).toMatchObject({ continuationsDelivered: 0, continuationsNotInvokableSkipped: 3 });
      const second = await service.sweepExpired();
      expect(second).toMatchObject({ continuationsDelivered: 1, continuationsNotInvokableSkipped: 1 });
      expect(await storedMetadata(activeDecision.id)).toMatchObject({ metadata: { continuationPending: false } });

      // The short batch wrapped the cursor, so the next sweep starts over.
      const third = await service.sweepExpired();
      expect(third).toMatchObject({ continuationsDelivered: 0, continuationsNotInvokableSkipped: 3 });
      for (const decision of orphanDecisions) {
        expect(await storedMetadata(decision.id)).toMatchObject({ metadata: { continuationPending: true } });
      }
      for (const orphan of orphans) expect(await wakeCount(orphan.agentId)).toBe(0);
    });

    it("pages running recovery with a cursor and throttles the effect-recovery ERROR", async () => {
      const error = vi.spyOn(logger, "error");
      const warn = vi.spyOn(logger, "warn");
      const companyId = await seedCompany();
      const stuck: Array<{ id: string }> = [];
      for (let index = 0; index < 4; index += 1) {
        const origin = await seedOriginAgent(companyId, "idle");
        // The stored option is gone, so runEffects throws on every sweep.
        const [row] = await db.insert(decisions)
          .values(runningDecisionValues(origin, "missing-option", new Date(Date.now() - (60 - index) * 60_000))).returning();
        stuck.push(row!);
      }
      const healthyOrigin = await seedOriginAgent(companyId, "idle");
      const [healthy] = await db.insert(decisions)
        .values(runningDecisionValues(healthyOrigin, "ok", new Date(Date.now() - 10 * 60_000))).returning();
      const service = decisionService(db, { wakeOriginAgent: realWake() });

      const first = await service.sweepExpired();
      expect(first).toMatchObject({ resumed: 0, resumeFailed: 3 });
      const second = await service.sweepExpired();
      expect(second).toMatchObject({ resumed: 1, resumeFailed: 1, continuationsDelivered: 1 });
      expect(await storedMetadata(healthy!.id)).toMatchObject({ metadata: { continuationPending: false } });
      const third = await service.sweepExpired();
      expect(third).toMatchObject({ resumed: 0, resumeFailed: 3 });

      const recoveryErrors = error.mock.calls.filter(([, message]) =>
        message === "decision effect recovery failed - decision stays running, continuing with the next one");
      expect(recoveryErrors).toHaveLength(4);
      expect(new Set(recoveryErrors.map(([context]) => (context as { decisionId: string }).decisionId)))
        .toEqual(new Set(stuck.map((row) => row.id)));
      // The third sweep only re-failed already-logged rows, so it adds no WARN.
      expect(warn.mock.calls.filter(([, message]) => message === SUMMARY_MESSAGE)).toHaveLength(2);
    });
  });

  it("pre-checks a broken reporting chain: no wake row, and the skip log is throttled", async () => {
    const warn = vi.spyOn(logger, "warn");
    const companyId = await seedCompany();
    const manager = await seedOriginAgent(companyId, "terminated");
    const orphan = await seedOriginAgent(companyId, "idle", manager.agentId);
    const orphanDecision = await seedPendingExpiredDecision(orphan);
    const service = decisionService(db, { wakeOriginAgent: realWake() });

    const first = await service.sweepExpired();
    const second = await service.sweepExpired();

    expect(first).toMatchObject({ continuationsDelivered: 0, continuationsNotInvokableSkipped: 1, continuationsFailed: 0 });
    expect(second).toMatchObject({ continuationsDelivered: 0, continuationsNotInvokableSkipped: 1, continuationsFailed: 0 });
    expect(await storedMetadata(orphanDecision.id)).toMatchObject({ metadata: { continuationPending: true } });
    expect(await wakeCount(orphan.agentId)).toBe(0);
    const skipLines = warn.mock.calls.filter(([, message]) => message === SKIP_MESSAGE);
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]![0]).toMatchObject({ decisionId: orphanDecision.id, reason: "manager_terminated" });
    expect(warn.mock.calls.filter(([, message]) => message === SUMMARY_MESSAGE)).toHaveLength(1);
  });

  it("isolates runEffects per resumed decision: one failure is logged and the rest still run", async () => {
    const error = vi.spyOn(logger, "error");
    const companyId = await seedCompany();
    const brokenOrigin = await seedOriginAgent(companyId, "idle");
    const healthyOrigin = await seedOriginAgent(companyId, "idle");
    const staleUpdatedAt = new Date(Date.now() - 10 * 60_000);
    const runningDecision = (origin: Origin, chosenOptionId: string, updatedAt: Date) => ({
      companyId: origin.companyId,
      originAgentId: origin.agentId,
      originIssueId: origin.issueId,
      originRunId: origin.runId,
      title: "Decided decision with effects in flight",
      body: "Body",
      options: [{ id: "ok", label: "OK", effects: [] }] as unknown as (typeof decisions.$inferInsert)["options"],
      status: "decided" as const,
      executionStatus: "running" as const,
      chosenOptionId,
      decidedByUserId: "owner-user",
      decidedAt: updatedAt,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      signedSpec: "unused-by-the-sweep",
      targetSnapshots: {},
      continuationPolicy: "wake_origin_agent" as const,
      metadata: { continuationPending: true },
      updatedAt,
    });
    // The broken row sorts first and its stored option is gone, so runEffects throws.
    const [broken] = await db.insert(decisions)
      .values(runningDecision(brokenOrigin, "missing-option", new Date(staleUpdatedAt.getTime() - 60_000))).returning();
    const [healthy] = await db.insert(decisions)
      .values(runningDecision(healthyOrigin, "ok", staleUpdatedAt)).returning();

    const result = await decisionService(db, { wakeOriginAgent: realWake() }).sweepExpired();

    expect(result).toMatchObject({ resumed: 1, resumeFailed: 1, continuationsDelivered: 1, continuationsFailed: 0 });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: broken!.id }),
      "decision effect recovery failed - decision stays running, continuing with the next one",
    );
    const [brokenRow] = await db.select({ executionStatus: decisions.executionStatus }).from(decisions).where(eq(decisions.id, broken!.id));
    expect(brokenRow).toMatchObject({ executionStatus: "running" });
    expect(await storedMetadata(healthy!.id)).toMatchObject({ metadata: { continuationPending: false } });
    expect(await wakeCount(healthyOrigin.agentId)).toBeGreaterThanOrEqual(1);
  });
});

describe("createSweepLogThrottle", () => {
  it("logs each key at most once per interval", () => {
    let clock = 0;
    const throttle = createSweepLogThrottle({ intervalMs: 1_000, maxEntries: 10, now: () => clock });
    expect(throttle.shouldLog("a")).toBe(true);
    clock = 999;
    expect(throttle.shouldLog("a")).toBe(false);
    clock = 1_000;
    expect(throttle.shouldLog("a")).toBe(true);
    throttle.forget("a");
    expect(throttle.shouldLog("a")).toBe(true);
  });

  it("has a hard cap and evicts the oldest entries first", () => {
    let clock = 0;
    const throttle = createSweepLogThrottle({ intervalMs: 60_000, maxEntries: 3, now: () => clock });
    for (const key of ["a", "b", "c"]) {
      expect(throttle.shouldLog(key)).toBe(true);
      clock += 1;
    }
    expect(throttle.shouldLog("d")).toBe(true);
    expect(throttle.size).toBe(3);
    // "a" was the oldest and was evicted, so it logs again; that evicts "b".
    expect(throttle.shouldLog("a")).toBe(true);
    expect(throttle.size).toBe(3);
    expect(throttle.shouldLog("c")).toBe(false);
    expect(throttle.shouldLog("d")).toBe(false);
    expect(throttle.shouldLog("b")).toBe(true);
    for (let index = 0; index < 100; index += 1) throttle.shouldLog(`k${index}`);
    expect(throttle.size).toBe(3);
  });
});
