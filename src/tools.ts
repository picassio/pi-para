/**
 * Tool registrations — wiki tools for both pi's session agent and standalone mini-agent.
 *
 * Tool implementations are shared between both consumers. Only the registration
 * wrapper differs (pi.registerTool vs AgentTool).
 *
 * Factory functions (createXxxExecute) close over wikiDir and store — no ctx dependency.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { QMDStore } from "@picassio/qmd";
import { Type } from "typebox";

import type { ProjectScope } from "./scope.js";
import { resolveSource, truncateSource, detectSourceType } from "./ingest.js";
import { queryWiki as queryWikiLib, formatQueryResults } from "./query.js";
import { reindex } from "./store.js";
import {
  readPage,
  writePage,
  movePage,
  listPages,
  readIndex,
  writeIndex,
  readSchema,
  appendLog,
  PARA_CATEGORIES,
} from "./wiki.js";
import type {
  ParaCategory,
  WikiPage,
  PageRef,
} from "./wiki.js";
import { validateFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { lintWiki } from "./lint.js";
import type { LintReport } from "./lint.js";
import { generateOverviewPrompt } from "./summarize.js";
import {
  INGEST_PROMPT,
  QUERY_PROMPT,
  LINT_PROMPT,
} from "./templates/prompts.js";

// -- Parameter schemas -------------------------------------------------------

const PARA_ENUM = StringEnum(
  ["projects", "areas", "resources", "archives"] as const,
  { description: "PARA category" },
);

const PARA_ENUM_NO_ARCHIVES = StringEnum(
  ["projects", "areas", "resources"] as const,
  { description: "PARA category (archives excluded for new content)" },
);

const WikiIngestParams = Type.Object({
  source: Type.String({ description: "URL, file path, or raw text to ingest" }),
  sourceType: Type.Optional(
    StringEnum(["url", "file", "text"] as const, {
      description: "Source type (auto-detected if omitted)",
    }),
  ),
  category: Type.Optional(PARA_ENUM_NO_ARCHIVES),
  scope: Type.Optional(
    Type.Array(Type.String(), { description: "Scope tags for the ingested content" }),
  ),
});

const WikiQueryParams = Type.Object({
  query: Type.String({ description: "Natural language search query" }),
  global: Type.Optional(
    Type.Boolean({ description: "Search all scopes, not just current project" }),
  ),
  category: Type.Optional(PARA_ENUM),
  limit: Type.Optional(
    Type.Number({ description: "Max results (default 10)" }),
  ),
});

const WikiWritePageSchema = Type.Object({
  category: PARA_ENUM,
  slug: Type.String({ description: "Page slug (lowercase, hyphens)" }),
  title: Type.String({ description: "Page title" }),
  scope: Type.Array(Type.String(), { description: "Scope tags" }),
  tags: Type.Array(Type.String(), { description: "Topic tags" }),
  body: Type.String({ description: "Page body in markdown (wiki summary format)" }),
  mode: StringEnum(["create", "replace", "append"] as const, {
    description: "Write mode: create new, replace existing, or append to existing",
  }),
});

const WikiWriteParams = Type.Object({
  pages: Type.Array(WikiWritePageSchema, {
    description: "Pages to write or update",
  }),
  indexContent: Type.Optional(
    Type.String({ description: "Updated index.md content (full replacement)" }),
  ),
  logSummary: Type.Optional(
    Type.String({ description: "One-line summary for log.md" }),
  ),
});

const WikiReadParams = Type.Object({
  path: Type.String({
    description: "Page path (e.g. 'projects/auth-refactor') or page title",
  }),
});

const WikiMoveParams = Type.Object({
  path: Type.String({
    description: "Current page path (e.g. 'projects/auth-refactor')",
  }),
  to: PARA_ENUM,
});

const WikiLintParams = Type.Object({
  autoFix: Type.Optional(
    Type.Boolean({ description: "Auto-fix simple issues (default true)" }),
  ),
});

const WikiSummarizeParams = Type.Object({
  target: Type.String({
    description: "Page path, category name (e.g. 'projects'), or 'all'",
  }),
  depth: Type.Optional(
    StringEnum(["brief", "detailed"] as const, {
      description: "Summary depth (default brief)",
    }),
  ),
});

// -- Detail types for tool results -------------------------------------------

interface WikiIngestDetails {
  sourceType: "url" | "file" | "text";
  rawPath?: string;
  sourceLength: number;
}

interface WikiQueryDetails {
  resultCount: number;
  scopeUsed: string;
}

interface WikiWriteDetails {
  pagesWritten: string[];
  indexUpdated: boolean;
  logAppended: boolean;
}

interface WikiReadDetails {
  found: boolean;
  path?: string;
}

interface WikiMoveDetails {
  from: string;
  to: string;
}

interface WikiLintDetails {
  issueCount: number;
  fixedCount: number;
  stats: LintReport["stats"];
}

interface WikiSummarizeDetails {
  target: string;
  pageCount: number;
}

// -- Source resolution helpers -----------------------------------------------

/** Resolve a page path like "projects/auth-refactor" into category + slug. */
function parsePagePath(
  path: string,
): { category: ParaCategory; slug: string } | null {
  const parts = path.split("/");
  if (parts.length === 2) {
    const cat = parts[0] as ParaCategory;
    if (PARA_CATEGORIES.includes(cat)) {
      const slug = parts[1].replace(/\.md$/, "");
      return { category: cat, slug };
    }
  }
  return null;
}

