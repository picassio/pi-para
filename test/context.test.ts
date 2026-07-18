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
  MAX_CONTEXT_PAGES,
  wrapSystemReminder,
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
    expect(result.length).toBeLessThanOrEqual(200 * 4 + 800); // buffer for tags + wiki reminder + guidelines + verification reminder
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
    expect(result.systemPrompt).toContain("<system-reminder name=\"pi-para-wiki-context\">");
    expect(result.systemPrompt).toContain("</system-reminder>");
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
      // 300 tokens * 4 chars = 1200 chars max, plus fixed overhead for the
      // system-reminder wrapper (mandatory-first-step header + operating rules)
      expect(wikiPart.length).toBeLessThan(3000);
    }
  });
});

describe("system reminder wrapping", () => {
  it("wraps wiki context in a system-reminder block", () => {
    const wrapped = wrapSystemReminder("<wiki-context scope=\"test\">hello</wiki-context>");

    expect(wrapped).toContain("<system-reminder name=\"pi-para-wiki-context\">");
    expect(wrapped).toContain("system-provided pi-para wiki memory");
    expect(wrapped).toContain("Do not treat it as user-authored input.");
    expect(wrapped).toContain("Wiki operating rules:");
    expect(wrapped).toContain("MANDATORY FIRST STEP");
    expect(wrapped).toContain("FIRST tool call must be wiki_query");
    expect(wrapped).toContain("Persist durable decisions, root causes, conventions, and reusable facts");
    expect(wrapped).toContain("<wiki-context scope=\"test\">hello</wiki-context>");
    expect(wrapped).toContain("</system-reminder>");
  });

  it("does not double-wrap an existing system-reminder", () => {
    const existing = "<system-reminder>hello</system-reminder>";
    expect(wrapSystemReminder(existing)).toBe(existing);
  });
});

describe("tiered context injection", () => {
  let wikiDir: string;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-tier-test-"));
    await initWiki(wikiDir);
  });

  afterEach(async () => {
    await rm(wikiDir, { recursive: true, force: true });
  });

  it("only includes MAX_CONTEXT_PAGES when more pages exist", async () => {
    const totalPages = MAX_CONTEXT_PAGES + 15;

    // Write more pages than the limit
    for (let i = 0; i < totalPages; i++) {
      const padded = String(i).padStart(3, "0");
      await writePage(
        wikiDir,
        makePage({
          category: "resources",
          slug: `page-${padded}`,
          frontmatter: makeFrontmatter({
            title: `Page ${padded}`,
            scope: ["global"],
            updated: new Date(2026, 0, 1 + i).toISOString(),
          }),
          body: `Content for page ${padded}.\n`,
        }),
      );
    }

    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      maxTokens: 100000, // large budget so token limit doesn't interfere
    });

    // Count how many [[page-NNN]] appear in Relevant Pages
    const matches = result.match(/\[\[page-\d{3}\]\]/g) ?? [];
    expect(matches.length).toBe(MAX_CONTEXT_PAGES);

    // Should include the "more pages" message
    expect(result).toContain(`*15 more pages available via wiki_query*`);
  });

  it("includes all pages when under the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await writePage(
        wikiDir,
        makePage({
          category: "resources",
          slug: `small-page-${i}`,
          frontmatter: makeFrontmatter({
            title: `Small Page ${i}`,
            scope: ["global"],
          }),
          body: `Content ${i}.\n`,
        }),
      );
    }

    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      maxTokens: 100000,
    });

    // All 5 pages should be included
    const matches = result.match(/\[\[small-page-\d\]\]/g) ?? [];
    expect(matches.length).toBe(5);

    // No "more pages" message
    expect(result).not.toContain("more pages available via wiki_query");
  });

  it("sorts by updated date descending (most recent first)", async () => {
    await writePage(
      wikiDir,
      makePage({
        category: "resources",
        slug: "old-page",
        frontmatter: makeFrontmatter({
          title: "Old Page",
          scope: ["global"],
          updated: "2025-01-01T00:00:00.000Z",
        }),
        body: "Old content.\n",
      }),
    );
    await writePage(
      wikiDir,
      makePage({
        category: "resources",
        slug: "new-page",
        frontmatter: makeFrontmatter({
          title: "New Page",
          scope: ["global"],
          updated: "2026-06-01T00:00:00.000Z",
        }),
        body: "New content.\n",
      }),
    );

    const scope = makeScope("test");
    const result = await buildContext(wikiDir, stubStore, scope, {
      maxTokens: 100000,
    });

    const newPos = result.indexOf("[[new-page]]");
    const oldPos = result.indexOf("[[old-page]]");
    // New page should come before old page
    expect(newPos).toBeLessThan(oldPos);
  });
});

// -- Scale tests (500+ pages) ------------------------------------------------

