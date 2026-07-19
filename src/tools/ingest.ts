import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import type { ProjectScope } from "../scope.js";
import type { ParaCategory } from "../wiki.js";
import { resolveSource, truncateSource } from "../ingest.js";
import { INGEST_PROMPT } from "../templates/prompts.js";
import type { WikiIngestDetails } from "./schemas.js";

// -- Factory: wiki_ingest execute --------------------------------------------

export function createIngestExecute(
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
