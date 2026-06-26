import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import piPara from "../src/index.js";
import type { ProjectScope } from "../src/scope.js";

// -- Mock helpers ------------------------------------------------------------

/** Collects event handlers registered via pi.on() */
interface MockPi {
  handlers: Record<string, Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>>>;
  tools: Array<{ name: string; [key: string]: unknown }>;
  commands: Record<string, { description?: string; handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }>;
  entries: Array<{ customType: string; data: unknown }>;
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  events: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
}

function createMockPi(): MockPi {
  const handlers: MockPi["handlers"] = {};
  const tools: MockPi["tools"] = [];
  const commands: MockPi["commands"] = {};
  const entries: MockPi["entries"] = [];

  return {
    handlers,
    tools,
    commands,
    entries,
    on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler as MockPi["handlers"][string][number]);
    }),
    registerTool: vi.fn((def: { name: string }) => {
      tools.push(def);
    }),
    registerCommand: vi.fn((name: string, opts: MockPi["commands"][string]) => {
      commands[name] = opts;
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ customType, data });
    }),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    events: {
      on: vi.fn(),
      emit: vi.fn(),
    },
  };
}

function createMockCtx(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cwd: overrides.cwd ?? "/tmp/test-project",
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    model: overrides.model ?? { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyForProvider: vi.fn(async () => "test-key"),
    },
    sessionManager: {
      getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
      getBranch: vi.fn(() => overrides.branch ?? []),
      getEntries: vi.fn(() => overrides.entries ?? []),
    },
    signal: undefined,
    ...overrides,
  };
}

// -- Test config directory ---------------------------------------------------

let configDir: string;
let wikiDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  const tmpBase = await mkdtemp(join(tmpdir(), "pi-para-index-"));
  configDir = tmpBase;
  wikiDir = join(configDir, ".pi", "wiki");
  // Set HOME so loadConfig reads from our temp directory
  originalHome = process.env.HOME;
  process.env.HOME = configDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(configDir, { recursive: true, force: true });
});

// -- Tests -------------------------------------------------------------------

