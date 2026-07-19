import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import { appendLog, gitCommit, movePage, readPage, rebuildIndex, type PageRef, type ParaCategory } from "../wiki.js";
import type { WikiMoveDetails } from "./schemas.js";
import { parsePagePath, scheduleWikiMaintenance } from "./shared.js";

// -- Factory: wiki_move execute ----------------------------------------------

export function createMoveExecute(
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

    // Rebuild index.md inline (fast, single-pass); defer QMD reindex to the
    // debounced background maintenance queue like wiki_write/wiki_edit.
    await rebuildIndex(wikiDir);
    scheduleWikiMaintenance(wikiDir, store, markDirty);
    markDirty();

    // Git commit
    await gitCommit(wikiDir, `move: ${page.frontmatter.title} → ${params.to}`);

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
