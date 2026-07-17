/**
 * qmd store lifecycle — manages the qmd-engine store instance.
 *
 * Handles store creation/opening, search with scope filtering,
 * re-indexing after wiki changes, and embedding lifecycle.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createStore, extractSnippet } from "qmd-engine";
import type { QMDStore, CollectionConfig } from "qmd-engine";
import { parseFrontmatter } from "./frontmatter.js";
import type { ParaUserConfig } from "./config.js";
import { buildQmdProvidersFromParaConfig, type QmdProvidersConfig } from "./qmd-providers.js";
import { matchesScope } from "./scope.js";
import type { PageFrontmatter, PageRef, ParaCategory } from "./wiki.js";
import type { ProjectScope } from "./scope.js";

// Re-export QMDStore for convenience
export type { QMDStore } from "qmd-engine";

// -- Types ------------------------------------------------------------------

export interface OpenStoreOptions {
  paraConfig?: ParaUserConfig;
  secretsPath?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
  /**
   * Start slow vector embedding in the background after BM25 indexing.
   * Pi session startup disables this so single-shot `pi -p` processes can exit
   * promptly; callers can still invoke embedIfNeeded() explicitly.
   */
  backgroundEmbed?: boolean;
}

export interface WikiSearchOptions {
  scope?: ProjectScope;
  category?: ParaCategory;
  limit?: number;
  includeArchives?: boolean; // default false
  graphBoost?: boolean; // default true — 1-hop wikilink expansion
}

export interface WikiSearchResult {
  page: PageRef;
  score: number;
  snippet: string;
  frontmatter: PageFrontmatter;
}

interface RawQmdSearchResult {
  displayPath: string;
  score: number;
  body?: string;
  title?: string;
  [key: string]: unknown;
}

// -- PARA context descriptions -----------------------------------------------

const PARA_CONTEXTS: Record<string, string> = {
  "projects/": "Active projects with defined goals and end dates",
  "areas/": "Ongoing responsibilities and standards",
  "resources/": "Reference material and how-to guides",
  "archives/": "Completed or deprecated items",
};

const RAW_CONTEXT = "Immutable source material: articles, documents, notes. Not synthesized.";

// -- Pending embed tracking --------------------------------------------------

const pendingEmbeds = new WeakMap<QMDStore, Promise<void>>();

export type QmdEmbedOperationResult<T> =
  | { ok: true; value: T; diagnostics: string[] }
  | { ok: false; error: unknown; diagnostics: string[] };

// qmd-engine's API adapter logs recoverable provider failures directly to
// console.error before returning null. Capture only those known messages so
// best-effort vector search and scheduler retries do not flash raw errors in
// the Pi UI. Other console errors continue to pass through unchanged.
const qmdEmbedDiagnosticContext = new AsyncLocalStorage<string[]>();
let qmdEmbedCaptureCount = 0;
let qmdEmbedOriginalConsoleError: typeof console.error | null = null;
const qmdEmbedConsoleInterceptor = (...args: unknown[]): void => {
  const sink = qmdEmbedDiagnosticContext.getStore();
  const first = String(args[0] ?? "");
  if (sink && /^embed(?:Batch)? error:/i.test(first)) {
    sink.push(args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(" "));
    return;
  }
  qmdEmbedOriginalConsoleError?.(...args);
};

/** Run a QMD embedding operation without leaking its recoverable raw stderr. */
export async function captureQmdEmbedErrors<T>(operation: () => Promise<T>): Promise<QmdEmbedOperationResult<T>> {
  const diagnostics: string[] = [];
  if (qmdEmbedCaptureCount++ === 0) {
    qmdEmbedOriginalConsoleError = console.error;
    console.error = qmdEmbedConsoleInterceptor;
  }
  try {
    return await qmdEmbedDiagnosticContext.run(diagnostics, async () => {
      try {
        return { ok: true, value: await operation(), diagnostics };
      } catch (error) {
        return { ok: false, error, diagnostics };
      }
    });
  } finally {
    qmdEmbedCaptureCount--;
    if (qmdEmbedCaptureCount === 0) {
      if (console.error === qmdEmbedConsoleInterceptor && qmdEmbedOriginalConsoleError) console.error = qmdEmbedOriginalConsoleError;
      qmdEmbedOriginalConsoleError = null;
    }
  }
}

// -- Inert-provider tracking ---------------------------------------------------

/** Stores opened with the NO_LOCAL_PROVIDERS shim (no real API provider). */
const inertProviderStores = new WeakSet<QMDStore>();

/**
 * Whether the store was opened with a real (configured) embedding provider.
 * When false, embedding calls would hit the inert shim endpoint and fail —
 * slowly on platforms where localhost connects to closed ports time out
 * (Windows firewall drops) — so background embedding must be skipped.
 */
