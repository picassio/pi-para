import type { QMDStore } from "qmd-engine";
import { randomUUID } from "node:crypto";
import { gitCommit, rebuildIndex } from "../wiki.js";
import { captureQmdEmbedErrors, reindex, storeHasApiProviders } from "../store.js";
import { getParaPaths } from "../paths.js";
import { acquireLease, releaseLease } from "./leases.js";
import { SchedulerStateDB, type QueueItem } from "./state.js";

export type SchedulerTaskHandler = (item: QueueItem, scheduler: WikiScheduler) => Promise<void>;

export interface WikiSchedulerOptions {
  wikiDir: string;
  dbPath?: string;
  intervalMs?: number;
  enabled?: boolean;
  storeProvider?: () => QMDStore | null;
  markDirty?: () => void;
  handlers?: Record<string, SchedulerTaskHandler>;
  /**
   * When true, wiki-maintenance chains a deduplicated `qmd-embed` task after
   * reindexing so new/changed pages get vector embeddings in the background.
   * Default false so standalone/test schedulers keep BM25-only behavior.
   */
  embedEnabled?: boolean;
}

export class WikiScheduler {
  readonly wikiDir: string;
  readonly holderId: string;
  readonly state: SchedulerStateDB;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private closed = false;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly storeProvider: () => QMDStore | null;
  private readonly markDirty: () => void;
  private handlers: Record<string, SchedulerTaskHandler>;
  embedEnabled: boolean;

  constructor(opts: WikiSchedulerOptions) {
    this.wikiDir = opts.wikiDir;
    this.holderId = `scheduler:${process.pid}:${randomUUID()}`;
    this.state = new SchedulerStateDB(opts.dbPath ?? getParaPaths({ wikiDir: opts.wikiDir }).schedulerDbPath);
    this.intervalMs = opts.intervalMs ?? 15 * 60_000;
    this.enabled = opts.enabled ?? true;
    this.storeProvider = opts.storeProvider ?? (() => null);
    this.markDirty = opts.markDirty ?? (() => {});
    this.embedEnabled = opts.embedEnabled ?? false;
    this.handlers = {
      "wiki-maintenance": async () => this.runWikiMaintenance(),
      "qmd-embed": async () => this.runQmdEmbed(),
      ...(opts.handlers ?? {}),
    };
  }

  start(): void {
    if (!this.enabled || this.timer || this.closed) return;
    this.stopped = false;
    this.state.requeueRunning();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.running) this.closeState();
  }

  private closeState(): void {
    if (this.closed) return;
    this.closed = true;
    this.state.close();
  }

  enqueue(taskName: string, payload: unknown = {}, opts: { priority?: number; dedupeKey?: string; availableAt?: Date } = {}): number {
    if (this.closed) throw new Error("Wiki scheduler is stopped.");
    return this.state.enqueue(taskName, payload, opts);
  }

  registerHandlers(handlers: Record<string, SchedulerTaskHandler>): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  async tick(): Promise<number> {
    if (!this.enabled || this.running || this.stopped || this.closed) return 0;
    this.running = true;
    let processed = 0;
    try {
      for (;;) {
        if (this.stopped) break;
        const item = this.state.claimNext();
        if (!item) break;
        await this.runItem(item);
        processed++;
      }
    } finally {
      this.running = false;
      if (this.stopped) this.closeState();
    }
    return processed;
  }

  private async runItem(item: QueueItem): Promise<void> {
    const handler = this.handlers[item.taskName];
    const started = new Date();
    if (!handler) {
      this.state.fail(item.id, `Unknown scheduler task: ${item.taskName}`, { now: started, maxAttempts: 1 });
      return;
    }

    try {
      await handler(item, this);
      if (this.stopped || this.closed) return;
      const finished = new Date();
      this.state.complete(item.id, finished);
      this.state.recordHistory(item.taskName, item.payload, "done", started, finished, finished.getTime() - started.getTime(), null);
    } catch (err) {
      if (this.stopped || this.closed) return;
      const retryAt = new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** item.attempts));
      this.state.fail(item.id, err instanceof Error ? err.message : String(err), { retryAt, now: new Date() });
    }
  }

  private async runWikiMaintenance(): Promise<void> {
    const leaseKey = `wiki-maintenance:${this.wikiDir}`;
    if (!acquireLease(this.state.db, leaseKey, this.holderId, { ttlMs: 5 * 60_000 })) return;
    try {
      await rebuildIndex(this.wikiDir);
      const store = this.storeProvider();
      if (store) await reindex(store);
      this.markDirty();
      await gitCommit(this.wikiDir, "wiki: rebuild index and refresh search");
    } finally {
      releaseLease(this.state.db, leaseKey, this.holderId);
    }
    // Chain background embedding so changed pages become vector-searchable.
    // Runs as its own task (deduplicated) so reindex latency stays low and
    // embedding failures are recorded/retried instead of breaking maintenance.
    if (this.embedEnabled) {
      this.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed", priority: 5 });
    }
  }

  /**
   * Generate vector embeddings for documents QMD reports as pending.
   * Skips fast when the backlog is empty. Throws when the embedding pass
   * reports errors so the scheduler records the failure and retries with
   * backoff — BM25 search keeps working regardless.
   */
  private async runQmdEmbed(): Promise<void> {
    const store = this.storeProvider();
    if (!store) return;
    // No real embedding provider configured — embed calls would hit the inert
    // shim endpoint (slow TCP timeouts on Windows) and always fail. Skip.
    if (!storeHasApiProviders(store)) return;

    const status = await store.getStatus();
    const pending = status.needsEmbedding ?? 0;
    if (pending === 0) return;

    const leaseKey = `qmd-embed:${this.wikiDir}`;
    if (!acquireLease(this.state.db, leaseKey, this.holderId, { ttlMs: 15 * 60_000 })) return;
    try {
      const attempt = await captureQmdEmbedErrors(() => store.embed());
      const diagnostics = [...new Set(attempt.diagnostics)].join(" | ");
      if (!attempt.ok) {
        const reason = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
        throw new Error(diagnostics ? `${reason} — ${diagnostics}` : reason);
      }
      const result = attempt.value;
      if (result.errors > 0) {
        throw new Error(
          `qmd embed finished with ${result.errors} error(s) (${result.chunksEmbedded} chunk(s) embedded, ${pending} doc(s) were pending)${diagnostics ? ` — ${diagnostics}` : ""}`,
        );
      }
    } finally {
      releaseLease(this.state.db, leaseKey, this.holderId);
    }
  }
}

