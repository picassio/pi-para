/**
 * Query pipeline — searches the wiki and returns relevant results.
 *
 * Performs scoped search via qmd and returns results for the LLM
 * to synthesize answers from. This is the reusable library function;
 * the wiki_query tool wraps it with LLM prompt formatting.
 */

import type { QMDStore } from "@picassio/qmd";
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
 */
export function formatQueryResults(results: WikiSearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const fm = r.frontmatter;
      return [
        `### Result ${i + 1}: ${fm.title} (${r.page.path})`,
        `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
        `Score: ${r.score.toFixed(3)}`,
        "",
        r.snippet,
      ].join("\n");
    })
    .join("\n\n");
}
