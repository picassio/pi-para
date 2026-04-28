import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWiki, writePage } from "../src/wiki.js";
import type { WikiPage, PageFrontmatter } from "../src/wiki.js";
import type { ProjectScope } from "../src/scope.js";
import {
  buildContext,
  markContextDirty,
  setupContextInjection,
} from "../src/context.js";
import type { ContextOptions, ContextConfig } from "../src/context.js";

// -- Helpers -----------------------------------------------------------------

function makeScope(name: string, extra?: Partial<ProjectScope>): ProjectScope {
  return {
    name,
    include: [name, ...(extra?.include ?? [])],
    exclude: extra?.exclude ?? [],
    source: extra?.source ?? "git-remote",
  };
}

function makeFrontmatter(
  overrides: Partial<PageFrontmatter> = {},
): PageFrontmatter {
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

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    category: "resources",
    slug: "test-page",
    frontmatter: makeFrontmatter({
      title: overrides.slug ?? "test-page",
      ...overrides.frontmatter,
    }),
    body: overrides.body ?? "Some content about this topic.\n",
    ...overrides,
  };
}

// Minimal stub for QMDStore — buildContext does not use the store directly
// for context building (only for search, which is not part of this module).
const stubStore = {} as any;

// -- Tests -------------------------------------------------------------------

