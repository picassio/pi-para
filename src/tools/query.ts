import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import type { ProjectScope } from "../scope.js";
import { readPage, type ParaCategory } from "../wiki.js";
import { queryWiki as queryWikiLib, formatQueryResults } from "../query.js";
import { QUERY_PROMPT } from "../templates/prompts.js";
import type { WikiQueryDetails } from "./schemas.js";
import { openQuestionsOf, RESOLVE_HOW } from "../questions.js";

// -- Factory: wiki_query execute ---------------------------------------------

export function createQueryExecute(
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  getGraphBoost?: () => boolean,
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
      graphBoost: getGraphBoost?.() ?? true,
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
    // The found pages' open questions: what is still unknown about this topic, and may be answered now.
    const open: string[] = [];

    for (const found of result.results) {
      const page = await readPage(wikiDir, found.page.category, found.page.slug);

      for (const question of page === null ? [] : openQuestionsOf(page.body)) {
        open.push(`- ${question.text} — on ${found.page.category}/${found.page.slug}${question.date ? `, asked ${question.date}${question.session ? ` (${question.session})` : ""}` : ""}`);
      }
    }
    const toolResultText = [
      QUERY_PROMPT,
      "",
      `Query: "${params.query}"`,
      `Scope: ${result.wasGlobal ? "global (all scopes)" : scope.name}`,
      `Results: ${result.results.length}`,
      "",
      ...(open.length === 0 ? [] : [`## Open questions on these pages (${open.length})`, "If what you know or find answers one, resolve it. " + RESOLVE_HOW, ...open, ""]),
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
