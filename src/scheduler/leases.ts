import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface LeaseRecord {
  leaseKey: string;
  holderId: string;
  expiresAt: string;
  heartbeatAt: string;
  metadataJson: string | null;
}

export function ensureLeaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_leases (
      lease_key TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      metadata_json TEXT
    );
  `);
}

export function createLeaseHolder(prefix = "pi-para"): string {
  return `${prefix}:${process.pid}:${randomUUID()}`;
}

export function acquireLease(
  db: Database.Database,
  leaseKey: string,
  holderId: string,
  opts: { ttlMs?: number; now?: Date; metadata?: unknown } = {},
): boolean {
  ensureLeaseSchema(db);
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? 2 * 60_000;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const nowIso = now.toISOString();
  const metadataJson = opts.metadata === undefined ? null : JSON.stringify(opts.metadata);

  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT holder_id, expires_at FROM scheduler_leases WHERE lease_key = ?").get(leaseKey) as
      | { holder_id: string; expires_at: string }
      | undefined;

    const expired = !current || Date.parse(current.expires_at) <= now.getTime();
    const sameHolder = current?.holder_id === holderId;
    if (!expired && !sameHolder) {
      db.exec("ROLLBACK");
      return false;
    }

    db.prepare(`
      INSERT OR REPLACE INTO scheduler_leases
      (lease_key, holder_id, expires_at, heartbeat_at, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(leaseKey, holderId, expiresAt, nowIso, metadataJson);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

export function renewLease(
  db: Database.Database,
  leaseKey: string,
  holderId: string,
  opts: { ttlMs?: number; now?: Date } = {},
): boolean {
  ensureLeaseSchema(db);
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? 2 * 60_000)).toISOString();
  const result = db.prepare(`
    UPDATE scheduler_leases
    SET expires_at = ?, heartbeat_at = ?
    WHERE lease_key = ? AND holder_id = ?
  `).run(expiresAt, now.toISOString(), leaseKey, holderId);
  return result.changes === 1;
}

export function releaseLease(db: Database.Database, leaseKey: string, holderId: string): boolean {
  ensureLeaseSchema(db);
  const result = db.prepare("DELETE FROM scheduler_leases WHERE lease_key = ? AND holder_id = ?").run(leaseKey, holderId);
  return result.changes === 1;
}

export function getLease(db: Database.Database, leaseKey: string): LeaseRecord | null {
  ensureLeaseSchema(db);
  const row = db.prepare(`
    SELECT lease_key as leaseKey, holder_id as holderId, expires_at as expiresAt,
           heartbeat_at as heartbeatAt, metadata_json as metadataJson
    FROM scheduler_leases WHERE lease_key = ?
  `).get(leaseKey) as LeaseRecord | undefined;
  return row ?? null;
}
