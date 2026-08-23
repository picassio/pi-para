/**
 * pi-para — PARA Knowledge Base Extension for pi
 *
 * Main extension entry point. Wires together wiki filesystem, qmd store,
 * scope detection, context injection, tools, and commands.
 *
 * Session capture and maintenance are coordinated by an in-process scheduler.
 * Completed-session registry entries are kept as a durable catch-up queue.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QMDStore } from "qmd-engine";

import type { ProjectScope } from "./scope.js";
import { detectScope } from "./scope.js";
import { initWiki } from "./wiki.js";
import { openStore, closeStore } from "./store.js";
import { registerTools } from "./tools.js";
import { setupContextInjection, markContextDirty } from "./context.js";
import type { ContextConfig } from "./context.js";
import { registerCommands } from "./commands.js";
import { startWikiScheduler, stopWikiScheduler } from "./scheduler/index.js";
import {
  appendCompletedSession,
  createCaptureSessionHandler,
  enqueueCompletedSessionsFromRegistry,
} from "./scheduler/session-capture.js";
import { loadParaConfig, toLegacyRuntimeConfig, type ParaUserConfig } from "./config.js";
import { createModelApiKeyResolver, createPiModelServices, getCaptureSelection, resolveSelectedModel } from "./model-resolver.js";
import { StateDB } from "./state.js";

// Re-export public types for consumers
export type { ParaCategory, WikiPage, PageFrontmatter, PageRef, LogEntry } from "./wiki.js";
export type { WikiSearchOptions, WikiSearchResult } from "./store.js";
export type { ProjectScope, ScopeConfig } from "./scope.js";
export type { IngestOptions, IngestReport, IngestResult } from "./ingest.js";
export type { QueryOptions, QueryResult } from "./query.js";
export type { LintOptions, LintReport, LintIssue, WikiStats } from "./lint.js";
export type { ContextOptions } from "./context.js";
export type { RawSource, SessionDigest } from "./raw.js";
export type { SummarizeOptions } from "./summarize.js";

// -- Config ------------------------------------------------------------------

interface ParaConfig {
  wikiDir: string;
  contextMaxTokens: number;
  contextIncludeSchema: boolean;
  contextIncludeIndex: boolean;
  lintAutoFix: boolean;
  lintStaleDays: number;
  searchLimit: number;
  searchIncludeArchives: boolean;
  searchGraphBoost: boolean;
  /** Legacy capture LLM: "provider/model-id" (e.g. "anthropic/claude-sonnet-4").
   *  New config stores this as models.capture; legacy field remains for migration. */
  daemonModel: string | null;
}

function getDefaultConfig(): ParaConfig {
  return {
    wikiDir: join(homedir(), ".pi", "wiki"),
    contextMaxTokens: 4000,
    contextIncludeSchema: true,
    contextIncludeIndex: true,
    lintAutoFix: true,
    lintStaleDays: 90,
    searchLimit: 10,
    searchIncludeArchives: false,
    searchGraphBoost: true,
    daemonModel: null,
  };
}

interface LoadedRuntimeConfig {
  runtime: ParaConfig;
  userConfig: ParaUserConfig | null;
  secretsPath: string | null;
}

async function loadConfig(): Promise<LoadedRuntimeConfig> {
  try {
    const loaded = await loadParaConfig({ migrate: true });
    const runtime = toLegacyRuntimeConfig(loaded.config);
    return {
      runtime,
      userConfig: loaded.config,
      secretsPath: loaded.paths.secretsPath,
    };
  } catch {
    return { runtime: getDefaultConfig(), userConfig: null, secretsPath: null };
  }
}

function isPrintModeProcess(argv = process.argv): boolean {
  return argv.includes("-p") || argv.includes("--print") || argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "json";
}

// -- Session state -----------------------------------------------------------

interface ParaSessionState {
  lastScope: ProjectScope;
  sessionFile: string | null;
}

const ENTRY_TYPE = "pi-para-state";

function reconstructState(ctx: ExtensionContext): ParaSessionState | null {
  let latest: ParaSessionState | null = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      latest = entry.data as ParaSessionState;
    }
  }
  return latest;
}