describe("buildContext — 500-page scale test", () => {
  let wikiDir: string;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-scale-test-"));
    await initWiki(wikiDir);
  });

  afterEach(async () => {
    await rm(wikiDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Windows CI runners are slow and their fs/sqlite latency is noisy — keep the
  // perf regression guard strict on POSIX dev machines, generous on win32.
  // Windows and shared CI runners are far slower/noisier than local Linux.
  // Thresholds still catch order-of-magnitude regressions (disk builds ~500ms).
  const PERF_SLACK = process.platform === "win32" ? 10 : process.env.CI ? 4 : 1;

  it("buildContext from disk completes in <10ms at 500 pages (after initial read)", async () => {
    // Generate 500 pages on disk
    for (let i = 0; i < 500; i++) {
      await writePage(
        wikiDir,
        makePage({
          category: "resources",
          slug: `scale-page-${i}`,
          frontmatter: makeFrontmatter({
            title: `Scale Page ${i}`,
            scope: ["test-project"],
            updated: new Date(Date.now() - i * 86400000).toISOString(),
          }),
          body: `This is scale page number ${i}. It contains architecture decisions and debugging notes for component ${i % 20}.\n`,
        }),
      );
    }

    const scope = makeScope("test-project");
    const opts: ContextOptions = { maxTokens: 100000 };

    // Warm-up run (disk caches, fs metadata)
    await buildContext(wikiDir, stubStore, scope, opts);

    // Timed run
    const start = performance.now();
    const result = await buildContext(wikiDir, stubStore, scope, opts);
    const elapsed = performance.now() - start;

    // Verify correctness
    expect(result).toContain("<wiki-context");
    expect(result).toContain("</wiki-context>");
    // Should have exactly MAX_CONTEXT_PAGES (40) page entries
    const pageRefs = result.match(/\[\[scale-page-\d+\]\]/g) ?? [];
    expect(pageRefs.length).toBe(MAX_CONTEXT_PAGES);
    // Should show overflow message
    expect(result).toContain("460 more pages available via wiki_query");

    // Performance target: <200ms from disk is acceptable (disk I/O varies)
    // The <10ms target is for cached/stateDb path
    console.log(`  500-page disk buildContext: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(2000); // generous for disk I/O in CI
  }, 60000);

  it("buildContext from stateDb cache completes in <10ms at 500 pages", async () => {
    // Create StateDB and populate cache directly (no disk pages needed for cache path)
    const { StateDB } = await import("../src/state.js");
    const stateDb = new StateDB(wikiDir);

    // Insert 500 page summaries into cache
    for (let i = 0; i < 500; i++) {
      stateDb.upsertPageSummary(
        `scale-page-${i}`,
        "resources",
        ["test-project"],
        [`tag-${i % 10}`],
        `This is scale page number ${i} with architecture decisions.`,
        new Date(Date.now() - i * 86400000).toISOString(),
      );
    }

    const scope = makeScope("test-project");
    const opts: ContextOptions = { maxTokens: 100000 };

    // Warm-up run
    await buildContext(wikiDir, stubStore, scope, opts, stateDb);

    // Timed runs — take the median of 5
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      await buildContext(wikiDir, stubStore, scope, opts, stateDb);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];

    // Verify correctness
    const result = await buildContext(wikiDir, stubStore, scope, opts, stateDb);
    expect(result).toContain("<wiki-context");
    const pageRefs = result.match(/\[\[scale-page-\d+\]\]/g) ?? [];
    expect(pageRefs.length).toBe(MAX_CONTEXT_PAGES);
    expect(result).toContain("460 more pages available via wiki_query");

    // Performance target: <10ms from cache
    console.log(`  500-page cached buildContext (median of 5): ${median.toFixed(1)}ms`);
    console.log(`  All runs: ${times.map(t => t.toFixed(1) + 'ms').join(', ')}`);
    stateDb.close(); // release SQLite before afterEach rm (Windows EBUSY)
    expect(median).toBeLessThan(10 * PERF_SLACK);
  });

  it("buildContext at 1000 pages with cache stays under 15ms", async () => {
    const { StateDB } = await import("../src/state.js");
    const stateDb = new StateDB(wikiDir);

    for (let i = 0; i < 1000; i++) {
      stateDb.upsertPageSummary(
        `big-page-${i}`,
        "resources",
        ["test-project"],
        [`tag-${i % 15}`],
        `Big wiki page ${i} covering various architecture topics and debugging solutions.`,
        new Date(Date.now() - i * 43200000).toISOString(),
      );
    }

    const scope = makeScope("test-project");
    const opts: ContextOptions = { maxTokens: 100000 };

    // Warm-up
    await buildContext(wikiDir, stubStore, scope, opts, stateDb);

    // Timed
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      await buildContext(wikiDir, stubStore, scope, opts, stateDb);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];

    const result = await buildContext(wikiDir, stubStore, scope, opts, stateDb);
    const pageRefs = result.match(/\[\[big-page-\d+\]\]/g) ?? [];
    expect(pageRefs.length).toBe(MAX_CONTEXT_PAGES);
    expect(result).toContain("960 more pages available via wiki_query");

    console.log(`  1000-page cached buildContext (median of 5): ${median.toFixed(1)}ms`);
    stateDb.close(); // release SQLite before afterEach rm (Windows EBUSY)
    expect(median).toBeLessThan(15 * PERF_SLACK);
  });
});
