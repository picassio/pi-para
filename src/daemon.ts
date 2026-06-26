/**
 * Main daemon loop — watches for completed sessions and processes them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Model } from "@earendil-works/pi-ai";
import { openStore, closeStore } from "./store.js";
import type { QMDStore } from "qmd-engine";

import { StateDB } from "./state.js";
import { RegistryWatcher } from "./watcher.js";
import type { CompletedSession } from "./watcher.js";
import { processSession } from "./processor.js";
import { runMaintenance } from "./maintainer.js";
import { startServer } from "./webui/server.js";
import type { WebWikiConfig } from "./webui/server.js";

export interface DaemonConfig {
  wikiDir: string;
  model: Model<any>;
  getApiKey: (provider: string) => Promise<string | undefined>;
  pollIntervalMs?: number;
  /** How often to run link discovery + lint (ms). Default: 30 minutes */
  maintenanceIntervalMs?: number;
  /** Web wiki server config. If enabled, the daemon hosts the web UI. */
  webWiki?: WebWikiConfig;
}

export class Daemon {
  private config: DaemonConfig;
  private state: StateDB;
  private watcher: RegistryWatcher;
  private store: QMDStore | null = null;
  private queue: CompletedSession[] = [];
  private processing = false;
  private running = false;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunning = false;
  private webServer: { close: () => Promise<void>; url: string } | null = null;

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

    // Start periodic maintenance (link discovery + lint)
    const maintenanceMs = this.config.maintenanceIntervalMs ?? 30 * 60 * 1000;
    this.maintenanceTimer = setInterval(() => this.runMaintenancePass(), maintenanceMs);
    // Run first maintenance after a delay to let the store warm up
    setTimeout(() => this.runMaintenancePass(), 60_000);

    // Start web wiki server if enabled
    if (this.config.webWiki?.enabled) {
      try {
        this.webServer = startServer(this.config.wikiDir, this.store, this.config.webWiki);
        console.log(`[daemon] Web wiki: ${this.webServer.url}`);
      } catch (err) {
        console.error(`[daemon] Web wiki failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`[daemon] Running (maintenance every ${Math.round(maintenanceMs / 60000)}m). Press Ctrl+C to stop.`);
  }

  /** Stop the daemon. */
  async stop(): Promise<void> {
    console.log("[daemon] Stopping...");
    this.running = false;
    this.watcher.stop();
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    // Stop web wiki server
    if (this.webServer) {
      try {
        await this.webServer.close();
        console.log("[daemon] Web wiki stopped");
      } catch {}
      this.webServer = null;
    }

    if (this.store) {
      try {
        await closeStore(this.store);
      } catch {}
      this.store = null;
    }

    this.state.close();
    console.log("[daemon] Stopped.");
  }

  /** Get the web server URL (if running). */
  getWebUrl(): string | null {
    return this.webServer?.url ?? null;
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

  /** Run periodic maintenance via LLM agent. */
  private async runMaintenancePass(): Promise<void> {
    if (this.maintenanceRunning || !this.running || !this.store) return;
    this.maintenanceRunning = true;

    try {
      console.log("[daemon] Running maintenance agent...");
      const result = await runMaintenance(
        this.config.wikiDir,
        this.store,
        this.config.model,
        this.config.getApiKey,
      );
      console.log(
        `[daemon] Maintenance done: ${result.pagesUpdated} updated, ${result.pagesMerged} merged`,
      );
      if (result.summary) {
        // Log first 200 chars of summary
        console.log(`[daemon] Summary: ${result.summary.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(
        `[daemon] Maintenance error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.maintenanceRunning = false;
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
  // 1. Try reading the session header — most reliable, has the real cwd
  try {
    const { readFileSync } = require("node:fs");
    const firstLine = readFileSync(sessionPath, "utf-8").split("\n")[0];
    const header = JSON.parse(firstLine);
    if (header.cwd) {
      const parts = header.cwd.split("/");
      return parts[parts.length - 1] ?? "unknown";
    }
  } catch {}

  // 2. Fallback: decode from directory name
  // Path format: ~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/file.jsonl
  // The dir name encodes the cwd path with / replaced by -
  // But project names can contain hyphens, so we can't just replace all - with /
  // Instead, find the last segment after "projects-" which is the project name
  const dirName = sessionPath.split("/").slice(-2, -1)[0] ?? "";
  if (dirName.startsWith("--") && dirName.endsWith("--")) {
    const inner = dirName.slice(2, -2); // e.g. "home-ubuntu-projects-agent-board"
    // Look for "projects-" marker — everything after it is the project name
    const projectsIdx = inner.indexOf("projects-");
    if (projectsIdx >= 0) {
      return inner.slice(projectsIdx + "projects-".length); // "agent-board"
    }
  }

  return "unknown";
}
