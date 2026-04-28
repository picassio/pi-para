/**
 * Session knowledge capture — extracts insights from sessions into the wiki.
 *
 * Two modes:
 * - Auto-capture on session_shutdown (standalone Agent with wiki tools)
 * - Explicit capture via /wiki-capture command (standalone Agent)
 *
 * Both are fully automatic — no user confirmation prompts.
 */

import type { Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage, AgentEvent } from "@mariozechner/pi-agent-core";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { QMDStore } from "@picassio/qmd";

import type { ProjectScope } from "./scope.js";
import type { PageRef, ParaCategory } from "./wiki.js";
import { readPage, PARA_CATEGORIES } from "./wiki.js";
import { appendSessionDigest } from "./raw.js";
import type { SessionDigest } from "./raw.js";
import { createStandaloneTools } from "./tools.js";
import { serializeSessionForWiki, generateSummary } from "./summarize.js";
import { CAPTURE_SYSTEM_PROMPT, EXPLICIT_CAPTURE_PROMPT } from "./templates/prompts.js";

// -- Types ------------------------------------------------------------------

export interface CaptureResult {
  pagesCreated: PageRef[];
  pagesUpdated: PageRef[];
  skipped: boolean;
  reason?: string; // why it was skipped ("trivial session", etc.)
  digestEntry?: SessionDigest;
}

// -- Constants ---------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
const NOTHING_PATTERN = /nothing to capture/i;

// -- Helpers -----------------------------------------------------------------

/**
 * Parse a page path like "projects/auth-refactor" into category + slug.
 * Returns null for invalid paths.
 */
function parsePagePath(pagePath: string): { category: ParaCategory; slug: string } | null {
  const parts = pagePath.split("/");
  if (parts.length !== 2) return null;
  const [cat, slug] = parts;
  if (!(PARA_CATEGORIES as readonly string[]).includes(cat)) return null;
  if (!slug) return null;
  return { category: cat as ParaCategory, slug };
}

/** Estimate total text chars in user + assistant messages. */
function estimateSessionChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = "content" in m ? m.content : undefined;
    if (typeof content === "string") { total += content.length; continue; }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
          total += (block as { text: string }).text.length;
        }
      }
    }
  }
  return total;
}

/**
 * Extract pages written from agent messages by inspecting tool results.
 *
 * After the standalone agent finishes, its messages contain tool calls and
 * tool results. We inspect wiki_write tool results to find pagesWritten.
 */
function extractWrittenPages(messages: AgentMessage[]): string[] {
  const pages: string[] = [];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null || !("role" in (msg as object))) continue;
    const m = msg as unknown as Record<string, unknown>;

    // Look for toolResult messages that contain pagesWritten info
    if (m.role === "toolResult") {
      // The content of a wiki_write tool result mentions "Wrote N page(s): path1, path2"
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as unknown as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          const match = b.text.match(/Wrote \d+ page\(s\): (.+)/);
          if (match) {
            const paths = match[1].split(", ").map((p) => p.trim());
            pages.push(...paths);
          }
        }
      }
    }
  }

  return [...new Set(pages)];
}

/**
 * Check if the agent's final assistant message indicates nothing was captured.
 */
function isNothingCaptured(messages: AgentMessage[]): boolean {
  // Walk messages backwards to find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null || !("role" in (msg as object))) continue;
    const m = msg as unknown as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as unknown as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        if (NOTHING_PATTERN.test(b.text)) return true;
      }
    }
    break; // only check the last assistant message
  }
  return false;
}

/**
 * Build PageRef objects from page paths by reading actual pages from disk.
 * Pages that don't exist on disk get a minimal PageRef.
 */
