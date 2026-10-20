import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  holdersUnder,
  holdersUnderResolved,
  normalizeDirPath,
  parseLsofCwd,
  workspaceHasLiveHolder,
  type CwdHold,
} from "../services/workspace-occupancy.js";

const fixture = ["p100", "fcwd", "n/Users/x/worktrees/a", "p200", "fcwd", "n/Users/x/worktrees/ab", "p300", "fcwd", "n/Users/x/other"].join("\n");

describe("parseLsofCwd", () => {
  it("pairs each pid with its cwd", () => {
    expect(parseLsofCwd(fixture)).toEqual<CwdHold[]>([
      { pid: 100, cwd: "/Users/x/worktrees/a" },
      { pid: 200, cwd: "/Users/x/worktrees/ab" },
      { pid: 300, cwd: "/Users/x/other" },
    ]);
  });

  it("accepts a name only after the cwd descriptor", () => {
    expect(parseLsofCwd("p1\nn/a")).toEqual([]);
    expect(parseLsofCwd("p1\nfcwd\nn/a")).toEqual([{ pid: 1, cwd: "/a" }]);
  });

  it("ignores malformed lines", () => {
    expect(parseLsofCwd("p0\nnnowhere\npx\np1\nfcwd\nn/a")).toEqual([{ pid: 1, cwd: "/a" }]);
  });
});

describe("normalizeDirPath", () => {
  it("drops a trailing separator", () => {
    expect(normalizeDirPath("/Users/x/worktrees/a/")).toBe("/Users/x/worktrees/a");
  });

  it("returns an empty string for an empty path", () => {
    expect(normalizeDirPath("   ")).toBe("");
  });
});

describe("holdersUnder", () => {
  const holds = parseLsofCwd(fixture);

  it("matches the path itself", () => {
    expect(holdersUnder(holds, "/Users/x/worktrees/a").map((h) => h.pid)).toEqual([100]);
  });

  it("matches below the path", () => {
    expect(holdersUnder(holds, "/Users/x/worktrees").map((h) => h.pid)).toEqual([100, 200]);
  });

  it("does not match a sibling with the same prefix", () => {
    const sibling = parseLsofCwd(["p400", "fcwd", "n/Users/x/worktrees/abc"].join("\n"));
    expect(holdersUnder(sibling, "/Users/x/worktrees/ab").map((h) => h.pid)).toEqual([]);
  });

  it("matches the path itself when the path carries a trailing separator", () => {
    expect(holdersUnder(holds, "/Users/x/worktrees/a/").map((h) => h.pid)).toEqual([100]);
  });

  it("matches nothing when the path is empty", () => {
    expect(holdersUnder(holds, "")).toEqual([]);
  });
});

describe("holdersUnderResolved", () => {
  it("matches a target that is reached through a symbolic link", async () => {
    const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-occupancy-real-"));
    const linkDir = `${realDir}-link`;
    await fs.symlink(realDir, linkDir, "dir");
    try {
      const resolved = await fs.realpath(realDir);
      const holds = parseLsofCwd(["p500", "fcwd", `n${resolved}`].join("\n"));
      expect((await holdersUnderResolved(holds, linkDir)).map((h) => h.pid)).toEqual([500]);
      expect((await holdersUnderResolved(holds, realDir)).map((h) => h.pid)).toEqual([500]);
    } finally {
      await fs.rm(linkDir, { force: true });
      await fs.rm(realDir, { recursive: true, force: true });
    }
  });
});

describe("workspaceHasLiveHolder", () => {
  it("is true when a process holds the directory and calls lsof as expected", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const run = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: fixture };
    };
    await expect(workspaceHasLiveHolder("/Users/x/worktrees/a", run)).resolves.toBe(true);
    expect(calls).toEqual([{ file: "lsof", args: ["-a", "-d", "cwd", "-F", "pn"] }]);
  });

  it("is false when nobody is inside", async () => {
    const run = async () => ({ stdout: fixture });
    await expect(workspaceHasLiveHolder("/Users/x/empty", run)).resolves.toBe(false);
  });

  it("fails open when the process table cannot be read", async () => {
    const run = async () => {
      throw new Error("lsof: not found");
    };
    await expect(workspaceHasLiveHolder("/Users/x/worktrees/a", run)).resolves.toBe(false);
  });

  it("is true for a target that is reached through a symbolic link", async () => {
    const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-occupancy-real-"));
    const linkDir = `${realDir}-link`;
    await fs.symlink(realDir, linkDir, "dir");
    try {
      const resolved = await fs.realpath(realDir);
      const run = async () => ({ stdout: ["p600", "fcwd", `n${resolved}`].join("\n") });
      await expect(workspaceHasLiveHolder(linkDir, run)).resolves.toBe(true);
    } finally {
      await fs.rm(linkDir, { force: true });
      await fs.rm(realDir, { recursive: true, force: true });
    }
  });
});
