import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import type { ProjectScope } from "../scope.js";
import type { ParaCategory } from "../wiki.js";
import { queryWiki as queryWikiLib, formatQueryResults } from "../query.js";
import { QUERY_PROMPT } from "../templates/prompts.js";
import type { WikiQueryDetails } from "./schemas.js";

// -- Factory: wiki_query execute ---------------------------------------------

export function createQueryExecute(
  _wikiDir: string,
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