async function buildPageRefs(
  wikiDir: string,
  pagePaths: string[],
): Promise<{ created: PageRef[]; updated: PageRef[] }> {
  const created: PageRef[] = [];
  const updated: PageRef[] = [];

  for (const pagePath of pagePaths) {
    const parsed = parsePagePath(pagePath);
    if (!parsed) continue;

    const page = await readPage(wikiDir, parsed.category, parsed.slug);
    const ref: PageRef = {
      category: parsed.category,
      slug: parsed.slug,
      title: page?.frontmatter.title ?? parsed.slug,
      path: `${parsed.category}/${parsed.slug}.md`,
    };

    // If created date == updated date, it's newly created; otherwise updated.
    // In practice, all pages written in capture are "created" from capture's
    // perspective — the wiki_write tool handles create vs update internally.
    // We heuristically check: if the page was created within the last minute,
    // treat it as newly created.
    if (page) {
      const createdTime = new Date(page.frontmatter.created).getTime();
      const updatedTime = new Date(page.frontmatter.updated).getTime();
      // If created and updated are within 2 seconds, it was just created
      if (Math.abs(updatedTime - createdTime) < 2000) {
        created.push(ref);
      } else {
        updated.push(ref);
      }
    } else {
      // Page was written but we can't read it — treat as created
      created.push(ref);
    }
  }

  return { created, updated };
}

/**
 * Run a standalone capture agent with the given prompt and tools.
 * Returns the agent's final messages for analysis.
 */
async function runCaptureAgent(
  wikiDir: string,
  store: QMDStore,
  scope: ProjectScope,
  model: Model<any>,
  modelRegistry: ModelRegistry,
  userPrompt: string,
  timeoutMs?: number,
): Promise<AgentMessage[]> {
  const tools = createStandaloneTools(wikiDir, store, () => scope);

  const agent = new Agent({
    initialState: {
      systemPrompt: CAPTURE_SYSTEM_PROMPT,
      model,
      tools,
      messages: [],
    },
    getApiKey: (provider) => modelRegistry.getApiKeyForProvider(provider),
  });

  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  // Wire abort into agent
  const unsubscribe = agent.subscribe(async (_event: AgentEvent, _signal: AbortSignal) => {
    if (abortController.signal.aborted) {
      agent.abort();
    }
  });

  try {
    // Prompt the agent — this runs the full tool loop
    await agent.prompt(userPrompt);
  } catch {
    // Agent was aborted or encountered an error — non-fatal
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  return agent.state.messages;
}

// -- Public API --------------------------------------------------------------

/**
 * Called automatically on session_shutdown.
 * Spins up a standalone Agent with wiki tools, aborts after timeoutMs.
 */
export async function autoCapture(
  wikiDir: string,
  store: QMDStore,
  messages: AgentMessage[],
  scope: ProjectScope,
  sessionFile: string,
  model: Model<any>,
  modelRegistry: ModelRegistry,
  timeoutMs?: number,
  alreadyCaptured?: string[],
): Promise<CaptureResult> {
  // Short-circuit only truly empty sessions (greetings, single-word exchanges).
  // Even short sessions can contain valuable operational knowledge (deploy keys,
  // server configs, build commands, architecture decisions).
  //
  // We also check for tool usage — if the LLM read files, ran commands, or
  // searched code, the session likely has project-specific knowledge.
  const totalChars = estimateSessionChars(messages);
  const hasToolCalls = messages.some(m =>
    m.role === "assistant" && Array.isArray(m.content) &&
    m.content.some((b: unknown) => typeof b === "object" && b !== null && "type" in (b as Record<string, unknown>) && (b as Record<string, unknown>).type === "toolCall")
  );

  // Skip only if: very short AND no tool usage
  if (!hasToolCalls && (messages.length < 4 || totalChars < 200)) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: `trivial session (${messages.length} messages, ${totalChars} chars, no tools)`,
    };
  }

  // Serialize the session conversation to text
  const serialized = serializeSessionForWiki(messages);

  if (!serialized.trim()) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: "empty session",
    };
  }

  // Build the capture prompt with session content
  const userPrompt = generateSummary(serialized, {
    mode: "session",
    scope,
  });

  // Add session file reference and already-captured pages
  const alreadyCapturedNote = alreadyCaptured && alreadyCaptured.length > 0
    ? `\nPages already captured from this session: ${alreadyCaptured.join(", ")}\nFocus on NEW knowledge not yet in those pages. Update existing pages if there is new information.`
    : "";

  const fullPrompt = [
    userPrompt,
    "",
    `Session file: ${sessionFile}`,
    `Project scope: ${scope.name}`,
    alreadyCapturedNote,
  ].join("\n");

  const agentMessages = await runCaptureAgent(
    wikiDir,
    store,
    scope,
    model,
    modelRegistry,
    fullPrompt,
    timeoutMs,
  );

  // Analyze what the agent did
  if (isNothingCaptured(agentMessages)) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: "trivial session",
    };
  }

  const writtenPaths = extractWrittenPages(agentMessages);

  if (writtenPaths.length === 0) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: "no pages written",
    };
  }

  const { created, updated } = await buildPageRefs(wikiDir, writtenPaths);
  const allPageSlugs = writtenPaths.map((p) => p.split("/").pop() ?? p);

  // Build a summary from the last assistant message text
  const summary = extractAssistantSummary(agentMessages);

  // Append session digest
  const digestEntry: SessionDigest = {
    date: new Date().toISOString().split("T")[0],
    project: scope.name,
    sessionFile,
    scope: scope.name,
    capturedPages: allPageSlugs,
    summary: summary || `Captured ${writtenPaths.length} page(s) from session.`,
  };

  await appendSessionDigest(wikiDir, digestEntry);

  return {
    pagesCreated: created,
    pagesUpdated: updated,
    skipped: false,
    digestEntry,
  };
}

