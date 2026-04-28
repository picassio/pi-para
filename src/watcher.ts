/**
 * Watch the .completed-sessions registry for new entries.
 * Uses polling (simpler and more reliable than inotify for append-only files).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CompletedSession {
  timestamp: string;
  sessionPath: string;
}

export class RegistryWatcher {
  private registryPath: string;
  private lastSize: number = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private onNewEntries: (entries: CompletedSession[]) => void;

  constructor(
    wikiDir: string,
    onNewEntries: (entries: CompletedSession[]) => void,
    private intervalMs: number = 5000,
  ) {
    this.registryPath = join(wikiDir, ".completed-sessions");
    this.onNewEntries = onNewEntries;

    // Initialize with current file size
    if (existsSync(this.registryPath)) {
      this.lastSize = statSync(this.registryPath).size;
    }
  }

  /** Start watching for new entries. */
  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.poll(), this.intervalMs);
    console.log(`[daemon] Watching ${this.registryPath} (poll every ${this.intervalMs}ms)`);
  }

  /** Stop watching. */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Check for new entries since last poll. */
  private poll(): void {
    if (!existsSync(this.registryPath)) return;

    const currentSize = statSync(this.registryPath).size;
    if (currentSize <= this.lastSize) return;

    // Read only the new bytes
    const content = readFileSync(this.registryPath, "utf-8");
    const allLines = content.split("\n").filter((l) => l.trim());

    // Parse lines that are after our last known position
    // Simple approach: re-parse all lines, only emit ones we haven't seen
    const newEntries: CompletedSession[] = [];
    let bytesProcessed = 0;

    for (const line of allLines) {
      bytesProcessed += line.length + 1; // +1 for newline
      if (bytesProcessed <= this.lastSize) continue;

      const parts = line.split("|", 2);
      if (parts.length === 2) {
        newEntries.push({
          timestamp: parts[0],
          sessionPath: parts[1],
        });
      }
    }

    this.lastSize = currentSize;

    if (newEntries.length > 0) {
      this.onNewEntries(newEntries);
    }
  }

  /** Process all entries in the registry (for manual/initial scan). */
  getAllEntries(): CompletedSession[] {
    if (!existsSync(this.registryPath)) return [];

    const content = readFileSync(this.registryPath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const parts = line.split("|", 2);
        return parts.length === 2
          ? { timestamp: parts[0], sessionPath: parts[1] }
          : null;
      })
      .filter((e): e is CompletedSession => e !== null);
  }
}
