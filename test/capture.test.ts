import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWiki, writePage, readPage } from "../src/wiki.js";
import type { WikiPage, ParaCategory } from "../src/wiki.js";
import type { ProjectScope } from "../src/scope.js";
import { openStore, closeStore } from "../src/store.js";
import type { QMDStore } from "../src/store.js";
import { readSessionDigests } from "../src/raw.js";

// We need to mock the Agent class since we can't make real LLM calls in tests.
// The Agent is imported inside capture.ts — we mock the entire module.

// Track what the mock agent receives
let mockAgentPromptCalls: string[] = [];
let mockAgentOptions: any = null;
let mockAgentMessages: any[] = [];

// Control mock agent behavior per test
let mockAgentBehavior: "nothing" | "write-page" | "timeout" | "error" = "nothing";

vi.mock("@mariozechner/pi-agent-core", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-agent-core")>(
    "@mariozechner/pi-agent-core",
  );

  class MockAgent {
    private _state: any;
    private listeners = new Set<(event: any, signal: AbortSignal) => Promise<void> | void>();

    constructor(options: any) {
      mockAgentOptions = options;
      this._state = {
        systemPrompt: options.initialState?.systemPrompt ?? "",
        model: options.initialState?.model ?? {},
        tools: options.initialState?.tools ?? [],
        messages: [],
        isStreaming: false,
        pendingToolCalls: new Set(),
      };
    }

    get state() {
      return this._state;
    }

    subscribe(listener: (event: any, signal: AbortSignal) => Promise<void> | void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    abort() {
      // no-op in mock
    }

    async prompt(input: string | any | any[]) {
      const text = typeof input === "string" ? input : JSON.stringify(input);
      mockAgentPromptCalls.push(text);

      if (mockAgentBehavior === "timeout") {
        // Simulate a long-running agent that gets aborted
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error("aborted");
      }

      if (mockAgentBehavior === "error") {
        throw new Error("LLM call failed");
      }

      if (mockAgentBehavior === "nothing") {
        // Agent responds with "nothing to capture"
        this._state.messages = [
          {
            role: "user",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "After reviewing the session, there is nothing to capture. The session was trivial." }],
            timestamp: Date.now(),
          },
        ];
        mockAgentMessages = this._state.messages;
        return;
      }

      if (mockAgentBehavior === "write-page") {
        // Simulate: agent calls wiki_write (we actually call the tool)
        const tools = this._state.tools as any[];
        const wikiWrite = tools.find((t: any) => t.name === "wiki_write");
        if (wikiWrite) {
          const result = await wikiWrite.execute("call-1", {
            pages: [
              {
                category: "resources" as ParaCategory,
                slug: "ssl-cert-debugging",
                title: "SSL Certificate Debugging",
                scope: ["test-project"],
                tags: ["ssl", "debugging"],
                body: "## Topic\nSSL cert debugging insights.\n\n## Key Facts\n- Check intermediate certs\n\n## Sources\n- session:test-session.jsonl",
                mode: "create",
              },
            ],
            logSummary: "Captured SSL debugging insights from session",
          });

          this._state.messages = [
            {
              role: "user",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "wiki_write",
                  arguments: {},
                },
              ],
              timestamp: Date.now(),
            },
            {
              role: "toolResult",
              content: result.content,
              toolCallId: "call-1",
              toolName: "wiki_write",
              timestamp: Date.now(),
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Captured SSL certificate debugging insights into resources/ssl-cert-debugging.",
                },
              ],
              timestamp: Date.now(),
            },
          ];
        }
        mockAgentMessages = this._state.messages;
        return;
      }
    }
  }

  return {
    ...actual,
    Agent: MockAgent,
  };
});

// Must import AFTER mock setup
import { autoCapture, explicitCapture } from "../src/capture.js";

// -- Helpers -----------------------------------------------------------------