// -- Factory: wiki_ingest execute --------------------------------------------

function createIngestExecute(
  wikiDir: string,
  _store: QMDStore,
  getScope: () => ProjectScope,
) {
  return async (
    params: { source: string; sourceType?: "url" | "file" | "text"; category?: ParaCategory; scope?: string[] },
  ): Promise<AgentToolResult<WikiIngestDetails>> => {
    const scope = getScope();
    const resolved = await resolveSource(wikiDir, {
      source: params.source,
      sourceType: params.sourceType,
      scope: params.scope,
      category: params.category,
    }, scope);

    const categoryHint = resolved.categoryHint
      ? `\nSuggested PARA category: ${resolved.categoryHint}`
      : "";

    // Assemble the tool result with instructions for the LLM
    const toolResultText = [
      INGEST_PROMPT,
      "",
      `Current scope: ${resolved.scopeName} (tags: ${resolved.scopeTags.join(", ")})`,
      categoryHint,
      resolved.rawPath ? `Raw source saved to: ${resolved.rawPath}` : "",
      "",
      "<wiki-schema>",
      resolved.schema,
      "</wiki-schema>",
      "",
      "<wiki-index>",
      resolved.index,
      "</wiki-index>",
      "",
      "<source-content>",
      truncateSource(resolved.content),
      "</source-content>",
      "",
      "Now analyze the source content and use wiki_write to create/update pages, update the index, and log the operation.",
    ].join("\n");

    return {
      content: [{ type: "text", text: toolResultText }],
      details: {
        sourceType: resolved.sourceType,
        rawPath: resolved.rawPath,
        sourceLength: resolved.content.length,
      },
    };
  };
}

// -- Factory: wiki_query execute ---------------------------------------------

