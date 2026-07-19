import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ProjectScope } from "../scope.js";
import { generateOverviewPrompt } from "../summarize.js";
import { listPages, readPage, PARA_CATEGORIES, type ParaCategory, type WikiPage } from "../wiki.js";
import type { WikiSummarizeDetails } from "./schemas.js";
import { parsePagePath } from "./shared.js";

// -- Factory: wiki_summarize execute -----------------------------------------

export function createSummarizeExecute(
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

    // Generate a bounded overview prompt for the LLM. For large targets like
    // `all`, brief mode must not dump every full page body into model context.
    const depth = params.depth ?? "brief";
    const overviewPrompt = generateOverviewPrompt(pages, scope, { depth });
    const depthNote =
      depth === "detailed"
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