export function storeHasApiProviders(store: QMDStore): boolean {
  return !inertProviderStores.has(store);
}

// -- qmd provider config -----------------------------------------------------

/**
 * qmd-engine currently falls back to node-llama-cpp when no API provider is
 * configured. pi-para never uses local LLMs, so provide an inert API endpoint
 * whenever neither pi-para profiles nor legacy provider config exists. BM25
 * search works without calling this endpoint; accidental vector/chat calls fail
 * fast instead of downloading/building local models.
 */
const NO_LOCAL_PROVIDERS: QmdProvidersConfig = {
  embed: {
    url: "http://127.0.0.1:9",
    model: "disabled-local-llm",
  },
};

// -- qmd config loading ------------------------------------------------------

/**
 * Read providers from ~/.config/qmd/index.yml.
 * Returns undefined if no config file or no providers configured.
 */
function loadQmdProviders(): Record<string, unknown> | undefined {
  const configPath = join(homedir(), ".config", "qmd", "index.yml");
  if (!existsSync(configPath)) return undefined;

  try {
    const content = readFileSync(configPath, "utf-8");
    const config = parseYaml(content) as { providers?: Record<string, unknown> };
    return config?.providers;
  } catch {
    return undefined;
  }
}

// -- Functions ---------------------------------------------------------------

/**
 * Open and configure a qmd store for the wiki directory.
 *
 * Creates the store with two collections:
 * - wiki: all .md files except raw/
 * - raw: .md files under raw/, not included in default queries
 *
 * Adds PARA category contexts and runs update() for BM25. When requested,
 * also schedules embed() in the background.
 */
export async function openStore(wikiDir: string, opts: OpenStoreOptions = {}): Promise<QMDStore> {
  // Prefer pi-para's in-memory provider profiles. Legacy QMD YAML remains a
  // fallback for migrated installs and tests that do not pass paraConfig.
  const configuredProviders = opts.paraConfig
    ? opts.paraConfig.qmd.providerConfig === "legacy-qmd-compatible"
      ? loadQmdProviders()
      : await buildQmdProvidersFromParaConfig(opts.paraConfig, {
        secretsPath: opts.secretsPath,
        authStorage: opts.authStorage,
      })
    : loadQmdProviders();
  const providers = configuredProviders ?? NO_LOCAL_PROVIDERS;
  const usingInertShim = !configuredProviders;

  const store = await createStore({
    dbPath: join(wikiDir, ".qmd.sqlite"),
    config: {
      collections: {
        wiki: {
          path: wikiDir,
          pattern: "**/*.md",
          ignore: ["raw/**"],
        },
        raw: {
          path: join(wikiDir, "raw"),
          pattern: "**/*.md",
          includeByDefault: false,
        },
      },
      providers: providers as CollectionConfig["providers"],
    },
  });

  if (usingInertShim) inertProviderStores.add(store);

  // Add PARA category contexts to the wiki collection
  for (const [prefix, description] of Object.entries(PARA_CONTEXTS)) {
    await store.addContext("wiki", prefix, description);
  }

  // Add context for the raw collection root
  await store.addContext("raw", "/", RAW_CONTEXT);

  // Sync filesystem -> BM25 index (fast, search ready immediately)
  await store.update();

  if (opts.backgroundEmbed !== false && opts.paraConfig?.qmd.embedEnabled !== false) {
    // Schedule embedding in background (non-blocking).
    // BM25 search works immediately; hybrid search improves once embed completes.
    const embedPromise = captureQmdEmbedErrors(() => store.embed()).then(() => {
      // Embedding failures are non-fatal — hybrid search degrades to BM25.
      pendingEmbeds.delete(store);
    });
    pendingEmbeds.set(store, embedPromise);
  }

  return store;
}

/**
 * Close the store. Awaits any pending embed operation (with timeout) first.
 */
export async function closeStore(store: QMDStore): Promise<void> {
  const pending = pendingEmbeds.get(store);
  if (pending) {
    // Wait for pending embed with a short timeout — don't hang forever
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([pending, timeout]);
    pendingEmbeds.delete(store);
  }
  await store.close();
}

/**
 * Search the wiki with scope and category filtering.
 *
 * Uses vector search when an embedding index is available, merged with BM25
 * lexical search for exact keyword matches. Each result's frontmatter is parsed
 * to apply scope/category/archive filters.
 */
