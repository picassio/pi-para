import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { acquireLease, getLease, releaseLease, renewLease } from "../src/scheduler/leases.js";
import { SchedulerStateDB } from "../src/scheduler/state.js";
import { WikiScheduler, isCredentialEmbedError, resetSchedulersForTests } from "../src/scheduler/index.js";

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

  it("qmd-embed quietly records provider diagnostics for retry instead of flashing raw errors", async () => {
    const file = await tempDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = {
        getStatus: async () => ({ hasVectorIndex: false, needsEmbedding: 3 }),
        embed: async () => {
          console.error("embed error:", "API 429 https://provider.example/embeddings: rate limited");
          console.error("unrelated scheduler error");
          return { docsProcessed: 3, chunksEmbedded: 1, errors: 2, durationMs: 10 };
        },
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
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith("unrelated scheduler error");
      expect(scheduler.state.listHistory({ taskName: "qmd-embed", limit: 1 })[0]?.error).toContain("API 429");
      scheduler.stop();
    } finally {
      errorSpy.mockRestore();
      await file.cleanup();
    }
  });

  it("qmd-embed retains the swallowed provider cause when first-chunk probing throws", async () => {
    const file = await tempDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = {
        getStatus: async () => ({ hasVectorIndex: false, needsEmbedding: 1 }),
        embed: async () => {
          console.error("embed error:", "API 503 https://provider.example/embeddings: unavailable");
          throw new Error("Failed to get embedding dimensions from first chunk");
        },
      };
      const scheduler = new WikiScheduler({ wikiDir: file.dir, dbPath: file.dbPath, storeProvider: () => store as any });
      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed" });
      await scheduler.tick();
      expect(errorSpy).not.toHaveBeenCalled();
      const failure = scheduler.state.listHistory({ taskName: "qmd-embed", limit: 1 })[0]?.error ?? "";
      expect(failure).toContain("Failed to get embedding dimensions from first chunk");
      expect(failure).toContain("API 503");
      scheduler.stop();
    } finally {
      errorSpy.mockRestore();
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

  it("classifies credential/billing embed failures", () => {
    expect(isCredentialEmbedError("embed failed — embed error: API 402 https://openrouter.ai/api/v1/embeddings: out of credits")).toBe(true);
    expect(isCredentialEmbedError("API 401 unauthorized")).toBe(true);
    expect(isCredentialEmbedError("API 403 forbidden")).toBe(true);
    expect(isCredentialEmbedError("API 429 rate limited")).toBe(false);
    expect(isCredentialEmbedError("API 500 server error")).toBe(false);
    expect(isCredentialEmbedError("The operation was aborted due to timeout")).toBe(false);
  });

  it("qmd-embed pauses durably after a 402 and resumes after backoff expiry", async () => {
    const file = await tempDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let embedCalls = 0;
      let failWith402 = true;
      const store = {
        getStatus: async () => ({ hasVectorIndex: false, needsEmbedding: 3 }),
        embed: async () => {
          embedCalls++;
          if (failWith402) {
            console.error("embed error:", "API 402 https://openrouter.ai/api/v1/embeddings: insufficient credits");
            return { docsProcessed: 0, chunksEmbedded: 0, errors: 3, durationMs: 5 };
          }
          return { docsProcessed: 3, chunksEmbedded: 3, errors: 0, durationMs: 5 };
        },
      };
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        storeProvider: () => store as any,
      });

      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed" });
      expect(await scheduler.tick()).toBe(1);
      expect(embedCalls).toBe(1);
      const history = scheduler.state.listHistory({ taskName: "qmd-embed", limit: 1 })[0];
      expect(history?.error).toContain("embedding paused until");
      const backoff = scheduler.state.getValue("qmd-embed-backoff-until");
      expect(backoff).toBeTruthy();
      expect(Date.parse(backoff!)).toBeGreaterThan(Date.now());

      // While the backoff is active, embed jobs complete without calling the provider.
      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed-2" });
      await scheduler.tick();
      expect(embedCalls).toBe(1);

      // Expired backoff resumes embedding; success clears the marker.
      failWith402 = false;
      scheduler.state.setValue("qmd-embed-backoff-until", new Date(Date.now() - 1_000).toISOString());
      scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed-3" });
      await scheduler.tick();
      expect(embedCalls).toBe(2);
      expect(scheduler.state.getValue("qmd-embed-backoff-until")).toBeNull();
      scheduler.stop();
    } finally {
      errorSpy.mockRestore();
      await file.cleanup();
    }
  });
});

describe("orphaned vector GC", () => {
  async function tempDb() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-gc-"));
    return { dir, dbPath: join(dir, ".pi-para.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("wiki-maintenance runs orphan GC at most once per day and records the result", async () => {
    const file = await tempDb();
    try {
      let gcCalls = 0;
      const store = {
        getStatus: async () => ({ hasVectorIndex: true, needsEmbedding: 0 }),
        internal: {
          cleanupOrphanedVectors: () => { gcCalls++; return 42; },
          cleanupOrphanedContent: () => 3,
        },
      };
      const scheduler = new WikiScheduler({
        wikiDir: file.dir,
        dbPath: file.dbPath,
        storeProvider: () => store as any,
      });

      // Direct call: private method via any-cast (unit surface)
      (scheduler as any).maybeCollectOrphanedVectors(store);
      expect(gcCalls).toBe(1);
      const result = JSON.parse(scheduler.state.getValue("qmd-vector-gc-last-result"));
      expect(result.chunks).toBe(42);
      expect(result.hashes).toBe(3);

      // Second call within 24h: skipped
      (scheduler as any).maybeCollectOrphanedVectors(store);
      expect(gcCalls).toBe(1);

      // Expired interval: runs again
      scheduler.state.setValue("qmd-vector-gc-last-run", new Date(Date.now() - 25 * 60 * 60_000).toISOString());
      (scheduler as any).maybeCollectOrphanedVectors(store);
      expect(gcCalls).toBe(2);

      // A store without the internal API degrades silently
      (scheduler as any).maybeCollectOrphanedVectors({});
      scheduler.stop();
    } finally {
      await file.cleanup();
    }
  });
});
