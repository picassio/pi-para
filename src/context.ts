/**
 * Session context injection — injects relevant wiki knowledge into every agent turn.
 *
 * Builds a context string from schema.md, index.md, and scope-filtered page
 * summaries, injected via the before_agent_start hook.
 *
 * Uses a dirty-flag caching strategy: the context string is rebuilt only when
 * wiki_write or wiki_move modifies the wiki (or on session start). Cached
 * context is returned on subsequent before_agent_start calls, adding <5ms.
 */

import type { QMDStore } from "qmd-engine";
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEventResult,
} from "@mariozechner/pi-coding-agent";
import type { ProjectScope } from "./scope.js";
import type { StateDB, PageSummary } from "./state.js";
import { readIndex, readSchema, listPages, readPage } from "./wiki.js";
import { matchesScope } from "./scope.js";
import { formatFreshness } from "./query.js";

// -- Types ------------------------------------------------------------------

export interface ContextOptions {
  maxTokens?: number; // max tokens for wiki context (default 4000)
  includeSchema?: boolean; // include schema.md (default true)
  includeIndex?: boolean; // include index.md (default true)
  includeSummaries?: boolean; // include page summaries (default true)
}

/** Config subset needed by context injection. */
export interface ContextConfig {
  contextMaxTokens?: number;
  contextIncludeSchema?: boolean;
  contextIncludeIndex?: boolean;
}

// -- Constants ---------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;

/** Maximum number of pages to include in context injection. */
export const MAX_CONTEXT_PAGES = 40;

// -- Schema summary ----------------------------------------------------------

/**
 * A compact conventions summary extracted from schema.md, much smaller than
 * the full schema. Used to give the LLM essential rules without blowing the
 * token budget.
 */
function buildSchemaSummary(fullSchema: string): string {
  // If the schema is small enough, include it verbatim
  if (fullSchema.length / CHARS_PER_TOKEN < 500) {
    return fullSchema;
  }

  // Otherwise return a compact summary of key conventions
  return [
    "## Wiki Conventions (summary)",
    "",
    "- Pages: markdown + YAML frontmatter (title, para, scope, tags, sources, created, updated, links)",
    "- PARA categories: **resources/** for almost everything (architecture docs, how-tos, patterns, debugging). **areas/** for ongoing responsibilities. **projects/** ONLY for actual goals with end dates. **archives/** for completed items.",
    "- Scope: must be a kebab-case project name (e.g. `pi-para`, `qmd`). NOT topic descriptions.",
    "- Tags: kebab-case, no spaces. Don't duplicate scope values as tags.",
    "- Slugs: lowercase, hyphens (e.g. ssl-cert-gotchas)",
    "- Cross-references: use [[slug]] wikilinks. Add a ## Connections section linking related pages.",
    "- Wiki summary format sections: Topic, Key Facts, Insights, Connections, Open Questions, Sources",
    "- Update existing pages for same concept, create new pages for distinct concepts",
    "- Tone: technical, concise, factual",
  ].join("\n");
}

// -- Public API --------------------------------------------------------------

/**
 * Build a context string from wiki state for injection into the system prompt.
 *
 * Strategy:
 * 1. Always include schema conventions summary + index.md
 * 2. Conditionally include first paragraph / summary of pages matching scope
 * 3. If budget exceeded, fall back to index + page titles only
 */
