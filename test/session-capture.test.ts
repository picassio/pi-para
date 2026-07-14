import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDB } from "../src/state.js";
import { WikiScheduler } from "../src/scheduler/index.js";
import {
  appendCompletedSession,
  createCaptureSessionHandler,
  detectScopeFromSessionPath,
  enqueueCompletedSessions,
  enqueueCompletedSessionsFromRegistry,
  parseCompletedSessionLine,
  readCompletedSessionRegistry,
} from "../src/scheduler/session-capture.js";

describe("scheduler session capture", () => {
  async function tempWiki() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-capture-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("parses, appends, and reads completed-session registry entries", async () => {
    const tmp = await tempWiki();
    try {
      expect(parseCompletedSessionLine("")).toBeNull();
      expect(parseCompletedSessionLine("bad-line")).toBeNull();
      expect(parseCompletedSessionLine("2026-01-01T00:00:00.000Z|/tmp/s.jsonl")).toEqual({
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionPath: "/tmp/s.jsonl",
      });
      await appendCompletedSession(tmp.dir, "/tmp/a.jsonl", "2026-01-01T00:00:00.000Z");
      await appendCompletedSession(tmp.dir, "/tmp/b.jsonl", "2026-01-01T00:00:01.000Z");
      expect(await readCompletedSessionRegistry(tmp.dir)).toHaveLength(2);
    } finally {
      await tmp.cleanup();
    }
  });

  it("detects scope from session header and encoded path fallback", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, `${JSON.stringify({ cwd: "/home/me/projects/my-app" })}\n`, "utf-8");
      expect(detectScopeFromSessionPath(session)).toBe("my-app");
      expect(detectScopeFromSessionPath("/home/me/.pi/agent/sessions/--home-me-projects-agent-board--/s.jsonl")).toBe("agent-board");
      expect(detectScopeFromSessionPath("/no/header/here.jsonl")).toBe("unknown");
    } finally {
      await tmp.cleanup();
    }
  });

  it("enqueues unprocessed existing sessions with dedupe", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, `${JSON.stringify({ cwd: "/repo/proj" })}\nuser`, "utf-8");
      const scheduler = new WikiScheduler({ wikiDir: tmp.dir, dbPath: join(tmp.dir, ".pi-para.sqlite") });
      const ids = enqueueCompletedSessions(scheduler, [{ timestamp: "t", sessionPath: session }]);
      const duplicate = enqueueCompletedSessions(scheduler, [{ timestamp: "t", sessionPath: session }]);
      expect(ids).toHaveLength(1);
      expect(duplicate).toEqual(ids);
      expect(scheduler.state.list("queued")[0]?.taskName).toBe("capture-session");
      scheduler.stop();
    } finally {
      await tmp.cleanup();
    }
  });

  it("enqueues from registry and skips already processed sessions", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, "{}\ncontent", "utf-8");
      await appendCompletedSession(tmp.dir, session, "t");
      const state = new StateDB(tmp.dir);
      state.recordSuccess(session, "scope", [], []);
      const scheduler = new WikiScheduler({ wikiDir: tmp.dir, dbPath: join(tmp.dir, ".pi-para.sqlite") });
      expect(await enqueueCompletedSessionsFromRegistry(scheduler, tmp.dir, { stateDb: state })).toEqual([]);
      state.close();
      scheduler.stop();
    } finally {
      await tmp.cleanup();
    }
  });

  it("runs capture-session handler and records success/failure", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, `${JSON.stringify({ cwd: "/repo/proj" })}\ncontent`, "utf-8");
      const state = new StateDB(tmp.dir);
      const scheduler = new WikiScheduler({
        wikiDir: tmp.dir,
        dbPath: join(tmp.dir, ".pi-para.sqlite"),
        handlers: {
          "capture-session": createCaptureSessionHandler({
            wikiDir: tmp.dir,
            storeProvider: () => ({} as any),
            model: {} as any,
            getApiKey: async () => "key",
            stateDb: state,
            processor: async () => ({ skipped: false, pagesCreated: ["resources/a"], pagesUpdated: [] }),
          }),
        },
      });
      scheduler.enqueue("capture-session", { sessionPath: session, scope: "proj" });
      expect(await scheduler.tick()).toBe(1);
      expect(state.isProcessed(session)).toBe(true);
      expect(state.getHistory("proj", 1)[0]?.pagesCreated).toEqual(["resources/a"]);
      scheduler.stop();
      state.close();
    } finally {
      await tmp.cleanup();
    }
  });

  it("capture-session chains qmd-embed when pages were written and embedding is enabled", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, `${JSON.stringify({ cwd: "/repo/proj" })}\ncontent`, "utf-8");
      const state = new StateDB(tmp.dir);
      let embedCalls = 0;
      const store = {
        getStatus: async () => ({ hasVectorIndex: false, needsEmbedding: 2 }),
        embed: async () => { embedCalls++; return { docsProcessed: 2, chunksEmbedded: 2, errors: 0, durationMs: 5 }; },
      };
      const scheduler = new WikiScheduler({
        wikiDir: tmp.dir,
        dbPath: join(tmp.dir, ".pi-para.sqlite"),
        storeProvider: () => store as any,
        embedEnabled: true,
        handlers: {
          "capture-session": createCaptureSessionHandler({
            wikiDir: tmp.dir,
            storeProvider: () => store as any,
            model: {} as any,
            getApiKey: async () => "key",
            stateDb: state,
            processor: async () => ({ skipped: false, pagesCreated: ["resources/a"], pagesUpdated: [] }),
          }),
        },
      });
      scheduler.enqueue("capture-session", { sessionPath: session, scope: "proj" });
      // One tick drains capture AND the chained qmd-embed task.
      expect(await scheduler.tick()).toBe(2);
      expect(embedCalls).toBe(1);
      const tasks = scheduler.state.list().map((t) => `${t.taskName}:${t.status}`);
      expect(tasks).toContain("qmd-embed:done");
      scheduler.stop();
      state.close();
    } finally {
      await tmp.cleanup();
    }
  });

  it("capture-session does not chain qmd-embed for skipped sessions or disabled embedding", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, `${JSON.stringify({ cwd: "/repo/proj" })}\ncontent`, "utf-8");
      const state = new StateDB(tmp.dir);
      const scheduler = new WikiScheduler({
        wikiDir: tmp.dir,
        dbPath: join(tmp.dir, ".pi-para.sqlite"),
        embedEnabled: false,
        handlers: {
          "capture-session": createCaptureSessionHandler({
            wikiDir: tmp.dir,
            storeProvider: () => ({} as any),
            model: {} as any,
            getApiKey: async () => "key",
            stateDb: state,
            processor: async () => ({ skipped: false, pagesCreated: ["resources/a"], pagesUpdated: [] }),
          }),
        },
      });
      scheduler.enqueue("capture-session", { sessionPath: session, scope: "proj" });
      expect(await scheduler.tick()).toBe(1);
      expect(scheduler.state.list().map((t) => t.taskName)).not.toContain("qmd-embed");
      scheduler.stop();
      state.close();
    } finally {
      await tmp.cleanup();
    }
  });

  it("capture-session handler fails clearly when dependencies are unavailable", async () => {
    const tmp = await tempWiki();
    try {
      const session = join(tmp.dir, "session.jsonl");
      await writeFile(session, "{}\ncontent", "utf-8");
      const scheduler = new WikiScheduler({
        wikiDir: tmp.dir,
        dbPath: join(tmp.dir, ".pi-para.sqlite"),
        handlers: {
          "capture-session": createCaptureSessionHandler({ wikiDir: tmp.dir, storeProvider: () => null }),
        },
      });
      scheduler.enqueue("capture-session", { sessionPath: session });
      await scheduler.tick();
      expect(scheduler.state.list()[0]?.status).toBe("queued");
      scheduler.stop();
    } finally {
      await tmp.cleanup();
    }
  });
});
