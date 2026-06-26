import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDB } from "../src/state.js";
import { SchedulerStateDB } from "../src/scheduler/state.js";
import { appendCompletedSession } from "../src/scheduler/session-capture.js";
import {
  formatQueueCaptureRecentResult,
  formatQueueItem,
  formatQueueItems,
  formatSchedulerHistory,
  getSchedulerTask,
  listSchedulerHistory,
  listSchedulerTasks,
  queueCaptureRecent,
  retryFailedSchedulerTasks,
} from "../src/scheduler/controls.js";

describe("scheduler controls", () => {
  async function tempWiki() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-controls-"));
    return { dir, dbPath: join(dir, ".pi-para.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("queues recent completed sessions and formats the result", async () => {
    const tmp = await tempWiki();
    try {
      const recent = join(tmp.dir, "recent.jsonl");
      const old = join(tmp.dir, "old.jsonl");
      await writeFile(recent, `${JSON.stringify({ cwd: "/repo/recent" })}\ncontent`, "utf-8");
      await writeFile(old, `${JSON.stringify({ cwd: "/repo/old" })}\ncontent`, "utf-8");
      await appendCompletedSession(tmp.dir, recent, "2026-01-02T00:00:00.000Z");
      await appendCompletedSession(tmp.dir, old, "2025-12-30T00:00:00.000Z");

      const result = await queueCaptureRecent({
        wikiDir: tmp.dir,
        dbPath: tmp.dbPath,
        hours: 24,
        now: new Date("2026-01-02T01:00:00.000Z"),
      });
      expect(result).toMatchObject({ scanned: 2, eligible: 1 });
      expect(result.queuedIds).toHaveLength(1);
      expect(formatQueueCaptureRecentResult(result)).toContain("Queued 1 capture task");
      expect(listSchedulerTasks(tmp.dir, { dbPath: tmp.dbPath, status: "queued" })).toHaveLength(1);
    } finally {
      await tmp.cleanup();
    }
  });

  it("does not queue already processed recent sessions", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, "{}\ncontent", "utf-8");
      await appendCompletedSession(tmp.dir, session, "2026-01-02T00:00:00.000Z");
      const state = new StateDB(tmp.dir);
      state.recordSuccess(session, "scope", [], []);
      state.close();
      const result = await queueCaptureRecent({ wikiDir: tmp.dir, dbPath: tmp.dbPath, now: new Date("2026-01-02T01:00:00.000Z") });
      expect(result.queuedIds).toEqual([]);
    } finally {
      await tmp.cleanup();
    }
  });

  it("lists and retries failed scheduler tasks", async () => {
    const tmp = await tempWiki();
    try {
      const db = new SchedulerStateDB(tmp.dbPath);
      const id = db.enqueue("task-a", {}, { now: new Date("2026-01-01T00:00:00Z") });
      db.claimNext(new Date("2026-01-01T00:00:01Z"));
      db.fail(id, "boom", { maxAttempts: 1, now: new Date("2026-01-01T00:00:02Z") });
      db.close();

      expect(formatQueueItems(listSchedulerTasks(tmp.dir, { dbPath: tmp.dbPath }))).toContain("failed task-a");
      expect(formatQueueItem(getSchedulerTask(tmp.dir, id, { dbPath: tmp.dbPath }))).toContain("Task 1: task-a");
      expect(formatQueueItem(null)).toBe("Scheduler task not found.");
      const history = listSchedulerHistory(tmp.dir, { dbPath: tmp.dbPath, taskName: "task-a", limit: 5 });
      expect(history[0]?.status).toBe("failed");
      expect(formatSchedulerHistory(history)).toContain("failed task-a");
      expect(formatSchedulerHistory([])).toBe("No scheduler history.");
      expect(retryFailedSchedulerTasks(tmp.dir, { dbPath: tmp.dbPath, taskName: "task-a", now: new Date("2026-01-01T00:00:03Z") })).toBe(1);
      expect(listSchedulerTasks(tmp.dir, { dbPath: tmp.dbPath, status: "queued" })[0]?.id).toBe(id);
      expect(formatQueueItems([])).toBe("No scheduler tasks queued.");
    } finally {
      await tmp.cleanup();
    }
  });
});
