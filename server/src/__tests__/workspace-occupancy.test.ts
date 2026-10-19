import { describe, expect, it } from "vitest";
import {
  holdersUnder,
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

  it("ignores malformed lines", () => {
    expect(parseLsofCwd("p0\nnnowhere\npx\np1\nn/a")).toEqual([{ pid: 1, cwd: "/a" }]);
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
    expect(holdersUnder(holds, "/Users/x/worktrees/a").map((h) => h.pid)).not.toContain(200);
  });
});

describe("workspaceHasLiveHolder", () => {
  it("is true when a process holds the directory", async () => {
    const run = async () => ({ stdout: fixture });
    await expect(workspaceHasLiveHolder("/Users/x/worktrees/a", run)).resolves.toBe(true);
  });

  it("is false when nobody is inside", async () => {
    const run = async () => ({ stdout: fixture });
    await expect(workspaceHasLiveHolder("/Users/x/empty", run)).resolves.toBe(false);
  });

  it("fails open when lsof cannot be read", async () => {
    const run = async () => {
      throw new Error("lsof: not found");
    };
    await expect(workspaceHasLiveHolder("/Users/x/worktrees/a", run)).resolves.toBe(false);
  });
});
