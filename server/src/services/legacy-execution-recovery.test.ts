import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import {
  legacyExecutionNeedsReconciliation,
  ROUTINE_EXECUTION_OWNED_SKIP_REASONS,
  routineExecutionSkipNeedsBlockedEscalation,
} from "./legacy-execution-recovery.js";
import { isRecoveryBudgetExhausted } from "./issue-recovery-actions.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});


it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});

// DIG-4075 / DIG-2152 design item 4: the skip-reason allowlist for
// `routine_execution`. A reason that means "somebody competent owns this" keeps
// its existing skip; every other reason is a silent abandonment and must resolve
// to `blocked`.

it("treats only owner reasons as a correct skip for a routine_execution issue", () => {
  const owned = [
    "active_execution_path",
    "pending_wake_interaction",
    "board_owned_recovery_action",
    "durable_goal_owns_continuation",
    "waiting_conversation",
    "chat_channel_waiting_for_settlement",
    "conversation_publication_window",
    "chat_control_recovery_stop",
    "paused_with_native_passive_wait",
    "persisted_durable_wait_path",
    "provider_quota_monitor_pending",
    "plugin_managed_handoff",
    "shared_workspace_child_waiting",
    "review_participant_waiting_nonterminal",
    "handoff_not_exhausted",
    "handoff_already_escalated",
    "pause_hold_suppresses_recovery",
    "accepted_continuation_wake_queued",
    "review_participant_wake_queued",
    "todo_initial_wake_queued",
    "backoff_delay_not_elapsed",
  ] as const;
  for (const reason of owned) {
    expect(ROUTINE_EXECUTION_OWNED_SKIP_REASONS.has(reason)).toBe(true);
    expect(
      routineExecutionSkipNeedsBlockedEscalation({
        originKind: "routine_execution",
        skipReason: reason,
      }),
    ).toBe(false);
  }
});

it("resolves every non-owner routine_execution skip reason to blocked", () => {
  const abandoned = [
    "missing_assignee_agent",
    "legacy_continuation_no_action",
    "escalation_declined_uninvokable",
    "escalation_declined_over_budget",
    "adapter_failure_target_mismatch",
    "adapter_monitor_not_scheduled",
    "review_participant_or_state_missing",
    "review_participant_requeue_declined",
    "review_participant_quota_monitor_declined",
    "todo_succeeded_no_handback",
    "assignment_dispatch_declined",
    "no_run_no_checkout",
    "continuation_not_productive",
    "continuation_budget_blocked",
    "backoff_not_a_reason_we_invented",
  ] as const;
  for (const reason of abandoned) {
    expect(ROUTINE_EXECUTION_OWNED_SKIP_REASONS.has(reason)).toBe(false);
    expect(
      routineExecutionSkipNeedsBlockedEscalation({
        originKind: "routine_execution",
        skipReason: reason,
      }),
    ).toBe(true);
  }
});

it("leaves every non-routine_execution origin on its existing skip behaviour", () => {
  for (const originKind of ["manual", "chat_channel", "harness_liveness_escalation", null, undefined]) {
    for (const skipReason of [
      "active_execution_path",
      "board_owned_recovery_action",
      "missing_assignee_agent",
      "no_run_no_checkout",
    ]) {
      expect(
        routineExecutionSkipNeedsBlockedEscalation({ originKind, skipReason }),
      ).toBe(false);
    }
  }
});

it("recognizes maxAttempts exhaustion only from the recorded recovery budget", () => {
  expect(
    isRecoveryBudgetExhausted({
      recoveryBudget: { state: "exhausted", attemptsUsed: 3, maxAttempts: 3 },
    }),
  ).toBe(true);
  expect(
    isRecoveryBudgetExhausted({
      recoveryBudget: { state: "spent", attemptsUsed: 3, maxAttempts: 3 },
    }),
  ).toBe(false);
  expect(isRecoveryBudgetExhausted({})).toBe(false);
  expect(isRecoveryBudgetExhausted({ recoveryBudget: "exhausted" })).toBe(false);
});
