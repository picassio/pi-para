/**
 * Session exploration tools for the Agent.
 *
 * These tools give the Agent the ability to explore a session file
 * without loading the entire thing into the prompt — the TypeScript
 * equivalent of RLM's REPL-based exploration.
 */

import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

// -- Session loading ---------------------------------------------------------

interface SessionMessage {
  role: string;
  text: string;
  toolCalls: string[];
  charOffset: number;
}

export interface LoadedSession {
  messages: SessionMessage[];
  serialized: string;
  stats: {
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    toolResults: number;
    toolCalls: number;
    totalChars: number;
    compactionSummaries: number;
  };
}

/** Load and pre-process a session JSONL file. */
export function loadSession(sessionPath: string): LoadedSession {
  const raw = readFileSync(sessionPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: SessionMessage[] = [];
  const parts: string[] = [];
  let charOffset = 0;
  let compactionSummaries = 0;
  let toolCallCount = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "compaction" && typeof entry.summary === "string") {
      const text = `[Compaction Summary]:\n${entry.summary}`;
      parts.push(text);
      messages.push({ role: "compaction", text, toolCalls: [], charOffset });
      charOffset += text.length + 2;
      compactionSummaries++;
      continue;
    }

    if (entry.type !== "message") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role as string;
    if (!["user", "assistant", "toolResult"].includes(role)) continue;

    const content = msg.content;
    let text = "";
    const toolCalls: string[] = [];

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const argsStr = JSON.stringify(b.arguments ?? {});
          toolCalls.push(
            `${b.name}(${argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr})`,
          );
          toolCallCount++;
        }
      }
      text = textParts.join("\n");
      if (toolCalls.length > 0) {
        text += `\n[Tools]: ${toolCalls.join("; ")}`;
      }
    }

    if (!text.trim()) continue;

    // Truncate tool results
    if (role === "toolResult" && text.length > 1000) {
      text = text.slice(0, 1000) + "\n[truncated]";
    }

    const label = { user: "User", assistant: "Assistant", toolResult: "Tool" }[role] ?? role;
    const formatted = `[${label}]: ${text}`;
    parts.push(formatted);
    messages.push({ role, text: formatted, toolCalls, charOffset });
    charOffset += formatted.length + 2;
  }

  const serialized = parts.join("\n\n");

  return {
    messages,
    serialized,
    stats: {
      totalMessages: messages.length,
      userMessages: messages.filter((m) => m.role === "user").length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length,
      toolResults: messages.filter((m) => m.role === "toolResult").length,
      toolCalls: toolCallCount,
      totalChars: serialized.length,
      compactionSummaries,
    },
  };
}

// -- Tool definitions --------------------------------------------------------

const SliceParams = Type.Object({
  start: Type.Number({ description: "Start character offset" }),
  end: Type.Number({ description: "End character offset" }),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Text to search for (case-insensitive)" }),
  maxResults: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
});

const StatsParams = Type.Object({});

/** Create session exploration tools bound to a loaded session. */
export function createSessionTools(session: LoadedSession): AgentTool[] {
  const sessionSlice: AgentTool<typeof SliceParams> = {
    name: "session_slice",
    label: "Session Slice",
    description: `Read a slice of the session text (${session.stats.totalChars} chars total). Use to explore specific sections.`,
    parameters: SliceParams,
    execute: async (_id, params) => {
      const start = Math.max(0, params.start);
      const end = Math.min(session.serialized.length, params.end);
      const slice = session.serialized.slice(start, end);
      return {
        content: [
          {
            type: "text",
            text: `[chars ${start}-${end} of ${session.serialized.length}]\n\n${slice}`,
          },
        ],
        details: { start, end, length: slice.length },
      };
    },
  };

  const sessionSearch: AgentTool<typeof SearchParams> = {
    name: "session_search",
    label: "Session Search",
    description: "Search the session for a keyword. Returns matching sections with character offsets.",
    parameters: SearchParams,
    execute: async (_id, params) => {
      const query = params.query.toLowerCase();
      const maxResults = params.maxResults ?? 10;
      const matches: Array<{ offset: number; context: string }> = [];

      const text = session.serialized.toLowerCase();
      let pos = 0;
      while (matches.length < maxResults) {
        const idx = text.indexOf(query, pos);
        if (idx === -1) break;

        // Extract context around match
        const contextStart = Math.max(0, idx - 200);
        const contextEnd = Math.min(session.serialized.length, idx + query.length + 200);
        matches.push({
          offset: idx,
          context: session.serialized.slice(contextStart, contextEnd),
        });
        pos = idx + query.length;
      }

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No matches for "${params.query}"` }],
          details: { matchCount: 0 },
        };
      }

      const resultText = matches
        .map(
          (m, i) =>
            `Match ${i + 1} (offset ${m.offset}):\n${m.context}\n`,
        )
        .join("\n---\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${matches.length} match(es) for "${params.query}":\n\n${resultText}`,
          },
        ],
        details: { matchCount: matches.length },
      };
    },
  };

  const sessionStats: AgentTool<typeof StatsParams> = {
    name: "session_stats",
    label: "Session Stats",
    description: "Get session overview: message counts, size, topics.",
    parameters: StatsParams,
    execute: async () => {
      const s = session.stats;

      // Extract user message topics (first 100 chars of each, cap at 50)
      const allUserMsgs = session.messages.filter((m) => m.role === "user");
      const displayLimit = 50;
      const userTopics = allUserMsgs
        .slice(0, displayLimit)
        .map((m) => m.text.replace(/^\[User\]: /, "").slice(0, 100))
        .map((t, i) => `  ${i + 1}. ${t}`);
      if (allUserMsgs.length > displayLimit) {
        userTopics.push(`  ... and ${allUserMsgs.length - displayLimit} more user messages. Use session_search to find specific topics.`);
      }

      const sizeLabel = s.totalChars > 1_000_000 ? `${(s.totalChars / 1_000_000).toFixed(1)}M`
        : s.totalChars > 1_000 ? `${(s.totalChars / 1_000).toFixed(0)}K`
        : `${s.totalChars}`;

      const text = [
        `Session: ${sizeLabel} chars, ${s.totalMessages} messages`,
        `  User: ${s.userMessages}, Assistant: ${s.assistantMessages}, Tool results: ${s.toolResults}`,
        `  Tool calls: ${s.toolCalls}, Compaction summaries: ${s.compactionSummaries}`,
        "",
        "Strategy: Use session_search to find topics, then session_slice to read details.",
        `Valid slice range: 0 to ${s.totalChars}`,
        "",
        "User messages (topics):",
        ...userTopics,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: s,
      };
    },
  };

  return [sessionSlice, sessionSearch, sessionStats];
}