/**
 * Called when user explicitly requests capture mid-session via /wiki-capture.
 * Spins up a standalone Agent with wiki tools.
 */
export async function explicitCapture(
  wikiDir: string,
  store: QMDStore,
  topic: string | undefined,
  messages: AgentMessage[],
  scope: ProjectScope,
  sessionFile: string,
  model: Model<any>,
  modelRegistry: ModelRegistry,
): Promise<CaptureResult> {
  // Serialize the session conversation to text
  const serialized = serializeSessionForWiki(messages);

  if (!serialized.trim()) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: "empty session",
    };
  }

  // Build the explicit capture prompt
  const topicInstruction = topic
    ? `\n\nFocus on capturing knowledge about: ${topic}`
    : "\n\nIdentify and capture any valuable knowledge from this session.";

  const userPrompt = [
    EXPLICIT_CAPTURE_PROMPT,
    topicInstruction,
    "",
    `Session file: ${sessionFile}`,
    `Project scope: ${scope.name}`,
    "",
    "<session-conversation>",
    serialized,
    "</session-conversation>",
  ].join("\n");

  const agentMessages = await runCaptureAgent(
    wikiDir,
    store,
    scope,
    model,
    modelRegistry,
    userPrompt,
    // Explicit capture gets a generous timeout (60s)
    60_000,
  );

  // Analyze what the agent did
  if (isNothingCaptured(agentMessages)) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: "trivial session",
    };
  }

  const writtenPaths = extractWrittenPages(agentMessages);

  if (writtenPaths.length === 0) {
    return {
      pagesCreated: [],
      pagesUpdated: [],
      skipped: true,
      reason: "no pages written",
    };
  }

  const { created, updated } = await buildPageRefs(wikiDir, writtenPaths);
  const allPageSlugs = writtenPaths.map((p) => p.split("/").pop() ?? p);

  const summary = extractAssistantSummary(agentMessages);

  // Append session digest
  const digestEntry: SessionDigest = {
    date: new Date().toISOString().split("T")[0],
    project: scope.name,
    sessionFile,
    scope: scope.name,
    capturedPages: allPageSlugs,
    summary: summary || `Captured ${writtenPaths.length} page(s) from session.`,
  };

  await appendSessionDigest(wikiDir, digestEntry);

  return {
    pagesCreated: created,
    pagesUpdated: updated,
    skipped: false,
    digestEntry,
  };
}

// -- Internal helpers --------------------------------------------------------

/**
 * Extract a summary string from the agent's last assistant message.
 * Used for the session digest summary field.
 */
function extractAssistantSummary(messages: AgentMessage[]): string {
  // Walk backwards to find the last assistant text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null || !("role" in (msg as object))) continue;
    const m = msg as unknown as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    const content = m.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as unknown as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }

    if (texts.length > 0) {
      const full = texts.join(" ").trim();
      // Truncate to a reasonable summary length
      if (full.length > 300) {
        return full.slice(0, 297) + "...";
      }
      return full;
    }
    break;
  }
  return "";
}