function createQueryExecute(
  _wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
) {
  return async (
    params: { query: string; global?: boolean; category?: ParaCategory; limit?: number },
  ): Promise<AgentToolResult<WikiQueryDetails>> => {
    const scope = getScope();
    const result = await queryWikiLib(store, {
      query: params.query,
      global: params.global,
      category: params.category,
      limit: params.limit,
    }, scope);

    if (result.results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No wiki pages found for "${params.query}". The wiki may not have content on this topic yet.`,
          },
        ],
        details: {
          resultCount: 0,
          scopeUsed: result.wasGlobal ? "global" : scope.name,
        },
      };
    }

    const formatted = formatQueryResults(result.results);
    const toolResultText = [
      QUERY_PROMPT,
      "",
      `Query: "${params.query}"`,
      `Scope: ${result.wasGlobal ? "global (all scopes)" : scope.name}`,
      `Results: ${result.results.length}`,
      "",
      formatted,
    ].join("\n");

    return {
      content: [{ type: "text", text: toolResultText }],
      details: {
        resultCount: result.results.length,
        scopeUsed: result.wasGlobal ? "global" : scope.name,
      },
    };
  };
}

// -- Factory: wiki_write execute ---------------------------------------------

function createWriteExecute(
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  markDirty: () => void,
) {
  return async (
    params: {
      pages: Array<{
        category: ParaCategory;
        slug: string;
        title: string;
        scope: string[];
        tags: string[];
        body: string;
        mode: "create" | "replace" | "append";
      }>;
      indexContent?: string;
      logSummary?: string;
    },
  ): Promise<AgentToolResult<WikiWriteDetails>> => {
    const pagesWritten: string[] = [];
    const now = new Date().toISOString();
    const scope = getScope();

    for (const pageSpec of params.pages) {
      // Sanitize slug
      const slug = pageSpec.slug
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      if (!slug) {
        continue; // skip invalid slugs
      }

      const existing = await readPage(wikiDir, pageSpec.category, slug);
      const pagePath = `${pageSpec.category}/${slug}`;

      if (pageSpec.mode === "append" && existing) {
        // Append to existing page body
        const updatedPage: WikiPage = {
          ...existing,
          body: existing.body.trimEnd() + "\n\n" + pageSpec.body,
          frontmatter: {
            ...existing.frontmatter,
            updated: now,
            // Merge tags
            tags: [...new Set([...existing.frontmatter.tags, ...pageSpec.tags])],
            // Merge scope
            scope: [...new Set([...existing.frontmatter.scope, ...pageSpec.scope])],
          },
        };
        await writePage(wikiDir, updatedPage);
        pagesWritten.push(pagePath);
      } else if (pageSpec.mode === "replace" && existing) {
        // Replace existing page body, update frontmatter
        const updatedPage: WikiPage = {
          category: pageSpec.category,
          slug,
          frontmatter: {
            ...existing.frontmatter,
            title: pageSpec.title,
            para: pageSpec.category,
            scope: pageSpec.scope.length > 0 ? pageSpec.scope : existing.frontmatter.scope,
            tags: pageSpec.tags.length > 0 ? pageSpec.tags : existing.frontmatter.tags,
            updated: now,
            links: extractWikilinks(pageSpec.body),
          },
          body: pageSpec.body,
        };
        await writePage(wikiDir, updatedPage);
        pagesWritten.push(pagePath);
      } else {
        // Create new page (or mode=create/replace on non-existing)
        const frontmatter = validateFrontmatter({
          title: pageSpec.title,
          para: pageSpec.category,
          scope: pageSpec.scope.length > 0 ? pageSpec.scope : [scope.name],
          tags: pageSpec.tags,
          sources: [],
          created: now,
          updated: now,
          links: extractWikilinks(pageSpec.body),
        });

        const newPage: WikiPage = {
          category: pageSpec.category,
          slug,
          frontmatter,
          body: pageSpec.body,
        };
        await writePage(wikiDir, newPage);
        pagesWritten.push(pagePath);
      }
    }

    // Update index.md if provided
    let indexUpdated = false;
    if (params.indexContent) {
      await writeIndex(wikiDir, params.indexContent);
      indexUpdated = true;
    }

    // Append to log.md if summary provided
    let logAppended = false;
    if (params.logSummary && pagesWritten.length > 0) {
      await appendLog(wikiDir, {
        date: now.split("T")[0],
        operation: "ingest",
        summary: params.logSummary,
        pages: pagesWritten,
      });
      logAppended = true;
    }

    // Re-index for BM25 (fast). Do NOT embed — deferred to shutdown.
    await reindex(store);

    // Mark context cache dirty so before_agent_start rebuilds
    markDirty();

    const summary = pagesWritten.length > 0
      ? `Wrote ${pagesWritten.length} page(s): ${pagesWritten.join(", ")}`
      : "No pages written.";

    return {
      content: [
        {
          type: "text",
          text: [
            summary,
            indexUpdated ? "Updated index.md." : "",
            logAppended ? `Logged: ${params.logSummary}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      details: {
        pagesWritten,
        indexUpdated,
        logAppended,
      },
    };
  };
}

