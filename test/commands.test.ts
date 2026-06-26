import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWiki, writePage, readPage, listPages, PARA_CATEGORIES, appendLog } from "../src/wiki.js";
import type { WikiPage, PageFrontmatter } from "../src/wiki.js";
import { openStore, closeStore } from "../src/store.js";
import type { QMDStore } from "../src/store.js";
import type { ProjectScope } from "../src/scope.js";
import { registerCommands } from "../src/commands.js";

// -- Helpers -----------------------------------------------------------------

function makeScope(name: string, extra?: Partial<ProjectScope>): ProjectScope {
  return {
    name,
    include: [name, ...(extra?.include ?? [])],
    exclude: extra?.exclude ?? [],
    source: extra?.source ?? "git-remote",
  };
}

function makeFrontmatter(overrides: Partial<PageFrontmatter> = {}): PageFrontmatter {
  return {
    title: "Test Page",
    para: "resources",
    scope: ["global"],
    tags: [],
    sources: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    links: [],
    ...overrides,
  };
}

function makePage(
  category: WikiPage["category"],
  slug: string,
  overrides: Partial<Omit<WikiPage, "category" | "slug">> = {},
): WikiPage {
  return {
    category,
    slug,
    frontmatter: makeFrontmatter({
      title: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      para: category,
      ...overrides.frontmatter,
    }),
    body: overrides.body ?? `Content about ${slug}.`,
  };
}

/** Minimal mock for ExtensionCommandContext */
function createMockCtx() {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: vi.fn((message: string, type?: string) => {
        notifications.push({ message, type });
      }),
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      custom: vi.fn(),
      onTerminalInput: vi.fn(),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
    },
    cwd: "/tmp",
    sessionManager: {
      getBranch: vi.fn(() => []),
      getSessionFile: vi.fn(() => "test-session.jsonl"),
      getCwd: vi.fn(() => "/tmp"),
      getSessionDir: vi.fn(() => "/tmp"),
      getSessionId: vi.fn(() => "test-id"),
      getLeafId: vi.fn(() => "leaf-id"),
      getLeafEntry: vi.fn(() => undefined),
      getEntry: vi.fn(() => undefined),
      getLabel: vi.fn(() => undefined),
      getHeader: vi.fn(() => undefined),
      getEntries: vi.fn(() => []),
      getTree: vi.fn(() => []),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {},
    model: { id: "test-model", provider: "test" },
    isIdle: vi.fn(() => true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ""),
    waitForIdle: vi.fn(async () => {}),
    newSession: vi.fn(),
    fork: vi.fn(),
    navigateTree: vi.fn(),
    switchSession: vi.fn(),
    reload: vi.fn(),
  };
  return { ctx, notifications };
}

/** Minimal mock for ExtensionAPI that captures registered commands */
function createMockPi() {
  const commands = new Map<string, {
    description?: string;
    getArgumentCompletions?: (prefix: string) => any;
    handler: (args: string, ctx: any) => Promise<void>;
  }>();

  const userMessages: Array<string | unknown[]> = [];

  const pi = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, options: any) => {
      commands.set(name, options);
    }),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn((content: string | unknown[]) => {
      userMessages.push(content);
    }),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
  };

  return { pi, commands, userMessages };
}

// -- Test suite --------------------------------------------------------------