export async function buildContext(
  wikiDir: string,
  _store: QMDStore,
  scope: ProjectScope,
  options?: ContextOptions,
  stateDb?: StateDB,
): Promise<string> {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const includeSchema = options?.includeSchema ?? true;
  const includeIndex = options?.includeIndex ?? true;
  const includeSummaries = options?.includeSummaries ?? true;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let usedChars = 0;

  // Header
  const header = `<wiki-context scope="${scope.name}">`;
  const footer = "</wiki-context>";
  usedChars += header.length + footer.length + 2; // +2 for newlines

  // 1. Schema conventions summary
  if (includeSchema) {
    let schemaContent: string;
    try {
      schemaContent = await readSchema(wikiDir);
    } catch {
      schemaContent = "";
    }
    if (schemaContent) {
      const summary = buildSchemaSummary(schemaContent);
      if (usedChars + summary.length + 2 <= maxChars) {
        parts.push(summary);
        usedChars += summary.length + 2;
      }
    }
  }

  // 2. Index.md
  let indexContent = "";
  if (includeIndex) {
    try {
      indexContent = await readIndex(wikiDir);
    } catch {
      indexContent = "";
    }
    if (indexContent) {
      if (usedChars + indexContent.length + 2 <= maxChars) {
        parts.push(indexContent);
        usedChars += indexContent.length + 2;
      } else {
        // Truncate index to fit
        const available = maxChars - usedChars - 2;
        if (available > 100) {
          parts.push(indexContent.slice(0, available) + "\n...(truncated)");
          usedChars = maxChars;
        }
      }
    }
  }

  // 3. Scope-filtered page summaries
  if (includeSummaries && usedChars < maxChars) {
    // Use stateDb cache if available, otherwise fall back to disk reads
    const scopeEntries = stateDb
      ? await buildScopeEntriesFromCache(stateDb, scope)
      : await buildScopeEntriesFromDisk(wikiDir, scope);

    // Sort by updated date descending (most recent first)
    scopeEntries.sort((a, b) => {
      const dateA = new Date(a.updatedAt).getTime() || 0;
      const dateB = new Date(b.updatedAt).getTime() || 0;
      return dateB - dateA;
    });

    const totalScopePages = scopeEntries.length;

    // Tier: only include top MAX_CONTEXT_PAGES
    const tieredEntries = scopeEntries.slice(0, MAX_CONTEXT_PAGES);
    const remaining = totalScopePages - tieredEntries.length;

    const summaryParts: string[] = [];
    const titleFallbacks: string[] = [];

    for (const entry of tieredEntries) {
      const summaryLine = `- **[[${entry.slug}]]** (${entry.category}): ${entry.firstParagraph}`;
      const titleLine = `- [[${entry.slug}]] (${entry.category})`;

      titleFallbacks.push(titleLine);

      if (usedChars + summaryLine.length + 2 <= maxChars) {
        summaryParts.push(summaryLine);
        usedChars += summaryLine.length + 1;
      }
    }

    if (summaryParts.length > 0) {
      let summaryBlock =
        "## Relevant Pages\n\n" + summaryParts.join("\n");
      if (remaining > 0) {
        summaryBlock += `\n\n*${remaining} more pages available via wiki_query*`;
      }
      parts.push(summaryBlock);
    } else if (titleFallbacks.length > 0) {
      // Budget exceeded for summaries — try titles only
      let titlesBlock =
        "## Relevant Pages (titles only)\n\n" + titleFallbacks.join("\n");
      if (remaining > 0) {
        titlesBlock += `\n\n*${remaining} more pages available via wiki_query*`;
      }
      const availableChars = maxChars - usedChars;
      if (titlesBlock.length <= availableChars) {
        parts.push(titlesBlock);
      }
    }
  }

  if (parts.length === 0) {
    return "";
  }

  // Reminder to use wiki tools proactively — this is injected into every turn
  // so the LLM doesn't forget between tool calls.
  parts.push(
    "Persist major decisions/debugging/conventions with wiki_write without being asked."
  );
  parts.push(
    "wiki_write: prefer resources/, kebab-case scope/tags, add [[wikilinks]], never store secrets. Use wiki_edit for surgical existing-page updates; mode=create will not overwrite."
  );
  parts.push(
    "Stale wiki claims about code/configs/APIs must be verified against source; fix wrong pages with wiki_edit."
  );

  return header + "\n" + parts.join("\n\n") + "\n" + footer;
}

// -- Caching and lifecycle ---------------------------------------------------

/** Module-level dirty flag, exported for tools.ts to call after mutations. */
let contextDirty = true;
let cachedContext: string | null = null;

