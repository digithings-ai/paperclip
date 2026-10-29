import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "@paperclipai/paperclip-runner";
import { NativeSessionProtocolIntegrityError } from "../../vendor/paperclip-runner/index.js";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { nativeSha256 } from "./canonical.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native run coordinator store tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A credential-shaped value. It is not a real token: the signature segment is
 * a fixed string, and the test only needs the shape that the redaction finds.
 */
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudCIsInNjb3BlIjoiYWdlbnQ6cnVuIn0.c2lnbmF0dXJlLXZhbHVl";

interface SeededNativeRun {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  runnerInstanceId: string;
  sessionId: string;
  completionContractId: string;
  completionContractSha256: string;
}

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: `The seat printed PAPERCLIP_API_KEY=${JWT}.`,
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [],
    remainingWork: [],
  },
  evidence: [{ kind: "log", ref: `PAPERCLIP_API_KEY=${JWT}` }],
  verification: [{ commandOrCheck: "coordinator store test", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

function runnerEvent(seed: SeededNativeRun, sourceSeq = 1): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `event-${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: seed.runnerInstanceId,
    sourceKind: "runner",
    runId: seed.runId,
    normalizedSessionId: seed.sessionId,
    turnId: "turn-1",
    itemId: "item-1",
    eventType: "turn.started",
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-25T18:00:00.000Z",
    payload: {},
  };
}

describeEmbeddedPostgres("native run coordinator store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-native-run-store-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedNativeRun(): Promise<SeededNativeRun> {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const runnerInstanceId = randomUUID();
    const sessionId = randomUUID();
    const completionContractId = randomUUID();
    const completionContractSha256 = `sha256:${"c".repeat(64)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Native store company",
      issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex runner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `NAT-${runId.slice(0, 8)}`,
      title: "Exercise the native run coordinator store",
      description: "Verify that the store redacts what it persists.",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: completionContractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "policy-v1",
      risk: "low",
      completionAuthority: "runner",
      incompleteCriteriaPolicy: "fail_closed",
      contractJson: { criteria: [] },
      canonicalSha256: completionContractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      runnerInstanceId,
      nativeSessionId: sessionId,
      driverKind: "codex",
      driverVersion: "0.3.0",
      completionContractId,
      completionContractSha256,
      nativePhase: "observed",
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    return {
      companyId,
      issueId,
      agentId,
      runId,
      runnerInstanceId,
      sessionId,
      completionContractId,
      completionContractSha256,
    };
  }

  function store(seed: SeededNativeRun): NativeRunCoordinatorStore {
    return new NativeRunCoordinatorStore(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      runId: seed.runId,
      agentId: seed.agentId,
      normalizedSessionId: seed.sessionId,
      runnerSourceInstanceId: seed.runnerInstanceId,
      completionContractId: seed.completionContractId,
      completionContractSha256: seed.completionContractSha256,
      completionContractRevision: "1",
      completionContractCriterionIds: [],
    });
  }

  it("redacts a credential in an event payload and in a result, and still reports a replay as a duplicate", async () => {
    const seed = await seedNativeRun();
    const nativeStore = store(seed);
    const event: PrpEvent = {
      ...runnerEvent(seed),
      payload: { output: `the seat printed PAPERCLIP_API_KEY=${JWT}` },
    };

    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "committed",
      cursor: 1,
    });

    const [storedEvent] = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, seed.runId));
    const storedPrpEvent = (
      storedEvent.payload as { prpEvent: Record<string, unknown> }
    ).prpEvent;
    // The credential is removed before the insert, so the stored payload and
    // its digest hold the redacted value.
    expect(JSON.stringify(storedPrpEvent)).not.toContain(JWT);
    expect(JSON.stringify(storedPrpEvent)).toContain("PAPERCLIP_API_KEY=");
    expect(storedEvent.sourcePayloadSha256).toBe(
      `sha256:${nativeSha256(storedPrpEvent)}`,
    );

    // A replay of the same event still matches the digest of the stored value.
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "duplicate",
      cursor: 1,
    });
    // A different payload under the same source event is still a conflict.
    await expect(
      nativeStore.appendEvent({ ...event, priority: 2 }),
    ).rejects.toBeInstanceOf(NativeSessionProtocolIntegrityError);

    const committed = await nativeStore.completeRun({ result, terminal });
    expect(committed.disposition).toBe("committed");

    const [storedResult] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, seed.runId));
    expect(JSON.stringify(storedResult.resultJson)).not.toContain(JWT);
    expect(JSON.stringify(storedResult.resultJson)).toContain(
      "PAPERCLIP_API_KEY=",
    );
    // The digest covers the stored value, so the replay check still holds.
    expect(storedResult.canonicalSha256).toBe(
      `sha256:${nativeSha256(storedResult.resultJson)}`,
    );
    await expect(nativeStore.completeRun({ result, terminal })).resolves.toEqual(
      { disposition: "duplicate", resultId: committed.resultId },
    );

    const readBack = await nativeStore.readCompletedRun();
    expect(readBack?.result.summary).not.toContain(JWT);
    expect(readBack?.result.summary).toContain("PAPERCLIP_API_KEY=");
    expect(JSON.stringify(readBack?.result.evidence)).not.toContain(JWT);
  });
});
