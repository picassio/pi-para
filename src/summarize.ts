/**
 * Wiki summarization — adapts pi's compaction approach for wiki knowledge.
 *
 * Produces structured wiki summaries in the standard format:
 * Topic, Key Facts, Insights, Connections, Open Questions, Sources.
 *
 * Supports ingest, session, page, and iterative summarization modes.
 *
 * Functions here generate prompt strings — they do NOT call the LLM.
 * The caller (capture.ts, tools.ts) passes the prompt to a standalone Agent.
 */

import type { WikiPage } from "./wiki.js";
import type { ParaCategory } from "./wiki.js";
import type { ProjectScope } from "./scope.js";
import {
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import {
  SUMMARIZE_SYSTEM_PROMPT,
  ITERATIVE_UPDATE_PROMPT,
  OVERVIEW_PROMPT,
  CAPTURE_PROMPT,
} from "./templates/prompts.js";

// -- Types ------------------------------------------------------------------

export interface SummarizeOptions {
  mode: "ingest" | "session" | "page" | "iterative";
  existingContent?: string; // for iterative mode
  scope: ProjectScope;
  category?: ParaCategory;
}

// -- Constants ---------------------------------------------------------------

/** Maximum characters for a tool result in serialized output. */
const TOOL_RESULT_MAX_CHARS = 2000;

// -- Fallback serialization --------------------------------------------------

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Extract text content from a message content field.
 * Handles both string and array-of-blocks shapes.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c: unknown): c is { type: "text"; text: string } =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        (c as { type: string }).type === "text" &&
        "text" in c,
    )
    .map((c) => c.text)
    .join("");
}

/**
 * Fallback serialization that mirrors pi's serializeConversation format.
 * Used when @mariozechner/pi-coding-agent is not available.
 *
 * Formats: [User]:, [Assistant]:, [Assistant thinking]:,
 *          [Assistant tool calls]:, [Tool result]:
 */
function serializeMessagesFallback(messages: unknown[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null || !("role" in msg)) continue;
    const m = msg as Record<string, unknown>;

    if (m.role === "user") {
      const text = extractTextContent(m.content);
      if (text) parts.push(`[User]: ${text}`);
    } else if (m.role === "assistant") {
      const content = m.content;
      if (!Array.isArray(content)) continue;

      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];

      for (const block of content) {
        if (typeof block !== "object" || block === null || !("type" in block)) continue;
        const b = block as Record<string, unknown>;

        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          thinkingParts.push(b.thinking);
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const args = (b.arguments ?? {}) as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${b.name}(${argsStr})`);
        }
      }

      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    } else if (m.role === "toolResult") {
      const text = extractTextContent(m.content);
      if (text) {
        parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }

  return parts.join("\n\n");
}

// -- Public API --------------------------------------------------------------

/**
 * Serialize session messages for wiki capture.
 *
 * Converts AgentMessage[] to a text representation that prevents the LLM
 * from treating it as a conversation to continue. Uses pi's convertToLlm +
 * serializeConversation when the messages contain pi-specific types
 * (bashExecution, compactionSummary, branchSummary, etc.). Falls back to
 * a compatible reimplementation for plain user/assistant/toolResult messages.
 *
 * @param messages - AgentMessage[] from @mariozechner/pi-agent-core
 * @returns Serialized text in [User]: / [Assistant]: / [Tool result]: format
 */
export function serializeSessionForWiki(
  messages: unknown[], // AgentMessage[] — typed as unknown[] to avoid hard dep
): string {
  // Use pi's convertToLlm to handle custom message types (bashExecution,
  // compactionSummary, branchSummary, etc.), then serialize the resulting
  // standard LLM messages.
  try {
    const llmMessages = convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
    return serializeConversation(llmMessages);
  } catch {
    // If convertToLlm fails (e.g., unexpected message shapes), fall back
    // to our reimplementation that handles the base roles.
    return serializeMessagesFallback(messages);
  }
}

/**
 * Generate a wiki-format summary prompt from raw content.
 *
 * Returns the prompt string to send to the LLM. The caller passes this
 * to a standalone Agent or includes it in a tool result for the session agent.
 *
 * @param content - Source text, serialized conversation, or page content
 * @param options - Summarization mode and context
 * @returns Prompt string for the LLM
 */
export function generateSummary(
  content: string,
  options: SummarizeOptions,
): string {
  const scopeInfo = `Current scope: ${options.scope.name} (tags: ${options.scope.include.join(", ")})`;
  const categoryHint = options.category ? `\nSuggested PARA category: ${options.category}` : "";

  switch (options.mode) {
    case "ingest":
      return [
        SUMMARIZE_SYSTEM_PROMPT,
        "",
        scopeInfo,
        categoryHint,
        "",
        "Produce a wiki page from the following source material:",
        "",
        "<source-content>",
        content,
        "</source-content>",
      ].join("\n");

    case "session":
      return [
        CAPTURE_PROMPT,
        content,
        "</session-conversation>",
      ].join("\n");

    case "page":
      return [
        SUMMARIZE_SYSTEM_PROMPT,
        "",
        scopeInfo,
        "",
        "Summarize the following wiki page into a concise overview:",
        "",
        "<page-content>",
        content,
        "</page-content>",
      ].join("\n");

    case "iterative":
      if (!options.existingContent) {
        // No existing content — treat as a fresh page
        return generateSummary(content, { ...options, mode: "ingest" });
      }
      return [
        ITERATIVE_UPDATE_PROMPT,
        "",
        scopeInfo,
        categoryHint,
        "",
        "<existing-page>",
        options.existingContent,
        "</existing-page>",
        "",
        "<new-content>",
        content,
        "</new-content>",
      ].join("\n");
  }
}

/**
 * Generate an overview prompt from multiple wiki pages.
 *
 * Used by /wiki-summarize and wiki_summarize tool to produce high-level
 * overviews of a category or the entire wiki.
 *
 * @param pages - Wiki pages to summarize
 * @param scope - Current project scope for context
 * @returns Prompt string for the LLM
 */
export function generateOverviewPrompt(
  pages: WikiPage[],
  scope: ProjectScope,
): string {
  const scopeInfo = `Current scope: ${scope.name} (tags: ${scope.include.join(", ")})`;

  const pageEntries = pages.map((page) => {
    const fm = page.frontmatter;
    return [
      `### ${fm.title} (${page.category}/${page.slug})`,
      `PARA: ${fm.para} | Scope: ${fm.scope.join(", ")} | Tags: ${fm.tags.join(", ")}`,
      "",
      page.body,
    ].join("\n");
  });

  return [
    OVERVIEW_PROMPT,
    "",
    scopeInfo,
    `Total pages: ${pages.length}`,
    "",
    ...pageEntries,
  ].join("\n");
}
