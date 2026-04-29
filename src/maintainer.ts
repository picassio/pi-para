/**
 * Wiki maintenance agent — uses LLM to intelligently maintain the wiki.
 *
 * Replaces brittle code-based maintenance (link discovery, dedup detection,
 * tag canonicalization, category review) with an LLM agent that understands
 * content and can make smarter decisions.
 *
 * Deterministic operations (secret redaction, schema validation, index rebuild)
 * stay in code. This agent handles everything that needs intelligence.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { QMDStore } from "@picassio/qmd";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import {
  readPage,
  writePage,
  listPages,
  writeIndex,
  gitCommit,
  PARA_CATEGORIES,
} from "./wiki.js";
import type { WikiPage, ParaCategory, PageRef } from "./wiki.js";
import { validateFrontmatter } from "./frontmatter.js";
import { searchWiki, reindex } from "./store.js";
import { extractWikilinks, syncFrontmatterLinks } from "./link-utils.js";
import { normalizeTags, normalizeScopes } from "./tag-registry.js";
import { redactSecrets } from "./redact.js";
import { lintWiki } from "./lint.js";

// -- Types -------------------------------------------------------------------

export interface MaintenanceResult {
  pagesUpdated: number;
  pagesMerged: number;
  linksAdded: number;
  issuesFixed: number;
  summary: string;
}

// -- Maintenance prompt ------------------------------------------------------

const MAINTENANCE_SYSTEM_PROMPT = `You are a wiki maintenance agent. Your job is to keep a PARA knowledge base healthy, well-linked, and free of duplicates.

You have tools to inspect and modify the wiki:
- wiki_list: List all pages with their scope, tags, and link counts
- wiki_read: Read a page's full content
- wiki_query: Search for pages by keyword
- wiki_write: Update a page (merge content, add links, fix category)
- wiki_merge: Merge two pages into one (keeps the target, deletes the source)
- wiki_lint: Run automated checks and get a report of issues

Your maintenance tasks (in priority order):

1. DUPLICATE DETECTION & MERGING
   - Find pages covering the same topic with different slugs
   - Merge them: combine content into the older/more complete page, delete the duplicate
   - Examples: "pi-para daemon architecture" and "pi-para daemon" are duplicates

2. WIKILINK DISCOVERY
   - Find pages that discuss related topics but aren't linked
   - Add [[wikilinks]] in body text and ## Connections sections
   - Every page should link to at least 2 related pages

3. CATEGORY REVIEW
   - resources/ should have reference docs, architecture, how-tos, patterns
   - areas/ should have ongoing responsibilities only
   - projects/ should ONLY have actual goals with end dates (almost never used)
   - Move miscategorized pages

4. TAG CLEANUP
   - Remove redundant tags (tags that duplicate scope values)
   - Canonicalize similar tags (e.g. "capture" and "session-capture" → keep "session-capture")
   - Ensure tags are kebab-case

5. CONTENT QUALITY
   - Pages should have: Topic, Key Facts, Connections sections at minimum
   - Flag pages with very thin content for expansion
   - Flag pages with no ## Connections section

6. STALENESS REVIEW
   - Identify pages not updated in >30 days that make specific claims about code, file paths, configs, ports, or API endpoints
   - These are high-risk for being outdated — add a note in Open Questions: "⚠️ This page has not been updated since [date]. Claims about [specific thing] should be verified."
   - If you can determine from other pages or context that a claim is now wrong, fix it directly
   - Pages about architecture decisions or historical events are less likely to go stale than pages about configs or deployment

Rules:
- Work systematically: list all pages first, then process in batches
- For merges: preserve ALL information from both pages, combine into the better-structured one
- For links: only add links between genuinely related pages, not random connections
- Be conservative: when unsure, leave it alone
- Never include secrets/API keys in page content
- Scope must be a kebab-case project name, not a topic description

When done, summarize what you changed.`;

// -- Tools -------------------------------------------------------------------

function createMaintenanceTools(wikiDir: string, store: QMDStore): AgentTool[] {
  const WikiListParams = Type.Object({});
  const WikiReadParams = Type.Object({ path: Type.String({ description: "category/slug" }) });
  const WikiQueryParams = Type.Object({ query: Type.String() });
  const WikiWriteParams = Type.Object({
    category: StringEnum(["projects", "areas", "resources", "archives"] as const),
    slug: Type.String(),
    title: Type.String(),
    scope: Type.Array(Type.String()),
    tags: Type.Array(Type.String()),
    body: Type.String(),
  });
  const WikiMergeParams = Type.Object({
    keepCategory: StringEnum(["projects", "areas", "resources", "archives"] as const),
    keepSlug: Type.String({ description: "Slug of the page to keep (target)" }),
    deleteCategory: StringEnum(["projects", "areas", "resources", "archives"] as const),
    deleteSlug: Type.String({ description: "Slug of the page to delete (source)" }),
    mergedBody: Type.String({ description: "Combined body text for the kept page" }),
  });
  const WikiLintParams = Type.Object({});

  const wikiList: AgentTool<typeof WikiListParams> = {
    name: "wiki_list",
    label: "Wiki List",
    description: "List all wiki pages with scope, tags, and outgoing link count.",
    parameters: WikiListParams,
    execute: async () => {
      const refs = await listPages(wikiDir);
      const lines: string[] = [];
      for (const ref of refs) {
        const page = await readPage(wikiDir, ref.category, ref.slug);
        if (!page) continue;
        const linkCount = extractWikilinks(page.body).length;
        lines.push(
          `${ref.category}/${ref.slug} | "${page.frontmatter.title}" | scope:[${page.frontmatter.scope.join(",")}] | tags:[${page.frontmatter.tags.join(",")}] | links:${linkCount}`
        );
      }
      return {
        content: [{ type: "text", text: `${lines.length} pages:\n${lines.join("\n")}` }],
        details: { count: lines.length },
      };
    },
  };

  const wikiRead: AgentTool<typeof WikiReadParams> = {
    name: "wiki_read",
    label: "Wiki Read",
    description: "Read a wiki page by path (category/slug).",
    parameters: WikiReadParams,
    execute: async (_id, params: { path: string }) => {
      const parts = params.path.split("/");
      if (parts.length !== 2) {
        return { content: [{ type: "text", text: `Invalid path: ${params.path}` }], details: {} };
      }
      const page = await readPage(wikiDir, parts[0] as ParaCategory, parts[1]);
      if (!page) {
        return { content: [{ type: "text", text: `Not found: ${params.path}` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `# ${page.frontmatter.title}\nCategory: ${page.category}\nScope: ${page.frontmatter.scope.join(", ")}\nTags: ${page.frontmatter.tags.join(", ")}\nLinks: ${page.frontmatter.links.join(", ") || "none"}\n\n${page.body}` }],
        details: { title: page.frontmatter.title },
      };
    },
  };

  const wikiQuery: AgentTool<typeof WikiQueryParams> = {
    name: "wiki_query",
    label: "Wiki Query",
    description: "Search wiki pages by keyword. Returns top matches with scores.",
    parameters: WikiQueryParams,
    execute: async (_id, params: { query: string }) => {
      const results = await searchWiki(store, params.query, { limit: 8 });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results." }], details: { count: 0 } };
      }
      const text = results
        .map(r => `${r.page.path} | "${r.frontmatter.title}" | score:${r.score.toFixed(3)}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `${results.length} results:\n${text}` }],
        details: { count: results.length },
      };
    },
  };

  const wikiWrite: AgentTool<typeof WikiWriteParams> = {
    name: "wiki_write",
    label: "Wiki Write",
    description: "Create or update a wiki page. Always redacts secrets and normalizes tags/scope.",
    parameters: WikiWriteParams,
    execute: async (_id, params: { category: ParaCategory; slug: string; title: string; scope: string[]; tags: string[]; body: string }) => {
      const now = new Date().toISOString();
      const slug = params.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const existing = await readPage(wikiDir, params.category, slug);
      const body = redactSecrets(params.body).text;
      const scope = normalizeScopes(params.scope);
      const tags = normalizeTags(params.tags, scope);
      const links = syncFrontmatterLinks(body);

      if (existing) {
        const updated: WikiPage = {
          ...existing,
          body,
          frontmatter: { ...existing.frontmatter, title: params.title, scope, tags, updated: now, links },
        };
        await writePage(wikiDir, updated);
      } else {
        const fm = validateFrontmatter({ title: params.title, para: params.category, scope, tags, sources: [], created: now, updated: now, links });
        await writePage(wikiDir, { category: params.category, slug, frontmatter: fm, body });
      }
      await reindex(store);
      return {
        content: [{ type: "text", text: `Wrote ${params.category}/${slug}` }],
        details: { path: `${params.category}/${slug}` },
      };
    },
  };

  const wikiMerge: AgentTool<typeof WikiMergeParams> = {
    name: "wiki_merge",
    label: "Wiki Merge",
    description: "Merge two pages: update the target page with combined content, delete the source page.",
    parameters: WikiMergeParams,
    execute: async (_id, params: { keepCategory: ParaCategory; keepSlug: string; deleteCategory: ParaCategory; deleteSlug: string; mergedBody: string }) => {
      const keepPage = await readPage(wikiDir, params.keepCategory, params.keepSlug);
      const deletePage = await readPage(wikiDir, params.deleteCategory, params.deleteSlug);
      if (!keepPage) return { content: [{ type: "text", text: `Target not found: ${params.keepCategory}/${params.keepSlug}` }], details: {} };
      if (!deletePage) return { content: [{ type: "text", text: `Source not found: ${params.deleteCategory}/${params.deleteSlug}` }], details: {} };

      const now = new Date().toISOString();
      const body = redactSecrets(params.mergedBody).text;
      const mergedScope = normalizeScopes([...new Set([...keepPage.frontmatter.scope, ...deletePage.frontmatter.scope])]);
      const mergedTags = normalizeTags([...new Set([...keepPage.frontmatter.tags, ...deletePage.frontmatter.tags])], mergedScope);

      // Update target
      const updated: WikiPage = {
        ...keepPage,
        body,
        frontmatter: {
          ...keepPage.frontmatter,
          scope: mergedScope,
          tags: mergedTags,
          updated: now,
          links: syncFrontmatterLinks(body),
        },
      };
      await writePage(wikiDir, updated);

      // Delete source
      const { unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await unlink(join(wikiDir, params.deleteCategory, params.deleteSlug + ".md"));

      await reindex(store);
      return {
        content: [{ type: "text", text: `Merged ${params.deleteCategory}/${params.deleteSlug} into ${params.keepCategory}/${params.keepSlug}, deleted source.` }],
        details: { kept: `${params.keepCategory}/${params.keepSlug}`, deleted: `${params.deleteCategory}/${params.deleteSlug}` },
      };
    },
  };

  const wikiLint: AgentTool<typeof WikiLintParams> = {
    name: "wiki_lint",
    label: "Wiki Lint",
    description: "Run lint checks and return a report. Does NOT auto-fix — you decide what to fix.",
    parameters: WikiLintParams,
    execute: async () => {
      const report = await lintWiki(wikiDir, { autoFix: false });
      const lines = report.issues.map(i => `[${i.severity}] ${i.category}: ${i.page ?? ""} — ${i.message}`);
      return {
        content: [{ type: "text", text: `${report.issues.length} issues:\n${lines.join("\n")}\n\nStats: ${JSON.stringify(report.stats.byCategory)}` }],
        details: { issueCount: report.issues.length },
      };
    },
  };

  return [wikiList, wikiRead, wikiQuery, wikiWrite, wikiMerge, wikiLint];
}

// -- Rebuild index helper (shared with processor) ----------------------------

async function rebuildIndex(wikiDir: string): Promise<void> {
  const allPages = await listPages(wikiDir);
  const sections: Record<ParaCategory, string[]> = {
    projects: [], areas: [], resources: [], archives: [],
  };
  for (const ref of allPages) {
    const page = await readPage(wikiDir, ref.category, ref.slug);
    const title = page?.frontmatter.title ?? ref.title;
    const summary = page?.body.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---"))?.trim() ?? "";
    const desc = summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
    sections[ref.category].push(`- [[${ref.slug}]] — ${title}${desc ? ": " + desc : ""}`);
  }
  const indexLines = [
    "# Wiki Index", "",
    "## Projects", "", sections.projects.length > 0 ? sections.projects.join("\n") : "_No active projects._", "",
    "## Areas", "", sections.areas.length > 0 ? sections.areas.join("\n") : "_No areas._", "",
    "## Resources", "", sections.resources.length > 0 ? sections.resources.join("\n") : "_No resources._", "",
    "## Archives", "", sections.archives.length > 0 ? sections.archives.join("\n") : "_No archived items._",
  ];
  await writeIndex(wikiDir, indexLines.join("\n"));
}

// -- Main entry point --------------------------------------------------------

/**
 * Run the maintenance agent. Called periodically by the daemon.
 */