// -- Factory: wiki_read execute ----------------------------------------------

function createReadExecute(wikiDir: string) {
  return async (
    params: { path: string },
  ): Promise<AgentToolResult<WikiReadDetails>> => {
    // Try parsing as category/slug path
    const parsed = parsePagePath(params.path);
    if (parsed) {
      const page = await readPage(wikiDir, parsed.category, parsed.slug);
      if (page) {
        const fm = page.frontmatter;
        const header = [
          `# ${fm.title}`,
          `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
          `Created: ${fm.created} | Updated: ${fm.updated}`,
          fm.sources.length > 0 ? `Sources: ${fm.sources.join(", ")}` : "",
          fm.links.length > 0 ? `Links: ${fm.links.map((l) => `[[${l}]]`).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text: `${header}\n\n${page.body}` }],
          details: { found: true, path: `${parsed.category}/${parsed.slug}` },
        };
      }
    }

    // Try finding by title (case-insensitive search across all pages)
    const allPages = await listPages(wikiDir);
    const titleLower = params.path.toLowerCase();
    for (const ref of allPages) {
      if (ref.title.toLowerCase() === titleLower || ref.slug === titleLower) {
        const page = await readPage(wikiDir, ref.category, ref.slug);
        if (page) {
          const fm = page.frontmatter;
          const header = [
            `# ${fm.title}`,
            `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
            `Created: ${fm.created} | Updated: ${fm.updated}`,
            fm.sources.length > 0 ? `Sources: ${fm.sources.join(", ")}` : "",
            fm.links.length > 0 ? `Links: ${fm.links.map((l) => `[[${l}]]`).join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          return {
            content: [{ type: "text", text: `${header}\n\n${page.body}` }],
            details: { found: true, path: `${ref.category}/${ref.slug}` },
          };
        }
      }
    }

    return {
      content: [{ type: "text", text: `Page not found: "${params.path}"` }],
      details: { found: false },
    };
  };
}

// -- Factory: wiki_move execute ----------------------------------------------

function createMoveExecute(
  wikiDir: string,
  store: QMDStore,
  markDirty: () => void,
) {
  return async (
    params: { path: string; to: ParaCategory },
  ): Promise<AgentToolResult<WikiMoveDetails>> => {
    const parsed = parsePagePath(params.path);
    if (!parsed) {
      throw new Error(`Invalid page path: "${params.path}". Expected format: category/slug`);
    }

    const page = await readPage(wikiDir, parsed.category, parsed.slug);
    if (!page) {
      throw new Error(`Page not found: "${params.path}"`);
    }

    if (parsed.category === params.to) {
      return {
        content: [
          {
            type: "text",
            text: `Page "${params.path}" is already in ${params.to}. No move needed.`,
          },
        ],
        details: { from: params.path, to: `${params.to}/${parsed.slug}` },
      };
    }

    const ref: PageRef = {
      category: parsed.category,
      slug: parsed.slug,
      title: page.frontmatter.title,
      path: `${parsed.category}/${parsed.slug}.md`,
    };

    await movePage(wikiDir, ref, params.to);

    // Re-index
    await reindex(store);
    markDirty();

    // Log the move
    const now = new Date().toISOString();
    await appendLog(wikiDir, {
      date: now.split("T")[0],
      operation: "move",
      summary: `Moved ${page.frontmatter.title} from ${parsed.category} to ${params.to}`,
      pages: [`${params.to}/${parsed.slug}`],
    });

    return {
      content: [
        {
          type: "text",
          text: `Moved "${page.frontmatter.title}" from ${parsed.category}/ to ${params.to}/`,
        },
      ],
      details: {
        from: `${parsed.category}/${parsed.slug}`,
        to: `${params.to}/${parsed.slug}`,
      },
    };
  };
}

// -- Factory: wiki_lint execute ----------------------------------------------

function createLintExecute(wikiDir: string) {
  return async (
    params: { autoFix?: boolean },
  ): Promise<AgentToolResult<WikiLintDetails>> => {
    const report = await lintWiki(wikiDir, {
      autoFix: params.autoFix ?? true,
    });

    const { issues, fixed, stats } = report;

    // Format report for the LLM
    const parts: string[] = [];

    parts.push("## Wiki Lint Report\n");
    parts.push(`Total pages: ${stats.totalPages}`);
    parts.push(
      `By category: ${PARA_CATEGORIES.map((c) => `${c}: ${stats.byCategory[c]}`).join(", ")}`,
    );
    parts.push(`Total links: ${stats.totalLinks} (broken: ${stats.brokenLinks})`);
    parts.push(`Orphan pages: ${stats.orphanPages}`);
    if (stats.oldestPage) parts.push(`Oldest page: ${stats.oldestPage}`);
    if (stats.newestPage) parts.push(`Newest page: ${stats.newestPage}`);
    if (stats.lastIngest) parts.push(`Last ingest: ${stats.lastIngest}`);

    if (fixed.length > 0) {
      parts.push(`\n## Auto-fixed (${fixed.length})\n`);
      for (const f of fixed) {
        parts.push(`- [${f.severity}] ${f.page ?? ""}: ${f.message}`);
      }
    }

    if (issues.length > 0) {
      parts.push(`\n## Remaining Issues (${issues.length})\n`);
      for (const issue of issues) {
        parts.push(
          `- [${issue.severity}] ${issue.category}${issue.page ? ` (${issue.page})` : ""}: ${issue.message}`,
        );
      }
      parts.push("");
      parts.push(LINT_PROMPT);
    } else {
      parts.push("\nNo remaining issues. Wiki is healthy.");
    }

    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: {
        issueCount: issues.length,
        fixedCount: fixed.length,
        stats,
      },
    };
  };
}

