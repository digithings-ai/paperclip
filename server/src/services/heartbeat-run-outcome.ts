import type { RunCancellation } from "./run-cancellation.js";

/** Terminal run statuses the finalizer may persist. */
export const HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type HeartbeatRunTerminalStatus =
  (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number];

export type HeartbeatRunOutcome = HeartbeatRunTerminalStatus;

export function isTerminalHeartbeatRunStatus(
  status: unknown,
): status is HeartbeatRunTerminalStatus {
  return (
    typeof status === "string" &&
    (HEARTBEAT_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

export interface HeartbeatRunOutcomeInput {
  /** Status already persisted on the run row, if any. */
  persistedStatus?: string | null;
  /** True when the executor's abort controller fired. */
  controllerAborted?: boolean;
  /** Cancellation request recorded on the run, if any. */
  recordedCancellation?: RunCancellation | null;
  /** Native finalization verdict, when the native runtime owns the run. */
  nativeFinalization?:
    | { terminal?: { runTerminalState?: string | null } | null }
    | null;
  timedOut?: boolean;
  /** Status the adapter itself reported. */
  adapterStatus?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  /** POSIX signal that ended the provider process. */
  signal?: string | null;
  /** True when the process-level cancellation settlement failed. */
  processCancellationFailed?: boolean;
}

/**
 * Decide how a finished run is recorded.
 *
 * An aborted controller is not proof that a stop was requested. The only
 * evidence of a requested stop is a recorded cancellation on the run. Without
 * that evidence an abort (a lost controller lease, a provider that ended on
 * its own) must not be recorded as a cancellation: the adapter's own result
 * decides the outcome.
 */
export function resolveHeartbeatRunOutcome(
  input: HeartbeatRunOutcomeInput,
): HeartbeatRunOutcome {
  if (isTerminalHeartbeatRunStatus(input.persistedStatus)) {
    return input.persistedStatus;
  }
  if (input.controllerAborted && input.recordedCancellation) {
    return "cancelled";
  }
  if (input.nativeFinalization) {
    const nativeTerminal = input.nativeFinalization.terminal?.runTerminalState;
    return nativeTerminal === "succeeded"
      ? "succeeded"
      : nativeTerminal === "cancelled"
        ? "cancelled"
        : "failed";
  }
  if (input.timedOut) return "timed_out";
  if (input.adapterStatus === "cancelled") return "cancelled";
  if (
    (input.exitCode ?? 0) === 0 &&
    !input.errorMessage &&
    !input.signal &&
    !input.processCancellationFailed
  ) {
    return "succeeded";
  }
  return "failed";
}
