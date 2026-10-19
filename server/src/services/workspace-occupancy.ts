import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

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
 *
 * The scan reads the process table with `lsof`. lsof reports the path the
 * kernel knows, so the target path is resolved before the comparison: a
 * directory reached through a symbolic link (a temporary directory, for
 * example) only matches when both sides name the same real directory.
 */

export type CwdHold = { pid: number; cwd: string };

const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Parse `lsof -a -d cwd -F pn` output. */
export function parseLsofCwd(output: string): CwdHold[] {
  const holds: CwdHold[] = [];
  let pid = 0;
  let descriptor: string | null = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number.parseInt(value, 10);
      descriptor = null;
      continue;
    }
    if (tag === "f") {
      descriptor = value;
      continue;
    }
    if (tag === "n" && pid > 0 && descriptor === "cwd") {
      holds.push({ pid, cwd: value });
    }
  }
  return holds;
}

/** Normalise a directory path: absolute, without a trailing separator. */
export function normalizeDirPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const resolved = path.resolve(trimmed);
  if (resolved === path.sep) return resolved;
  return resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

function isUnder(cwd: string, base: string): boolean {
  if (!base) return false;
  const resolved = normalizeDirPath(cwd);
  if (!resolved) return false;
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

/** Holds whose cwd is the path itself or below it. */
export function holdersUnder(holds: CwdHold[], targetPath: string): CwdHold[] {
  const base = normalizeDirPath(targetPath);
  if (!base) return [];
  return holds.filter((hold) => isUnder(hold.cwd, base));
}

/**
 * Holds under the target, comparing resolved paths.
 *
 * lsof reports the path the kernel knows, which is the resolved path. A target
 * that contains a symbolic link therefore matches only when the target is
 * resolved first. The unresolved path stays as a fallback for a target that is
 * not on disk.
 */
export async function holdersUnderResolved(holds: CwdHold[], targetPath: string): Promise<CwdHold[]> {
  const base = normalizeDirPath(targetPath);
  if (!base) return [];
  const resolvedBase = await resolveDirPath(base);
  const resolvedMatches = holds.filter((hold) => isUnder(hold.cwd, resolvedBase));
  if (resolvedMatches.length > 0) return resolvedMatches;
  return holds.filter((hold) => isUnder(hold.cwd, base));
}

async function resolveDirPath(value: string): Promise<string> {
  return await realpath(value).then((resolved) => path.resolve(resolved)).catch(() => value);
}

/**
 * True when a live process has its working directory inside the target.
 *
 * Fail-open: if the process table cannot be read, this returns false and the
 * run proceeds as it did before the guard existed. A guard that blocks work
 * because a diagnostic tool failed is a worse failure than the collision.
 */
export async function workspaceHasLiveHolder(
  targetPath: string,
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = defaultRun,
): Promise<boolean> {
  try {
    const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-F", "pn"]);
    const holds = parseLsofCwd(stdout);
    return (await holdersUnderResolved(holds, targetPath)).length > 0;
  } catch {
    return false;
  }
}

async function defaultRun(file: string, args: string[]): Promise<{ stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: LSOF_MAX_BUFFER_BYTES, timeout: LSOF_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const killed = Boolean((error as { killed?: boolean }).killed);
        if (code === "ENOENT" || killed) {
          reject(error);
          return;
        }
        // lsof exits with 1 when nothing matches. Keep whatever it printed.
        resolve({ stdout: stdout ?? "" });
        return;
      }
      resolve({ stdout: stdout ?? "" });
    });
  });
}
