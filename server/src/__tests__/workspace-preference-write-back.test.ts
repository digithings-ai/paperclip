import { describe, expect, it } from "vitest";
import {
  hasReusableExecutionWorkspaceBinding,
  resolveIssueExecutionWorkspacePreferenceForCreate,
  resolveIssueExecutionWorkspacePreferenceWriteBack,
  shouldMergeExecutionWorkspaceConfigIntoWorkspace,
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

  it("keeps the operator branch preference on a workspace the issue owns", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceWriteBack({
        nextIssueWorkspaceMode: "operator_branch",
        boundWorkspaceOwnedByThisIssue: true,
      }),
    ).toBe("operator_branch");
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

  // Unit level. The production call sites do not pass the two branch inputs
  // yet, so this guard is inert in the runtime today. The test pins the
  // function, not a production guarantee.
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
        resolvedMode: "operator_branch",
      }),
    ).toBe("operator_branch");
  });

  it("leaves the preference empty for a shared workspace: the checkout is the project's", () => {
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: null,
        requestNamedPreference: false,
        hasBoundWorkspace: false,
        resolvedMode: "shared_workspace",
      }),
    ).toBeNull();
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

  it("records the reuse of a named workspace when the request named no preference", () => {
    // A request that names a workspace and no preference left the issue with
    // a concrete mode and no preference: the state the audit calls DROP, with
    // nothing that says what the binding is for.
    expect(
      resolveIssueExecutionWorkspacePreferenceForCreate({
        effectivePreference: null,
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

describe("merging issue settings into a bound workspace", () => {
  it("merges into a workspace the issue owns", () => {
    expect(
      shouldMergeExecutionWorkspaceConfigIntoWorkspace({
        nextExecutionWorkspacePreference: "isolated_workspace",
        workspaceSourceIssueId: "issue-1",
        issueId: "issue-1",
      }),
    ).toBe(true);
  });

  it("merges into a reuse binding", () => {
    expect(
      shouldMergeExecutionWorkspaceConfigIntoWorkspace({
        nextExecutionWorkspacePreference: "reuse_existing",
        workspaceSourceIssueId: "issue-2",
        issueId: "issue-1",
      }),
    ).toBe(true);
  });

  it("leaves the workspace of another issue alone", () => {
    expect(
      shouldMergeExecutionWorkspaceConfigIntoWorkspace({
        nextExecutionWorkspacePreference: "isolated_workspace",
        workspaceSourceIssueId: "issue-2",
        issueId: "issue-1",
      }),
    ).toBe(false);
  });

  it("leaves a workspace without an owner alone", () => {
    expect(
      shouldMergeExecutionWorkspaceConfigIntoWorkspace({
        nextExecutionWorkspacePreference: "isolated_workspace",
        workspaceSourceIssueId: null,
        issueId: "issue-1",
      }),
    ).toBe(false);
  });
});

describe("reusable execution workspace binding", () => {
  it("counts a bound workspace with a preference that names a mode as reusable", () => {
    expect(
      hasReusableExecutionWorkspaceBinding({
        executionWorkspaceId: "workspace-own",
        executionWorkspacePreference: "isolated_workspace",
      }),
    ).toBe(true);
  });

  it("counts a bound workspace with the reuse preference as reusable", () => {
    expect(
      hasReusableExecutionWorkspaceBinding({
        executionWorkspaceId: "workspace-own",
        executionWorkspacePreference: "reuse_existing",
      }),
    ).toBe(true);
  });

  it("counts an issue without a bound workspace as not reusable", () => {
    expect(
      hasReusableExecutionWorkspaceBinding({
        executionWorkspaceId: null,
        executionWorkspacePreference: "isolated_workspace",
      }),
    ).toBe(false);
  });
});