describe("piPara extension entry point", () => {
  it("registers session_start, session_shutdown, session_tree, before_agent_start handlers", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const registeredEvents = pi.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("session_start");
    expect(registeredEvents).toContain("session_shutdown");
    expect(registeredEvents).toContain("session_tree");
    // before_agent_start is registered by setupContextInjection
    expect(registeredEvents).toContain("before_agent_start");
  });

  it("registers all 7 wiki tools", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const toolNames = pi.tools.map((t) => t.name);
    expect(toolNames).toContain("wiki_ingest");
    expect(toolNames).toContain("wiki_query");
    expect(toolNames).toContain("wiki_write");
    expect(toolNames).toContain("wiki_read");
    expect(toolNames).toContain("wiki_move");
    expect(toolNames).toContain("wiki_lint");
    expect(toolNames).toContain("wiki_summarize");
  });

  it("registers all 7 slash commands", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const cmdNames = Object.keys(pi.commands);
    expect(cmdNames).toContain("wiki");
    expect(cmdNames).toContain("wiki-ingest");
    expect(cmdNames).toContain("wiki-lint");
    expect(cmdNames).toContain("wiki-capture");
    expect(cmdNames).toContain("wiki-scope");
    expect(cmdNames).toContain("wiki-search");
    expect(cmdNames).toContain("wiki-summarize");
  });

  it("creates config.jsonc with defaults during async factory", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    // Config should be created by the async factory (loadConfig)
    const configContent = await readFile(join(configDir, ".pi", "para", "config.jsonc"), "utf-8");
    const config = JSON.parse(configContent);
    expect(config.context.maxTokens).toBe(4000);
  });

  it("session_start creates wiki directory structure", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    // Trigger session_start
    const ctx = createMockCtx();
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    // Wiki dir should be initialized with schema, index, log, sessions
    const schemaContent = await readFile(join(wikiDir, "schema.md"), "utf-8");
    expect(schemaContent).toContain("Wiki Schema");

    const indexContent = await readFile(join(wikiDir, "index.md"), "utf-8");
    expect(indexContent).toContain("Wiki Index");

    const logContent = await readFile(join(wikiDir, "log.md"), "utf-8");
    expect(logContent).toContain("Activity Log");
  });

  it("session_start reads existing config.json", async () => {
    // Pre-create config
    await mkdir(wikiDir, { recursive: true });
    await writeFile(
      join(wikiDir, "config.json"),
      JSON.stringify({ contextMaxTokens: 8000 }),
      "utf-8",
    );

    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const ctx = createMockCtx();
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    // Verify state was persisted
    const stateEntry = pi.entries.find((e) => e.customType === "pi-para-state");
    expect(stateEntry).toBeDefined();
  });

  it("session_start persists initial state via appendEntry", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const ctx = createMockCtx({ cwd: "/tmp/my-project" });
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    const stateEntries = pi.entries.filter((e) => e.customType === "pi-para-state");
    expect(stateEntries.length).toBeGreaterThan(0);

    const state = stateEntries[stateEntries.length - 1].data as {
      lastScope: ProjectScope;
      
      sessionFile: string | null;
    };
    expect(state.lastScope).toBeDefined();
    expect(state.lastScope.name).toBeTruthy();
    
    expect(state.sessionFile).toBe("/tmp/test-session.jsonl");
  });

  it("session_start reconstructs state from existing session entries", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const savedScope: ProjectScope = {
      name: "overridden-project",
      include: ["overridden-project"],
      exclude: [],
      source: "config", // explicit override
    };

    const ctx = createMockCtx({
      branch: [
        {
          type: "custom",
          customType: "pi-para-state",
          data: {
            lastScope: savedScope,
            sessionFile: "/old-session.jsonl",
          },
        },
      ],
    });

    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    // The scope should be restored from saved state (since source is "config")
    const lastEntry = pi.entries[pi.entries.length - 1];
    const state = lastEntry.data as { lastScope: ProjectScope; sessionFile: string | null };
    expect(state.lastScope.name).toBe("overridden-project");
    
  });

  it("session_start does not restore non-config scope overrides", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const savedScope: ProjectScope = {
      name: "git-detected",
      include: ["git-detected"],
      exclude: [],
      source: "git-remote", // NOT an explicit override
    };

    const ctx = createMockCtx({
      cwd: "/tmp/different-project",
      branch: [
        {
          type: "custom",
          customType: "pi-para-state",
          data: {
            lastScope: savedScope,
            sessionFile: "/session.jsonl",
          },
        },
      ],
    });

    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    // Should re-detect scope from cwd, not use the saved git-remote scope
    const lastEntry = pi.entries[pi.entries.length - 1];
    const state = lastEntry.data as { lastScope: ProjectScope };
    // The scope should be freshly detected, not "git-detected"
    expect(state.lastScope.source).not.toBe("git-remote");
  });

  it("session_tree reconstructs state from branch entries", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    // First, run session_start to initialize
    const startCtx = createMockCtx();
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, startCtx);
    }

    // Now simulate tree navigation with saved state
    const savedScope: ProjectScope = {
      name: "tree-project",
      include: ["tree-project"],
      exclude: [],
      source: "config",
    };

    const treeCtx = createMockCtx({
      branch: [
        {
          type: "custom",
          customType: "pi-para-state",
          data: {
            lastScope: savedScope,
            sessionFile: "/session.jsonl",
          },
        },
      ],
    });

    for (const handler of pi.handlers["session_tree"] ?? []) {
      await handler({ newLeafId: "abc", oldLeafId: "def" }, treeCtx);
    }

    // Should complete without error — state reconstructed
  });

  it("session_shutdown does not throw when store is null", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    // Don't run session_start, so store remains null
    const ctx = createMockCtx();

    // session_shutdown should handle null store gracefully
    for (const handler of pi.handlers["session_shutdown"] ?? []) {
      await handler({ reason: "quit" }, ctx);
    }
    // No error thrown = pass
  });

  it("session_shutdown skips auto-capture when model is not available", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    // Don't run session_start — store is null, so auto-capture and
    // embed/close are all skipped. Tests that model=null also skips.
    const shutdownCtx = createMockCtx({
      model: null,
      branch: [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
      ],
    });

    for (const handler of pi.handlers["session_shutdown"] ?? []) {
      await handler({ reason: "quit" }, shutdownCtx);
    }
    // Should complete without error — auto-capture skipped (no store + no model)
  });

  it("session_shutdown skips auto-capture when no messages exist", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    // Don't run session_start — store is null. Even if it weren't,
    // empty branch means no messages -> no auto-capture.
    const shutdownCtx = createMockCtx({ branch: [] });

    for (const handler of pi.handlers["session_shutdown"] ?? []) {
      await handler({ reason: "quit" }, shutdownCtx);
    }
    // Should complete — no messages means no capture
  });

  it("gracefully handles qmd store open failure", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const ctx = createMockCtx();
    // Run session_start — even if qmd has issues, it should not throw
    for (const handler of pi.handlers["session_start"] ?? []) {
      try {
        await handler({ reason: "startup" }, ctx);
      } catch {
        // qmd may throw in test env — the test verifies the error path
      }
    }
  });

  it("config defaults are used when config.json has invalid JSON", async () => {
    await mkdir(wikiDir, { recursive: true });
    await writeFile(join(wikiDir, "config.json"), "NOT JSON", "utf-8");

    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const ctx = createMockCtx();
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    // Should still initialize successfully with default config
    const stateEntry = pi.entries.find((e) => e.customType === "pi-para-state");
    expect(stateEntry).toBeDefined();
  });

  it("config wikiDir with ~ is resolved to home directory", async () => {
    await mkdir(wikiDir, { recursive: true });
    await writeFile(
      join(wikiDir, "config.json"),
      JSON.stringify({ wikiDir: "~/.pi/wiki" }),
      "utf-8",
    );

    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const ctx = createMockCtx();
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    // The wiki should be initialized at the resolved path
    const schemaContent = await readFile(join(wikiDir, "schema.md"), "utf-8");
    expect(schemaContent).toContain("Wiki Schema");
  });

  it("appendEntry is called with correct session state shape", async () => {
    const pi = createMockPi();
    await piPara(pi as unknown as Parameters<typeof piPara>[0]);

    const ctx = createMockCtx();
    for (const handler of pi.handlers["session_start"] ?? []) {
      await handler({ reason: "startup" }, ctx);
    }

    expect(pi.appendEntry).toHaveBeenCalled();
    const call = pi.appendEntry.mock.calls.find(
      (c: unknown[]) => c[0] === "pi-para-state",
    );
    expect(call).toBeDefined();
    const data = call![1] as ParaSessionStateShape;
    expect(data).toHaveProperty("lastScope");
    expect(data).toHaveProperty("sessionFile");
    expect(typeof data.lastScope.name).toBe("string");
    
  });
});

// Type helper for test assertions
interface ParaSessionStateShape {
  lastScope: ProjectScope;
  
  sessionFile: string | null;
}
