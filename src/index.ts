/**
 * pi-para — PARA Knowledge Base Extension for pi
 *
 * Main extension entry point. Wires together all components:
 * wiki filesystem, qmd store, scope detection, context injection,
 * tools, commands, and session capture.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { QMDStore } from "@picassio/qmd";

import type { ProjectScope } from "./scope.js";
import { detectScope } from "./scope.js";
import { initWiki } from "./wiki.js";
import { openStore, closeStore, embedIfNeeded } from "./store.js";
import { registerTools } from "./tools.js";
import { setupContextInjection, markContextDirty } from "./context.js";
import type { ContextConfig } from "./context.js";
import { registerCommands } from "./commands.js";
import { autoCapture } from "./capture.js";

// Re-export public types for consumers
export type { ParaCategory, WikiPage, PageFrontmatter, PageRef, LogEntry } from "./wiki.js";
export type { WikiSearchOptions, WikiSearchResult } from "./store.js";
export type { ProjectScope, ScopeConfig } from "./scope.js";
export type { IngestOptions, IngestReport, IngestResult } from "./ingest.js";
export type { QueryOptions, QueryResult } from "./query.js";
export type { LintOptions, LintReport, LintIssue, WikiStats } from "./lint.js";
export type { ContextOptions } from "./context.js";
export type { CaptureResult } from "./capture.js";
export type { RawSource, SessionDigest } from "./raw.js";
export type { SummarizeOptions } from "./summarize.js";

// -- Config ------------------------------------------------------------------

interface ParaConfig {
  wikiDir: string;
  contextMaxTokens: number;
  contextIncludeSchema: boolean;
  contextIncludeIndex: boolean;
  autoCapture: boolean;
  autoCaptureTimeoutMs: number;
  lintAutoFix: boolean;
  lintStaleDays: number;
  searchLimit: number;
  searchIncludeArchives: boolean;
}

/** Compute defaults lazily so homedir() is evaluated at call time. */
function getDefaultConfig(): ParaConfig {
  return {
    wikiDir: join(homedir(), ".pi", "wiki"),
    contextMaxTokens: 4000,
    contextIncludeSchema: true,
    contextIncludeIndex: true,
    autoCapture: true,
    autoCaptureTimeoutMs: 60_000,
    lintAutoFix: true,
    lintStaleDays: 90,
    searchLimit: 10,
    searchIncludeArchives: false,
  };
}

/** Read config from ~/.pi/wiki/config.json, creating defaults if missing. */
async function loadConfig(): Promise<ParaConfig> {
  const defaults = getDefaultConfig();
  const configPath = join(defaults.wikiDir, "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ParaConfig>;
    // Resolve ~ in wikiDir if present
    const wikiDir = parsed.wikiDir
      ? parsed.wikiDir.replace(/^~\//, `${homedir()}/`)
      : defaults.wikiDir;
    return { ...defaults, ...parsed, wikiDir };
  } catch {
    // Config doesn't exist or is invalid — use defaults and try to create it
    try {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify(defaults, null, 2), "utf-8");
    } catch {
      // Non-fatal: we can operate without persisting the config
    }
    return { ...defaults };
  }
}

// -- Session state -----------------------------------------------------------

/** State persisted via pi.appendEntry(). */
interface ParaSessionState {
  lastScope: ProjectScope;
  capturedInSession: string[];
  sessionFile: string | null;
  /** ID of the last session entry processed by auto-capture.
   *  On resume+quit, only messages after this entry are captured. */
  lastCapturedEntryId: string | null;
}

const ENTRY_TYPE = "pi-para-state";

/** Reconstruct session state from pi.appendEntry entries in the branch. */
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

/**
 * Async factory — pi awaits the returned Promise before continuing startup.
 * This lets us load config and determine wikiDir before registering tools.
 */