/**
 * Mark the cached context as dirty. Call this after wiki_write or wiki_move
 * so the next before_agent_start rebuilds the context.
 */
export function markContextDirty(): void {
  contextDirty = true;
}

/**
 * Wire up context injection on the extension API.
 *
 * - On session_start: mark dirty so context is rebuilt for the new scope
 * - On before_agent_start: return cached context if clean, rebuild if dirty
 *
 * @param pi - The extension API
 * @param wikiDir - Path to the wiki directory
 * @param store - qmd store instance (or getter returning one)
 * @param getScope - Returns the current ProjectScope
 * @param getConfig - Returns the current config values for context
 */
export function setupContextInjection(
  pi: ExtensionAPI,
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope | null,
  getConfig: () => ContextConfig,
): void {
  // Reset cache state for a fresh setup
  contextDirty = true;
  cachedContext = null;

  pi.on("session_start", async () => {
    contextDirty = true;
    cachedContext = null;
  });

  pi.on(
    "before_agent_start",
    async (
      event,
      _ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | void> => {
      const scope = getScope();
      if (!scope) return;

      if (!contextDirty && cachedContext !== null) {
        // Return cached context
        if (cachedContext) {
          return {
            systemPrompt: event.systemPrompt + "\n\n" + cachedContext,
          };
        }
        return;
      }

      // Rebuild context
      const config = getConfig();
      const options: ContextOptions = {
        maxTokens: config.contextMaxTokens ?? DEFAULT_MAX_TOKENS,
        includeSchema: config.contextIncludeSchema ?? true,
        includeIndex: true,
      };

      try {
        cachedContext = await buildContext(wikiDir, store, scope, options);
        contextDirty = false;
      } catch {
        // On error, clear cache and don't inject anything
        cachedContext = null;
        contextDirty = false;
        return;
      }

      if (cachedContext) {
        return {
          systemPrompt: event.systemPrompt + "\n\n" + cachedContext,
        };
      }
    },
  );
}

// -- Helpers -----------------------------------------------------------------

interface ScopeEntry {
  slug: string;
  category: string;
  firstParagraph: string;
  updatedAt: string;
}

/** Build scope entries from the StateDB page summary cache. */
async function buildScopeEntriesFromCache(
  stateDb: StateDB,
  scope: ProjectScope,
): Promise<ScopeEntry[]> {
  const summaries = stateDb.getPageSummaries(scope);
  return summaries.map((s) => ({
    slug: s.slug,
    category: s.category,
    firstParagraph: s.firstParagraph || "(no summary)",
    updatedAt: s.updatedAt,
  }));
}

/** Build scope entries by reading all pages from disk. */
async function buildScopeEntriesFromDisk(
  wikiDir: string,
  scope: ProjectScope,
): Promise<ScopeEntry[]> {
  const pages = await listPages(wikiDir);
  const entries: ScopeEntry[] = [];

  for (const ref of pages) {
    const page = await readPage(wikiDir, ref.category, ref.slug);
    if (!page) continue;
    if (!matchesScope(page.frontmatter.scope, scope)) continue;

    entries.push({
      slug: ref.slug,
      category: ref.category,
      firstParagraph: extractFirstParagraph(page.body),
      updatedAt: page.frontmatter.updated,
    });
  }

  return entries;
}

/**
 * Extract the first non-empty paragraph from a markdown body.
 * Skips headings and blank lines. Returns a single line.
 */
export function extractFirstParagraph(body: string): string {
  const lines = body.split("\n");
  const paragraphLines: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headings and empty lines before paragraph starts
    if (!inParagraph) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      inParagraph = true;
    }

    // End paragraph on blank line or heading
    if (inParagraph && (trimmed === "" || trimmed.startsWith("#"))) {
      break;
    }

    paragraphLines.push(trimmed);
  }

  const result = paragraphLines.join(" ");
  // Truncate long paragraphs
  if (result.length > 200) {
    return result.slice(0, 197) + "...";
  }
  return result || "(no summary)";
}