// -- Extension entry point ---------------------------------------------------

export default async function piPara(pi: ExtensionAPI): Promise<void> {
  const loadedConfig = await loadConfig();
  const config = loadedConfig.runtime;
  const wikiDir = config.wikiDir;
  const printMode = isPrintModeProcess();

  let store: QMDStore | null = null;
  let currentScope: ProjectScope | null = null;
  let startupMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  let startupMaintenancePromise: Promise<void> | null = null;
  let readyStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let initializationPromise: Promise<void> | null = null;
  let sessionClosing = false;
  let storeDisabled = false;


  const getScope = (): ProjectScope => {
    if (!currentScope) {
      return { name: "unknown", include: ["unknown"], exclude: [], source: "dirname" };
    }
    return currentScope;
  };

  const setScope = (scope: ProjectScope): void => {
    currentScope = scope;
    markContextDirty();
    pi.appendEntry(ENTRY_TYPE, {
      lastScope: scope,
      sessionFile: null,
    } satisfies ParaSessionState);
  };

  const getConfig = (): ContextConfig => ({
    contextMaxTokens: config.contextMaxTokens,
    contextIncludeSchema: config.contextIncludeSchema,
    contextIncludeIndex: config.contextIncludeIndex,
  });

  // Lazy retry: if the store failed at startup, try reopening on first tool use.
  // This handles cases where the db was temporarily locked or had transient errors.
  let storeRetrying = false;
  async function retryStoreOpen(): Promise<boolean> {
    if (storeRetrying || sessionClosing) return false;
    storeRetrying = true;
    try {
      const reopenedStore = await openStore(wikiDir, {
        paraConfig: loadedConfig.userConfig ?? undefined,
        secretsPath: loadedConfig.secretsPath ?? undefined,
        backgroundEmbed: false,
      });
      if (sessionClosing) {
        await closeStore(reopenedStore);
        return false;
      }
      store = reopenedStore;
      storeDisabled = false;
      markContextDirty(); // rebuild context now that store works
      return true;
    } catch {
      return false;
    } finally {
      storeRetrying = false;
    }
  }

  // Store proxy — delegates to real store once opened, with lazy retry on failure
  const storeProxy = new Proxy({} as QMDStore, {
    get(_target, prop) {
      if (!store) {
        if (storeDisabled) {
          // Return an async function that retries opening the store first
          return async (...args: unknown[]) => {
            const reopened = await retryStoreOpen();
            if (reopened && store) {
              const method = (store as unknown as Record<string, unknown>)[prop as string];
              if (typeof method === "function") {
                return (method as Function).apply(store, args);
              }
              return method;
            }
            throw new Error("Wiki search is disabled: qmd store failed to open.");
          };
        }
        return (..._args: unknown[]) => {
          throw new Error("Wiki store not initialized yet.");
        };
      }
      return (store as unknown as Record<string, unknown>)[prop as string];
    },
  });

  // Register tools, context injection, commands
  registerTools(
    pi,
    wikiDir,
    storeProxy,
    getScope,
    markContextDirty,
    () => config.searchGraphBoost,
    () => loadedConfig.userConfig?.lint ?? { autoFix: true, staleDays: 90 },
  );
  setupContextInjection(pi, wikiDir, storeProxy, () => currentScope, getConfig);
  registerCommands(pi, wikiDir, storeProxy, getScope, setScope);

  // -- session_start ---------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    // Interactive sessions must NEVER wait on wiki initialization: store
    // opens, git init, scope detection, and model-service setup have all
    // intermittently stalled behind cross-process contention (locks, slow
    // IO, network), blocking the whole TUI at "wiki: indexing...". Keep the
    // work in the background, but retain its promise: session_shutdown MUST
    // await it before Node tears down native better-sqlite3 resources.
    // Print/RPC one-shot runs still await because they may query then exit.
    sessionClosing = false;
    const pending = initializeSession(ctx);
    initializationPromise = pending;
    void pending.finally(() => {
      if (initializationPromise === pending) initializationPromise = null;
    }).catch(() => { /* the owning path reports initialization failures */ });

    if (ctx.hasUI) {
      void pending.catch(() => {
        if (!sessionClosing) {
          try { ctx.ui.setStatus("pi-para", "wiki: init failed"); } catch { /* ui gone */ }
        }
      });
      return;
    }
    await pending;
  });

  async function initializeSession(ctx: ExtensionContext): Promise<void> {
    ctx.ui.setStatus("pi-para", "wiki: loading...");

    try {
      await initWiki(wikiDir);
    } catch (err) {
      if (!sessionClosing) {
        ctx.ui.notify(
          `Wiki init failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    }
    if (sessionClosing) return;

    ctx.ui.setStatus("pi-para", "wiki: indexing...");
    storeDisabled = false;
    try {
      const openedStore = await openStore(wikiDir, {
        paraConfig: loadedConfig.userConfig ?? undefined,
        secretsPath: loadedConfig.secretsPath ?? undefined,
        backgroundEmbed: false,
      });
      if (sessionClosing) {
        await closeStore(openedStore);
        return;
      }
      store = openedStore;
    } catch (err) {
      store = null;
      storeDisabled = true;
      if (!sessionClosing) {
        ctx.ui.notify(
          `Wiki search disabled: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }
    if (sessionClosing) return;

    currentScope = await detectScope(ctx.cwd);
    if (sessionClosing) return;

    const savedState = reconstructState(ctx);
    if (savedState?.lastScope.source === "config") {
      currentScope = savedState.lastScope;
    }

    pi.appendEntry(ENTRY_TYPE, {
      lastScope: currentScope,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    } satisfies ParaSessionState);

    const schedulerHandlers = {} as Record<string, any>;
    const schedulerConfig = loadedConfig.userConfig?.scheduler;
    const wikiConfig = loadedConfig.userConfig?.wiki;
    const autoCaptureEnabled = wikiConfig?.autoCapture !== false;
    const startupCatchupEnabled = autoCaptureEnabled && wikiConfig?.captureOnStartup !== false && schedulerConfig?.startupCatchup !== false;
    try {
      const loadedParaConfig = await loadParaConfig({ migrate: true });
      const services = autoCaptureEnabled ? await createPiModelServices() : null;
      if (services) {
        const captureSelection = getCaptureSelection(loadedParaConfig.config);
        const captureModel = resolveSelectedModel(captureSelection, services.modelRegistry, {
          legacyModelSpec: config.daemonModel,
          preferredModelSpec: "anthropic/claude-sonnet-4-20250514",
        });
        if (captureModel) {
          schedulerHandlers["capture-session"] = createCaptureSessionHandler({
            wikiDir,
            storeProvider: () => store,
            model: captureModel,
            getApiKey: createModelApiKeyResolver(captureSelection, services.modelRegistry, {
              credentials: services.credentials,
              secretsPath: loadedParaConfig.paths.secretsPath,
            }),
          });
        }
      }
    } catch {
      // Capture handler registration is best-effort; manual capture remains available.
    }
    if (sessionClosing) return;

    const embedEnabled = loadedConfig.userConfig?.qmd.embedEnabled !== false;
    const schedulerEnabled = !printMode && schedulerConfig?.enabled !== false;
    const scheduler = schedulerEnabled
      ? startWikiScheduler({
        wikiDir,
        enabled: true,
        intervalMs: (schedulerConfig?.intervalMinutes ?? 15) * 60_000,
        storeProvider: () => store,
        markDirty: () => markContextDirty(),
        handlers: schedulerHandlers,
        embedEnabled,
      })
      : null;

    // Startup maintenance (embed backlog drain + capture catch-up) is
    // deliberately deferred and detached: it must never run inside this
    // awaited session_start handler, where registry scans over large session
    // files previously froze fresh sessions. It is also skipped entirely in
    // non-interactive children (squad workers, RPC probes) — they only append
    // their own completed sessions for the next interactive session to pick up.
    const interactive = ctx.hasUI === true;
    if (scheduler && interactive && ((embedEnabled && store) || startupCatchupEnabled)) {
      const envDelay = Number(process.env.PI_PARA_STARTUP_DELAY_MS);
      const startupDelayMs = Number.isFinite(envDelay) && envDelay >= 0 ? envDelay : 30_000;
      startupMaintenanceTimer = setTimeout(() => {
        startupMaintenanceTimer = null;
        if (sessionClosing) return;
        const maintenance = (async () => {
          if (embedEnabled && store && !sessionClosing) {
            try {
              scheduler.embedEnabled = true;
              scheduler.enqueue("qmd-embed", {}, { dedupeKey: "qmd-embed", priority: 5 });
            } catch {
              // Background embedding is best-effort; BM25 search works regardless.
            }
          }
          if (startupCatchupEnabled) {
            try {
              const stateDb = new StateDB(wikiDir);
              await enqueueCompletedSessionsFromRegistry(scheduler, wikiDir, { stateDb });
              stateDb.close();
            } catch {
              // Startup capture catch-up is best-effort.
            }
          }
          try {
            await scheduler.tick();
          } catch {
            // Tick failures are recorded in scheduler history.
          }
        })();
        startupMaintenancePromise = maintenance;
        void maintenance.finally(() => {
          if (startupMaintenancePromise === maintenance) startupMaintenancePromise = null;
        }).catch(() => { /* maintenance is best-effort */ });
      }, startupDelayMs);
      startupMaintenanceTimer.unref?.();
    }

    if (loadedConfig.userConfig?.webWiki.enabled && !printMode) {
      ctx.ui.notify("webWiki configuration is ignored because Web Wiki was removed in 0.7.", "warning");
    }
    if (sessionClosing) return;
    ctx.ui.setStatus("pi-para", "wiki: ready");
    if (!printMode) {
      readyStatusTimer = setTimeout(() => {
        readyStatusTimer = null;
        if (!sessionClosing) ctx.ui.setStatus("pi-para", undefined);
      }, 3000);
    }
  }

  // -- session_tree ----------------------------------------------------------

  pi.on("session_tree", async (_event, ctx) => {
    const savedState = reconstructState(ctx);
    if (savedState?.lastScope.source === "config") {
      currentScope = savedState.lastScope;
    } else {
      currentScope = await detectScope(ctx.cwd);
    }
    markContextDirty();
  });

  // -- session_compact: register session for scheduler capture on compaction --

  pi.on("session_compact", async (_event, ctx) => {
    // Compaction means the session has accumulated enough content that details
    // are about to be compressed/lost. Perfect time to capture knowledge.
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      try {
        await appendCompletedSession(wikiDir, sessionFile);
        ctx.ui.setStatus("pi-para", "wiki: capture queued (compaction)");
        setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 5000);
      } catch {
        // Non-fatal
      }
    }
  });

  // -- session_shutdown: register session for scheduler, close store ---------

  pi.on("session_shutdown", async (_event, ctx) => {
    // 0. Own the complete initializer lifecycle. Returning while its native
    // qmd/better-sqlite3 work is still in flight can destroy V8 first and
    // crash in Statement::~Statement / RemoveEnvironmentCleanupHook.
    sessionClosing = true;
    if (startupMaintenanceTimer) {
      clearTimeout(startupMaintenanceTimer);
      startupMaintenanceTimer = null;
    }
    if (readyStatusTimer) {
      clearTimeout(readyStatusTimer);
      readyStatusTimer = null;
    }
    if (initializationPromise) {
      try {
        await initializationPromise;
      } catch {
        // Initialization errors were already surfaced by the owning path.
      }
    }
    if (startupMaintenancePromise) {
      try {
        await startupMaintenancePromise;
      } catch {
        // Maintenance is best-effort, but must settle before native teardown.
      }
    }

    // 1. Register session as completed (scheduler catch-up processes later)
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      try {
        await appendCompletedSession(wikiDir, sessionFile);
      } catch {
        // Non-fatal — startup catch-up can also discover sessions via filesystem scan
      }
    }

    // 2. Stop scheduler, await any in-flight SQLite work, then close the store.
    await stopWikiScheduler(wikiDir);

    if (store) {
      try {
        await closeStore(store);
      } catch {
        // Non-fatal
      }
      store = null;
    }
  });
}