// -- Factory: wiki_summarize execute -----------------------------------------

function createSummarizeExecute(
  wikiDir: string,
  getScope: () => ProjectScope,
) {
  return async (
    params: { target: string; depth?: "brief" | "detailed" },
  ): Promise<AgentToolResult<WikiSummarizeDetails>> => {
    const scope = getScope();
    const pages: WikiPage[] = [];

    if (params.target === "all") {
      // Summarize entire wiki
      const refs = await listPages(wikiDir);
      for (const ref of refs) {
        const page = await readPage(wikiDir, ref.category, ref.slug);
        if (page) pages.push(page);
      }
    } else if (PARA_CATEGORIES.includes(params.target as ParaCategory)) {
      // Summarize a category
      const refs = await listPages(wikiDir, params.target as ParaCategory);
      for (const ref of refs) {
        const page = await readPage(wikiDir, ref.category, ref.slug);
        if (page) pages.push(page);
      }
    } else {
      // Summarize a single page
      const parsed = parsePagePath(params.target);
      if (parsed) {
        const page = await readPage(wikiDir, parsed.category, parsed.slug);
        if (page) pages.push(page);
      } else {
        // Try finding by slug alone across categories
        const allPages = await listPages(wikiDir);
        const targetLower = params.target.toLowerCase();
        for (const ref of allPages) {
          if (ref.slug === targetLower || ref.title.toLowerCase() === targetLower) {
            const page = await readPage(wikiDir, ref.category, ref.slug);
            if (page) pages.push(page);
            break;
          }
        }
      }
    }

    if (pages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No pages found for target "${params.target}". Nothing to summarize.`,
          },
        ],
        details: { target: params.target, pageCount: 0 },
      };
    }

    // Generate overview prompt for the LLM
    const overviewPrompt = generateOverviewPrompt(pages, scope);
    const depthNote =
      params.depth === "detailed"
        ? "\nProvide a DETAILED summary with full Key Facts, Insights, and Connections for each theme."
        : "\nProvide a BRIEF overview — one paragraph per theme, focus on high-level patterns.";

    return {
      content: [
        {
          type: "text",
          text: overviewPrompt + depthNote +
            "\n\nYou may optionally create a summary page via wiki_write if the overview is worth preserving.",
        },
      ],
      details: {
        target: params.target,
        pageCount: pages.length,
      },
    };
  };
}

// -- Wikilink extraction helper ----------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** Extract all [[wikilink]] targets from markdown body. */
function extractWikilinks(body: string): string[] {
  const links: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((m = re.exec(body)) !== null) {
    links.push(m[1].trim());
  }
  return [...new Set(links)];
}

// -- Public API: register tools for pi session -------------------------------

/**
 * Register all wiki tools with the pi extension API.
 *
 * Tools: wiki_ingest, wiki_query, wiki_write, wiki_read,
 *        wiki_move, wiki_lint, wiki_summarize
 */
export function registerTools(
  pi: ExtensionAPI,
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  markDirty: () => void,
): void {
  const ingestExec = createIngestExecute(wikiDir, store, getScope);
  const queryExec = createQueryExecute(wikiDir, store, getScope);
  const writeExec = createWriteExecute(wikiDir, store, getScope, markDirty);
  const readExec = createReadExecute(wikiDir);
  const moveExec = createMoveExecute(wikiDir, store, markDirty);
  const lintExec = createLintExecute(wikiDir);
  const summarizeExec = createSummarizeExecute(wikiDir, getScope);

  // -- wiki_ingest --
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description:
      "Ingest a source (URL, file path, or raw text) into the wiki. " +
      "Fetches the content, saves a raw copy, and returns it with schema and index " +
      "so you can synthesize wiki pages via wiki_write.",
    promptSnippet: "Ingest a URL, file, or text into the PARA wiki knowledge base",
    promptGuidelines: [
      "Use wiki_ingest when the user provides a URL, file path, or text to add to the knowledge base.",
    ],
    parameters: WikiIngestParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return ingestExec(params);
    },
    renderCall(args, theme) {
      const srcType = args.sourceType ?? detectSourceType(args.source);
      const src =
        args.source.length > 60
          ? args.source.slice(0, 57) + "..."
          : args.source;
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_ingest ")) +
          theme.fg("muted", `[${srcType}] `) +
          theme.fg("dim", src),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiIngestDetails | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text.slice(0, 80) : "", 0, 0);
      }
      const parts = [
        theme.fg("success", "Fetched ") +
          theme.fg("muted", `${details.sourceType} (${formatBytes(details.sourceLength)})`),
      ];
      if (details.rawPath) {
        parts.push(theme.fg("dim", `Saved: ${details.rawPath}`));
      }
      return new Text(parts.join("\n"), 0, 0);
    },
  });

  // -- wiki_query --
  pi.registerTool({
    name: "wiki_query",
    label: "Wiki Query",
    description:
      "Search the wiki knowledge base with a natural language query. " +
      "Returns relevant pages with content snippets. " +
      "Use global=true to search across all project scopes.",
    promptSnippet: "Search the PARA wiki for relevant knowledge pages",
    promptGuidelines: [
      "Use wiki_query BEFORE answering questions that might have relevant context in the wiki — architecture decisions, past debugging solutions, project conventions, or domain knowledge.",
      "Use wiki_query when the user asks about something you previously discussed or captured in the wiki.",
    ],
    parameters: WikiQueryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return queryExec(params);
    },
    renderCall(args, theme) {
      const q =
        args.query.length > 50 ? args.query.slice(0, 47) + "..." : args.query;
      let text =
        theme.fg("toolTitle", theme.bold("wiki_query ")) +
        theme.fg("dim", `"${q}"`);
      if (args.global) text += theme.fg("muted", " (global)");
      if (args.category) text += theme.fg("muted", ` [${args.category}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiQueryDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "No results"), 0, 0);
      }
      return new Text(
        theme.fg("success", `${details.resultCount} result(s)`) +
          theme.fg("dim", ` scope: ${details.scopeUsed}`),
        0,
        0,
      );
    },
  });

  // -- wiki_write --
  pi.registerTool({
    name: "wiki_write",
    label: "Wiki Write",
    description:
      "Write or update wiki pages. Supports create, replace, and append modes. " +
      "Optionally update index.md and append to log.md. " +
      "Pages are automatically re-indexed for search after writing.",
    promptSnippet: "Write/update PARA wiki pages with frontmatter and markdown body",
    promptGuidelines: [
      "Use wiki_write after wiki_ingest to create/update pages based on the ingested content.",
      "Use wiki_write to save valuable answers or synthesis back into the wiki when they add new knowledge.",
    ],
    parameters: WikiWriteParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return writeExec(params);
    },
    renderCall(args, theme) {
      const count = args.pages?.length ?? 0;
      const slugs = (args.pages ?? [])
        .slice(0, 3)
        .map((p: { slug: string }) => p.slug)
        .join(", ");
      let text =
        theme.fg("toolTitle", theme.bold("wiki_write ")) +
        theme.fg("muted", `${count} page(s)`);
      if (slugs) text += theme.fg("dim", ` [${slugs}]`);
      if (args.indexContent) text += theme.fg("muted", " +index");
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiWriteDetails | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      const parts: string[] = [];
      if (details.pagesWritten.length > 0) {
        parts.push(
          theme.fg("success", `Wrote ${details.pagesWritten.length} page(s): `) +
            theme.fg("muted", details.pagesWritten.join(", ")),
        );
      }
      if (details.indexUpdated) parts.push(theme.fg("dim", "Updated index.md"));
      if (details.logAppended) parts.push(theme.fg("dim", "Logged operation"));
      return new Text(parts.join("\n") || theme.fg("dim", "No changes"), 0, 0);
    },
  });

  // -- wiki_read --
  pi.registerTool({
    name: "wiki_read",
    label: "Wiki Read",
    description:
      "Read a specific wiki page by path (e.g. 'projects/auth-refactor') " +
      "or by title. Returns the full page content with frontmatter metadata.",
    promptSnippet: "Read a wiki page by path or title",
    parameters: WikiReadParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return readExec(params);
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_read ")) +
          theme.fg("dim", args.path),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiReadDetails | undefined;
      if (!details || !details.found) {
        return new Text(theme.fg("error", "Page not found"), 0, 0);
      }
      return new Text(
        theme.fg("success", "Found ") + theme.fg("muted", details.path ?? ""),
        0,
        0,
      );
    },
  });

  // -- wiki_move --
  pi.registerTool({
    name: "wiki_move",
    label: "Wiki Move",
    description:
      "Move a wiki page between PARA categories (e.g. move a completed project to archives). " +
      "Updates frontmatter and re-indexes.",
    promptSnippet: "Move a wiki page between PARA categories",
    parameters: WikiMoveParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return moveExec(params);
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_move ")) +
          theme.fg("dim", `${args.path} -> ${args.to}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiMoveDetails | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      return new Text(
        theme.fg("success", "Moved ") +
          theme.fg("muted", `${details.from} -> ${details.to}`),
        0,
        0,
      );
    },
  });

  // -- wiki_lint --
  pi.registerTool({
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Run wiki health checks: orphan pages, broken links, stale pages, " +
      "scope drift, archive candidates, missing pages, frontmatter issues, " +
      "index drift, and duplicate slugs. Auto-fixes simple issues by default.",
    promptSnippet: "Run wiki health checks and auto-fix issues",
    parameters: WikiLintParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return lintExec(params);
    },
    renderCall(args, theme) {
      const mode = args.autoFix === false ? "report-only" : "auto-fix";
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_lint ")) +
          theme.fg("muted", `[${mode}]`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiLintDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "Lint complete"), 0, 0);
      }
      const parts = [
        theme.fg("muted", `${details.stats.totalPages} pages`),
      ];
      if (details.fixedCount > 0) {
        parts.push(theme.fg("success", `${details.fixedCount} fixed`));
      }
      if (details.issueCount > 0) {
        parts.push(theme.fg("warning", `${details.issueCount} remaining`));
      } else {
        parts.push(theme.fg("success", "healthy"));
      }
      return new Text(parts.join(" | "), 0, 0);
    },
  });

  // -- wiki_summarize --
  pi.registerTool({
    name: "wiki_summarize",
    label: "Wiki Summarize",
    description:
      "Summarize a page, category, or the entire wiki. " +
      "Target can be a page path (e.g. 'projects/auth-refactor'), " +
      "a category name (e.g. 'projects'), or 'all'. " +
      "Returns content with a summary prompt for you to synthesize.",
    promptSnippet: "Summarize wiki pages, categories, or the entire wiki",
    parameters: WikiSummarizeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return summarizeExec(params);
    },
    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("wiki_summarize ")) +
        theme.fg("dim", args.target);
      if (args.depth) text += theme.fg("muted", ` [${args.depth}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiSummarizeDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "Summary generated"), 0, 0);
      }
      if (details.pageCount === 0) {
        return new Text(theme.fg("warning", "No pages found"), 0, 0);
      }
      return new Text(
        theme.fg("success", `Summarizing ${details.pageCount} page(s)`) +
          theme.fg("dim", ` target: ${details.target}`),
        0,
        0,
      );
    },
  });
}

