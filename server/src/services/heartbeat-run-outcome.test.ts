import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunOutcome } from "./heartbeat-run-outcome.js";
import { requestedRunCancellation } from "./run-cancellation.js";

describe("resolveHeartbeatRunOutcome", () => {
  it("records an exit-0 run as succeeded when no cancellation was requested", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: true,
        recordedCancellation: null,
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("succeeded");
  });

  it("records an exit-0 run as succeeded when the controller aborted without a cancellation request", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: true,
        recordedCancellation: null,
        exitCode: 0,
        errorMessage: null,
        signal: null,
        adapterStatus: null,
      }),
    ).toBe("succeeded");
  });

  it("keeps a requested cancellation cancelled", () => {
    const recordedCancellation = requestedRunCancellation({}, "Stopped by an operator");
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: true,
        recordedCancellation,
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("cancelled");
  });

  it("keeps a terminal status already persisted on the run", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "cancelled",
        controllerAborted: true,
        recordedCancellation: null,
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("cancelled");
  });

  it("fails an aborted run that reported an error", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: true,
        recordedCancellation: null,
        exitCode: 1,
        errorMessage: "adapter failed",
        signal: null,
      }),
    ).toBe("failed");
  });

  it("keeps a timeout, a provider cancellation and a signal failure distinct", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: false,
        recordedCancellation: null,
        timedOut: true,
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("timed_out");
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: false,
        recordedCancellation: null,
        adapterStatus: "cancelled",
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("cancelled");
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: false,
        recordedCancellation: null,
        exitCode: 0,
        errorMessage: null,
        signal: "SIGTERM",
      }),
    ).toBe("failed");
  });

  it("keeps the native finalization verdict", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: false,
        recordedCancellation: null,
        nativeFinalization: { terminal: { runTerminalState: "succeeded" } },
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("succeeded");
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: false,
        recordedCancellation: null,
        nativeFinalization: { terminal: { runTerminalState: "failed" } },
        exitCode: 0,
        errorMessage: null,
        signal: null,
      }),
    ).toBe("failed");
  });

  it("fails a run whose process cancellation settlement failed", () => {
    expect(
      resolveHeartbeatRunOutcome({
        persistedStatus: "running",
        controllerAborted: false,
        recordedCancellation: null,
        exitCode: 0,
        errorMessage: null,
        signal: null,
        processCancellationFailed: true,
      }),
    ).toBe("failed");
  });
});
