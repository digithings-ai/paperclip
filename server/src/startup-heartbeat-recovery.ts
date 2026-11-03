import type { heartbeatService } from "./services/heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

export type StartupRecoveryHeartbeat = Pick<
  HeartbeatService,
  | "promoteDueScheduledRetries"
  | "resumeQueuedRuns"
  | "recoverPendingSessionGoalActions"
  | "recoverActiveSessionGoals"
  | "reconcileStrandedAssignedIssues"
  | "reconcileResolvedDependencyWakes"
  | "reconcileTaskWatchdogs"
  | "scanSilentActiveRuns"
  | "sweepStaleIssueLocks"
  | "sweepOrphanedRunContinuations"
>;

export type StartupRecoveryLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type StartupNativeRecoveryHeartbeat = Pick<
  HeartbeatService,
  "recoverNativeRunsAfterRestart"
>;

/**
 * Native runner restart recovery stays fail-closed: on failure it logs and
 * rethrows, so startup does not continue with native runs in an unknown state.
 */
export async function runStartupNativeRecoveryFailClosed(input: {
  heartbeat: StartupNativeRecoveryHeartbeat;
  logger: StartupRecoveryLogger;
}) {
  const { heartbeat, logger } = input;
  try {
    const nativeRecovery = await heartbeat.recoverNativeRunsAfterRestart();
    if (nativeRecovery.dispositions.length > 0) {
      logger.info(
        {
          restartKind: nativeRecovery.restartKind,
          claims: nativeRecovery.claims.map((claim) => ({
            runId: claim.runId,
            disposition: claim.kind,
            controllerGeneration: claim.controllerGeneration,
          })),
          awaitingEvidenceRunIds: nativeRecovery.awaitingEvidenceRunIds,
          blockedRunIds: nativeRecovery.blockedRunIds,
        },
        "startup native runner restart recovery classified",
      );
    }
    return nativeRecovery;
  } catch (err) {
    logger.error({ err }, "startup native runner restart recovery failed closed");
    throw err;
  }
}

export type StartupRecoveryStepOutcome = { step: string; ok: boolean };

/**
 * Runs the recoverable startup heartbeat recovery steps in order. Each step
 * has its own try/catch: a failure is logged and the next step still runs, so
 * one bad pass (for example, a wake for a paused seat) cannot exit startup.
 * The periodic timers run the same passes later, so a skipped step heals on
 * the next tick.
 *
 * Native runner restart recovery is intentionally NOT here: it stays
 * fail-closed in index.ts.
 */
export async function runStartupRecoverableSteps(input: {
  heartbeat: StartupRecoveryHeartbeat;
  logger: StartupRecoveryLogger;
}): Promise<StartupRecoveryStepOutcome[]> {
  const { heartbeat, logger } = input;
  const outcomes: StartupRecoveryStepOutcome[] = [];

  async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      const value = await run();
      outcomes.push({ step: name, ok: true });
      return value;
    } catch (err) {
      outcomes.push({ step: name, ok: false });
      logger.error(
        { err, step: name },
        "startup heartbeat recovery step failed - continuing with the next step",
      );
      return null;
    }
  }

  const promotion = await step("promote_due_scheduled_retries", () =>
    heartbeat.promoteDueScheduledRetries(),
  );
  await step("resume_queued_runs", () => heartbeat.resumeQueuedRuns());

  await step("recover_pending_session_goal_actions", async () => {
    const recoveredGoalActions = await heartbeat.recoverPendingSessionGoalActions();
    if (recoveredGoalActions.enqueued > 0 || recoveredGoalActions.invalid > 0) {
      logger.warn(
        { ...recoveredGoalActions },
        "startup session-goal action outbox recovery reconciled pending controls",
      );
    }
  });

  await step("recover_active_session_goals", async () => {
    const recoveredGoals = await heartbeat.recoverActiveSessionGoals();
    if (recoveredGoals.enqueued > 0) {
      logger.warn(
        { ...recoveredGoals },
        "startup session-goal recovery resumed durable agent goals",
      );
    }
  });

  await step("reconcile_stranded_assigned_issues", async () => {
    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    const promoted = promotion?.promoted ?? 0;
    if (
      promoted > 0 ||
      reconciled.assignmentDispatched > 0 ||
      reconciled.dispatchRequeued > 0 ||
      reconciled.continuationRequeued > 0 ||
      reconciled.successfulRunHandoffEscalated > 0 ||
      reconciled.successfulRunHandoffRetried > 0 ||
      reconciled.escalated > 0
    ) {
      logger.warn(
        {
          promotedScheduledRetries: promoted,
          promotedScheduledRetryRunIds: promotion?.runIds ?? [],
          ...reconciled,
        },
        "startup heartbeat recovery changed assigned issue state",
      );
    }
  });

  await step("reconcile_resolved_dependency_wakes", async () => {
    const dependencyWakesReconciled = await heartbeat.reconcileResolvedDependencyWakes();
    if (dependencyWakesReconciled.healed > 0) {
      logger.warn(
        { ...dependencyWakesReconciled },
        "startup dependency-wake reconciliation restored task execution paths",
      );
    }
  });

  await step("reconcile_task_watchdogs", async () => {
    const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
    if (taskWatchdogsReconciled.triggered > 0) {
      logger.warn(
        { ...taskWatchdogsReconciled },
        "startup task-watchdog reconciliation triggered watchdog work",
      );
    }
  });

  await step("scan_silent_active_runs", async () => {
    const scanned = await heartbeat.scanSilentActiveRuns();
    if (scanned.created > 0 || scanned.escalated > 0) {
      logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
    }
  });

  await step("sweep_stale_issue_locks", async () => {
    const swept = await heartbeat.sweepStaleIssueLocks();
    if (swept.cleared > 0) {
      logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
    }
  });

  await step("sweep_orphaned_run_continuations", async () => {
    const continued = await heartbeat.sweepOrphanedRunContinuations();
    if (continued.continued > 0) {
      logger.warn(
        { ...continued },
        "startup orphaned-run sweeper continued terminalized runs",
      );
    }
  });

  const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.step);
  if (failed.length > 0) {
    logger.warn(
      { failedSteps: failed, totalSteps: outcomes.length },
      "startup heartbeat recovery finished with failed steps",
    );
  }
  return outcomes;
}
