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
import { homedir, networkInterfaces } from "node:os";

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
import { createServer } from "node:http";
import { startWikiScheduler, stopWikiScheduler } from "./scheduler/index.js";
import {
  appendCompletedSession,
  createCaptureSessionHandler,
  enqueueCompletedSessionsFromRegistry,
} from "./scheduler/session-capture.js";
import { loadParaConfig, toLegacyRuntimeConfig, type ParaUserConfig } from "./config.js";
import { createModelApiKeyResolver, createPiModelRegistry, getCaptureSelection, resolveSelectedModel } from "./model-resolver.js";
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
  /** Web wiki UI settings */
  webWiki: {
    enabled: boolean;
    host: string;
    port: number;
  };
  /** GEPA prompt optimizer settings */
  gepa: {
    /** When true, load optimized prompts from ~/.pi/wiki/gepa/optimized/ at runtime. */
    useOptimized: boolean;
    /** Student model — runs the proxy (generates wiki output). Fast + cheap.
     *  Default: anthropic/claude-sonnet-4-20250514 */
    studentModel: string | null;
    /** Teacher/reflection model — proposes instruction mutations. Smart + creative.
     *  Default: anthropic/claude-opus-4-6 */
    teacherModel: string | null;
    /** Judge model — scores candidate outputs (LLM-as-judge). Fast + cheap.
     *  Default: same as studentModel */
    judgeModel: string | null;
    /** Budget preset: light (~460 calls), medium (~1500), heavy (~5000) */
    auto: "light" | "medium" | "heavy";
    /** Parallel eval threads */
    threads: number;
    /** Random seed for reproducibility */
    seed: number;
  };
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
    webWiki: {
      enabled: false,
      host: "0.0.0.0",
      port: 10973,
    },
    gepa: {
      useOptimized: true,
      studentModel: null,
      teacherModel: null,
      judgeModel: null,
      auto: "light",
      threads: 2,
      seed: 42,
    },
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
      runtime: {
        ...runtime,
        gepa: {
          ...runtime.gepa,
          studentModel: runtime.gepa.studentModel ?? null,
          teacherModel: runtime.gepa.teacherModel ?? null,
          judgeModel: runtime.gepa.judgeModel ?? null,
        },
      },
      userConfig: loaded.config,
      secretsPath: loaded.paths.secretsPath,
    };
  } catch {
    return { runtime: getDefaultConfig(), userConfig: null, secretsPath: null };
  }
}

// -- LAN IP detection --------------------------------------------------------

/** Check if the optional web wiki server is alive on the given port. */
function checkWebServerAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = createServer().listen(port, "127.0.0.1");
    req.on("error", (err: NodeJS.ErrnoException) => {
      req.close();
      // EADDRINUSE means something is already listening — daemon is running
      resolve(err.code === "EADDRINUSE");
    });
    req.on("listening", () => {
      // Port is free — no daemon web server
      req.close();
      resolve(false);
    });
  });
}

function isPrintModeProcess(argv = process.argv): boolean {
  return argv.includes("-p") || argv.includes("--print") || argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "json";
}

function getLanIp(): string | null {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
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

  let store: QMDStore | null = null;
  let currentScope: ProjectScope | null = null;
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
    if (storeRetrying) return false;
    storeRetrying = true;
    try {
      store = await openStore(wikiDir, {
        paraConfig: loadedConfig.userConfig ?? undefined,
        secretsPath: loadedConfig.secretsPath ?? undefined,
        backgroundEmbed: false,
      });
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
  registerTools(pi, wikiDir, storeProxy, getScope, markContextDirty, () => config.searchGraphBoost);
  setupContextInjection(pi, wikiDir, storeProxy, () => currentScope, getConfig);
  registerCommands(pi, wikiDir, storeProxy, getScope, setScope);

  // -- session_start ---------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pi-para", "wiki: loading...");

    try {
      await initWiki(wikiDir);
    } catch (err) {
      ctx.ui.notify(
        `Wiki init failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }

    ctx.ui.setStatus("pi-para", "wiki: indexing...");
    storeDisabled = false;
    try {
      store = await openStore(wikiDir, {
        paraConfig: loadedConfig.userConfig ?? undefined,
        secretsPath: loadedConfig.secretsPath ?? undefined,
        backgroundEmbed: false,
      });
    } catch (err) {
      store = null;
      storeDisabled = true;
      ctx.ui.notify(
        `Wiki search disabled: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }

    currentScope = await detectScope(ctx.cwd);

    const savedState = reconstructState(ctx);
    if (savedState?.lastScope.source === "config") {
      currentScope = savedState.lastScope;
    }

    pi.appendEntry(ENTRY_TYPE, {
      lastScope: currentScope,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    } satisfies ParaSessionState);

    const schedulerHandlers = {} as Record<string, any>;
    try {
      const loadedParaConfig = await loadParaConfig({ migrate: true });
      const registry = await createPiModelRegistry();
      if (registry) {
        const captureSelection = getCaptureSelection(loadedParaConfig.config);
        const captureModel = resolveSelectedModel(captureSelection, registry.modelRegistry, {
          legacyModelSpec: config.daemonModel,
          preferredModelSpec: "anthropic/claude-sonnet-4-20250514",
        });
        if (captureModel) {
          schedulerHandlers["capture-session"] = createCaptureSessionHandler({
            wikiDir,
            storeProvider: () => store,
            model: captureModel,
            getApiKey: createModelApiKeyResolver(captureSelection, registry.modelRegistry, {
              authStorage: registry.authStorage,
              secretsPath: loadedParaConfig.paths.secretsPath,
            }),
          });
        }
      }
    } catch {
      // Capture handler registration is best-effort; manual capture remains available.
    }

    const schedulerEnabled = !isPrintModeProcess();
    const scheduler = schedulerEnabled
      ? startWikiScheduler({
        wikiDir,
        enabled: true,
        intervalMs: 15 * 60_000,
        storeProvider: () => store,
        markDirty: () => markContextDirty(),
        handlers: schedulerHandlers,
      })
      : null;

    if (scheduler) {
      try {
        const stateDb = new StateDB(wikiDir);
        await enqueueCompletedSessionsFromRegistry(scheduler, wikiDir, { stateDb });
        stateDb.close();
        void scheduler.tick();
      } catch {
        // Startup capture catch-up is best-effort.
      }
    }

    // Check if web wiki server is running (don't start our own yet)
    if (config.webWiki.enabled) {
      const port = config.webWiki.port;
      try {
        const alive = await checkWebServerAlive(port);
        if (alive) {
          const lanIp = getLanIp();
          const url = lanIp ? `http://${lanIp}:${port}` : `http://localhost:${port}`;
          ctx.ui.setStatus("pi-para", `wiki: ${url}`);
        } else {
          ctx.ui.setStatus("pi-para", "wiki: ready (web UI disabled)");
          setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 5000);
        }
      } catch {
        ctx.ui.setStatus("pi-para", "wiki: ready");
        setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 3000);
      }
    } else {
      ctx.ui.setStatus("pi-para", "wiki: ready");
      setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 3000);
    }
  });

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
    // 1. Register session as completed (scheduler catch-up processes later)
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      try {
        await appendCompletedSession(wikiDir, sessionFile);
      } catch {
        // Non-fatal — startup catch-up can also discover sessions via filesystem scan
      }
    }

    // 2. Stop scheduler and close the store (instant)
    stopWikiScheduler(wikiDir);

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
