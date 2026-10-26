import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeByDesignWake,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("recognizes a retired available connection without accepting ordinary expiry", () => {
    const context = { interactionId: "connection", interactionStatus: "expired", interactionKind: "connection_intent",
      connectionIntentResolution: "existing_connection", mutation: "interaction", wakeReason: "issue_commented" };
    expect(isResolvedInteractionContinuationWakeContext(context)).toBe(true);
    expect(isResolvedInteractionContinuationWakeContext({ ...context, interactionKind: "request_confirmation" })).toBe(false);
    expect(isResolvedInteractionContinuationWakeContext({ ...context, connectionIntentResolution: undefined })).toBe(false);
  });
  it("requires the subscription-specific non-assignee receipt for a subscription wait", () => {
    expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", {
      aiConnectionBusyDeferredWhileAssignee: false,
    })).toBe(true);
    for (const context of [ {}, { aiConnectionBusyDeferredWhileAssignee: true }, { workspaceBusyDeferredWhileAssignee: false } ]) {
      expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", context)).toBe(false);
    }
    expect(isNonAssigneeWorkspaceBusyRetry("transient_failure", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(false);
  });
  it("recognizes only workspace-busy retries deferred outside assignee-ship", () => {
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(true);
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe(false);
    expect(isNonAssigneeWorkspaceBusyRetry("another_reason", {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(false);
  });

  it("keeps ordered, unique, non-empty wake comment ids", () => {
    expect(extractWakeCommentIds({
      wakeCommentIds: ["comment-1", "", null, "comment-2", "comment-1"],
    })).toEqual(["comment-1", "comment-2"]);
    expect(extractWakeCommentIds({ wakeCommentIds: "comment-1" })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it.each([
    [{ wakeCommentIds: ["batch-1", "batch-2"], wakeCommentId: "wake" }, {}, "batch-2"],
    [{ wakeCommentId: "wake", commentId: "context" }, {}, "wake"],
    [{ commentId: "context" }, { commentId: "payload" }, "context"],
    [{}, { commentId: "payload" }, "payload"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
  });

  it.each([
    // A question card's addressee. Snapshot is the one a live DIG-3326
    // addressee run actually carried: persistence narrows it to these six
    // keys, so no other signal (no comment id, no interaction id) survives
    // for a gate to read.
    "interaction_pending",
    // An unblock descriptor's owner. Snapshot is the one live run c49764a4
    // carried on 2026-10-13T17:48:53Z, cancelled by this same guard on an
    // issue (DIG-3297) whose assignee never changed.
    "issue_unblock_requested",
  ])("recognizes the %s wake from the shape the platform persists, and only that", (wakeReason) => {
    expect(isNonAssigneeByDesignWake({
      issueId: "issue-1",
      taskId: "issue-1",
      taskKey: "DIG-3326",
      wakeReason,
      wakeSource: "automation",
      wakeTriggerDetail: "system",
    })).toBe(true);

    // Controls. An assignment wake is the reassignment this guard exists to
    // catch; a comment wake is already covered by allowsIssueInteractionWake;
    // the rest must not be swept in by a loose match.
    for (const context of [
      { wakeReason: "issue_assigned", wakeSource: "assignment" },
      { wakeReason: "issue_commented", wakeCommentId: "comment-1" },
      { wakeReason: "issue_continuation_needed" },
      { wakeReason: "  interaction_pending  " },
      { wakeReason: "Interaction_Pending" },
      { wakeReason: "  issue_unblock_requested  " },
      { wakeReason: "issue_unblock" },
      { wakeReason: "issue_unblock_requested_extra" },
      { wakeReason: "" },
      {},
      undefined,
    ]) {
      expect(isNonAssigneeByDesignWake(context)).toBe(false);
    }
  });

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s issue-comment interaction continuations",
    (interactionStatus) => {
      expect(isResolvedInteractionContinuationWakeContext({
        interactionId: "interaction-1",
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      })).toBe(true);
    },
  );

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s infrastructure continuations and rejects incomplete contexts",
    (interactionStatus) => {
      const base = { interactionId: "interaction-1", interactionStatus };
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        wakeReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        retryReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});

 it("preserves non-assignee pool wait authority", () => {
   expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_pool_wait", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(true);
   expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_pool_wait", { aiConnectionBusyDeferredWhileAssignee: true })).toBe(false);
 });
