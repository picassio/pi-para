import { appendFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { QMDStore } from "qmd-engine";
import { StateDB } from "../state.js";
import { processSession, type ProcessResult } from "../processor.js";
import type { QueueItem } from "./state.js";
import type { WikiScheduler, SchedulerTaskHandler } from "./index.js";

export interface CompletedSessionEntry {
  timestamp: string;
  sessionPath: string;
}

export interface CaptureSessionPayload {
  sessionPath: string;
  scope?: string;
}

export interface CaptureSessionDeps {
  wikiDir: string;
  storeProvider: () => QMDStore | null;
  model?: Model<any>;
  getApiKey?: (provider: string) => Promise<string | undefined>;
  stateDb?: StateDB;
  processor?: (
    sessionPath: string,
    wikiDir: string,
    store: QMDStore,
    scope: string,
    model: Model<any>,
    getApiKey: (provider: string) => Promise<string | undefined>,
  ) => Promise<ProcessResult>;
}

export function parseCompletedSessionLine(line: string): CompletedSessionEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("|", 2);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { timestamp: parts[0], sessionPath: parts[1] };
}

export async function readCompletedSessionRegistry(wikiDir: string): Promise<CompletedSessionEntry[]> {
  const registryPath = join(wikiDir, ".completed-sessions");
  if (!existsSync(registryPath)) return [];
  const content = await readFile(registryPath, "utf-8");
  return content
    .split(/\r?\n/)
    .map(parseCompletedSessionLine)
    .filter((entry): entry is CompletedSessionEntry => entry !== null);
}

export async function appendCompletedSession(
  wikiDir: string,
  sessionPath: string,
  timestamp = new Date().toISOString(),
): Promise<CompletedSessionEntry> {
  const registryPath = join(wikiDir, ".completed-sessions");
  await appendFile(registryPath, `${timestamp}|${sessionPath}\n`, "utf-8");
  return { timestamp, sessionPath };
}

export async function enqueueCompletedSessionsFromRegistry(
  scheduler: WikiScheduler,
  wikiDir: string,
  opts: { stateDb?: StateDB } = {},
): Promise<number[]> {
  const entries = await readCompletedSessionRegistry(wikiDir);
  return enqueueCompletedSessions(scheduler, entries, opts);
}

export function enqueueCompletedSessions(
  scheduler: WikiScheduler,
  entries: CompletedSessionEntry[],
  opts: { stateDb?: StateDB } = {},
): number[] {
  const ids: number[] = [];
  for (const entry of entries) {
    if (!existsSync(entry.sessionPath)) continue;
    if (opts.stateDb?.isProcessed(entry.sessionPath)) continue;
    ids.push(scheduler.enqueue(
      "capture-session",
      { sessionPath: entry.sessionPath, scope: detectScopeFromSessionPath(entry.sessionPath) } satisfies CaptureSessionPayload,
      { dedupeKey: `capture-session:${entry.sessionPath}`, priority: 20 },
    ));
  }
  return ids;
}

export function createCaptureSessionHandler(deps: CaptureSessionDeps): SchedulerTaskHandler {
  return async (item: QueueItem) => {
    const payload = item.payload as CaptureSessionPayload;
    if (!payload.sessionPath) throw new Error("capture-session payload missing sessionPath");
    if (!existsSync(payload.sessionPath)) throw new Error(`Session file not found: ${payload.sessionPath}`);

    const store = deps.storeProvider();
    if (!store) throw new Error("QMD store unavailable for capture-session");
    if (!deps.model) throw new Error("Capture model unavailable for capture-session");
    if (!deps.getApiKey) throw new Error("API key resolver unavailable for capture-session");

    const stateDb = deps.stateDb ?? new StateDB(deps.wikiDir);
    const ownsState = !deps.stateDb;
    const scope = payload.scope ?? detectScopeFromSessionPath(payload.sessionPath);
    try {
      if (stateDb.isProcessed(payload.sessionPath)) return;
      const run = deps.processor ?? processSession;
      const result = await run(payload.sessionPath, deps.wikiDir, store, scope, deps.model, deps.getApiKey);
      if (result.skipped) {
        stateDb.recordSuccess(payload.sessionPath, scope, [], []);
      } else {
        stateDb.recordSuccess(payload.sessionPath, scope, result.pagesCreated, result.pagesUpdated);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stateDb.recordFailure(payload.sessionPath, scope, message);
      throw err;
    } finally {
      if (ownsState) stateDb.close();
    }
  };
}

export function detectScopeFromSessionPath(sessionPath: string): string {
  try {
    const firstLine = requireReadFirstLine(sessionPath);
    const header = JSON.parse(firstLine) as { cwd?: string };
    if (header.cwd) return basename(header.cwd) || "unknown";
  } catch {
    // fall through to path decoding
  }

  const dirName = basename(dirname(sessionPath));
  if (dirName.startsWith("--") && dirName.endsWith("--")) {
    const inner = dirName.slice(2, -2);
    const projectsIdx = inner.indexOf("projects-");
    if (projectsIdx >= 0) return inner.slice(projectsIdx + "projects-".length);
  }
  return "unknown";
}

function requireReadFirstLine(path: string): string {
  const content = readFileSync(path, "utf-8");
  return content.split("\n")[0] ?? "";
}
