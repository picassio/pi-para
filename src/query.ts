/**
 * Query pipeline — searches the wiki and returns relevant results.
 *
 * Performs scoped search via qmd and returns results for the LLM
 * to synthesize answers from. This is the reusable library function;
 * the wiki_query tool wraps it with LLM prompt formatting.
 */

import type { QMDStore } from "qmd-engine";
import type { ParaCategory } from "./wiki.js";
import { searchWiki } from "./store.js";
import type { WikiSearchResult } from "./store.js";
import type { ProjectScope } from "./scope.js";

// -- Types ------------------------------------------------------------------

export interface QueryOptions {
  /** Natural language search query */
  query: string;
  /** Override auto-detected scope tags */
  scope?: string[];
  /** Search all scopes (ignore project filter) */
  global?: boolean;
  /** Restrict to a PARA category */
  category?: ParaCategory;
  /** Maximum results (default 10) */
  limit?: number;
  /** Include archives in results (default false) */
  includeArchives?: boolean;
  /** Also search the raw/ collection (default false) */
  includeRaw?: boolean;
  /** Enable graph-boosted search via 1-hop wikilink expansion (default true) */
  graphBoost?: boolean;
}

export interface QueryResult {
  /** Search results with page metadata and snippets */
  results: WikiSearchResult[];
  /** The scope that was used for filtering */
  scopeUsed: ProjectScope;
  /** Whether the search was global (no scope filtering) */
  wasGlobal: boolean;
}

// -- Main pipeline -----------------------------------------------------------

/**
 * Search the wiki with scope and category filtering.
 *
 * This is the reusable library function. It:
 * 1. Applies scope filtering (unless global flag is set)
 * 2. Filters by PARA category if specified
 * 3. Excludes archives unless explicitly requested
 * 4. Returns results sorted by relevance score
 *
 * The caller (tool or standalone agent) can format the results
 * into an LLM prompt or use them directly.
 */
export async function queryWiki(
  store: QMDStore,
  options: QueryOptions,
  scope: ProjectScope,
): Promise<QueryResult> {
  const limit = options.limit ?? 10;
  const isGlobal = options.global ?? false;
  const includeArchives = options.includeArchives ?? (options.category === "archives");

  // Build scope override if explicit scope tags provided
  let effectiveScope: ProjectScope | undefined;
  if (isGlobal) {
    effectiveScope = undefined; // no scope filtering
  } else if (options.scope && options.scope.length > 0) {
    effectiveScope = {
      ...scope,
      name: scope.name,
      include: options.scope,
    };
  } else {
    effectiveScope = scope;
  }

  const results = await searchWiki(store, options.query, {
    scope: effectiveScope,
    category: options.category,
    limit,
    includeArchives,
    graphBoost: options.graphBoost,
  });

  return {
    results,
    scopeUsed: effectiveScope ?? scope,
    wasGlobal: isGlobal,
  };
}

/**
 * Format query results as a readable text block.
 * Useful for building LLM prompts or display.
 *
 * Includes freshness indicators so the LLM knows which pages to trust
 * vs. which need verification against current code/state.
 */
export function formatQueryResults(results: WikiSearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const now = Date.now();

  return results
    .map((r, i) => {
      const fm = r.frontmatter;
      const freshness = formatFreshness(fm.updated, now);
      return [
        `### Result ${i + 1}: ${fm.title} (${r.page.path})`,
        `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
        `Updated: ${fm.updated} | ${freshness}`,
        `Score: ${r.score.toFixed(3)}`,
        "",
        r.snippet,
      ].join("\n");
    })
    .join("\n\n");
}

// -- Freshness helpers -------------------------------------------------------

/**
 * Compute a human-readable freshness indicator from the page's `updated` date.
 *
 * - < 7 days  → "✅ FRESH"
 * - 7-14 days → "✅ Recent — N days old"
 * - 14-30 days → "⚠️ AGING — N days old — verify claims about code/configs"
 * - 30-90 days → "⚠️ STALE — N days old — verify before trusting"
 * - > 90 days  → "🚨 VERY STALE — N days old — likely outdated, verify everything"
 */
export function formatFreshness(updatedISO: string, nowMs: number): string {
  const updatedMs = Date.parse(updatedISO);
  if (isNaN(updatedMs)) return "❓ Unknown freshness (no valid date)";

  const ageDays = Math.floor((nowMs - updatedMs) / (1000 * 60 * 60 * 24));

  if (ageDays < 0) return "✅ FRESH";
  if (ageDays < 7) return "✅ FRESH";
  if (ageDays < 14) return `✅ Recent — ${ageDays} days old`;
  if (ageDays < 30) return `⚠️ AGING — ${ageDays} days old — verify claims about code/configs`;
  if (ageDays < 90) return `⚠️ STALE — ${ageDays} days old — verify before trusting`;
  return `🚨 VERY STALE — ${ageDays} days old — likely outdated, verify everything`;
}
