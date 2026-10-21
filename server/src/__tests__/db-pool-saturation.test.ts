import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { dbPoolSaturationMiddleware } from "../middleware/db-pool-saturation.js";

/** A database handle that carries the pool size the guard reads. */
function fakeDb(poolMax: number): Db {
  return { $client: { options: { max: poolMax, connection: { application_name: "paperclip" } } } } as unknown as Db;
}

describe("database pool saturation guard", () => {
  it("passes every request while the pool has a free connection", async () => {
    const app = express();
    const guard = dbPoolSaturationMiddleware({
      db: fakeDb(4),
      sample: async () => 3,
      now: () => 1_000,
    });
    app.use(guard.middleware);
    app.get("/api/companies", (_req, res) => res.json([]));
    try {
      await guard.poll();
      expect((await request(app).get("/api/companies")).status).toBe(200);
      expect(guard.snapshot()).toMatchObject({ busy: 3, poolMax: 4, saturated: false });
    } finally {
      await guard.stop();
    }
  });

  it("answers with a 503 after the pool stayed saturated for the grace period", async () => {
    const app = express();
    let clock = 0;
    const guard = dbPoolSaturationMiddleware({
      db: fakeDb(2),
      graceMs: 5_000,
      sample: async () => 2,
      now: () => clock,
    });
    app.use(guard.middleware);
    app.get("/api/companies", (_req, res) => res.json([]));
    try {
      await guard.poll();
      // The pool is saturated, but the grace period has not passed yet.
      expect((await request(app).get("/api/companies")).status).toBe(200);
      expect(guard.snapshot()).toMatchObject({ busy: 2, poolMax: 2, saturated: false });

      clock = 6_000;
      expect(guard.snapshot().saturated).toBe(true);
      expect((await request(app).get("/api/companies")).status).toBe(503);
    } finally {
      await guard.stop();
    }
  });

  it("fails fast with a 503 and a Retry-After header when the pool is saturated", async () => {
    const app = express();
    let clock = 0;
    const guard = dbPoolSaturationMiddleware({
      db: fakeDb(1),
      graceMs: 1_000,
      retryAfterSeconds: 7,
      sample: async () => 1,
      now: () => clock,
    });
    app.use(guard.middleware);
    app.get("/api/companies", (_req, res) => res.json([]));
    try {
      await guard.poll();
      clock = 5_000;
      const response = await request(app).get("/api/companies");
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "database_pool_saturated" });
      expect(response.headers["retry-after"]).toBe("7");
    } finally {
      await guard.stop();
    }
  });

  it("keeps the health route reachable while the pool is saturated", async () => {
    const app = express();
    let clock = 0;
    const guard = dbPoolSaturationMiddleware({
      db: fakeDb(1),
      graceMs: 0,
      sample: async () => 1,
      now: () => clock,
    });
    app.use(guard.middleware);
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.get("/api/companies", (_req, res) => res.json([]));
    app.get("/assets/app.js", (_req, res) => res.type("js").send("ready"));
    try {
      await guard.poll();
      clock = 5_000;
      expect((await request(app).get("/api/health")).status).toBe(200);
      expect((await request(app).get("/api/companies")).status).toBe(503);
      // A page of the user interface is not a protocol path. It still answers.
      expect((await request(app).get("/assets/app.js")).status).toBe(200);
    } finally {
      await guard.stop();
    }
  });

  it("stays open when the probe cannot read the pool", async () => {
    const app = express();
    const guard = dbPoolSaturationMiddleware({
      db: fakeDb(1),
      graceMs: 0,
      sample: async () => { throw new Error("monitor offline"); },
      now: () => 0,
    });
    app.use(guard.middleware);
    app.get("/api/companies", (_req, res) => res.json([]));
    try {
      await guard.poll();
      expect(guard.snapshot().saturated).toBe(false);
      expect((await request(app).get("/api/companies")).status).toBe(200);
    } finally {
      await guard.stop();
    }
  });

  it("forgets the saturation when the pool frees a connection", async () => {
    const app = express();
    let busy = 1;
    const guard = dbPoolSaturationMiddleware({
      db: fakeDb(1),
      graceMs: 0,
      sample: async () => busy,
      now: () => 0,
    });
    app.use(guard.middleware);
    app.get("/api/companies", (_req, res) => res.json([]));
    try {
      await guard.poll();
      expect((await request(app).get("/api/companies")).status).toBe(503);
      busy = 0;
      await guard.poll();
      expect(guard.snapshot().saturated).toBe(false);
      expect((await request(app).get("/api/companies")).status).toBe(200);
    } finally {
      await guard.stop();
    }
  });

  it("does not open a monitor connection when the caller injects a probe", async () => {
    const sample = vi.fn(async () => 0);
    const guard = dbPoolSaturationMiddleware({ db: fakeDb(1), sample });
    try {
      await guard.poll();
      expect(sample).toHaveBeenCalledOnce();
    } finally {
      await guard.stop();
    }
  });
});