export async function searchWiki(
  store: QMDStore,
  query: string,
  opts: WikiSearchOptions,
): Promise<WikiSearchResult[]> {
  const limit = opts.limit ?? 10;

  // Build metadata filter for SQL-level filtering (qmd v2.2.0+)
  // Note: we can only use metadata.category here, NOT scope.
  // Scope filtering must remain as post-filter because:
  // - Pages with scope:["global"] must match ANY project scope
  // - Pages in the scope.include list need OR matching
  // - The exclude list needs post-filter negation
  // SQL-level scope filter would miss global pages.
  const metadata: Record<string, string> = {};
  if (opts.category) {
    metadata.category = opts.category;
  }

  const fetchLimit = opts.scope ? limit * 3 : limit;

  const lexResults = await store.searchLex(query, {
    limit: fetchLimit,
    collection: "wiki",
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    graphBoost: opts.graphBoost ?? true,
  });

  const rawResults = await mergeLexAndVectorResults(store, query, lexResults, fetchLimit);
  const results: WikiSearchResult[] = [];

  for (const result of rawResults) {
    // Parse category and slug from the display path (e.g. "projects/auth-refactor.md")
    const parsed = parseDisplayPath(result.displayPath);
    if (!parsed) continue;

    const { category, slug } = parsed;

    // Exclude archives unless explicitly requested (post-filter fallback
    // for pages without frontmatter metadata)
    if (category === "archives" && !opts.includeArchives) {
      continue;
    }

    // Parse frontmatter from body
    const body = result.body ?? "";
    const { frontmatter } = parseFrontmatter(body);

    // Scope post-filter fallback for pages without metadata
    if (opts.scope && !matchesScope(frontmatter.scope, opts.scope)) {
      continue;
    }

    // Extract a snippet for display
    const snippetResult = extractSnippet(body, query);
    const snippet = snippetResult.snippet;

    results.push({
      page: {
        category,
        slug,
        title: frontmatter.title || result.title || slug,
        path: `${category}/${slug}.md`,
      },
      score: result.score,
      snippet,
      frontmatter,
    });

    if (results.length >= limit) break;
  }

  return results;
}

async function mergeLexAndVectorResults(
  store: QMDStore,
  query: string,
  lexResults: RawQmdSearchResult[],
  limit: number,
): Promise<RawQmdSearchResult[]> {
  let vecResults: RawQmdSearchResult[] = [];
  try {
    const status = await store.getStatus();
    const llm = (store.internal as unknown as { llm?: unknown }).llm;
    const embedModel = (llm as { embedModelName?: string } | undefined)?.embedModelName;
    if (status.hasVectorIndex && llm && embedModel) {
      const vectorAttempt = await captureQmdEmbedErrors(
        () => store.internal.searchVec(query, embedModel, limit, "wiki", llm as any) as Promise<RawQmdSearchResult[]>,
      );
      if (vectorAttempt.ok) vecResults = vectorAttempt.value;
    }
  } catch {
    // Semantic search is best-effort; lexical BM25 remains the reliable fallback.
  }

  const merged = new Map<string, RawQmdSearchResult>();
  for (const result of lexResults) {
    merged.set(result.displayPath, { ...result, score: result.score * 0.85 });
  }
  for (const result of vecResults) {
    const existing = merged.get(result.displayPath);
    if (!existing || result.score > existing.score) {
      merged.set(result.displayPath, result);
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit * 2);
}

/**
 * Re-index the store (fast filesystem scan). Makes new/changed
 * content BM25-searchable immediately. Call after wiki writes.
 */
export async function reindex(store: QMDStore): Promise<void> {
  await store.update();
}

/**
 * Generate vector embeddings for new/changed pages.
 * Slow — call only at startup (via openStore) or shutdown.
 */
export async function embedIfNeeded(store: QMDStore): Promise<void> {
  await store.embed();
}

// -- Helpers -----------------------------------------------------------------

/** Valid PARA categories for path parsing. */
const VALID_CATEGORIES = new Set<string>([
  "projects",
  "areas",
  "resources",
  "archives",
]);

/**
 * Parse a qmd display path into category + slug.
 * Display paths from searchLex include the collection prefix:
 *   "wiki/resources/ssl-certs.md" or "wiki/schema.md"
 * Returns null for root-level files (schema.md, index.md, etc.) — they
 * still appear in search results but aren't PageRef-able.
 */
function parseDisplayPath(
  displayPath: string,
): { category: ParaCategory; slug: string } | null {
  const parts = displayPath.split("/");

  // Display paths are: collection/category/slug.md (3+ parts)
  // or collection/file.md (2 parts, root-level files like schema.md)
  if (parts.length < 3) return null;

  // Skip collection prefix (parts[0] = "wiki")
  const category = parts[1];
  if (!VALID_CATEGORIES.has(category)) return null;

  const filename = parts.slice(2).join("/");
  if (!filename.endsWith(".md")) return null;

  const slug = filename.slice(0, -3);
  return { category: category as ParaCategory, slug };
}