function makePage(
  category: ParaCategory,
  slug: string,
  body: string = `# ${slug}\n\nContent.`,
): WikiPage {
  return {
    category,
    slug,
    frontmatter: {
      title: slug,
      para: category,
      scope: ["test-project"],
      tags: [],
      sources: [],
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      links: [],
    },
    body,
  };
}

const testScope: ProjectScope = {
  name: "test-project",
  include: ["test-project"],
  exclude: [],
  source: "dirname",
};

const testModel = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} as any;

const testModelRegistry = {
  getApiKeyForProvider: async (_provider: string) => "test-key",
} as any;

const testSessionFile = "/home/user/.pi/agent/sessions/test/2026-04-27_abc123.jsonl";

// -- Test setup --------------------------------------------------------------

let wikiDir: string;
let store: QMDStore | null = null;

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "pi-para-capture-test-"));
  await initWiki(wikiDir);
  store = await openStore(wikiDir);

  // Reset mock state
  mockAgentPromptCalls = [];
  mockAgentOptions = null;
  mockAgentMessages = [];
  mockAgentBehavior = "nothing";
});

afterEach(async () => {
  if (store) {
    await closeStore(store);
    store = null;
  }
  await rm(wikiDir, { recursive: true, force: true });
}, 30_000);

// -- Session messages for testing --------------------------------------------

const trivialMessages = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "What time is it?" }],
    timestamp: Date.now(),
  },
  {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "I don't have access to the current time." }],
    timestamp: Date.now(),
  },
];

const substantiveMessages = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Help me debug this SSL cert issue. The intermediate cert is expired." }],
    timestamp: Date.now(),
  },
  {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "The issue is likely an expired intermediate certificate cached by Node.js. Solution: clear the cert cache before renewal." }],
    timestamp: Date.now(),
  },
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "That fixed it. The CI pipeline is now passing." }],
    timestamp: Date.now(),
  },
  {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "The root cause was the intermediate certificate cache. In CI environments, always clear the TLS cert cache before cert operations." }],
    timestamp: Date.now(),
  },
];

// -- autoCapture tests -------------------------------------------------------

