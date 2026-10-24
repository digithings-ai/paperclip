import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  assessRecordedProcessLiveness,
  parseProcessTable,
  type ProcessTable,
  type RecordedProcessIdentity,
} from "./process-identity.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { readProcessStartedAt } from "./hot-restart.js";

const PROCESS_TABLE_OUTPUT = [
  "  903   903 Wed Oct  7 01:22:14 2026 /usr/sbin/distnoted",
  "  683   683 Wed Oct  7 01:22:14 2026 /usr/libexec/ContinuityCaptureAgent",
  " 1012  1010 Wed Oct  7 01:22:15 2026 /usr/bin/some-child",
].join("\n");

function table(entries: Array<{ pid: number; pgid: number | null; startedAt: string | null }>): ProcessTable {
  const parsed = new Map<number, { pid: number; pgid: number | null; startedAt: Date | null }>();
  for (const entry of entries) {
    parsed.set(entry.pid, {
      pid: entry.pid,
      pgid: entry.pgid,
      startedAt: entry.startedAt ? new Date(entry.startedAt) : null,
    });
  }
  return parsed as ProcessTable;
}

describe("parseProcessTable", () => {
  it("reads pid, group and start time from a ps listing", () => {
    const parsed = parseProcessTable(PROCESS_TABLE_OUTPUT);
    expect(parsed.size).toBe(3);
    expect(parsed.get(903)).toEqual({
      pid: 903,
      pgid: 903,
      startedAt: new Date("Wed Oct 7 01:22:14 2026"),
    });
    expect(parsed.get(1012)?.pgid).toBe(1010);
  });

  it("ignores lines without a start time", () => {
    const parsed = parseProcessTable("  903   903 /usr/sbin/distnoted");
    expect(parsed.size).toBe(0);
  });
});

describe("assessRecordedProcessLiveness", () => {
  const finishedAt = new Date("2026-10-06T06:05:30.000Z");

  it("reports a reused pid and a reused group as gone", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 903,
        processGroupId: 903,
        processStartedAt: new Date("2026-10-06T06:05:30.000Z"),
        finishedAt,
      },
      table([
        { pid: 903, pgid: 903, startedAt: "2026-10-07T01:22:14.000Z" },
      ]),
    );
    expect(assessment.pid).toBe("recycled");
    expect(assessment.group).toBe("recycled");
    expect(assessment.alive).toBe(false);
    expect(assessment.gone).toBe(true);
  });

  it("reports the recorded provider as alive while it runs", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 903,
        processGroupId: 903,
        processStartedAt: new Date("2026-10-07T01:22:14.000Z"),
        finishedAt,
      },
      table([
        { pid: 903, pgid: 903, startedAt: "2026-10-07T01:22:14.000Z" },
      ]),
    );
    expect(assessment.pid).toBe("alive");
    expect(assessment.group).toBe("alive");
    expect(assessment.alive).toBe(true);
    expect(assessment.gone).toBe(false);
  });

  it("reports a provider that runs as a group member as alive", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 1012,
        processGroupId: 1010,
        processStartedAt: new Date("2026-10-07T01:22:15.000Z"),
        finishedAt,
      },
      table([
        { pid: 1012, pgid: 1010, startedAt: "2026-10-07T01:22:15.000Z" },
      ]),
    );
    expect(assessment.alive).toBe(true);
  });

  it("keeps the hold when a member of the recorded group survived the leader", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 903,
        processGroupId: 903,
        processStartedAt: new Date("2026-10-06T06:05:30.000Z"),
        finishedAt,
      },
      table([
        { pid: 1012, pgid: 903, startedAt: "2026-10-06T06:05:20.000Z" },
      ]),
      { isPidAlive: () => false },
    );
    expect(assessment.group).toBe("alive");
    expect(assessment.alive).toBe(true);
  });

  it("releases a group whose members were forked after the run ended", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 903,
        processGroupId: 903,
        processStartedAt: new Date("2026-10-06T06:05:30.000Z"),
        finishedAt,
      },
      table([
        { pid: 1012, pgid: 903, startedAt: "2026-10-06T09:05:20.000Z" },
      ]),
      { isPidAlive: () => false },
    );
    expect(assessment.group).toBe("recycled");
    expect(assessment.alive).toBe(false);
  });

  it("holds when the recorded start time is missing", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 903,
        processGroupId: 903,
        processStartedAt: null,
        finishedAt,
      },
      table([
        { pid: 903, pgid: 903, startedAt: "2026-10-07T01:22:14.000Z" },
      ]),
    );
    expect(assessment.alive).toBe(true);
    expect(assessment.gone).toBe(false);
  });

  it("holds when the pid answers a probe but the table cannot see it", () => {
    const assessment = assessRecordedProcessLiveness(
      {
        processPid: 4242,
        processGroupId: 4242,
        processStartedAt: new Date("2026-10-06T06:05:30.000Z"),
        finishedAt,
      },
      new Map() as ProcessTable,
      { isPidAlive: () => true },
    );
    expect(assessment.pid).toBe("unknown");
    expect(assessment.alive).toBe(true);
    expect(assessment.gone).toBe(false);
  });
});

describe("getConversationOwnershipBlocker", () => {
  function fakeDb(candidates: unknown[], updates: unknown[]) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => candidates,
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
            return undefined;
          },
        }),
      }),
    } as unknown as Db;
  }

  it("does not hold an issue when the recorded pid was reused", async () => {
    const updates: unknown[] = [];
    const db = fakeDb(
      [
        {
          activeLease: false,
          run: {
            id: "run-recycled",
            agentId: "agent-1",
            status: "failed",
            runtimeMode: "legacy",
            processPid: process.pid,
            processGroupId: process.pid,
            processStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            finishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          },
        },
      ],
      updates,
    );
    const blocker = await getConversationOwnershipBlocker(db, "company-1", "issue-1");
    expect(blocker).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
    });
  });

  it("holds an issue while the recorded provider still runs", async () => {
    const startedAt = new Date(
      (await readProcessStartedAt(process.pid)) ?? Date.now(),
    );
    const updates: unknown[] = [];
    const db = fakeDb(
      [
        {
          activeLease: false,
          run: {
            id: "run-live",
            agentId: "agent-1",
            status: "failed",
            runtimeMode: "legacy",
            processPid: process.pid,
            processGroupId: process.pid,
            processStartedAt: startedAt,
            finishedAt: new Date(),
          },
        },
      ],
      updates,
    );
    const blocker = await getConversationOwnershipBlocker(db, "company-1", "issue-1");
    expect(blocker?.cause).toBe("execution_owner_active");
    expect(blocker?.runId).toBe("run-live");
    expect(updates).toHaveLength(0);
  });
});
