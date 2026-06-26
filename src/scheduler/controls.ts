import { getParaPaths } from "../paths.js";
import { StateDB } from "../state.js";
import { WikiScheduler } from "./index.js";
import { SchedulerStateDB, type QueueItem, type QueueStatus, type SchedulerHistoryItem } from "./state.js";
import { enqueueCompletedSessions, readCompletedSessionRegistry } from "./session-capture.js";

export interface QueueCaptureRecentOptions {
  wikiDir: string;
  dbPath?: string;
  hours?: number;
  now?: Date;
}

export interface QueueCaptureRecentResult {
  scanned: number;
  eligible: number;
  queuedIds: number[];
}

export async function queueCaptureRecent(options: QueueCaptureRecentOptions): Promise<QueueCaptureRecentResult> {
  const now = options.now ?? new Date();
  const hours = options.hours ?? 24;
  const cutoff = now.getTime() - hours * 60 * 60 * 1000;
  const entries = await readCompletedSessionRegistry(options.wikiDir);
  const eligible = entries.filter((entry) => {
    const ts = Date.parse(entry.timestamp);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const dbPath = options.dbPath ?? getParaPaths({ wikiDir: options.wikiDir }).schedulerDbPath;
  const scheduler = new WikiScheduler({ wikiDir: options.wikiDir, dbPath, enabled: true });
  const stateDb = new StateDB(options.wikiDir);
  try {
    const queuedIds = enqueueCompletedSessions(scheduler, eligible, { stateDb });
    return { scanned: entries.length, eligible: eligible.length, queuedIds };
  } finally {
    stateDb.close();
    scheduler.stop();
  }
}

export function listSchedulerTasks(
  wikiDir: string,
  opts: { dbPath?: string; status?: QueueStatus } = {},
): QueueItem[] {
  const db = new SchedulerStateDB(opts.dbPath ?? getParaPaths({ wikiDir }).schedulerDbPath);
  try {
    return db.list(opts.status);
  } finally {
    db.close();
  }
}

export function retryFailedSchedulerTasks(
  wikiDir: string,
  opts: { dbPath?: string; taskName?: string; now?: Date } = {},
): number {
  const db = new SchedulerStateDB(opts.dbPath ?? getParaPaths({ wikiDir }).schedulerDbPath);
  try {
    return db.retryFailed(opts.taskName, opts.now);
  } finally {
    db.close();
  }
}

export function getSchedulerTask(
  wikiDir: string,
  id: number,
  opts: { dbPath?: string } = {},
): QueueItem | null {
  const db = new SchedulerStateDB(opts.dbPath ?? getParaPaths({ wikiDir }).schedulerDbPath);
  try {
    return db.get(id);
  } finally {
    db.close();
  }
}

export function listSchedulerHistory(
  wikiDir: string,
  opts: { dbPath?: string; taskName?: string; limit?: number } = {},
): SchedulerHistoryItem[] {
  const db = new SchedulerStateDB(opts.dbPath ?? getParaPaths({ wikiDir }).schedulerDbPath);
  try {
    return db.listHistory({ taskName: opts.taskName, limit: opts.limit });
  } finally {
    db.close();
  }
}

export function formatQueueItems(items: QueueItem[]): string {
  if (items.length === 0) return "No scheduler tasks queued.";
  return items
    .map((item) => `${item.id} ${item.status} ${item.taskName} attempts=${item.attempts} dedupe=${item.dedupeKey ?? "-"}`)
    .join("\n");
}

export function formatQueueCaptureRecentResult(result: QueueCaptureRecentResult): string {
  return [
    `Scanned ${result.scanned} completed-session entr${result.scanned === 1 ? "y" : "ies"}.`,
    `Eligible within window: ${result.eligible}.`,
    `Queued ${result.queuedIds.length} capture task${result.queuedIds.length === 1 ? "" : "s"}.`,
  ].join("\n");
}

export function formatQueueItem(item: QueueItem | null): string {
  if (!item) return "Scheduler task not found.";
  return [
    `Task ${item.id}: ${item.taskName}`,
    `Status: ${item.status}`,
    `Attempts: ${item.attempts}`,
    `Available: ${item.availableAt}`,
    `Dedupe: ${item.dedupeKey ?? "-"}`,
    `Payload: ${JSON.stringify(item.payload, null, 2)}`,
  ].join("\n");
}

export function formatSchedulerHistory(items: SchedulerHistoryItem[]): string {
  if (items.length === 0) return "No scheduler history.";
  return items.map((item) => {
    const duration = item.durationMs === null ? "-" : `${item.durationMs}ms`;
    const error = item.error ? ` error=${item.error.slice(0, 80)}` : "";
    return `${item.id} ${item.status} ${item.taskName} duration=${duration}${error}`;
  }).join("\n");
}
