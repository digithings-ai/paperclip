import os from "node:os";

// Host saturation gate for bounded continuations.
//
// The recovery backstop terminalizes a run whose process and sandbox are gone.
// On 21 Oct 2026 every measured orphan came out of a saturated host (load
// average 128.5 on 18 cores, about 7.14 per core, against about 1.17 per core
// on a recovered host). Re-dispatching the same seat straight after the
// backstop would land it on the same saturated host, so the continuation needs
// a host-health gate.
//
// The product has no host-health input today, so this module is that input:
// a small, injectable read of the host load with an operator override. The
// gate is deliberately fail-open on an unreadable load: a continuation that
// fails is recoverable (the attempt cap bounds it), while a lost run is not.

export const DEFAULT_HOST_SATURATION_LOAD_PER_CORE = 3;

export type HostHealthSource = "override" | "load_average" | "unavailable";

export type HostHealth = {
  // True when the host is saturated and a continuation must not be dispatched.
  saturated: boolean;
  // Human-readable reason for the verdict, carried into logs and the sweep
  // result so an operator can see why a continuation did not fire.
  reason: string;
  source: HostHealthSource;
  loadAverage1m: number | null;
  cpuCount: number | null;
  loadPerCore: number | null;
  thresholdLoadPerCore: number;
};

export type HostHealthInput = {
  env?: Record<string, string | undefined>;
  // Injected for tests. When omitted the module reads the host directly.
  loadAverage1m?: number | null;
  cpuCount?: number | null;
};

const TRUTHY_OVERRIDE = new Set(["1", "true", "yes", "on"]);
const FALSY_OVERRIDE = new Set(["0", "false", "no", "off"]);

function readThreshold(env: Record<string, string | undefined>) {
  const raw = env.PAPERCLIP_HOST_SATURATION_LOAD_PER_CORE;
  if (raw === undefined) return DEFAULT_HOST_SATURATION_LOAD_PER_CORE;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HOST_SATURATION_LOAD_PER_CORE;
  }
  return parsed;
}

export function readHostHealth(input?: HostHealthInput): HostHealth {
  const env = input?.env ?? process.env;
  const thresholdLoadPerCore = readThreshold(env);

  const override = (env.PAPERCLIP_HOST_SATURATED ?? "").trim().toLowerCase();
  if (TRUTHY_OVERRIDE.has(override)) {
    return {
      saturated: true,
      reason: "host saturation forced by PAPERCLIP_HOST_SATURATED",
      source: "override",
      loadAverage1m: null,
      cpuCount: null,
      loadPerCore: null,
      thresholdLoadPerCore,
    };
  }
  if (FALSY_OVERRIDE.has(override)) {
    return {
      saturated: false,
      reason: "host saturation cleared by PAPERCLIP_HOST_SATURATED",
      source: "override",
      loadAverage1m: null,
      cpuCount: null,
      loadPerCore: null,
      thresholdLoadPerCore,
    };
  }

  const loadAverage1m =
    input?.loadAverage1m === undefined ? os.loadavg()[0] : input.loadAverage1m;
  const cpuCount = input?.cpuCount === undefined ? os.cpus().length : input.cpuCount;

  if (
    loadAverage1m === null ||
    !Number.isFinite(loadAverage1m) ||
    cpuCount === null ||
    !Number.isFinite(cpuCount) ||
    cpuCount <= 0
  ) {
    return {
      saturated: false,
      reason: "host load is unavailable, so the saturation gate stays open",
      source: "unavailable",
      loadAverage1m: loadAverage1m ?? null,
      cpuCount: cpuCount ?? null,
      loadPerCore: null,
      thresholdLoadPerCore,
    };
  }

  const loadPerCore = loadAverage1m / cpuCount;
  const saturated = loadPerCore >= thresholdLoadPerCore;
  return {
    saturated,
    reason: saturated
      ? `load ${loadAverage1m.toFixed(2)} over ${cpuCount} cpus is ${loadPerCore.toFixed(2)} per core, at or above the ${thresholdLoadPerCore} threshold`
      : `load ${loadAverage1m.toFixed(2)} over ${cpuCount} cpus is ${loadPerCore.toFixed(2)} per core, below the ${thresholdLoadPerCore} threshold`,
    source: "load_average",
    loadAverage1m,
    cpuCount,
    loadPerCore,
    thresholdLoadPerCore,
  };
}