export async function runMaintenance(
  wikiDir: string,
  store: QMDStore,
  model: Model<any>,
  getApiKey: (provider: string) => Promise<string | undefined>,
): Promise<MaintenanceResult> {
  const tools = createMaintenanceTools(wikiDir, store);

  const agent = new Agent({
    initialState: {
      systemPrompt: MAINTENANCE_SYSTEM_PROMPT,
      model,
      tools,
      messages: [],
    },
    getApiKey,
  });

  const prompt = `Run a maintenance pass on the wiki. Start by listing all pages, then:
1. Look for duplicate pages (same topic, different slugs) and merge them
2. Find pages with 0 outgoing links and add relevant [[wikilinks]]
3. Check for any category misuse or tag issues
4. Review pages not updated in >30 days for staleness — add Open Questions warnings for pages making specific claims about code/configs/ports that may have changed
Be thorough but conservative. Summarize what you changed at the end.`;

  try {
    await agent.prompt(prompt);
  } catch (err) {
    return {
      pagesUpdated: 0,
      pagesMerged: 0,
      linksAdded: 0,
      issuesFixed: 0,
      summary: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Rebuild index after all changes
  await rebuildIndex(wikiDir);

  // Extract summary from agent's last message
  const messages = agent.state.messages;
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  let summary = "Maintenance completed.";
  if (lastAssistant && "content" in lastAssistant) {
    const content = lastAssistant.content;
    if (typeof content === "string") summary = content;
    else if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b.type === "text" && typeof b.text === "string") as { text: string } | undefined;
      if (textBlock) summary = textBlock.text;
    }
  }

  // Count changes from tool results
  let pagesUpdated = 0;
  let pagesMerged = 0;
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const c = msg.content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      const b = block as unknown as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.startsWith("Wrote ")) pagesUpdated++;
        if (b.text.startsWith("Merged ")) pagesMerged++;
      }
    }
  }

  // Git commit all maintenance changes
  if (pagesUpdated > 0 || pagesMerged > 0) {
    await gitCommit(wikiDir, `maintenance: ${pagesUpdated} updated, ${pagesMerged} merged`);
  }

  return {
    pagesUpdated,
    pagesMerged,
    linksAdded: 0, // Agent handles this via wiki_write
    issuesFixed: pagesUpdated + pagesMerged,
    summary,
  };
}
