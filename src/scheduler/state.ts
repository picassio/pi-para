import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getParaPaths } from "../paths.js";
import { ensureLeaseSchema } from "./leases.js";

export type QueueStatus = "queued" | "running" | "done" | "failed";

export interface QueueItem<T = unknown> {
  id: number;
  taskName: string;
  payload: T;
  priority: number;
  availableAt: string;
  dedupeKey: string | null;
  status: QueueStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueOptions {
  priority?: number;
  availableAt?: Date;
  dedupeKey?: string;
  now?: Date;
}

export interface SchedulerHistoryItem<T = unknown> {
  id: number;
  taskName: string;
  payload: T | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export class SchedulerStateDB {
  readonly db: Database.Database;

  constructor(dbPath = getParaPaths().schedulerDbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  migrate(): void {
    ensureLeaseSchema(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        task_key TEXT PRIMARY KEY,
        task_name TEXT NOT NULL,
        scope TEXT,
        schedule TEXT,
        next_due_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduler_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        dedupe_key TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS scheduler_queue_dedupe
        ON scheduler_queue(dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

      CREATE TABLE IF NOT EXISTS scheduler_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT
      );
    `);
  }

  enqueue(taskName: string, payload: unknown, opts: EnqueueOptions = {}): number {
    const now = opts.now ?? new Date();
    const availableAt = opts.availableAt ?? now;
    const payloadJson = JSON.stringify(payload ?? {});
    const existing = opts.dedupeKey ? this.getQueuedByDedupe(opts.dedupeKey) : null;
    if (existing) return existing.id;

    const result = this.db.prepare(`
      INSERT INTO scheduler_queue
      (task_name, payload_json, priority, available_at, dedupe_key, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    `).run(
      taskName,
      payloadJson,
      opts.priority ?? 0,
      availableAt.toISOString(),
      opts.dedupeKey ?? null,
      now.toISOString(),
      now.toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  claimNext(now = new Date()): QueueItem | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT * FROM scheduler_queue
        WHERE status = 'queued' AND available_at <= ?
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(now.toISOString()) as QueueRow | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db.prepare(`
        UPDATE scheduler_queue
        SET status = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now.toISOString(), row.id);
      this.db.exec("COMMIT");
      return rowToItem({ ...row, status: "running", attempts: row.attempts + 1, updated_at: now.toISOString() });
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  complete(id: number, now = new Date()): void {
    this.db.prepare("UPDATE scheduler_queue SET status = 'done', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  fail(id: number, error: string, opts: { retryAt?: Date; maxAttempts?: number; now?: Date } = {}): void {
    const now = opts.now ?? new Date();
    const row = this.get(id);
    if (!row) return;
    const maxAttempts = opts.maxAttempts ?? 3;
    if (row.attempts < maxAttempts && opts.retryAt) {
      this.db.prepare(`
        UPDATE scheduler_queue
        SET status = 'queued', available_at = ?, updated_at = ?
        WHERE id = ?
      `).run(opts.retryAt.toISOString(), now.toISOString(), id);
    } else {
      this.db.prepare("UPDATE scheduler_queue SET status = 'failed', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
    }
    this.recordHistory(row.taskName, row.payload, "failed", now, now, 0, error);
  }

  get(id: number): QueueItem | null {
    const row = this.db.prepare("SELECT * FROM scheduler_queue WHERE id = ?").get(id) as QueueRow | undefined;
    return row ? rowToItem(row) : null;
  }

  list(status?: QueueStatus): QueueItem[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM scheduler_queue WHERE status = ? ORDER BY id ASC").all(status) as QueueRow[]
      : this.db.prepare("SELECT * FROM scheduler_queue ORDER BY id ASC").all() as QueueRow[];
    return rows.map(rowToItem);
  }

  retryFailed(taskName?: string, now = new Date()): number {
    const result = taskName
      ? this.db.prepare(`
        UPDATE scheduler_queue
        SET status = 'queued', available_at = ?, updated_at = ?
        WHERE status = 'failed' AND task_name = ?
      `).run(now.toISOString(), now.toISOString(), taskName)
      : this.db.prepare(`
        UPDATE scheduler_queue
        SET status = 'queued', available_at = ?, updated_at = ?
        WHERE status = 'failed'
      `).run(now.toISOString(), now.toISOString());
    return result.changes;
  }

  listHistory(opts: { taskName?: string; limit?: number } = {}): SchedulerHistoryItem[] {
    const limit = opts.limit ?? 20;
    const rows = opts.taskName
      ? this.db.prepare("SELECT * FROM scheduler_history WHERE task_name = ? ORDER BY id DESC LIMIT ?").all(opts.taskName, limit) as HistoryRow[]
      : this.db.prepare("SELECT * FROM scheduler_history ORDER BY id DESC LIMIT ?").all(limit) as HistoryRow[];
    return rows.map(rowToHistoryItem);
  }

  getHistoryItem(id: number): SchedulerHistoryItem | null {
    const row = this.db.prepare("SELECT * FROM scheduler_history WHERE id = ?").get(id) as HistoryRow | undefined;
    return row ? rowToHistoryItem(row) : null;
  }

  recordHistory(
    taskName: string,
    payload: unknown,
    status: string,
    startedAt: Date,
    finishedAt: Date | null,
    durationMs: number | null,
    error: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO scheduler_history
      (task_name, payload_json, status, started_at, finished_at, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskName,
      JSON.stringify(payload ?? {}),
      status,
      startedAt.toISOString(),
      finishedAt?.toISOString() ?? null,
      durationMs,
      error,
    );
  }

  close(): void {
    this.db.close();
  }

  private getQueuedByDedupe(dedupeKey: string): QueueItem | null {
    const row = this.db.prepare(`
      SELECT * FROM scheduler_queue
      WHERE dedupe_key = ? AND status IN ('queued', 'running')
      ORDER BY id ASC LIMIT 1
    `).get(dedupeKey) as QueueRow | undefined;
    return row ? rowToItem(row) : null;
  }
}

interface QueueRow {
  id: number;
  task_name: string;
  payload_json: string;
  priority: number;
  available_at: string;
  dedupe_key: string | null;
  status: QueueStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
}

interface HistoryRow {
  id: number;
  task_name: string;
  payload_json: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

function rowToItem(row: QueueRow): QueueItem {
  return {
    id: row.id,
    taskName: row.task_name,
    payload: JSON.parse(row.payload_json) as unknown,
    priority: row.priority,
    availableAt: row.available_at,
    dedupeKey: row.dedupe_key,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHistoryItem(row: HistoryRow): SchedulerHistoryItem {
  return {
    id: row.id,
    taskName: row.task_name,
    payload: row.payload_json ? JSON.parse(row.payload_json) as unknown : null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
  };
}
