import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import type { ProjectScope } from "../scope.js";
import { normalizeTags, normalizeScopes } from "../tag-registry.js";
import { redactSecrets } from "../redact.js";
import { autoLinkSlugs, syncFrontmatterLinks } from "../link-utils.js";
import { validateFrontmatter } from "../frontmatter.js";
import { appendLog, gitCommit, listPageSlugs, readPage, rebuildIndex, writePage, type ParaCategory, type WikiPage } from "../wiki.js";
import type { WikiWriteDetails } from "./schemas.js";
import { scheduleWikiMaintenance } from "./shared.js";

// -- Factory: wiki_write execute ---------------------------------------------

export function createWriteExecute(
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
        mode: "create" | "replace" | "append" | "edit";
        edits?: Array<{ oldText: string; newText: string }>;
      }>;
      indexContent?: string;
      logSummary?: string;
    },
  ): Promise<AgentToolResult<WikiWriteDetails>> => {
    const pagesWritten: string[] = [];
    const pagesSkipped: string[] = [];
    const now = new Date().toISOString();
    const scope = getScope();

    // Gather all existing slugs for auto-linking (slug-only readdir scan;
    // reading/parsing every page here made wiki_write scale poorly)
    const allSlugs = await listPageSlugs(wikiDir);

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

      // Track this slug for auto-linking other pages in this batch
      allSlugs.add(slug);

      if (pageSpec.mode === "create" && existing) {
        pagesSkipped.push(`${pagePath} (already exists; use mode=replace, mode=append, or wiki_edit)`);
        continue;
      }

      if (pageSpec.mode === "edit" && !existing) {
        pagesSkipped.push(`${pagePath} (missing; wiki_write mode=edit requires an existing page)`);
        continue;
      }

      if (pageSpec.mode === "edit" && existing) {
        // Legacy edit mode: keep for compatibility, but make it atomic like wiki_edit.
        const edits = pageSpec.edits ?? [];
        if (edits.length === 0) {
          continue; // no edits to apply
        }
        const errors: string[] = [];
        for (const edit of edits) {
          const first = existing.body.indexOf(edit.oldText);
          const last = existing.body.lastIndexOf(edit.oldText);
          if (first === -1) {
            errors.push(`oldText not found: "${edit.oldText.slice(0, 60)}..."`);
          } else if (first !== last) {
            errors.push(`oldText is not unique: "${edit.oldText.slice(0, 60)}..."`);
          }
        }
        if (errors.length > 0) {
          pagesSkipped.push(`${pagePath} (${errors.join("; ")})`);
          continue;
        }
        let editedBody = existing.body;
        for (const edit of edits) {
          editedBody = editedBody.replace(edit.oldText, edit.newText);
        }
        const linkedBody = redactSecrets(autoLinkSlugs(editedBody, allSlugs, slug)).text;
        const rawScope = pageSpec.scope.length > 0 ? pageSpec.scope : existing.frontmatter.scope;
        const newScope = normalizeScopes(rawScope);
        const newTags = pageSpec.tags.length > 0 ? pageSpec.tags : existing.frontmatter.tags;
        const updatedPage: WikiPage = {
          category: pageSpec.category,
          slug,
          frontmatter: {
            ...existing.frontmatter,
            title: pageSpec.title || existing.frontmatter.title,
            scope: newScope,
            tags: normalizeTags(newTags, newScope),
            updated: now,
            links: syncFrontmatterLinks(linkedBody),
          },
          body: linkedBody,
        };
        await writePage(wikiDir, updatedPage);
        pagesWritten.push(pagePath + (errors.length > 0 ? ` (${errors.length} edit(s) failed)` : ""));
      } else if (pageSpec.mode === "append" && existing) {
        // Append to existing page body
        const combinedBody = existing.body.trimEnd() + "\n\n" + pageSpec.body;
        const linkedBody = redactSecrets(autoLinkSlugs(combinedBody, allSlugs, slug)).text;
        const mergedTags = [...new Set([...existing.frontmatter.tags, ...pageSpec.tags])];
        const mergedScope = normalizeScopes([...new Set([...existing.frontmatter.scope, ...pageSpec.scope])]);
        const updatedPage: WikiPage = {
          ...existing,
          body: linkedBody,
          frontmatter: {
            ...existing.frontmatter,
            updated: now,
            tags: normalizeTags(mergedTags, mergedScope),
            scope: mergedScope,
            links: syncFrontmatterLinks(linkedBody),
          },
        };
        await writePage(wikiDir, updatedPage);
        pagesWritten.push(pagePath);
      } else if (pageSpec.mode === "replace" && existing) {
        // Replace existing page body, update frontmatter
        const linkedBody = redactSecrets(autoLinkSlugs(pageSpec.body, allSlugs, slug)).text;
        const rawScope = pageSpec.scope.length > 0 ? pageSpec.scope : existing.frontmatter.scope;
        const newScope = normalizeScopes(rawScope);
        const newTags = pageSpec.tags.length > 0 ? pageSpec.tags : existing.frontmatter.tags;
        const updatedPage: WikiPage = {
          category: pageSpec.category,
          slug,
          frontmatter: {
            ...existing.frontmatter,
            title: pageSpec.title,
            para: pageSpec.category,
            scope: newScope,
            tags: normalizeTags(newTags, newScope),
            updated: now,
            links: syncFrontmatterLinks(linkedBody),
          },
          body: linkedBody,
        };
        await writePage(wikiDir, updatedPage);
        pagesWritten.push(pagePath);
      } else {
        // Create new page (or mode=create/replace on non-existing)
        const linkedBody = redactSecrets(autoLinkSlugs(pageSpec.body, allSlugs, slug)).text;
        const rawScope = pageSpec.scope.length > 0 ? pageSpec.scope : [scope.name];
        const newScope = normalizeScopes(rawScope);
        const frontmatter = validateFrontmatter({
          title: pageSpec.title,
          para: pageSpec.category,
          scope: newScope,
          tags: normalizeTags(pageSpec.tags, newScope),
          sources: [],
          created: now,
          updated: now,
          links: syncFrontmatterLinks(linkedBody),
        });

        const newPage: WikiPage = {
          category: pageSpec.category,
          slug,
          frontmatter,
          body: linkedBody,
        };
        await writePage(wikiDir, newPage);
        pagesWritten.push(pagePath);
      }
    }

    // Always auto-rebuild index from disk.
    // The LLM's indexContent is unreliable — it only knows about pages
    // in its context, so it produces partial indexes that overwrite
    // the full one. indexContent parameter is deprecated and ignored.
    let indexUpdated = false;
    if (pagesWritten.length > 0) {
      await rebuildIndex(wikiDir);
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

    // Defer QMD BM25 reindex to the debounced background maintenance queue
    // (same as wiki_edit). Immediate post-write queries are safe: queryWiki
    // retries with a fresh store.update() before returning zero results.
    if (pagesWritten.length > 0) {
      scheduleWikiMaintenance(wikiDir, store, markDirty);
    }

    // Mark context cache dirty so before_agent_start rebuilds
    markDirty();

    // Git auto-commit
    if (pagesWritten.length > 0) {
      const commitMsg = params.logSummary
        ? params.logSummary
        : `wiki: ${pagesWritten.join(", ")}`;
      await gitCommit(wikiDir, commitMsg);
    }

    const summary = [
      pagesWritten.length > 0
        ? `Wrote ${pagesWritten.length} page(s): ${pagesWritten.join(", ")}`
        : "No pages written.",
      pagesSkipped.length > 0 ? `Skipped ${pagesSkipped.length} page(s): ${pagesSkipped.join(", ")}` : "",
    ].filter(Boolean).join("\n");

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
        pagesSkipped,
      },
    };
  };
}