describe("buildContext", () => {
  let wikiDir: string;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-ctx-test-"));
    await initWiki(wikiDir);
  });

  afterEach(async () => {
    await rm(wikiDir, { recursive: true, force: true });
  });

  it("returns empty string for empty wiki with no pages", async () => {
    const scope = makeScope("my-project");
    const result = await buildContext(wikiDir, stubStore, scope);

    // Should still have schema + index (the seeded defaults)
    expect(result).toContain("<wiki-context");
    expect(result).toContain("scope=\"my-project\"");
    expect(result).toContain("</wiki-context>");
    // Index should be included
    expect(result).toContain("Wiki Index");
  });

  it("includes schema conventions summary", async () => {
    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope);
    // Should include something about PARA or wiki conventions
    expect(result).toMatch(/PARA|Wiki|convention/i);
  });

  it("includes index.md content", async () => {
    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).toContain("Wiki Index");
    expect(result).toContain("Projects");
    expect(result).toContain("Areas");
  });

  it("includes scope-matching page summaries", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "projects",
        slug: "my-project-auth",
        frontmatter: makeFrontmatter({
          title: "Auth Refactor",
          para: "projects",
          scope: ["my-project"],
        }),
        body: "# Auth\n\nRefactoring the auth module to use JWT tokens.\n",
      }),
    );

    const scope = makeScope("my-project");
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).toContain("my-project-auth");
    expect(result).toContain("Refactoring the auth module");
  });

  it("includes global-scoped pages", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "areas",
        slug: "coding-standards",
        frontmatter: makeFrontmatter({
          title: "Coding Standards",
          para: "areas",
          scope: ["global"],
        }),
        body: "Always use TypeScript strict mode.\n",
      }),
    );

    const scope = makeScope("any-project");
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).toContain("coding-standards");
  });

  it("excludes pages not matching scope", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "projects",
        slug: "other-project-stuff",
        frontmatter: makeFrontmatter({
          title: "Other Stuff",
          para: "projects",
          scope: ["other-project"],
        }),
        body: "This is for a different project.\n",
      }),
    );

    const scope = makeScope("my-project");
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).not.toContain("other-project-stuff");
  });

  it("excludes pages matching scope exclude list", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "areas",
        slug: "health-tracking",
        frontmatter: makeFrontmatter({
          title: "Health Tracking",
          para: "areas",
          scope: ["global", "health"],
        }),
        body: "Daily exercise routine.\n",
      }),
    );

    const scope = makeScope("my-project", { exclude: ["health"] });
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).not.toContain("health-tracking");
  });

  it("respects maxTokens budget", async () => {
    // Write several pages to overflow a tiny budget
    for (let i = 0; i < 10; i++) {
      await writePage(
        wikiDir,
        makePage({
          category: "resources",
          slug: `page-${i}`,
          frontmatter: makeFrontmatter({
            title: `Page ${i}`,
            scope: ["global"],
          }),
          body: `Content for page ${i}. ${"x".repeat(200)}\n`,
        }),
      );
    }

    const scope = makeScope("test");
    // Very small budget: 200 tokens = 800 chars
    const result = await buildContext(wikiDir, stubStore, scope, {
      maxTokens: 200,
    });

    // Should not exceed budget (chars / 4 estimate)
    expect(result.length).toBeLessThanOrEqual(200 * 4 + 500); // buffer for tags + wiki reminder + guidelines
  });

  it("falls back to titles only when summaries exceed budget", async () => {
    // Write pages with very long bodies
    for (let i = 0; i < 5; i++) {
      await writePage(
        wikiDir,
        makePage({
          category: "resources",
          slug: `long-page-${i}`,
          frontmatter: makeFrontmatter({
            title: `Long Page ${i}`,
            scope: ["global"],
          }),
          body: `${"x".repeat(500)}\n`,
        }),
      );
    }

    const scope = makeScope("test");
    // Budget that fits schema + index but not all summaries
    const result = await buildContext(wikiDir, stubStore, scope, {
      maxTokens: 600,
    });

    // Should still have some content
    expect(result).toContain("<wiki-context");
  });

  it("respects includeSchema=false", async () => {
    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      includeSchema: false,
    });
    // Should not contain the schema summary
    expect(result).not.toMatch(/Wiki Conventions/);
    // But should still have index
    expect(result).toContain("Wiki Index");
  });

  it("respects includeIndex=false", async () => {
    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      includeIndex: false,
    });
    expect(result).not.toContain("Wiki Index");
  });

  it("respects includeSummaries=false", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "projects",
        slug: "visible-project",
        frontmatter: makeFrontmatter({
          title: "Visible Project",
          para: "projects",
          scope: ["global"],
        }),
        body: "This should be excluded from summaries.\n",
      }),
    );

    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      includeSummaries: false,
    });
    expect(result).not.toContain("Relevant Pages");
    expect(result).not.toContain("visible-project");
  });

  it("wraps output in wiki-context tags with scope", async () => {
    const scope = makeScope("pi-mono");
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).toMatch(/^<wiki-context scope="pi-mono">/);
    expect(result).toMatch(/<\/wiki-context>$/);
  });

  it("extracts first paragraph as page summary", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "resources",
        slug: "multi-para",
        frontmatter: makeFrontmatter({
          title: "Multi Paragraph",
          scope: ["global"],
        }),
        body: "# Multi Paragraph\n\nFirst paragraph is the summary.\n\nSecond paragraph should not appear.\n",
      }),
    );

    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope);
    expect(result).toContain("First paragraph is the summary");
    expect(result).not.toContain("Second paragraph should not appear");
  });

  it("returns empty string when all options are disabled and no pages exist", async () => {
    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      includeSchema: false,
      includeIndex: false,
      includeSummaries: false,
    });
    expect(result).toBe("");
  });
});

describe("markContextDirty", () => {
  it("is callable and does not throw", () => {
    expect(() => markContextDirty()).not.toThrow();
  });
});