describe("autoCapture", () => {
  it("skips empty sessions", async () => {
    const result = await autoCapture(
      wikiDir,
      store!,
      [], // empty messages
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty session");
    expect(result.pagesCreated).toEqual([]);
    expect(result.pagesUpdated).toEqual([]);
    expect(mockAgentPromptCalls).toHaveLength(0);
  });

  it("skips trivial sessions when agent says nothing to capture", async () => {
    mockAgentBehavior = "nothing";

    const result = await autoCapture(
      wikiDir,
      store!,
      trivialMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("trivial session");
    expect(result.pagesCreated).toEqual([]);
    // Agent was called (it decided nothing to capture)
    expect(mockAgentPromptCalls).toHaveLength(1);
  });

  it("captures knowledge from a substantive session", async () => {
    mockAgentBehavior = "write-page";

    const result = await autoCapture(
      wikiDir,
      store!,
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(false);
    expect(result.pagesCreated.length).toBeGreaterThan(0);
    expect(result.pagesCreated[0].slug).toBe("ssl-cert-debugging");
    expect(result.pagesCreated[0].category).toBe("resources");

    // Page was actually written to disk
    const page = await readPage(wikiDir, "resources", "ssl-cert-debugging");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.title).toBe("SSL Certificate Debugging");
    expect(page!.body).toContain("SSL cert debugging insights");
  });

  it("appends session digest after capture", async () => {
    mockAgentBehavior = "write-page";

    const result = await autoCapture(
      wikiDir,
      store!,
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.digestEntry).toBeDefined();
    expect(result.digestEntry!.project).toBe("test-project");
    expect(result.digestEntry!.sessionFile).toBe(testSessionFile);
    expect(result.digestEntry!.capturedPages).toContain("ssl-cert-debugging");

    // Verify sessions.md was written
    const digests = await readSessionDigests(wikiDir);
    expect(digests).toHaveLength(1);
    expect(digests[0].project).toBe("test-project");
  });

  it("passes correct system prompt and model to agent", async () => {
    mockAgentBehavior = "nothing";

    await autoCapture(
      wikiDir,
      store!,
      trivialMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(mockAgentOptions).not.toBeNull();
    expect(mockAgentOptions.initialState.systemPrompt).toContain("knowledge capture");
    expect(mockAgentOptions.initialState.model).toBe(testModel);
    expect(mockAgentOptions.initialState.tools.length).toBe(4); // write, read, query, move
    expect(mockAgentOptions.initialState.messages).toEqual([]);
    expect(mockAgentOptions.getApiKey).toBeDefined();
  });

  it("includes session file and scope in prompt", async () => {
    mockAgentBehavior = "nothing";

    await autoCapture(
      wikiDir,
      store!,
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(mockAgentPromptCalls).toHaveLength(1);
    const prompt = mockAgentPromptCalls[0];
    expect(prompt).toContain(testSessionFile);
    expect(prompt).toContain("test-project");
  });

  it("handles agent errors gracefully", async () => {
    mockAgentBehavior = "error";

    const result = await autoCapture(
      wikiDir,
      store!,
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    // Should not throw, should return skipped
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no pages written");
  });

  it("provides standalone wiki tools to agent", async () => {
    mockAgentBehavior = "nothing";

    await autoCapture(
      wikiDir,
      store!,
      trivialMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    const toolNames = mockAgentOptions.initialState.tools.map((t: any) => t.name);
    expect(toolNames).toContain("wiki_write");
    expect(toolNames).toContain("wiki_read");
    expect(toolNames).toContain("wiki_query");
    expect(toolNames).toContain("wiki_move");
  });
});

// -- explicitCapture tests ---------------------------------------------------

describe("explicitCapture", () => {
  it("skips empty sessions", async () => {
    const result = await explicitCapture(
      wikiDir,
      store!,
      undefined,
      [],
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty session");
  });

  it("captures with user-specified topic", async () => {
    mockAgentBehavior = "write-page";

    const result = await explicitCapture(
      wikiDir,
      store!,
      "SSL certificate debugging",
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(false);
    expect(result.pagesCreated.length).toBeGreaterThan(0);

    // Prompt should include the topic
    const prompt = mockAgentPromptCalls[0];
    expect(prompt).toContain("SSL certificate debugging");
  });

  it("auto-detects topic when none provided", async () => {
    mockAgentBehavior = "write-page";

    const result = await explicitCapture(
      wikiDir,
      store!,
      undefined, // no topic
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(false);
    // Prompt should use the generic instruction
    const prompt = mockAgentPromptCalls[0];
    expect(prompt).toContain("Identify and capture any valuable knowledge");
  });

  it("appends session digest", async () => {
    mockAgentBehavior = "write-page";

    const result = await explicitCapture(
      wikiDir,
      store!,
      "SSL debugging",
      substantiveMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.digestEntry).toBeDefined();
    expect(result.digestEntry!.capturedPages).toContain("ssl-cert-debugging");

    const digests = await readSessionDigests(wikiDir);
    expect(digests).toHaveLength(1);
  });

  it("includes session file in prompt", async () => {
    mockAgentBehavior = "nothing";

    await explicitCapture(
      wikiDir,
      store!,
      undefined,
      trivialMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    const prompt = mockAgentPromptCalls[0];
    expect(prompt).toContain(testSessionFile);
    expect(prompt).toContain("test-project");
  });

  it("skips when agent finds nothing to capture", async () => {
    mockAgentBehavior = "nothing";

    const result = await explicitCapture(
      wikiDir,
      store!,
      "something obscure",
      trivialMessages,
      testScope,
      testSessionFile,
      testModel,
      testModelRegistry,
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("trivial session");
  });
});
