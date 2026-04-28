/**
 * Main daemon loop — watches for completed sessions and processes them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Model } from "@mariozechner/pi-ai";
import { openStore, closeStore } from "./store.js";
import type { QMDStore } from "@picassio/qmd";

import { StateDB } from "./state.js";
import { RegistryWatcher } from "./watcher.js";
import type { CompletedSession } from "./watcher.js";
import { processSession } from "./processor.js";

export interface DaemonConfig {
  wikiDir: string;
  model: Model<any>;
  getApiKey: (provider: string) => Promise<string | undefined>;
  pollIntervalMs?: number;
}

export class Daemon {
  private config: DaemonConfig;
  private state: StateDB;
  private watcher: RegistryWatcher;
  private store: QMDStore | null = null;
  private queue: CompletedSession[] = [];
  private processing = false;
  private running = false;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.state = new StateDB(config.wikiDir);
    this.watcher = new RegistryWatcher(
      config.wikiDir,
      (entries) => this.onNewEntries(entries),
      config.pollIntervalMs ?? 5000,
    );
  }

  /** Start the daemon. */
  async start(): Promise<void> {
    console.log(`[daemon] Starting — wiki: ${this.config.wikiDir}`);

    // Open qmd store
    try {
      this.store = await openStore(this.config.wikiDir);
      console.log("[daemon] qmd store opened");
    } catch (err) {
      console.error(`[daemon] Failed to open store: ${err instanceof Error ? err.message : err}`);
      this.store = null;
    }

    this.running = true;
    this.state.setState("daemon_started_at", new Date().toISOString());
    this.state.setState("daemon_pid", String(process.pid));

    // Start watching
    this.watcher.start();

    // Process any unprocessed sessions from registry
    const existing = this.watcher.getAllEntries();
    const unprocessed = existing.filter((e) => !this.state.isProcessed(e.sessionPath));
    if (unprocessed.length > 0) {
      console.log(`[daemon] Found ${unprocessed.length} unprocessed session(s)`);
      this.onNewEntries(unprocessed);
    }

    console.log("[daemon] Running. Press Ctrl+C to stop.");
  }

  /** Stop the daemon. */
  async stop(): Promise<void> {
    console.log("[daemon] Stopping...");
    this.running = false;
    this.watcher.stop();

    if (this.store) {
      try {
        await closeStore(this.store);
      } catch {}
      this.store = null;
    }

    this.state.close();
    console.log("[daemon] Stopped.");
  }

  /** Process a single session file (for CLI `process` command). */
  async processOne(sessionPath: string): Promise<void> {
    if (!existsSync(sessionPath)) {
      console.error(`[daemon] Session file not found: ${sessionPath}`);
      return;
    }

    if (!this.store) {
      try {
        this.store = await openStore(this.config.wikiDir);
      } catch (err) {
        console.error(`[daemon] Failed to open store: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    const scope = detectScopeFromPath(sessionPath);
    console.log(`[daemon] Processing: ${sessionPath} (scope: ${scope})`);

    try {
      const result = await processSession(
        sessionPath,
        this.config.wikiDir,
        this.store,
        scope,
        this.config.model,
        this.config.getApiKey,
      );

      if (result.skipped) {
        console.log(`[daemon] Skipped: ${result.reason}`);
        this.state.recordSuccess(sessionPath, scope, [], []);
      } else {
        console.log(`[daemon] Done: ${result.pagesCreated.length} created, ${result.pagesUpdated.length} updated`);
        this.state.recordSuccess(sessionPath, scope, result.pagesCreated, result.pagesUpdated);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[daemon] Failed: ${msg}`);
      this.state.recordFailure(sessionPath, scope, msg);
    }
  }

  /** Handle new entries from the registry watcher. */
  private onNewEntries(entries: CompletedSession[]): void {
    // Filter already-processed
    const newEntries = entries.filter(
      (e) => existsSync(e.sessionPath) && !this.state.isProcessed(e.sessionPath),
    );

    if (newEntries.length === 0) return;

    console.log(`[daemon] Queued ${newEntries.length} session(s) for processing`);
    this.queue.push(...newEntries);
    this.processQueue();
  }

  /** Process queued sessions sequentially. */
  private async processQueue(): Promise<void> {
    if (this.processing || !this.running) return;
    this.processing = true;

    while (this.queue.length > 0 && this.running) {
      const entry = this.queue.shift()!;
      await this.processOne(entry.sessionPath);
    }

    this.processing = false;
  }

  /** Get processing history. */
  getHistory(scope?: string, limit?: number) {
    return this.state.getHistory(scope, limit);
  }

  /** Get failed sessions. */
  getFailed() {
    return this.state.getFailed();
  }

  /** Retry all failed sessions. */
  async retryFailed(): Promise<void> {
    const failed = this.state.getFailed();
    if (failed.length === 0) {
      console.log("[daemon] No failed sessions to retry.");
      return;
    }
    console.log(`[daemon] Retrying ${failed.length} failed session(s)...`);
    for (const session of failed) {
      await this.processOne(session.sessionPath);
    }
  }
}

/** Extract project scope from session path or header. */
function detectScopeFromPath(sessionPath: string): string {
  // Path format: ~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/file.jsonl
  const dirName = sessionPath.split("/").slice(-2, -1)[0] ?? "";
  if (dirName.startsWith("--") && dirName.endsWith("--")) {
    // Decode: --home-ubuntu-projects-pi-mono-- → /home/ubuntu/projects/pi-mono → pi-mono
    const decoded = dirName.slice(2, -2).replace(/-/g, "/");
    const parts = decoded.split("/");
    return parts[parts.length - 1] ?? "unknown";
  }

  // Try reading session header
  try {
    const { readFileSync } = require("node:fs");
    const firstLine = readFileSync(sessionPath, "utf-8").split("\n")[0];
    const header = JSON.parse(firstLine);
    if (header.cwd) {
      const parts = header.cwd.split("/");
      return parts[parts.length - 1] ?? "unknown";
    }
  } catch {}

  return "unknown";
}
