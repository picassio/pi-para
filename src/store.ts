/**
 * qmd store lifecycle — manages the @picassio/qmd store instance.
 *
 * Handles store creation/opening, search with scope filtering,
 * re-indexing after wiki changes, and embedding lifecycle.
 */

import { join } from "node:path";
import { createStore, extractSnippet } from "@picassio/qmd";
import type { QMDStore } from "@picassio/qmd";
import { parseFrontmatter } from "./frontmatter.js";
import { matchesScope } from "./scope.js";
import type { PageFrontmatter, PageRef, ParaCategory } from "./wiki.js";
import type { ProjectScope } from "./scope.js";

// Re-export QMDStore for convenience
export type { QMDStore } from "@picassio/qmd";

// -- Types ------------------------------------------------------------------

export interface WikiSearchOptions {
  scope?: ProjectScope;
  category?: ParaCategory;
  limit?: number;
  includeArchives?: boolean; // default false
}

export interface WikiSearchResult {
  page: PageRef;
  score: number;
  snippet: string;
  frontmatter: PageFrontmatter;
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

// -- Functions ---------------------------------------------------------------

/**
 * Open and configure a qmd store for the wiki directory.
 *
 * Creates the store with two collections:
 * - wiki: all .md files except raw/
 * - raw: .md files under raw/, not included in default queries
 *
 * Adds PARA category contexts, runs update() for BM25,
 * and schedules embed() in the background.
 */
export async function openStore(wikiDir: string): Promise<QMDStore> {
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
    },
  });

  // Add PARA category contexts to the wiki collection
  for (const [prefix, description] of Object.entries(PARA_CONTEXTS)) {
    await store.addContext("wiki", prefix, description);
  }

  // Add context for the raw collection root
  await store.addContext("raw", "/", RAW_CONTEXT);

  // Sync filesystem -> BM25 index (fast, search ready immediately)
  await store.update();

  // Schedule embedding in background (non-blocking).
  // BM25 search works immediately; hybrid search improves once embed completes.
  const embedPromise = store.embed().then(() => {
    pendingEmbeds.delete(store);
  }).catch(() => {
    // Embedding failures are non-fatal — hybrid search degrades to BM25
    pendingEmbeds.delete(store);
  });
  pendingEmbeds.set(store, embedPromise);

  return store;
}

/**
 * Close the store. Awaits any pending embed operation (with timeout) first.
 */
export async function closeStore(store: QMDStore): Promise<void> {
  const pending = pendingEmbeds.get(store);
  if (pending) {
    // Wait for pending embed with a short timeout — don't hang forever
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([pending, timeout]);
    pendingEmbeds.delete(store);
  }
  await store.close();
}

/**
 * Search the wiki with scope and category filtering.
 *
 * Uses BM25 search (searchLex) which requires no LLM. Each result's
 * frontmatter is parsed to apply scope/category/archive filters.
 */
export async function searchWiki(
  store: QMDStore,
  query: string,
  opts: WikiSearchOptions,
): Promise<WikiSearchResult[]> {
  const limit = opts.limit ?? 10;

  // Use searchLex (BM25) — fast, no LLM dependency.
  // Fetch extra results to compensate for post-filtering.
  const fetchLimit = limit * 3;
  const rawResults = await store.searchLex(query, { limit: fetchLimit, collection: "wiki" });

  const results: WikiSearchResult[] = [];

  for (const result of rawResults) {
    // Parse category and slug from the display path (e.g. "projects/auth-refactor.md")
    const parsed = parseDisplayPath(result.displayPath);
    if (!parsed) continue;

    const { category, slug } = parsed;

    // Exclude archives unless explicitly requested
    if (category === "archives" && !opts.includeArchives) {
      continue;
    }

    // Filter by category if specified
    if (opts.category && category !== opts.category) {
      continue;
    }

    // Parse frontmatter from body
    const body = result.body ?? "";
    const { frontmatter } = parseFrontmatter(body);

    // Filter by scope if provided
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
        title: frontmatter.title || result.title,
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
