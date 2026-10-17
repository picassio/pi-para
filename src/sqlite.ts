/**
 * pi-para's own SQLite files (state, scheduler queue and leases, status probes), through the driver qmd-engine uses:
 * better-sqlite3 by default, or Node.js's own node:sqlite with `QMD_SQLITE_DRIVER=node` (Node 22.13 or later), for
 * platforms better-sqlite3 has no build for, such as Android (pi-phone). One switch for both, read once when this module
 * loads; better-sqlite3 is not even imported under node:sqlite.
 */
import { existsSync } from "node:fs";
import type BetterSqlite3 from "better-sqlite3";

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** What pi-para uses of a database, on either driver. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** `PRAGMA <text>`, its rows. */
  pragma(text: string): unknown[];
  close(): void;
}

export type SqliteDriver = "better-sqlite3" | "node";

export function resolveSqliteDriver(value = process.env.QMD_SQLITE_DRIVER): SqliteDriver {
  if (value === undefined || value.trim() === "") return "better-sqlite3";
  const driver = value.trim();
  if (driver !== "better-sqlite3" && driver !== "node") {
    throw new Error(`QMD_SQLITE_DRIVER must be better-sqlite3 or node for pi-para; got ${JSON.stringify(value)}`);
  }
  return driver;
}

export const sqliteDriver: SqliteDriver = resolveSqliteDriver();

const Better: typeof BetterSqlite3 | undefined =
  sqliteDriver === "better-sqlite3" ? (await import("better-sqlite3")).default : undefined;

/** Open a database file; `fileMustExist` refuses to make one, as better-sqlite3's option does. */
export function openSqlite(path: string, options: { readonly?: boolean; fileMustExist?: boolean } = {}): SqliteDatabase {
  if (Better !== undefined) {
    const db = new Better(path, options);

    return {
      exec: (sql) => void db.exec(sql),
      prepare: (sql) => db.prepare(sql) as unknown as SqliteStatement,
      pragma: (text) => db.pragma(text) as unknown[],
      close: () => void db.close(),
    };
  }

  if (options.fileMustExist === true && !existsSync(path)) {
    throw new Error(`unable to open database file: ${path} does not exist`);
  }

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: options.readonly === true });

  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql) as unknown as SqliteStatement,
    pragma: (text) => db.prepare(`PRAGMA ${text}`).all(),
    close: () => db.close(),
  };
}
