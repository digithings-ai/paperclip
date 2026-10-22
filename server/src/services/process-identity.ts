import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One entry of the operating system process table. */
export interface ObservedProcess {
  pid: number;
  /** Process group id. The group leader is the process whose pid equals the pgid. */
  pgid: number | null;
  startedAt: Date | null;
}

export type ProcessTable = Map<number, ObservedProcess>;

/** The identity a run recorded for the provider process it started. */
export interface RecordedProcessIdentity {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  /** When the run reached a terminal status. */
  finishedAt: Date | null;
}

/**
 * alive     - the recorded process, or one it left behind, still runs
 * recycled  - the pid exists but now belongs to a process started later
 * dead      - nothing of the recorded process runs any more
 * unknown   - the identity could not be read, so it cannot be disproved
 */
export type ProcessLivenessVerdict = "alive" | "recycled" | "dead" | "unknown";

export interface ProcessLivenessAssessment {
  pid: ProcessLivenessVerdict;
  group: ProcessLivenessVerdict;
  /** The provider still holds execution authority over the run. */
  alive: boolean;
  /** The recorded identity is provably gone, so the stored fields can be cleared. */
  gone: boolean;
  reason: string;
}

/** A process that starts within this window of the recorded start time is the same process. */
const STARTED_AT_TOLERANCE_MS = 2_000;
/** A leftover member forked shortly after the run ended still belongs to the recorded group. */
const GROUP_MEMBER_SLACK_MS = 60_000;

/** `ps -A -o pid= -o pgid= -o lstart=` lists every process with its group and start time. */
export function parseProcessTable(output: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    // pid pgid <weekday> <month> <day> <time> <year>
    if (parts.length < 7) continue;
    const pid = Number.parseInt(parts[0]!, 10);
    const pgid = Number.parseInt(parts[1]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      pgid: Number.isInteger(pgid) && pgid > 0 ? pgid : null,
      startedAt: parseProcessStartTime(parts.slice(2, 7).join(" ")),
    });
  }
  return table;
}

/** `ps lstart` reports local time, the same way the stored identity was read. */
function parseProcessStartTime(value: string): Date | null {
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export type ProcessTableReader = () => Promise<ProcessTable | null>;

export async function readProcessTable(options: {
  runCommand?: (command: string, args: string[]) => Promise<{ stdout: string }>;
} = {}): Promise<ProcessTable | null> {
  const run = options.runCommand ?? runProcessCommand;
  try {
    const { stdout } = await run("ps", [
      "-A",
      "-o",
      "pid=",
      "-o",
      "pgid=",
      "-o",
      "lstart=",
    ]);
    const table = parseProcessTable(stdout);
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

async function runProcessCommand(command: string, args: string[]) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
}

/** A pid answers a signal probe even when the process is not ours to signal. */
function processPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A process that started no later than the recorded start time is the recorded
 * process. A later process with the same pid is a reuse of the pid.
 */
function startedNoLaterThan(
  observed: Date,
  recorded: Date,
  toleranceMs: number,
): boolean {
  return observed.getTime() <= recorded.getTime() + toleranceMs;
}

/**
 * Decides whether the provider a run recorded is still running.
 *
 * Pids are reused. A recycled pid answers every liveness probe while the
 * unrelated process that took it over is alive, so the pid alone never proves
 * that the recorded provider still holds execution authority. The recorded
 * start time and the process group carry the identity.
 */
export function assessRecordedProcessLiveness(
  identity: RecordedProcessIdentity,
  table: ProcessTable,
  options: {
    startedAtToleranceMs?: number;
    groupMemberSlackMs?: number;
    isPidAlive?: (pid: number) => boolean;
  } = {},
): ProcessLivenessAssessment {
  const tolerance = options.startedAtToleranceMs ?? STARTED_AT_TOLERANCE_MS;
  const slack = options.groupMemberSlackMs ?? GROUP_MEMBER_SLACK_MS;
  const isPidAlive = options.isPidAlive ?? processPidExists;
  const pid = assessRecordedPid(identity, table, tolerance, isPidAlive);
  const group = assessRecordedProcessGroup(identity, table, tolerance, slack);
  // An identity that cannot be disproved keeps the hold.
  // An identity that cannot be disproved keeps the hold.
  const unknown = pid === "unknown" || group === "unknown";
  const alive = unknown || pid === "alive" || group === "alive";
  // An unknown leg is never "gone": the hold stays until it can be disproved.
  const gone = !alive;
  const reason = unknown
    ? `recorded provider identity is unknown (pid ${pid}, group ${group})`
    : alive
      ? `recorded provider still runs (pid ${pid}, group ${group})`
      : `recorded provider is gone (pid ${pid}, group ${group})`;
  return { pid, group, alive, gone, reason };
}

function assessRecordedPid(
  identity: RecordedProcessIdentity,
  table: ProcessTable,
  tolerance: number,
  isPidAlive: (pid: number) => boolean,
): ProcessLivenessVerdict {
  const pid = identity.processPid;
  if (pid === null || pid <= 0) return "dead";
  const observed = table.get(pid);
  if (!observed) {
    // The table does not list the pid. A pid that still answers a probe is
    // alive but invisible, so the identity cannot be disproved.
    return isPidAlive(pid) ? "unknown" : "dead";
  }
  if (!identity.processStartedAt) return "alive";
  if (!observed.startedAt) return "unknown";
  return startedNoLaterThan(observed.startedAt, identity.processStartedAt, tolerance)
    ? "alive"
    : "recycled";
}

function assessRecordedProcessGroup(
  identity: RecordedProcessIdentity,
  table: ProcessTable,
  tolerance: number,
  slack: number,
): ProcessLivenessVerdict {
  const pgid = identity.processGroupId;
  if (pgid === null || pgid <= 0) return "dead";
  // The group leader holds the pid of the group.
  const leader = table.get(pgid);
  if (leader) {
    if (!identity.processStartedAt) return "alive";
    if (!leader.startedAt) return "unknown";
    // The leader is the recorded provider or the parent that started it. A
    // later process with that pid is a reuse, and the group it created is not
    // the recorded group.
    return startedNoLaterThan(leader.startedAt, identity.processStartedAt, tolerance)
      ? "alive"
      : "recycled";
  }
  // The leader is gone. The members that remain were forked by the recorded
  // provider, unless they were forked by a later process that took the pid.
  const members = [...table.values()].filter(
    (observed) => observed.pgid === pgid,
  );
  if (!members.length) return "dead";
  if (!identity.finishedAt) return "alive";
  const finishedAt = identity.finishedAt.getTime();
  const memberOfRecordedGroup = members.some((member) => {
    if (!member.startedAt) return true;
    return member.startedAt.getTime() <= finishedAt + slack;
  });
  return memberOfRecordedGroup ? "alive" : "recycled";
}

/**
 * Reads the process table once and decides whether the recorded provider of a
 * run is still alive. An unreadable process table cannot disprove the
 * identity, so the run keeps its hold.
 */
export async function assessRecordedExecutionLiveness(
  identity: RecordedProcessIdentity,
  options: {
    readTable?: ProcessTableReader;
    startedAtToleranceMs?: number;
    groupMemberSlackMs?: number;
    isPidAlive?: (pid: number) => boolean;
  } = {},
): Promise<ProcessLivenessAssessment> {
  const table = await (options.readTable ?? readProcessTable)();
  if (!table) {
    return {
      pid: "unknown",
      group: "unknown",
      alive: true,
      gone: false,
      reason: "process table unavailable",
    };
  }
  return assessRecordedProcessLiveness(identity, table, options);
}
