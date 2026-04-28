/**
 * SQLite state management for processed sessions.
 * Tracks which sessions have been processed, their content hash,
 * and what pages were created/updated.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcessedSession {
  sessionPath: string;
  contentHash: string;
  processedAt: string;
  scope: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  error: string | null;
}

export class StateDB {
  private db: Database.Database;

  constructor(wikiDir: string) {
    const dbPath = join(wikiDir, ".daemon.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_sessions (
        session_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        scope TEXT,
        pages_created TEXT DEFAULT '[]',
        pages_updated TEXT DEFAULT '[]',
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  /** Check if a session file has already been processed with the same content. */
  isProcessed(sessionPath: string): boolean {
    const row = this.db
      .prepare("SELECT content_hash FROM processed_sessions WHERE session_path = ?")
      .get(sessionPath) as { content_hash: string } | undefined;
    if (!row) return false;

    const currentHash = hashFile(sessionPath);
    return row.content_hash === currentHash;
  }

  /** Get the stored hash for a session (or null if not processed). */
  getHash(sessionPath: string): string | null {
    const row = this.db
      .prepare("SELECT content_hash FROM processed_sessions WHERE session_path = ?")
      .get(sessionPath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  /** Record a successfully processed session. */
  recordSuccess(
    sessionPath: string,
    scope: string,
    pagesCreated: string[],
    pagesUpdated: string[],
  ): void {
    const hash = hashFile(sessionPath);
    this.db
      .prepare(`
        INSERT OR REPLACE INTO processed_sessions
        (session_path, content_hash, processed_at, scope, pages_created, pages_updated, error)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        sessionPath,
        hash,
        new Date().toISOString(),
        scope,
        JSON.stringify(pagesCreated),
        JSON.stringify(pagesUpdated),
      );
  }

  /** Record a failed processing attempt. */
  recordFailure(sessionPath: string, scope: string, error: string): void {
    const hash = hashFile(sessionPath);
    this.db
      .prepare(`
        INSERT OR REPLACE INTO processed_sessions
        (session_path, content_hash, processed_at, scope, pages_created, pages_updated, error)
        VALUES (?, ?, ?, ?, '[]', '[]', ?)
      `)
      .run(sessionPath, hash, new Date().toISOString(), scope, error);
  }

  /** Get all failed sessions for retry. */
  getFailed(): ProcessedSession[] {
    const rows = this.db
      .prepare("SELECT * FROM processed_sessions WHERE error IS NOT NULL")
      .all() as Array<{
        session_path: string;
        content_hash: string;
        processed_at: string;
        scope: string;
        pages_created: string;
        pages_updated: string;
        error: string;
      }>;
    return rows.map(rowToSession);
  }

  /** Get processing history, optionally filtered by scope. */
  getHistory(scope?: string, limit: number = 20): ProcessedSession[] {
    const sql = scope
      ? "SELECT * FROM processed_sessions WHERE scope = ? ORDER BY processed_at DESC LIMIT ?"
      : "SELECT * FROM processed_sessions ORDER BY processed_at DESC LIMIT ?";
    const params = scope ? [scope, limit] : [limit];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      session_path: string;
      content_hash: string;
      processed_at: string;
      scope: string;
      pages_created: string;
      pages_updated: string;
      error: string | null;
    }>;
    return rows.map(rowToSession);
  }

  /** Get/set daemon state values. */
  getState(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM daemon_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function hashFile(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "missing";
  }
}

function rowToSession(row: {
  session_path: string;
  content_hash: string;
  processed_at: string;
  scope: string;
  pages_created: string;
  pages_updated: string;
  error: string | null;
}): ProcessedSession {
  return {
    sessionPath: row.session_path,
    contentHash: row.content_hash,
    processedAt: row.processed_at,
    scope: row.scope ?? "",
    pagesCreated: JSON.parse(row.pages_created || "[]"),
    pagesUpdated: JSON.parse(row.pages_updated || "[]"),
    error: row.error,
  };
}
