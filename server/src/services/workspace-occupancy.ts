import { execFile } from "node:child_process";

/**
 * Worktree occupancy guard.
 *
 * Two runs can end up in the same worktree because `git worktree add` refuses a
 * branch that is already checked out, and the runtime then falls back to the
 * existing directory. This module answers one question for that fallback: is
 * anybody actually working in there right now?
 *
 * It is deliberately stateless. A lease held by the server process would never
 * be released if the run died in a way the server did not observe, and a stale
 * lease that blocks every future run is worse than the collision it prevents.
 */

export type CwdHold = { pid: number; cwd: string };

/** Parse `lsof -a -d cwd -F pn` output. */
export function parseLsofCwd(output: string): CwdHold[] {
  const holds: CwdHold[] = [];
  let pid = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    if (line[0] === "p") {
      pid = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (line[0] === "n" && pid > 0) {
      holds.push({ pid, cwd: line.slice(1) });
    }
  }
  return holds;
}

/** Holds whose cwd is the path itself or below it. */
export function holdersUnder(holds: CwdHold[], path: string): CwdHold[] {
  const base = path.endsWith("/") ? path : `${path}/`;
  return holds.filter((h) => h.cwd === path || h.cwd.startsWith(base));
}

/**
 * True when a live process has its working directory inside `path`.
 *
 * Fail-open: if lsof cannot be read, this returns false and the run proceeds as
 * it did before the guard existed. A guard that blocks work because a diagnostic
 * tool failed is a worse failure than the collision.
 */
export async function workspaceHasLiveHolder(
  path: string,
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = defaultRun,
): Promise<boolean> {
  try {
    const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-F", "pn"]);
    return holdersUnder(parseLsofCwd(stdout), path).length > 0;
  } catch {
    return false;
  }
}

async function defaultRun(file: string, args: string[]): Promise<{ stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}