describe("commands", () => {
  let wikiDir: string;
  let store: QMDStore;
  let scope: ProjectScope;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "wiki-cmd-test-"));
    await initWiki(wikiDir);
    store = await openStore(wikiDir);
    scope = makeScope("test-project");
  }, 30_000);

  afterEach(async () => {
    await closeStore(store);
    await rm(wikiDir, { recursive: true, force: true });
  }, 30_000);

  describe("/wiki", () => {
    it("should show status with scope and page counts", async () => {
      // Add some pages
      await writePage(wikiDir, makePage("projects", "auth-refactor", {
        frontmatter: { scope: ["test-project"], tags: ["auth"] },
      }));
      await writePage(wikiDir, makePage("resources", "ssl-guide", {
        frontmatter: { scope: ["global"], tags: ["ssl"] },
      }));

      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const cmd = commands.get("wiki");
      expect(cmd).toBeDefined();

      const { ctx, notifications } = createMockCtx();
      await cmd!.handler("", ctx);

      expect(notifications.length).toBe(1);
      const msg = notifications[0].message;
      expect(msg).toContain("test-project");
      expect(msg).toContain("git-remote");
      expect(msg).toContain("projects: 1");
      expect(msg).toContain("resources: 1");
      expect(msg).toContain("2 total");
    });

    it("should show recent log entries", async () => {
      await appendLog(wikiDir, {
        date: "2026-01-15",
        operation: "ingest",
        summary: "Ingested SSL article",
        pages: ["resources/ssl-guide"],
      });
      await appendLog(wikiDir, {
        date: "2026-01-16",
        operation: "capture",
        summary: "Captured auth session",
        pages: ["projects/auth-refactor"],
      });

      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki")!.handler("", ctx);

      const msg = notifications[0].message;
      expect(msg).toContain("Ingested SSL article");
      expect(msg).toContain("Captured auth session");
    });

    it("should show 'No activity logged yet' for empty log", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki")!.handler("", ctx);

      expect(notifications[0].message).toContain("No activity logged yet");
    });
  });

  describe("/wiki-ingest", () => {
    it("should send user message with source after waiting for idle", async () => {
      const { pi, commands, userMessages } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx } = createMockCtx();
      await commands.get("wiki-ingest")!.handler("https://example.com/article", ctx);

      expect(ctx.waitForIdle).toHaveBeenCalled();
      expect(userMessages.length).toBe(1);
      expect(userMessages[0]).toContain("https://example.com/article");
    });

    it("should show error when no source provided", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-ingest")!.handler("", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("Usage");
    });
  });

  describe("/wiki-lint", () => {
    it("should run lint with auto-fix by default", async () => {
      // Create a page with a broken link for the lint to find
      await writePage(wikiDir, makePage("resources", "test-page", {
        body: "Content with [[broken-link]].",
        frontmatter: { scope: ["global"], links: ["broken-link"] },
      }));

      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-lint")!.handler("", ctx);

      // Should have two notifications: "Running..." and the report
      expect(notifications.length).toBe(2);
      const report = notifications[1].message;
      expect(report).toContain("Pages:");
    });

    it("should run report-only when --report-only flag is passed", async () => {
      await writePage(wikiDir, makePage("resources", "test-page", {
        body: "Content with [[broken-link]].",
        frontmatter: { scope: ["global"], links: ["broken-link"] },
      }));

      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-lint")!.handler("--report-only", ctx);

      expect(notifications.length).toBe(2);
      const report = notifications[1].message;
      // In report-only mode, broken links should remain as issues (not fixed)
      expect(report).toContain("broken-link");
    });

    it("should provide --report-only completion", () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const cmd = commands.get("wiki-lint")!;
      const completions = cmd.getArgumentCompletions!("--r");
      expect(completions).toEqual([{ value: "--report-only", label: "--report-only" }]);
    });
  });

  describe("/wiki-scope", () => {
    it("should show current scope when no args", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-scope")!.handler("", ctx);

      expect(notifications[0].message).toContain("test-project");
      expect(notifications[0].message).toContain("git-remote");
    });

    it("should override scope when args provided", async () => {
      const { pi, commands } = createMockPi();
      let currentScope = scope;
      registerCommands(
        pi as any, wikiDir, store,
        () => currentScope,
        (s) => { currentScope = s; },
      );

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-scope")!.handler("my-project", ctx);

      expect(notifications[0].message).toContain("my-project");
      expect(currentScope.name).toBe("my-project");
      expect(currentScope.include).toContain("my-project");
    });
  });

  describe("/wiki-search", () => {
    it("should show 'no results' for empty wiki", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-search")!.handler("nonexistent topic", ctx);

      expect(notifications[0].message).toContain("No results");
    });

    it("should show error when no query provided", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-search")!.handler("", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("Usage");
    });
  });

  describe("/wiki-summarize", () => {
    it("should send user message with target via sendUserMessage", async () => {
      const { pi, commands, userMessages } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx } = createMockCtx();
      await commands.get("wiki-summarize")!.handler("projects", ctx);

      expect(ctx.waitForIdle).toHaveBeenCalled();
      expect(userMessages.length).toBe(1);
      expect(userMessages[0]).toContain("projects");
    });

    it("should default to 'all' when no target given", async () => {
      const { pi, commands, userMessages } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx } = createMockCtx();
      await commands.get("wiki-summarize")!.handler("", ctx);

      expect(userMessages[0]).toContain("all");
    });

    it("should provide argument completions", () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const cmd = commands.get("wiki-summarize")!;
      const completions = cmd.getArgumentCompletions!("p");
      expect(completions).toEqual([{ value: "projects", label: "projects" }]);

      const allCompletions = cmd.getArgumentCompletions!("a");
      expect(allCompletions).toEqual(
        expect.arrayContaining([
          { value: "areas", label: "areas" },
          { value: "archives", label: "archives" },
          { value: "all", label: "all" },
        ]),
      );
    });
  });

  describe("/wiki-project", () => {
    it("should create a project page with correct structure", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("auth-refactor Refactor auth to use JWT tokens", ctx);

      expect(notifications[0].type).toBe("info");
      expect(notifications[0].message).toContain("projects/auth-refactor");

      // Verify page was created
      const page = await readPage(wikiDir, "projects", "auth-refactor");
      expect(page).not.toBeNull();
      expect(page!.frontmatter.title).toBe("Auth Refactor");
      expect(page!.frontmatter.para).toBe("projects");
      expect(page!.frontmatter.scope).toContain("test-project");
      expect(page!.body).toContain("## Goal");
      expect(page!.body).toContain("Refactor auth to use JWT tokens");
      expect(page!.body).toContain("## Status");
      expect(page!.body).toContain("- [ ] Define scope and milestones");
      expect(page!.body).toContain("- [ ] Implementation");
      expect(page!.body).toContain("- [ ] Verification");
      expect(page!.body).toContain("## End Condition");
      expect(page!.body).toContain("Refactor auth to use JWT tokens \u2014 verified and complete.");
      expect(page!.body).toContain("## Connections");
    });

    it("should rebuild index after creating a project", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx } = createMockCtx();
      await commands.get("wiki-project")!.handler("my-proj Build the thing", ctx);

      const index = await readFile(join(wikiDir, "index.md"), "utf-8");
      expect(index).toContain("[[my-proj]]");
    });

    it("should convert special chars and spaces in name to kebab-case", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("My_Cool.Project Do something", ctx);

      expect(notifications[0].type).toBe("info");
      // my_cool.project -> my-cool-project
      const page = await readPage(wikiDir, "projects", "my-cool-project");
      expect(page).not.toBeNull();
      expect(page!.frontmatter.title).toBe("My Cool Project");
    });

    it("should show error when no goal is provided", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("my-proj", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("Usage");
    });

    it("should show error when no args provided", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("Usage");
    });

    it("should reject invalid project name with only special chars", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("!@#$ Do something", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("Invalid project name");
    });
  });

  describe("/wiki-project done", () => {
    it("should move project to archives", async () => {
      // First create a project page
      await writePage(wikiDir, makePage("projects", "auth-refactor", {
        frontmatter: { scope: ["test-project"], title: "Auth Refactor" },
        body: "# Auth Refactor\n\n## Goal\nRefactor auth",
      }));

      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("done auth-refactor", ctx);

      expect(notifications[0].type).toBe("info");
      expect(notifications[0].message).toContain("Archived");
      expect(notifications[0].message).toContain("archives/auth-refactor");

      // Verify page moved
      const archived = await readPage(wikiDir, "archives", "auth-refactor");
      expect(archived).not.toBeNull();
      expect(archived!.frontmatter.para).toBe("archives");

      // Verify original is gone
      const original = await readPage(wikiDir, "projects", "auth-refactor");
      expect(original).toBeNull();
    });

    it("should rebuild index after archiving", async () => {
      await writePage(wikiDir, makePage("projects", "old-proj", {
        frontmatter: { scope: ["test-project"], title: "Old Proj" },
        body: "# Old Proj\n\nDone.",
      }));

      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx } = createMockCtx();
      await commands.get("wiki-project")!.handler("done old-proj", ctx);

      const index = await readFile(join(wikiDir, "index.md"), "utf-8");
      // Should be in archives section, not projects
      expect(index).toContain("[[old-proj]]");
      expect(index).toContain("## Archives");
    });

    it("should show error when project not found", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("done nonexistent", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("not found");
    });

    it("should show error when no name provided after done", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-project")!.handler("done", ctx);

      expect(notifications[0].type).toBe("error");
      expect(notifications[0].message).toContain("Usage");
    });
  });

  describe("/wiki-scheduler", () => {
    it("should show scheduler status and keep /wiki-daemon as alias", async () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      expect(commands.has("wiki-scheduler")).toBe(true);
      expect(commands.has("wiki-daemon")).toBe(true);

      const { ctx, notifications } = createMockCtx();
      await commands.get("wiki-scheduler")!.handler("status", ctx);
      expect(notifications[0].message).toContain("Scheduler: active");
      expect(notifications[0].message).toContain("Queue:");
    });
  });

  describe("registerCommands", () => {
    it("should register all 12 commands", () => {
      const { pi, commands } = createMockPi();
      registerCommands(pi as any, wikiDir, store, () => scope, (s) => { scope = s; });

      expect(commands.size).toBe(12);
      expect(commands.has("wiki")).toBe(true);
      expect(commands.has("wiki-ingest")).toBe(true);
      expect(commands.has("wiki-lint")).toBe(true);
      expect(commands.has("wiki-capture")).toBe(true);
      expect(commands.has("wiki-scope")).toBe(true);
      expect(commands.has("wiki-search")).toBe(true);
      expect(commands.has("wiki-summarize")).toBe(true);
      expect(commands.has("wiki-migrate")).toBe(true);
      expect(commands.has("wiki-project")).toBe(true);
      expect(commands.has("wiki-scheduler")).toBe(true);
      expect(commands.has("wiki-daemon")).toBe(true);
    });
  });
});
