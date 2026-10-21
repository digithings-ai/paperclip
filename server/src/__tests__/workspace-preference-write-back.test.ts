import { describe, expect, it } from "vitest";
import {
  resolveIssueExecutionWorkspacePreferenceForCreate,
  resolveIssueExecutionWorkspacePreferenceWriteBack,
} from "../services/execution-workspace-policy.ts";
import { resolveExecutionWorkspaceReuseRequestForIssue } from "../services/heartbeat.ts";

describe("issue execution workspace preference write-back", () => {
  it("keeps the isolated preference on a workspace the issue owns", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceWriteBack({
        nextIssueWorkspaceMode: "isolated_workspace",
        boundWorkspaceOwnedByThisIssue: true,
      }),
    ).toBe("isolated_workspace");
  });

  it("keeps the reuse preference on a workspace another issue owns", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceWriteBack({
        nextIssueWorkspaceMode: "isolated_workspace",
        boundWorkspaceOwnedByThisIssue: false,
      }),
    ).toBe("reuse_existing");
  });

  it("keeps the reuse preference on a shared workspace", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceWriteBack({
        nextIssueWorkspaceMode: "shared_workspace",
        boundWorkspaceOwnedByThisIssue: true,
      }),
    ).toBe("reuse_existing");
  });
});

describe("execution workspace reuse request", () => {
  it("restores a workspace the issue owns when the preference names a mode", () => {
    expect(
      resolveExecutionWorkspaceReuseRequestForIssue({
        issueExecutionWorkspaceId: "workspace-own",
        issueExecutionWorkspacePreference: "isolated_workspace",
        existingExecutionWorkspaceStatus: "active",
        existingExecutionWorkspaceSourceIssueId: "issue-1",
        issueId: "issue-1",
      }),
    ).toEqual({
      requestedExecutionWorkspaceId: "workspace-own",
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceAvailable: true,
    });
  });

  it("still realizes fresh when the owned workspace carries no preference", () => {
    expect(
      resolveExecutionWorkspaceReuseRequestForIssue({
        issueExecutionWorkspaceId: "workspace-own",
        issueExecutionWorkspacePreference: null,
        existingExecutionWorkspaceStatus: "active",
        existingExecutionWorkspaceSourceIssueId: "issue-1",
        issueId: "issue-1",
      }),
    ).toEqual({
      requestedExecutionWorkspaceId: "workspace-own",
      requestedShouldReuseExisting: false,
      existingExecutionWorkspaceAvailable: false,
    });
  });

  it("still realizes fresh when the owned workspace carries an unresolved preference", () => {
    expect(
      resolveExecutionWorkspaceReuseRequestForIssue({
        issueExecutionWorkspaceId: "workspace-own",
        issueExecutionWorkspacePreference: "inherit",
        existingExecutionWorkspaceStatus: "active",
        existingExecutionWorkspaceSourceIssueId: "issue-1",
        issueId: "issue-1",
      }),
    ).toEqual({
      requestedExecutionWorkspaceId: "workspace-own",
      requestedShouldReuseExisting: false,
      existingExecutionWorkspaceAvailable: false,
    });
  });

  it("refuses to reuse a workspace another issue owns", () => {
    expect(
      resolveExecutionWorkspaceReuseRequestForIssue({
        issueExecutionWorkspaceId: "workspace-other",
        issueExecutionWorkspacePreference: "isolated_workspace",
        existingExecutionWorkspaceStatus: "active",
        existingExecutionWorkspaceSourceIssueId: "issue-2",
        issueId: "issue-1",
      }),
    ).toEqual({
      requestedExecutionWorkspaceId: "workspace-other",
      requestedShouldReuseExisting: false,
      existingExecutionWorkspaceAvailable: false,
    });
  });

  it("still realizes a pinned branch over a workspace the issue owns", () => {
    expect(
      resolveExecutionWorkspaceReuseRequestForIssue({
        issueExecutionWorkspaceId: "workspace-own",
        issueExecutionWorkspacePreference: "isolated_workspace",
        existingExecutionWorkspaceStatus: "active",
        existingExecutionWorkspaceSourceIssueId: "issue-1",
        issueId: "issue-1",
        requestedExistingBranch: "PAP-14380-salvage-pap-9514",
        existingExecutionWorkspaceBranchName: "PAP-9001-other-branch",
      }),
    ).toEqual({
      requestedExecutionWorkspaceId: "workspace-own",
      requestedShouldReuseExisting: false,
      existingExecutionWorkspaceAvailable: false,
    });
  });

  it("keeps the archived-workspace refusal for a workspace the issue owns", () => {
    const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: "workspace-own",
      issueExecutionWorkspacePreference: "isolated_workspace",
      existingExecutionWorkspaceStatus: "archived",
      existingExecutionWorkspaceSourceIssueId: "issue-1",
      issueId: "issue-1",
    });

    expect(reuseRequest.requestedShouldReuseExisting).toBe(true);
    expect(reuseRequest.existingExecutionWorkspaceAvailable).toBe(false);
  });
});

describe("issue execution workspace preference on create", () => {
  it("takes the mode the platform resolved when the request named no preference", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: null,
        requestNamedPreference: false,
        hasBoundWorkspace: false,
        resolvedMode: "isolated_workspace",
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: null,
        requestNamedPreference: false,
        hasBoundWorkspace: false,
        resolvedMode: "shared_workspace",
      }),
    ).toBe("shared_workspace");
  });

  it("keeps the preference the request named", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: "isolated_workspace",
        requestNamedPreference: true,
        hasBoundWorkspace: false,
        resolvedMode: "isolated_workspace",
      }),
    ).toBe("isolated_workspace");
  });

  it("keeps the preference a bound workspace came with", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: "reuse_existing",
        requestNamedPreference: false,
        hasBoundWorkspace: true,
        resolvedMode: "isolated_workspace",
      }),
    ).toBe("reuse_existing");
  });

  it("leaves the preference empty when the request named none and no mode was resolved", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: null,
        requestNamedPreference: false,
        hasBoundWorkspace: false,
        resolvedMode: undefined,
      }),
    ).toBeNull();
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: null,
        requestNamedPreference: true,
        hasBoundWorkspace: false,
        resolvedMode: "isolated_workspace",
      }),
    ).toBeNull();
  });
});
