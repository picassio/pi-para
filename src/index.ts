/**
 * pi-para — PARA Knowledge Base Extension for pi
 *
 * Main extension entry point. Wires together wiki filesystem, qmd store,
 * scope detection, context injection, tools, and commands.
 *
 * Session capture is handled by a separate daemon (pi-para-daemon).
 * This extension registers completed sessions for the daemon to process.
 */

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { QMDStore } from "@picassio/qmd";

import type { ProjectScope } from "./scope.js";
import { detectScope } from "./scope.js";
import { initWiki } from "./wiki.js";
import { openStore, closeStore } from "./store.js";
import { registerTools } from "./tools.js";
import { setupContextInjection, markContextDirty } from "./context.js";
import type { ContextConfig } from "./context.js";
import { registerCommands } from "./commands.js";

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
  /** Daemon LLM: "provider/model-id" (e.g. "anthropic/claude-sonnet-4").
   *  If not set, daemon auto-detects from pi env keys or qmd config. */
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
    daemonModel: null,
  };
}

async function loadConfig(): Promise<ParaConfig> {
  const defaults = getDefaultConfig();
  const configPath = join(defaults.wikiDir, "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ParaConfig>;
    const wikiDir = parsed.wikiDir
      ? parsed.wikiDir.replace(/^~\//, `${homedir()}/`)
      : defaults.wikiDir;
    return { ...defaults, ...parsed, wikiDir };
  } catch {
    try {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify(defaults, null, 2), "utf-8");
    } catch {
      // Non-fatal
    }
    return { ...defaults };
  }
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
  const config = await loadConfig();
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

  // Store proxy — delegates to real store once opened
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

  // Register tools, context injection, commands
  registerTools(pi, wikiDir, storeProxy, getScope, markContextDirty);
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
      store = await openStore(wikiDir);
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

    ctx.ui.setStatus("pi-para", "wiki: ready");
    setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 3000);
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

  // -- session_shutdown: register session for daemon, close store ------------

  pi.on("session_shutdown", async (_event, ctx) => {
    // 1. Register session as completed (for daemon to process later)
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      try {
        const registry = join(wikiDir, ".completed-sessions");
        const entry = `${new Date().toISOString()}|${sessionFile}\n`;
        await appendFile(registry, entry);
      } catch {
        // Non-fatal — daemon can also discover sessions via filesystem scan
      }
    }

    // 2. Close the store (instant)
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
