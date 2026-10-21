import type { RequestHandler } from "express";
import {
  createDbMonitoringClient,
  databaseApplicationName,
  databasePoolMax,
  type Db,
} from "@paperclipai/db";
import { logger } from "./logger.js";

/** How long the pool must stay saturated before the API fails fast. */
const DEFAULT_GRACE_MS = 10_000;
/** How often the monitor reads the state of the pool. */
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
/** The `Retry-After` value of the 503 answer. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Reads a positive integer from the environment, or returns the default. */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/** The paths that carry the API and the MCP protocol. */
const PROTOCOL_PATH = /^\/(?:api|mcp)(?:\/|$)/i;
/** The health path answers even when the pool is saturated. It is the diagnostic. */
const HEALTH_PATH = /^\/api\/health(?:\/|$)/i;

export interface DbPoolSaturationOptions {
  /** The database whose pool the guard watches. */
  db: Db;
  /** How long the pool must stay saturated before the API fails fast. */
  graceMs?: number;
  /** How often the monitor reads the state of the pool. */
  sampleIntervalMs?: number;
  /** The `Retry-After` value of the 503 answer. */
  retryAfterSeconds?: number;
  /** Test override: reads the number of busy connections of the pool. */
  sample?: () => Promise<number>;
  /** Test override: reads the current time. */
  now?: () => number;
}

export interface DbPoolSaturationSnapshot {
  /** The number of connections of the application pool that run a query. */
  busy: number;
  /** The number of connections the application pool can hold. */
  poolMax: number;
  /** The moment the pool became saturated, or null when it is not saturated. */
  saturatedSince: number | null;
  /** True when the pool stayed saturated for the whole grace period. */
  saturated: boolean;
}

export interface DbPoolSaturationGuard {
  /** The Express middleware that answers with a 503 while the pool is saturated. */
  middleware: RequestHandler;
  /** The current state of the pool. */
  snapshot: () => DbPoolSaturationSnapshot;
  /** Reads the state of the pool once. */
  poll: () => Promise<void>;
  /** Ends the monitor connection and stops the sampling. */
  stop: () => Promise<void>;
}

/**
 * Fails fast with a 503 when every connection of the application pool is busy.
 *
 * A saturated pool used to leave the API hanging: the request was accepted and
 * the answer came only after the queued query finished, which took minutes
 * under load. The health route stayed green the whole time, so the cause was
 * hard to see from the outside.
 *
 * The guard watches the pool from its own connection. The monitor connection
 * does not count as application traffic, so it still answers when every
 * connection of the application pool is busy.
 */
export function dbPoolSaturationMiddleware(options: DbPoolSaturationOptions): DbPoolSaturationGuard {
  const graceMs = options.graceMs ?? readPositiveInt("DATABASE_POOL_SATURATION_GRACE_MS", DEFAULT_GRACE_MS);
  const sampleIntervalMs = options.sampleIntervalMs
    ?? readPositiveInt("DATABASE_POOL_SATURATION_SAMPLE_INTERVAL_MS", DEFAULT_SAMPLE_INTERVAL_MS);
  const retryAfterSeconds = options.retryAfterSeconds
    ?? readPositiveInt("DATABASE_POOL_SATURATION_RETRY_AFTER_SECONDS", DEFAULT_RETRY_AFTER_SECONDS);
  const now = options.now ?? (() => Date.now());
  const poolMax = databasePoolMax(options.db);

  let monitorClient: ReturnType<typeof createDbMonitoringClient> = null;
  let monitorClientFailed = false;

  const takeSample = async (): Promise<number> => {
    if (options.sample) return options.sample();
    if (monitorClientFailed) return 0;
    if (!monitorClient) {
      monitorClient = createDbMonitoringClient(options.db);
      if (!monitorClient) {
        monitorClientFailed = true;
        return 0;
      }
    }
    const rows = await monitorClient.unsafe<{ busy: number }[]>(
      "select count(*)::int as busy from pg_stat_activity "
        + "where application_name = $1 and datname = current_database() "
        // A connection that waits inside a transaction holds a slot of the
        // pool without running a query. It counts as busy.
        + "and (state = 'active' or state like 'idle in transaction%') "
        + "and pid <> pg_backend_pid()",
      [databaseApplicationName(options.db)],
    );
    return rows[0]?.busy ?? 0;
  };

  let busy = 0;
  let saturatedSince: number | null = null;

  const poll = async () => {
    try {
      busy = await takeSample();
    } catch (error) {
      // A probe that cannot run says nothing about the pool. The guard stays
      // open, so a failure of the monitor never takes the API down. The last
      // state is dropped, because a state of an old sample must not keep the
      // API closed after the pool recovered.
      logger.warn({ err: error }, "database pool saturation probe failed");
      busy = 0;
      saturatedSince = null;
      return;
    }
    if (busy >= poolMax) {
      if (saturatedSince === null) saturatedSince = now();
      return;
    }
    saturatedSince = null;
  };

  const timer = setInterval(() => {
    void poll();
  }, sampleIntervalMs);
  timer.unref?.();

  const snapshot = (): DbPoolSaturationSnapshot => ({
    busy,
    poolMax,
    saturatedSince,
    saturated: saturatedSince !== null && now() - saturatedSince >= graceMs,
  });

  const middleware: RequestHandler = (req, res, next) => {
    if (!snapshot().saturated) {
      next();
      return;
    }
    // The health route is the diagnostic of a saturated pool. It answers.
    if (!PROTOCOL_PATH.test(req.path) || HEALTH_PATH.test(req.path)) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(503).json({ error: "database_pool_saturated" });
  };

  const stop = async () => {
    clearInterval(timer);
    if (!monitorClient) return;
    await monitorClient.end({ timeout: 1 }).catch(() => {});
    monitorClient = null;
  };

  return { middleware, snapshot, stop, poll };
}
