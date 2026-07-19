import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import { formatFreshness } from "../query.js";
import { autoLinkSlugs, syncFrontmatterLinks } from "../link-utils.js";
import { normalizeTags, normalizeScopes } from "../tag-registry.js";
import { redactSecrets } from "../redact.js";
import { appendLog, gitCommit, listPages, readIndex, readPage, writePage, type WikiPage } from "../wiki.js";
import type { WikiReadDetails, WikiWriteDetails } from "./schemas.js";
import { parsePagePath, scheduleWikiMaintenance } from "./shared.js";

// -- Factory: wiki_read execute ----------------------------------------------

export function createEditExecute(
  wikiDir: string,
  store: QMDStore,
  markDirty: () => void,
) {
  return async (
    params: {
      path: string;
      edits: Array<{ oldText: string; newText: string }>;
      title?: string;
      scope?: string[];
      tags?: string[];
      logSummary?: string;
    },
  ): Promise<AgentToolResult<WikiWriteDetails>> => {
    const parsed = parsePagePath(params.path);
    if (!parsed) {
      return {
        content: [{ type: "text", text: `Invalid page path: ${params.path}` }],
        details: { pagesWritten: [], pagesSkipped: [params.path], indexUpdated: false, logAppended: false },
      };
    }

    const existing = await readPage(wikiDir, parsed.category, parsed.slug);
    const pagePath = `${parsed.category}/${parsed.slug}`;
    if (!existing) {
      return {
        content: [{ type: "text", text: `Page not found: ${pagePath}` }],
        details: { pagesWritten: [], pagesSkipped: [pagePath], indexUpdated: false, logAppended: false },
      };
    }

    if (params.edits.length === 0) {
      return {
        content: [{ type: "text", text: "No edits supplied." }],
        details: { pagesWritten: [], pagesSkipped: [pagePath], indexUpdated: false, logAppended: false },
      };
    }

    // Atomic validation: all oldText strings must exist exactly once before writing.
    const errors: string[] = [];
    for (const edit of params.edits) {
      const first = existing.body.indexOf(edit.oldText);
      const last = existing.body.lastIndexOf(edit.oldText);
      if (first === -1) {
        errors.push(`oldText not found: "${edit.oldText.slice(0, 60)}..."`);
      } else if (first !== last) {
        errors.push(`oldText is not unique: "${edit.oldText.slice(0, 60)}..."`);
      }
    }
    if (errors.length > 0) {
      return {
        content: [{ type: "text", text: `No changes written.\n${errors.join("\n")}` }],
        details: { pagesWritten: [], pagesSkipped: [pagePath], indexUpdated: false, logAppended: false },
      };
    }

    let editedBody = existing.body;
    for (const edit of params.edits) {
      editedBody = editedBody.replace(edit.oldText, edit.newText);
    }

    // Surgical edit path: do not scan/autolink/rebuild/reindex the whole wiki.
    // wiki_edit is often called mid-task and must stay fast; broader maintenance
    // can run via wiki_lint/rebuildIndex or on startup.
    const linkedBody = redactSecrets(editedBody).text;
    const now = new Date().toISOString();
    const rawScope = params.scope ?? existing.frontmatter.scope;
    const newScope = normalizeScopes(rawScope);
    const rawTags = params.tags ?? existing.frontmatter.tags;
    const updatedPage: WikiPage = {
      category: parsed.category,
      slug: parsed.slug,
      frontmatter: {
        ...existing.frontmatter,
        title: params.title ?? existing.frontmatter.title,
        scope: newScope,
        tags: normalizeTags(rawTags, newScope),
        updated: now,
        links: syncFrontmatterLinks(linkedBody),
      },
      body: linkedBody,
    };

    await writePage(wikiDir, updatedPage);
    if (params.logSummary) {
      await appendLog(wikiDir, {
        date: now.split("T")[0],
        operation: "edit",
        summary: params.logSummary,
        pages: [pagePath],
      });
    }
    markDirty();
    await gitCommit(wikiDir, params.logSummary ?? `wiki_edit: ${pagePath}`);
    scheduleWikiMaintenance(wikiDir, store, markDirty);

    return {
      content: [{ type: "text", text: `Edited ${pagePath}. Scheduled background index/search refresh.` }],
      details: {
        pagesWritten: [pagePath],
        pagesSkipped: [],
        indexUpdated: false,
        logAppended: !!params.logSummary,
      },
    };
  };
}

export function createReadExecute(wikiDir: string) {
  return async (
    params: { path: string },
  ): Promise<AgentToolResult<WikiReadDetails>> => {
    const now = Date.now();
    const normalizedPath = params.path.trim().toLowerCase().replace(/^\/+/, "");

    if (normalizedPath === "index" || normalizedPath === "index.md" || normalizedPath === "wiki-index") {
      const index = await readIndex(wikiDir);
      return {
        content: [{ type: "text", text: index }],
        details: { found: true, path: "index.md" },
      };
    }

    // Try parsing as category/slug path
    const parsed = parsePagePath(params.path);
    if (parsed) {
      const page = await readPage(wikiDir, parsed.category, parsed.slug);
      if (page) {
        const fm = page.frontmatter;
        const freshness = formatFreshness(fm.updated, now);
        const header = [
          `# ${fm.title}`,
          `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
          `Created: ${fm.created} | Updated: ${fm.updated} | ${freshness}`,
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
          const freshness = formatFreshness(fm.updated, now);
          const header = [
            `# ${fm.title}`,
            `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
            `Created: ${fm.created} | Updated: ${fm.updated} | ${freshness}`,
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
