import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
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

/**
 * A session file modified this recently is treated as still active: capturing
 * it now would both re-read a growing file and produce a summary that is
 * immediately stale, so it stays in the registry for a later pass.
 */
export const ACTIVE_SESSION_QUIET_MS = 10 * 60_000;

export async function enqueueCompletedSessionsFromRegistry(
  scheduler: WikiScheduler,
  wikiDir: string,
  opts: { stateDb?: StateDB; quietMs?: number } = {},
): Promise<number[]> {
  const entries = await readCompletedSessionRegistry(wikiDir);
  const { ids, survivors } = scanCompletedSessions(scheduler, entries, opts);
  // Compact the registry: keep one line per still-relevant session so the
  // file (and the startup scan) cannot grow without bound. Processed and
  // deleted sessions are dropped; unprocessed and still-active ones survive.
  if (survivors.length < entries.length) {
    await compactCompletedSessionRegistry(wikiDir, entries, survivors);
  }
  return ids;
}

export function enqueueCompletedSessions(
  scheduler: WikiScheduler,
  entries: CompletedSessionEntry[],
  opts: { stateDb?: StateDB; quietMs?: number } = {},
): number[] {
  return scanCompletedSessions(scheduler, entries, opts).ids;
}

function scanCompletedSessions(
  scheduler: WikiScheduler,
  entries: CompletedSessionEntry[],
  opts: { stateDb?: StateDB; quietMs?: number } = {},
): { ids: number[]; survivors: CompletedSessionEntry[] } {
  const quietMs = opts.quietMs ?? ACTIVE_SESSION_QUIET_MS;
  const ids: number[] = [];
  const survivors: CompletedSessionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.sessionPath)) continue;
    seen.add(entry.sessionPath);
    if (!existsSync(entry.sessionPath)) continue;
    // Still-active session: skip this pass but keep it registered.
    try {
      if (Date.now() - statSync(entry.sessionPath).mtimeMs < quietMs) {
        survivors.push(entry);
        continue;
      }
    } catch {
      continue;
    }
    if (opts.stateDb?.isProcessed(entry.sessionPath)) continue;
    survivors.push(entry);
    ids.push(scheduler.enqueue(
      "capture-session",
      { sessionPath: entry.sessionPath, scope: detectScopeFromSessionPath(entry.sessionPath) } satisfies CaptureSessionPayload,
      { dedupeKey: `capture-session:${entry.sessionPath}`, priority: 20 },
    ));
  }
  return { ids, survivors };
}

/**
 * Atomically rewrite the registry with the surviving entries, merging any
 * lines appended concurrently since `snapshot` was read.
 */
async function compactCompletedSessionRegistry(
  wikiDir: string,
  snapshot: CompletedSessionEntry[],
  survivors: CompletedSessionEntry[],
): Promise<void> {
  const registryPath = join(wikiDir, ".completed-sessions");
  try {
    const snapshotPaths = new Set(snapshot.map((entry) => entry.sessionPath));
    const current = await readCompletedSessionRegistry(wikiDir);
    const appendedSinceSnapshot = current.filter((entry) => !snapshotPaths.has(entry.sessionPath));
    const lines = [...survivors, ...appendedSinceSnapshot]
      .map((entry) => `${entry.timestamp}|${entry.sessionPath}`)
      .join("\n");
    const tmpPath = `${registryPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, lines ? `${lines}\n` : "", "utf-8");
    await rename(tmpPath, registryPath);
  } catch {
    // Compaction is an optimization; the registry stays valid without it.
  }
}

export function createCaptureSessionHandler(deps: CaptureSessionDeps): SchedulerTaskHandler {
  return async (item: QueueItem, scheduler: WikiScheduler) => {
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
        // Capture writes pages through processSession, which reindexes BM25
        // inline but never embeds. Chain a deduplicated qmd-embed task so the
        // new pages become vector-searchable without waiting for the next
        // session startup drain. Enqueued on the same scheduler, so the
        // surrounding tick loop claims it right after this task completes.
        if (scheduler.embedEnabled && result.pagesCreated.length + result.pagesUpdated.length > 0) {
          scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed", priority: 5 });
        }
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
