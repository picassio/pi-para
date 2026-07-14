import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { acquireLease, getLease, releaseLease, renewLease } from "../src/scheduler/leases.js";
import { SchedulerStateDB } from "../src/scheduler/state.js";
import { WikiScheduler, resetSchedulersForTests } from "../src/scheduler/index.js";

describe("scheduler", () => {
  afterEach(() => resetSchedulersForTests());

  async function tempDb() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-scheduler-"));
    return { dir, dbPath: join(dir, ".pi-para.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("acquires, renews, expires, and releases leases atomically", () => {
    const db = new Database(":memory:");
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      expect(acquireLease(db, "qmd", "holder-a", { now, ttlMs: 1000 })).toBe(true);
      expect(acquireLease(db, "qmd", "holder-b", { now: new Date(now.getTime() + 500), ttlMs: 1000 })).toBe(false);
      expect(renewLease(db, "qmd", "holder-a", { now: new Date(now.getTime() + 600), ttlMs: 1000 })).toBe(true);
      expect(getLease(db, "qmd")?.holderId).toBe("holder-a");
      expect(acquireLease(db, "qmd", "holder-b", { now: new Date(now.getTime() + 2000), ttlMs: 1000 })).toBe(true);
      expect(releaseLease(db, "qmd", "holder-a")).toBe(false);
      expect(releaseLease(db, "qmd", "holder-b")).toBe(true);
      expect(getLease(db, "qmd")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("dedupes queue entries, claims by priority, and completes work", async () => {
    const file = await tempDb();
    try {
      const state = new SchedulerStateDB(file.dbPath);
      const first = state.enqueue("low", { a: 1 }, { dedupeKey: "same", priority: 1, now: new Date("2026-01-01T00:00:00Z") });
      const duplicate = state.enqueue("low", { a: 2 }, { dedupeKey: "same", priority: 1 });
      const high = state.enqueue("high", { b: 1 }, { priority: 10, now: new Date("2026-01-01T00:00:01Z") });
      expect(duplicate).toBe(first);
      expect(state.list("queued")).toHaveLength(2);
      const claimed = state.claimNext(new Date("2026-01-01T00:00:02Z"));
      expect(claimed?.id).toBe(high);
      expect(claimed?.attempts).toBe(1);
      state.complete(high);
      expect(state.get(high)?.status).toBe("done");
      state.close();
    } finally {
      await file.cleanup();
    }
  });

  it("retries failed work until max attempts", async () => {
    const file = await tempDb();
    try {
      const state = new SchedulerStateDB(file.dbPath);
      const id = state.enqueue("task", {}, { now: new Date("2026-01-01T00:00:00Z") });
      const item = state.claimNext(new Date("2026-01-01T00:00:01Z"));
      expect(item?.id).toBe(id);
      state.fail(id, "boom", { retryAt: new Date("2026-01-01T00:00:02Z"), maxAttempts: 2, now: new Date("2026-01-01T00:00:01Z") });
      expect(state.get(id)?.status).toBe("queued");
      state.claimNext(new Date("2026-01-01T00:00:03Z"));
      state.fail(id, "boom again", { retryAt: new Date("2026-01-01T00:00:04Z"), maxAttempts: 2, now: new Date("2026-01-01T00:00:03Z") });
      expect(state.get(id)?.status).toBe("failed");
      state.close();
    } finally {
      await file.cleanup();
    }
  });

  it("runs custom handlers through the scheduler public interface", async () => {
    const file = await tempDb();
    try {
      const seen: unknown[] = [];
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        enabled: true,
        handlers: {
          custom: async (item) => { seen.push(item.payload); },
        },
      });
      scheduler.enqueue("custom", { hello: "world" });
      expect(await scheduler.tick()).toBe(1);
      expect(seen).toEqual([{ hello: "world" }]);
      expect(scheduler.state.list()[0]?.status).toBe("done");
      scheduler.stop();
    } finally {
      await file.cleanup();
    }
  });

  it("requeues stale running tasks", async () => {
    const file = await tempDb();
    try {
      const state = new SchedulerStateDB(file.dbPath);
      const id = state.enqueue("stale", {}, { now: new Date("2026-01-01T00:00:00Z") });
      state.claimNext(new Date("2026-01-01T00:00:01Z"));
      expect(state.get(id)?.status).toBe("running");
      expect(state.requeueRunning(new Date("2026-01-01T00:00:02Z"))).toBe(1);
      expect(state.get(id)?.status).toBe("queued");
      state.close();
    } finally {
      await file.cleanup();
    }
  });

  it("stops cleanly while a handler is still running", async () => {
    const file = await tempDb();
    try {
      let release!: () => void;
      const running = new Promise<void>((resolve) => { release = resolve; });
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        handlers: {
          slow: async () => { await running; },
        },
      });

      scheduler.enqueue("slow", {});
      const tick = scheduler.tick();
      scheduler.stop();
      release();

      await expect(tick).resolves.toBe(1);
    } finally {
      await file.cleanup();
    }
  });

  it("qmd-embed skips when no embeddings are pending", async () => {
    const file = await tempDb();
    try {
      let embedCalls = 0;
      const store = {
        getStatus: async () => ({ hasVectorIndex: true, needsEmbedding: 0 }),
        embed: async () => { embedCalls++; return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
      };
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        storeProvider: () => store as any,
      });
      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed" });
      expect(await scheduler.tick()).toBe(1);
      expect(embedCalls).toBe(0);
      expect(scheduler.state.list()[0]?.status).toBe("done");
      scheduler.stop();
    } finally {
      await file.cleanup();
    }
  });

  it("qmd-embed drains a pending backlog via store.embed", async () => {
    const file = await tempDb();
    try {
      let embedCalls = 0;
      const store = {
        getStatus: async () => ({ hasVectorIndex: false, needsEmbedding: 5 }),
        embed: async () => { embedCalls++; return { docsProcessed: 5, chunksEmbedded: 5, errors: 0, durationMs: 10 }; },
      };
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        storeProvider: () => store as any,
      });
      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed" });
      expect(await scheduler.tick()).toBe(1);
      expect(embedCalls).toBe(1);
      expect(scheduler.state.list()[0]?.status).toBe("done");
      scheduler.stop();
    } finally {
      await file.cleanup();
    }
  });

  it("qmd-embed records provider failures for retry instead of swallowing them", async () => {
    const file = await tempDb();
    try {
      const store = {
        getStatus: async () => ({ hasVectorIndex: false, needsEmbedding: 3 }),
        embed: async () => ({ docsProcessed: 3, chunksEmbedded: 1, errors: 2, durationMs: 10 }),
      };
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        storeProvider: () => store as any,
      });
      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed" });
      expect(await scheduler.tick()).toBe(1);
      const item = scheduler.state.list()[0];
      expect(item?.status).toBe("queued"); // failed → retry with backoff
      expect(item?.attempts).toBe(1);
      scheduler.stop();
    } finally {
      await file.cleanup();
    }
  });

  it("wiki-maintenance chains qmd-embed only when embedEnabled", async () => {
    const file = await tempDb();
    try {
      const store = {
        update: async () => {},
        getStatus: async () => ({ hasVectorIndex: true, needsEmbedding: 0 }),
        embed: async () => ({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
      };
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        storeProvider: () => store as any,
        embedEnabled: true,
      });
      scheduler.enqueue("wiki-maintenance", {}, { dedupeKey: "wiki-maintenance" });
      await scheduler.tick();
      const tasks = scheduler.state.list().map((t) => t.taskName);
      expect(tasks).toContain("qmd-embed");
      scheduler.stop();

      // Disabled: no chaining
      resetSchedulersForTests();
      const file2 = await tempDb();
      const scheduler2 = new WikiScheduler({
        wikiDir: file2.dir,
        dbPath: file2.dbPath,
        storeProvider: () => store as any,
        embedEnabled: false,
      });
      scheduler2.enqueue("wiki-maintenance", {}, { dedupeKey: "wiki-maintenance" });
      await scheduler2.tick();
      expect(scheduler2.state.list().map((t) => t.taskName)).not.toContain("qmd-embed");
      scheduler2.stop();
      await file2.cleanup();
    } finally {
      await file.cleanup();
    }
  });

  it("marks unknown tasks failed", async () => {
    const file = await tempDb();
    try {
      const scheduler = new WikiScheduler({ wikiDir: file.dir, dbPath: file.dbPath });
      scheduler.enqueue("missing", {});
      expect(await scheduler.tick()).toBe(1);
      expect(scheduler.state.list()[0]?.status).toBe("failed");
      scheduler.stop();
    } finally {
      await file.cleanup();
    }
  });
});