// -- Public API: standalone tools for mini-agent -----------------------------

/**
 * Create standalone AgentTool instances for the mini-agent (capture/lint/summarize).
 * Returns only the tools needed for autonomous wiki operations:
 * wiki_write, wiki_read, wiki_query, wiki_move.
 */
export function createStandaloneTools(
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  markDirty?: () => void,
): AgentTool[] {
  const noopDirty = markDirty ?? (() => {});
  const writeExec = createWriteExecute(wikiDir, store, getScope, noopDirty);
  const readExec = createReadExecute(wikiDir);
  const queryExec = createQueryExecute(wikiDir, store, getScope);
  const moveExec = createMoveExecute(wikiDir, store, noopDirty);

  const wikiWrite: AgentTool<typeof WikiWriteParams> = {
    name: "wiki_write",
    label: "Wiki Write",
    description:
      "Write or update wiki pages. Supports create, replace, and append modes. " +
      "Optionally update index.md and append to log.md.",
    parameters: WikiWriteParams,
    execute: (_toolCallId, params) => writeExec(params),
  };

  const wikiRead: AgentTool<typeof WikiReadParams> = {
    name: "wiki_read",
    label: "Wiki Read",
    description:
      "Read a specific wiki page by path (e.g. 'projects/auth-refactor') or by title.",
    parameters: WikiReadParams,
    execute: (_toolCallId, params) => readExec(params),
  };

  const wikiQuery: AgentTool<typeof WikiQueryParams> = {
    name: "wiki_query",
    label: "Wiki Query",
    description:
      "Search the wiki knowledge base with a natural language query. Returns relevant pages.",
    parameters: WikiQueryParams,
    execute: (_toolCallId, params) => queryExec(params),
  };

  const wikiMove: AgentTool<typeof WikiMoveParams> = {
    name: "wiki_move",
    label: "Wiki Move",
    description: "Move a wiki page between PARA categories.",
    parameters: WikiMoveParams,
    execute: (_toolCallId, params) => moveExec(params),
  };

  return [wikiWrite, wikiRead, wikiQuery, wikiMove];
}

// -- Utilities ---------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