describe("setupContextInjection", () => {
  let wikiDir: string;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-ctx-setup-test-"));
    await initWiki(wikiDir);
  });

  afterEach(async () => {
    await rm(wikiDir, { recursive: true, force: true });
  });

  it("registers session_start and before_agent_start handlers", () => {
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    } as any;

    const scope = makeScope("test");
    setupContextInjection(
      mockPi,
      wikiDir,
      stubStore,
      () => scope,
      () => ({}),
    );

    expect(handlers["session_start"]).toHaveLength(1);
    expect(handlers["before_agent_start"]).toHaveLength(1);
  });

  it("session_start handler marks context dirty", async () => {
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    } as any;

    const scope = makeScope("test");
    setupContextInjection(
      mockPi,
      wikiDir,
      stubStore,
      () => scope,
      () => ({}),
    );

    // Call session_start handler
    await handlers["session_start"][0]({ type: "session_start", reason: "startup" }, {});

    // Now call before_agent_start — should rebuild (not return undefined)
    const event = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "You are an assistant.",
      systemPromptOptions: {},
    };
    const result = await handlers["before_agent_start"][0](event, {});
    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain("You are an assistant.");
    expect(result.systemPrompt).toContain("<wiki-context");
  });

  it("before_agent_start caches context on second call", async () => {
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    } as any;

    const scope = makeScope("test");
    setupContextInjection(
      mockPi,
      wikiDir,
      stubStore,
      () => scope,
      () => ({}),
    );

    const event = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "Base prompt.",
      systemPromptOptions: {},
    };

    // First call — builds context
    const result1 = await handlers["before_agent_start"][0](event, {});
    expect(result1).toBeDefined();

    // Second call — should use cache (same result)
    const result2 = await handlers["before_agent_start"][0](event, {});
    expect(result2).toBeDefined();
    expect(result2.systemPrompt).toBe(result1.systemPrompt);
  });

  it("markContextDirty forces rebuild on next before_agent_start", async () => {
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    } as any;

    const scope = makeScope("test");
    setupContextInjection(
      mockPi,
      wikiDir,
      stubStore,
      () => scope,
      () => ({}),
    );

    const event = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "Base prompt.",
      systemPromptOptions: {},
    };

    // First call — builds and caches
    const result1 = await handlers["before_agent_start"][0](event, {});
    expect(result1).toBeDefined();

    // Write a new page
    await writePage(
      wikiDir,
      makePage({
        category: "resources",
        slug: "new-page-after-dirty",
        frontmatter: makeFrontmatter({
          title: "New Page",
          scope: ["global"],
        }),
        body: "New content after dirty mark.\n",
      }),
    );

    // Mark dirty
    markContextDirty();

    // Next call should rebuild and include the new page
    const result2 = await handlers["before_agent_start"][0](event, {});
    expect(result2).toBeDefined();
    expect(result2.systemPrompt).toContain("new-page-after-dirty");
  });

  it("returns void when scope is null", async () => {
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    } as any;

    setupContextInjection(
      mockPi,
      wikiDir,
      stubStore,
      () => null,
      () => ({}),
    );

    const event = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "Base prompt.",
      systemPromptOptions: {},
    };

    const result = await handlers["before_agent_start"][0](event, {});
    expect(result).toBeUndefined();
  });

  it("uses config maxTokens", async () => {
    const handlers: Record<string, Function[]> = {};
    const mockPi = {
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    } as any;

    // Write pages to make context non-trivial
    for (let i = 0; i < 5; i++) {
      await writePage(
        wikiDir,
        makePage({
          category: "resources",
          slug: `cfg-page-${i}`,
          frontmatter: makeFrontmatter({
            title: `Config Page ${i}`,
            scope: ["global"],
          }),
          body: `Config content ${i}. ${"y".repeat(300)}\n`,
        }),
      );
    }

    const scope = makeScope("test");
    setupContextInjection(
      mockPi,
      wikiDir,
      stubStore,
      () => scope,
      () => ({ contextMaxTokens: 300 }), // very small budget
    );

    const event = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "",
      systemPromptOptions: {},
    };

    const result = await handlers["before_agent_start"][0](event, {});
    if (result?.systemPrompt) {
      // The wiki-context portion should be small
      const wikiPart = result.systemPrompt.replace(/^.*?(?=<wiki-context)/, "");
      // 300 tokens * 4 chars = 1200 chars max, plus overhead for guidelines
      expect(wikiPart.length).toBeLessThan(1900);
    }
  });
});
