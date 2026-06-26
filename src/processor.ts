/**
 * Session processor — uses Agent with session exploration tools
 * to extract knowledge and write wiki pages.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { QMDStore } from "qmd-engine";

import {
  readPage,
  writePage,
  listPages,
  writeIndex,
  appendLog,
  gitCommit,
  PARA_CATEGORIES,
} from "./wiki.js";
import type { WikiPage, ParaCategory, PageRef } from "./wiki.js";
import { validateFrontmatter } from "./frontmatter.js";
import { extractWikilinks, autoLinkSlugs, syncFrontmatterLinks } from "./link-utils.js";
import { normalizeTags, normalizeScopes } from "./tag-registry.js";
import { redactSecrets } from "./redact.js";
import { reindex, searchWiki } from "./store.js";
import { appendSessionDigest } from "./raw.js";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { loadSession, createSessionTools } from "./session-tools.js";
import type { LoadedSession } from "./session-tools.js";

// -- Types -------------------------------------------------------------------

export interface ProcessResult {
  pagesCreated: string[];
  pagesUpdated: string[];
  skipped: boolean;
  reason?: string;
}

// -- Wiki tools for the Agent ------------------------------------------------

const WikiWriteParams = Type.Object({
  category: StringEnum(["projects", "areas", "resources", "archives"] as const),
  slug: Type.String(),
  title: Type.String(),
  scope: Type.Array(Type.String()),
  tags: Type.Array(Type.String()),
  body: Type.String(),
});
type WikiWriteInput = { category: ParaCategory; slug: string; title: string; scope: string[]; tags: string[]; body: string };

const WikiQueryParams = Type.Object({ query: Type.String() });
const WikiReadParams = Type.Object({ path: Type.String({ description: "category/slug" }) });

function createWikiTools(wikiDir: string, store: QMDStore): AgentTool[] {

  const wikiWrite: AgentTool<typeof WikiWriteParams> = {
    name: "wiki_write",
    label: "Wiki Write",
    description: "Create or update a wiki page with PARA frontmatter.",
    parameters: WikiWriteParams,
    execute: async (_id, params: WikiWriteInput) => {
      const now = new Date().toISOString();
      const slug = params.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const existing = await readPage(wikiDir, params.category, slug);

      // Gather all existing slugs for auto-linking
      const allRefs = await listPages(wikiDir);
      const allSlugs = new Set(allRefs.map(r => r.slug));
      allSlugs.add(slug);

      // Auto-link slug mentions in body text, redact any secrets
      const linkedBody = redactSecrets(autoLinkSlugs(params.body, allSlugs, slug)).text;

      if (existing) {
        // Update existing page (exact slug match)
        const rawScope = params.scope.length > 0 ? params.scope : existing.frontmatter.scope;
        const newScope = normalizeScopes(rawScope);
        const mergedTags = [...new Set([...existing.frontmatter.tags, ...params.tags])];
        const updated: WikiPage = {
          ...existing,
          body: linkedBody,
          frontmatter: {
            ...existing.frontmatter,
            title: params.title,
            scope: newScope,
            tags: normalizeTags(mergedTags, newScope),
            updated: now,
            links: syncFrontmatterLinks(linkedBody),
          },
        };
        await writePage(wikiDir, updated);
      } else {
        // Create new page
        const newScope = normalizeScopes(params.scope);
        const fm = validateFrontmatter({
          title: params.title,
          para: params.category,
          scope: newScope,
          tags: normalizeTags(params.tags, newScope),
          sources: [],
          created: now,
          updated: now,
          links: syncFrontmatterLinks(linkedBody),
        });
        await writePage(wikiDir, { category: params.category, slug, frontmatter: fm, body: linkedBody });
      }

      await reindex(store);
      await rebuildIndex(wikiDir);
      await gitCommit(wikiDir, `capture: ${params.category}/${slug}`);

      return {
        content: [{ type: "text", text: `Wrote ${params.category}/${slug}` }],
        details: { path: `${params.category}/${slug}`, existed: !!existing },
      };
    },
  };

  const wikiQuery: AgentTool<typeof WikiQueryParams> = {
    name: "wiki_query",
    label: "Wiki Query",
    description: "Search the wiki for existing pages (for deduplication).",
    parameters: WikiQueryParams,
    execute: async (_id, params: { query: string }) => {
      const results = await searchWiki(store, params.query, { limit: 5 });
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching wiki pages found." }],
          details: { count: 0 },
        };
      }
      const text = results
        .map((r: { page: PageRef; frontmatter: { title: string }; score: number }) =>
          `${r.page.path}: ${r.frontmatter.title} (score: ${r.score.toFixed(3)})`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text: `Found ${results.length} pages:\n${text}` }],
        details: { count: results.length },
      };
    },
  };

  const wikiRead: AgentTool<typeof WikiReadParams> = {
    name: "wiki_read",
    label: "Wiki Read",
    description: "Read an existing wiki page by path (category/slug).",
    parameters: WikiReadParams,
    execute: async (_id, params: { path: string }) => {
      const parts = params.path.split("/");
      if (parts.length !== 2) {
        return {
          content: [{ type: "text", text: `Invalid path: ${params.path}` }],
          details: {},
        };
      }
      const [cat, slug] = parts;
      const page = await readPage(wikiDir, cat as ParaCategory, slug);
      if (!page) {
        return {
          content: [{ type: "text", text: `Page not found: ${params.path}` }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `# ${page.frontmatter.title}\n\n${page.body}` }],
        details: { title: page.frontmatter.title },
      };
    },
  };

  return [wikiWrite, wikiQuery, wikiRead];
}

// -- Helpers -----------------------------------------------------------------

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
    sections[ref.category].push(`- [[${ref.slug}]] \u2014 ${title}${desc ? ": " + desc : ""}`);
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

// -- System prompt -----------------------------------------------------------

const CAPTURE_SYSTEM_PROMPT = `You are a knowledge capture agent. You explore coding session transcripts and extract valuable knowledge into a PARA-structured wiki.

You have tools to explore the session:
- session_stats: Get an overview of the session (message count, topics)
- session_search: Search for keywords in the session
- session_slice: Read a specific character range of the session

And tools to write to the wiki:
- wiki_query: Search existing wiki pages (check for duplicates first!)
- wiki_read: Read an existing page
- wiki_write: Create or update a wiki page

PARA category rules (IMPORTANT):
- **resources/**: Use for almost everything — architecture docs, how-tos, debugging solutions, configs, patterns, reference material. This is the default.
- **areas/**: Only for ongoing responsibilities with no end date (e.g. server config, deployment procedures).
- **projects/**: ONLY for actual project goals with a defined end date. Do NOT use for documentation about a project's internals. A page like "pi-para-daemon" is a resource about pi-para, not a project.
- **archives/**: Never create pages here — pages get moved here when completed.

Scope rules:
- scope must be a project name in kebab-case (e.g. "pi-para", "qmd", "pi-mono")
- Do NOT put topic descriptions in scope (wrong: "session exploration", right: "pi-para")

Security rules:
- NEVER include API keys, tokens, passwords, or secrets in wiki pages
- Document WHERE the secret is stored (e.g. "API key in ~/.config/qmd/index.yml"), not the value itself

Your workflow:
1. Call session_stats to understand the session
2. For each topic, call wiki_query FIRST to find existing pages on that topic
3. Call session_search or session_slice to read the relevant discussion
4. If wiki_query found a matching page, call wiki_read to get its content, then wiki_write to UPDATE it (use the same slug)
5. Only create a NEW page if wiki_query returned no relevant results

CRITICAL: ALWAYS prefer updating existing pages over creating new ones. The wiki already has many pages — search before writing. If you find a page covering the same topic (even with a different title), update it by using its exact slug.

Capture ANY of these — even small facts:
- Architecture decisions and rationale
- Debugging solutions (root cause + fix)
- Server/infrastructure details (IPs, paths, configs)
- Build and deployment procedures
- Tool configurations and setup steps
- Package names and versions
- Project conventions and coding patterns
- Operational knowledge (how to restart, deploy, rollback)

Each wiki page must use this format:
## Topic
[What this covers]

## Key Facts
- [Fact 1]
- [Fact 2]

## Insights
- [Non-obvious finding]

## Sources
- [Session file path]

When done, respond with a summary of what you captured.`;

// -- Main processor ----------------------------------------------------------

export async function processSession(
  sessionPath: string,
  wikiDir: string,
  store: QMDStore,
  scope: string,
  model: Model<any>,
  getApiKey: (provider: string) => Promise<string | undefined>,
): Promise<ProcessResult> {
  // 1. Load session
  const session = loadSession(sessionPath);

  // 2. Quick check: worth processing?
  const { stats } = session;
  const hasToolCalls = stats.toolCalls > 0;
  if (!hasToolCalls && (stats.totalMessages < 4 || stats.totalChars < 200)) {
    return { pagesCreated: [], pagesUpdated: [], skipped: true, reason: "trivial session" };
  }

  // 3. Create tools
  const sessionTools = createSessionTools(session);
  const wikiTools = createWikiTools(wikiDir, store);
  const allTools = [...sessionTools, ...wikiTools];

  // 4. Spin up Agent with context pruning for long-running exploration.
  // After many tool calls, the accumulated context can exceed the LLM's
  // context window. Prune old session_slice/session_search results — the
  // Agent already extracted what it needed from them.
  // Use 75% of the model's context window (chars ≈ tokens * 4), leave headroom.
  const contextWindowChars = (model.contextWindow ?? 128_000) * 4;
  const MAX_CONTEXT_CHARS = Math.floor(contextWindowChars * 0.75);

  const agent = new Agent({
    initialState: {
      systemPrompt: CAPTURE_SYSTEM_PROMPT,
      model,
      tools: allTools,
      messages: [],
    },
    getApiKey,
    transformContext: async (messages) => {
      // Estimate total chars
      let total = CAPTURE_SYSTEM_PROMPT.length;
      for (const m of messages) {
        if ("content" in m) {
          const c = m.content;
          if (typeof c === "string") total += c.length;
          else if (Array.isArray(c)) {
            for (const b of c) {
              if (typeof b === "object" && b !== null && "text" in b && typeof (b as { text: string }).text === "string") {
                total += (b as { text: string }).text.length;
              }
            }
          }
        }
      }

      if (total <= MAX_CONTEXT_CHARS) return messages;

      // Prune old tool results — truncate text blocks to 200 chars
      return messages.map((m, i): AgentMessage => {
        if (i >= messages.length - 10) return m;
        if (m.role !== "toolResult") return m;
        if (!("content" in m) || !Array.isArray(m.content)) return m;
        const newContent = (m.content as Array<{ type: string; text: string }>).map(b => {
          if (b.type === "text" && b.text.length > 200) {
            return { type: "text" as const, text: b.text.slice(0, 200) + "\n[pruned]" };
          }
          return b;
        });
        return { ...m, content: newContent } as AgentMessage;
      });
    },
  });

  // 5. Prompt the agent
  const promptText = [
    `Process this session and capture all valuable knowledge into the wiki.`,
    `Session file: ${sessionPath}`,
    `Project scope: ${scope}`,
    `Start by calling session_stats to understand the session.`,
  ].join("\n");

  try {
    await agent.prompt(promptText);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[processor] Agent error: ${errMsg}`);
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: `Agent error: ${errMsg}`,
    };
  }

  // Debug: log what the agent did
  const msgCount = agent.state.messages.length;
  const toolCalls = agent.state.messages.filter(m => m.role === "toolResult").length;
  const lastMsg = agent.state.messages[msgCount - 1];
  let lastContent = "";
  if (lastMsg && "content" in lastMsg) {
    const c = lastMsg.content;
    if (typeof c === "string") lastContent = c.slice(0, 200);
    else if (Array.isArray(c)) {
      const tb = c.find((b: any) => b.type === "text") as { text: string } | undefined;
      if (tb) lastContent = tb.text.slice(0, 200);
    }
  }
  console.log(`[processor] Agent finished: ${msgCount} messages, ${toolCalls} tool results. Last: ${lastContent}`);

  // 6. Extract what was written from agent's messages
  const pagesCreated: string[] = [];
  const pagesUpdated: string[] = [];

  for (const msg of agent.state.messages) {
    if (msg.role !== "toolResult") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as unknown as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.startsWith("Wrote ")) {
        const path = b.text.replace("Wrote ", "").trim();
        // Check details to see if it was a create or update
        pagesCreated.push(path);
      }
    }
  }

  if (pagesCreated.length === 0 && pagesUpdated.length === 0) {
    return { pagesCreated: [], pagesUpdated: [], skipped: true, reason: "no pages written" };
  }

  // 7. Append session digest
  try {
    await appendSessionDigest(wikiDir, {
      date: new Date().toISOString().split("T")[0],
      project: scope,
      sessionFile: sessionPath,
      scope,
      capturedPages: pagesCreated,
      summary: `Daemon captured ${pagesCreated.length} page(s) from session`,
    });
  } catch {
    // Non-fatal
  }

  return { pagesCreated, pagesUpdated, skipped: false };
}
