import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunPresentationDecision } from "@paperclipai/shared";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  buildLateFinalizationPatch,
  buildPresentationResultJson,
  stripNulDeep,
  stripNulFromHeartbeatPatch,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping NUL-strip tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DIG-3981: heartbeat finalization must strip NUL (U+0000) before the
// db.update; Postgres rejects NUL in text/jsonb and the write fails.
describeEmbeddedPostgres("heartbeat NUL strip before finalization update (postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-nul-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedRunningRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NUL Agent",
      role: "engineer",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { triggeredBy: "system" },
    } as typeof heartbeatRuns.$inferInsert);
    return { companyId, agentId, runId };
  }

  it("strips NUL but preserves other control chars", () => {
    expect(stripNulDeep("a\u0000b\nc\td")).toBe("ab\nc\td");
    expect(stripNulDeep({ a: "x\u0000y", nested: ["p\u0000", { q: "r\u0000s" }], n: 1 })).toEqual({
      a: "xy",
      nested: ["p", { q: "rs" }],
      n: 1,
    });
  });

  it("raw NUL text is rejected by Postgres, stripped patch writes clean", async () => {
    const { runId } = await seedRunningRun();

    // Guard-bite control: raw NUL reaches Postgres and is refused.
    await expect(
      db
        .update(heartbeatRuns)
        .set({ error: "boom\u0000here" })
        .where(eq(heartbeatRuns.id, runId)),
    ).rejects.toThrow();

    const patch = stripNulFromHeartbeatPatch({
      error: "boom\u0000here\nkept",
      stdoutExcerpt: "out\u0000",
      stderrExcerpt: "err\u0000",
      usageJson: { note: "a\u0000b", list: ["x\u0000", 2] },
      resultJson: { deep: { msg: "m\u0000" } },
    });

    const rows = await db
      .update(heartbeatRuns)
      .set({ status: "failed", ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning();
    expect(rows[0]?.error).toBe("boomhere\nkept");
    expect(rows[0]?.stdoutExcerpt).toBe("out");
    expect(rows[0]?.stderrExcerpt).toBe("err");
    expect(rows[0]?.usageJson).toMatchObject({ note: "ab" });
    expect(JSON.stringify(rows[0]?.usageJson)).not.toContain("\\u0000");
    expect(JSON.stringify(rows[0]?.resultJson)).not.toContain("\\u0000");
  });

  // DIG-4392: after setRunStatusIfRunning loses the compare-and-set to the
  // reconciler, the late metadata write re-binds the adapter-derived patch.
  it("late finalization write strips NUL after the compare-and-set loses", async () => {
    const { runId } = await seedRunningRun();
    // The reconciler already committed the same terminal status.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    const persistedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);

    const finalRunPatch: Partial<typeof heartbeatRuns.$inferInsert> = {
      finishedAt: new Date(),
      error: "late\u0000error",
      stdoutExcerpt: "out\u0000late",
      stderrExcerpt: "err\u0000late",
      usageJson: { input: 1, note: "a\u0000b" },
      resultJson: { summary: "done\u0000", nested: { text: "x\u0000y" } },
    };

    // Guard-bite control: the pre-fix write re-binds the raw patch unsanitized
    // and Postgres refuses it.
    await expect(
      db
        .update(heartbeatRuns)
        .set({ ...finalRunPatch, updatedAt: new Date() })
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.status, "succeeded"),
          ),
        ),
    ).rejects.toThrow();

    const patch = buildLateFinalizationPatch({
      finalRunPatch,
      persistedRun,
      status: "succeeded",
      runErrorCode: null,
      runErrorMessage: "late\u0000error",
    });
    const rows = await db
      .update(heartbeatRuns)
      .set(patch)
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.status, "succeeded"),
        ),
      )
      .returning();

    expect(rows[0]?.status).toBe("succeeded");
    expect(rows[0]?.error).toBe("lateerror");
    expect(rows[0]?.stdoutExcerpt).toBe("outlate");
    expect(rows[0]?.stderrExcerpt).toBe("errlate");
    expect(JSON.stringify(rows[0]?.usageJson)).not.toContain("\\u0000");
    expect(JSON.stringify(rows[0]?.resultJson)).not.toContain("\\u0000");
    expect(rows[0]?.resultJson).toMatchObject({
      summary: "done",
      nested: { text: "xy" },
    });
    // The shared finalRunPatch must not be mutated in place.
    expect((finalRunPatch.resultJson as Record<string, unknown>).summary).toBe("done\u0000");
    expect(
      ((finalRunPatch.resultJson as Record<string, unknown>).nested as Record<string, unknown>).text,
    ).toBe("x\u0000y");
  });

  // DIG-4392: the presentation write re-binds the adapter resultJson, which
  // still carries raw NUL text.
  it("presentation write strips NUL without mutating the adapter resultJson", async () => {
    const { runId } = await seedRunningRun();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const persistedResultJson: Record<string, unknown> = {
      summary: "adapter\u0000summary",
      nested: { note: "n\u0000" },
    };
    const presentationDecision: RunPresentationDecision = {
      schema: "paperclip.run_presentation_decision.v1",
      resolverVersion: "v1",
      chosenSource: "semantic_result_summary",
      sourceEventId: null,
      commentAction: "none",
      commentId: null,
      activityDisposition: "collapse",
      reasonCodes: ["no_issue"],
    };

    // Guard-bite control: the pre-fix write re-binds the raw adapter result and
    // Postgres refuses it.
    await expect(
      db
        .update(heartbeatRuns)
        .set({
          resultJson: { ...persistedResultJson, presentationDecision },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId)),
    ).rejects.toThrow();

    const rows = await db
      .update(heartbeatRuns)
      .set({
        resultJson: buildPresentationResultJson(
          persistedResultJson,
          presentationDecision,
        ),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning();

    expect(JSON.stringify(rows[0]?.resultJson)).not.toContain("\\u0000");
    expect(rows[0]?.resultJson).toMatchObject({
      summary: "adaptersummary",
      nested: { note: "n" },
      presentationDecision,
    });
    // The adapter result is reused after this write and must stay untouched.
    expect(persistedResultJson.summary).toBe("adapter\u0000summary");
    expect((persistedResultJson.nested as Record<string, unknown>).note).toBe("n\u0000");
  });
});