export default async function piPara(pi: ExtensionAPI): Promise<void> {
  // 1. Load config (determines wikiDir for all registrations)
  const config = await loadConfig();
  const wikiDir = config.wikiDir;

  // Module-level mutable state
  let store: QMDStore | null = null;
  let currentScope: ProjectScope | null = null;
  let capturedInSession: string[] = [];
  let lastCapturedEntryId: string | null = null;
  let storeDisabled = false;

  // Accessors for closures
  const getScope = (): ProjectScope => {
    if (!currentScope) {
      // Fallback scope — should only happen if called before session_start
      return { name: "unknown", include: ["unknown"], exclude: [], source: "dirname" };
    }
    return currentScope;
  };

  const setScope = (scope: ProjectScope): void => {
    currentScope = scope;
    markContextDirty();
    // Persist scope change
    pi.appendEntry(ENTRY_TYPE, {
      lastScope: scope,
      capturedInSession,
      sessionFile: null,
      lastCapturedEntryId,
    } satisfies ParaSessionState);
  };

  const getConfig = (): ContextConfig => ({
    contextMaxTokens: config.contextMaxTokens,
    contextIncludeSchema: config.contextIncludeSchema,
    contextIncludeIndex: config.contextIncludeIndex,
  });

  // -- Store proxy -----------------------------------------------------------
  // Tools are registered eagerly but the store is opened in session_start.
  // The proxy delegates to the real store once opened. If store is null,
  // operations throw a clear error.

  const storeProxy = new Proxy({} as QMDStore, {
    get(_target, prop) {
      if (!store) {
        if (storeDisabled) {
          return (..._args: unknown[]) => {
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

  // -- Register tools, context injection, commands ---------------------------

  registerTools(pi, wikiDir, storeProxy, getScope, markContextDirty);
  setupContextInjection(pi, wikiDir, storeProxy, () => currentScope, getConfig);
  registerCommands(pi, wikiDir, storeProxy, getScope, setScope);

  // -- session_start: init wiki, open store, detect scope --------------------

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pi-para", "wiki: loading...");

    // 1. Init wiki directory (idempotent — creates dirs and seeds files if missing)
    try {
      await initWiki(wikiDir);
    } catch (err) {
      ctx.ui.notify(
        `Wiki init failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }

    // 2. Open qmd store
    ctx.ui.setStatus("pi-para", "wiki: indexing...");
    storeDisabled = false;
    try {
      store = await openStore(wikiDir);
    } catch (err) {
      // qmd failed to open — warn and disable search
      store = null;
      storeDisabled = true;
      ctx.ui.notify(
        `Wiki search disabled: qmd store failed to open. ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }

    // 3. Detect scope
    currentScope = await detectScope(ctx.cwd);

    // 4. Reconstruct session state from appendEntry entries
    const savedState = reconstructState(ctx);
    if (savedState) {
      // Restore scope override if it was explicitly set by the user
      if (savedState.lastScope.source === "config") {
        currentScope = savedState.lastScope;
      }
      capturedInSession = savedState.capturedInSession ?? [];
      lastCapturedEntryId = savedState.lastCapturedEntryId ?? null;
    } else {
      capturedInSession = [];
      lastCapturedEntryId = null;
    }

    // 5. Persist initial state
    pi.appendEntry(ENTRY_TYPE, {
      lastScope: currentScope,
      capturedInSession,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      lastCapturedEntryId,
    } satisfies ParaSessionState);

    ctx.ui.setStatus("pi-para", "wiki: ready");
    // Clear status after a moment so it doesn't persist forever
    setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 3000);
  });

  // -- session_tree: reconstruct state after tree navigation -----------------

  pi.on("session_tree", async (_event, ctx) => {
    const savedState = reconstructState(ctx);
    if (savedState) {
      if (savedState.lastScope.source === "config") {
        currentScope = savedState.lastScope;
      } else {
        // Re-detect scope (may have changed)
        currentScope = await detectScope(ctx.cwd);
      }
      capturedInSession = savedState.capturedInSession ?? [];
      lastCapturedEntryId = savedState.lastCapturedEntryId ?? null;
    } else {
      currentScope = await detectScope(ctx.cwd);
      capturedInSession = [];
      lastCapturedEntryId = null;
    }
    markContextDirty();
  });

  // -- session_shutdown: auto-capture, embed, close store --------------------

  pi.on("session_shutdown", async (_event, ctx) => {
    const shutdownStart = Date.now();

    // 1. Auto-capture if enabled
    if (config.autoCapture && store && currentScope) {
      const model = ctx.model;
      if (!model) {
        console.error("[pi-para] auto-capture skipped: no model available at shutdown");
      } else {
        ctx.ui.setStatus("pi-para", "wiki: capturing session knowledge...");
        const sessionFile = ctx.sessionManager.getSessionFile() ?? "unknown";
        const branch = ctx.sessionManager.getBranch();

        // Always serialize the full session. The capture prompt tells the LLM
        // what was already captured (via capturedInSession) so it focuses on
        // NEW knowledge. Incremental-only capture loses context and misses
        // knowledge that spans multiple quit/resume cycles.
        const messages: AgentMessage[] = [];
        let lastEntryId: string | null = null;
        for (const entry of branch) {
          if (entry.type === "message") {
            messages.push(entry.message as AgentMessage);
          }
          lastEntryId = entry.id;
        }

        if (messages.length > 0) {
          const captureStart = Date.now();
          try {
            const result = await autoCapture(
              wikiDir,
              store,
              messages,
              currentScope,
              sessionFile,
              model,
              ctx.modelRegistry,
              config.autoCaptureTimeoutMs,
              capturedInSession,
            );
            const captureMs = Date.now() - captureStart;
            if (result.skipped) {
              console.error(`[pi-para] auto-capture skipped (${captureMs}ms): ${result.reason ?? "trivial session"}`);
            } else {
              console.error(`[pi-para] auto-capture (${captureMs}ms): ${result.pagesCreated.length} created, ${result.pagesUpdated.length} updated`);
            }
            // Track what was captured so subsequent quits can focus on NEW knowledge
            if (!result.skipped) {
              capturedInSession = [...capturedInSession, ...result.pagesCreated.map(p => p.slug)];
              pi.appendEntry(ENTRY_TYPE, {
                lastScope: currentScope!,
                capturedInSession,
                sessionFile,
                lastCapturedEntryId: null,
              } satisfies ParaSessionState);
            }
          } catch (err) {
            const captureMs = Date.now() - captureStart;
            console.error(`[pi-para] auto-capture failed (${captureMs}ms): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // 2. Run final embed (generates vector embeddings for any new/changed pages)
    ctx.ui.setStatus("pi-para", "wiki: embedding...");
    const embedStart = Date.now();
    if (store) {
      try {
        await embedIfNeeded(store);
      } catch {
        // Embedding failure is non-fatal
      }
    }
    console.error(`[pi-para] embed: ${Date.now() - embedStart}ms`);

    // 3. Close the store
    ctx.ui.setStatus("pi-para", "wiki: closing...");
    if (store) {
      try {
        await closeStore(store);
      } catch {
        // Close failure is non-fatal
      }
      store = null;
    }

    ctx.ui.setStatus("pi-para", undefined);
    console.error(`[pi-para] shutdown total: ${Date.now() - shutdownStart}ms`);
  });
}