const schedulers = new Map<string, WikiScheduler>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function getWikiScheduler(opts: WikiSchedulerOptions): WikiScheduler {
  const key = opts.dbPath ?? getParaPaths({ wikiDir: opts.wikiDir }).schedulerDbPath;
  const existing = schedulers.get(key);
  if (existing) {
    if (opts.handlers) existing.registerHandlers(opts.handlers);
    return existing;
  }
  const scheduler = new WikiScheduler(opts);
  schedulers.set(key, scheduler);
  return scheduler;
}

export function startWikiScheduler(opts: WikiSchedulerOptions): WikiScheduler {
  const scheduler = getWikiScheduler(opts);
  scheduler.start();
  return scheduler;
}

export function stopWikiScheduler(wikiDir: string, dbPath?: string): void {
  const key = dbPath ?? getParaPaths({ wikiDir }).schedulerDbPath;
  const timer = debounceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
  const scheduler = schedulers.get(key);
  if (!scheduler) return;
  scheduler.stop();
  schedulers.delete(key);
}

export function enqueueWikiMaintenance(
  wikiDir: string,
  store: QMDStore,
  markDirty: () => void,
  opts: { delayMs?: number; dbPath?: string } = {},
): number | null {
  const key = opts.dbPath ?? getParaPaths({ wikiDir }).schedulerDbPath;
  const existingTimer = debounceTimers.get(key);
  if (existingTimer) clearTimeout(existingTimer);

  const scheduler = getWikiScheduler({
    wikiDir,
    dbPath: opts.dbPath,
    storeProvider: () => store,
    markDirty,
  });

  const delayMs = opts.delayMs ?? 2_000;
  if (delayMs <= 0) {
    const id = scheduler.enqueue("wiki-maintenance", {}, { dedupeKey: "wiki-maintenance", priority: 10 });
    void scheduler.tick();
    return id;
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    scheduler.enqueue("wiki-maintenance", {}, { dedupeKey: "wiki-maintenance", priority: 10 });
    void scheduler.tick();
  }, delayMs);
  (timer as { unref?: () => void }).unref?.();
  debounceTimers.set(key, timer);
  return null;
}

/**
 * Enqueue a deduplicated background embedding pass (e.g. at session startup
 * to drain a pre-existing needsEmbedding backlog). No-op scheduling cost when
 * the backlog is empty — the task exits after one getStatus() call.
 */
export function enqueueQmdEmbed(
  wikiDir: string,
  store: QMDStore,
  opts: { dbPath?: string } = {},
): number {
  const scheduler = getWikiScheduler({
    wikiDir,
    dbPath: opts.dbPath,
    storeProvider: () => store,
  });
  scheduler.embedEnabled = true;
  const id = scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed", priority: 5 });
  void scheduler.tick();
  return id;
}

export function resetSchedulersForTests(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  for (const [key, scheduler] of schedulers) {
    scheduler.stop();
    schedulers.delete(key);
  }
}
