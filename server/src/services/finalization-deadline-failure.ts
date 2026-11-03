/**
 * What a run records when its finalization control deadline expires (DIG-5758).
 *
 * The deadline is an internal control budget: `completeWorkspace` gives the
 * finalizer 60 s after the provider stops to persist the result, then the
 * reconciliation sweep writes the terminal row. When that budget expires the
 * run used to record the substituted board instruction in `error` and leave
 * `resultJson` null, so a reader saw a failed run with no cause and no record
 * of what the turn had already done. The instruction belongs in `nextAction`.
 *
 * The message below is built from facts the row already carries, so it is true
 * at the moment of the write and costs no extra query.
 */

export const FINALIZATION_DEADLINE_ERROR_CODE =
  "execution_finalization_deadline_exceeded";

/**
 * The board instruction. Kept in `nextAction` only; it names no cause and must
 * not be the reason a reader is given for the failure.
 */
export const FINALIZATION_DEADLINE_NEXT_ACTION =
  "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";

/** Bound for `heartbeat_runs.error`; the column is text but the board renders one line. */
const MAX_ERROR_LENGTH = 512;

export type FinalizationDeadlineRunFacts = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputBytes: number | null;
  processPid: number | null;
};

function iso(value: Date | null): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function bytes(value: number | null): string {
  return typeof value === "number" && value > 0 ? `${value} bytes` : "no byte count";
}

/**
 * One sentence a reader can act on: when the run last spoke, how much it
 * produced, when the budget ran out, and whether a provider process was still
 * recorded. Deliberately says nothing about an outcome it cannot know.
 */
export function finalizationDeadlineError(
  run: FinalizationDeadlineRunFacts,
  deadlineAt: Date | null,
  recordedAt: Date,
): string {
  const deadline = iso(deadlineAt) ?? "an earlier sweep";
  const lastOutput = iso(run.lastOutputAt);

  const opening = lastOutput
    ? `Finalization deadline exceeded: the run last produced output at ${lastOutput} (seq ${run.lastOutputSeq}, ${bytes(run.lastOutputBytes)}) and finished persisting after the control deadline at ${deadline}.`
    : `Finalization deadline exceeded: the run produced no output and finished persisting after the control deadline at ${deadline}.`;

  const provider =
    typeof run.processPid === "number"
      ? ` The run still recorded provider pid ${run.processPid}, so check that process before continuing.`
      : " No provider process was recorded on the run, so the provider had already stopped.";

  const guidance =
    " The work it completed before this write is in the run log; nothing was replayed.";

  const recorded = ` Recorded at ${iso(recordedAt) ?? "an unrecorded time"}.`;

  return `${opening}${provider}${guidance}${recorded}`.slice(0, MAX_ERROR_LENGTH);
}

/**
 * The marker written to `resultJson`, in the same spirit as
 * `cancellationResultJson`: the adapter result was never persisted, so the run
 * carries the facts it does have instead of `null`.
 */
export function finalizationDeadlineResultJson(
  run: FinalizationDeadlineRunFacts,
  deadlineAt: Date | null,
  recordedAt: Date,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    finalization: {
      cause: FINALIZATION_DEADLINE_ERROR_CODE,
      deadlineAt: iso(deadlineAt),
      lastOutputAt: iso(run.lastOutputAt),
      lastOutputSeq: run.lastOutputSeq,
      lastOutputBytes: run.lastOutputBytes,
      providerProcessRecorded: typeof run.processPid === "number",
      recordedAt: iso(recordedAt),
    },
  };
}
