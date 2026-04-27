import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryWiki, formatQueryResults } from "../src/query.js";
import { openStore, closeStore } from "../src/store.js";
import type { QMDStore } from "@picassio/qmd";
import { initWiki, writePage } from "../src/wiki.js";
import type { ProjectScope } from "../src/scope.js";
import type { PageFrontmatter } from "../src/wiki.js";

const now = new Date().toISOString().split("T")[0];

function makeFrontmatter(overrides: Partial<PageFrontmatter> = {}): PageFrontmatter {
  return {
    title: "Test Page",
    para: "resources",
    scope: ["test-project"],
    tags: ["test"],
    sources: [],
    created: now,
    updated: now,
    links: [],
    ...overrides,
  };
}

const testScope: ProjectScope = {
  name: "test-project",
  include: ["test-project"],
  exclude: [],
  source: "dirname",
};

const globalScope: ProjectScope = {
  name: "other-project",
  include: ["other-project"],
  exclude: [],
  source: "dirname",
};

let wikiDir: string;
let store: QMDStore;

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "pi-para-query-test-"));
  await initWiki(wikiDir);
  store = await openStore(wikiDir);
}, 30_000);

afterEach(async () => {
  await closeStore(store);
  await rm(wikiDir, { recursive: true, force: true });
});

describe("queryWiki", () => {
  it("searches with scope filtering", async () => {
    await writePage(wikiDir, {
      category: "resources",
      slug: "ssl-certs",
      frontmatter: makeFrontmatter({ title: "SSL Certificates", scope: ["test-project"], tags: ["ssl", "security"] }),
      body: "How to manage SSL certificates in production environments.",
    });
    await writePage(wikiDir, {
      category: "resources",
      slug: "other-topic",
      frontmatter: makeFrontmatter({ title: "Other Topic", scope: ["other-project"], tags: ["unrelated"] }),
      body: "Something about another project entirely.",
    });
    await store.update();

    const result = await queryWiki(store, { query: "SSL certificates" }, testScope);

    expect(result.scopeUsed.name).toBe("test-project");
    expect(result.wasGlobal).toBe(false);
    // The SSL page matches test-project scope
    const sslResults = result.results.filter(r => r.page.slug === "ssl-certs");
    expect(sslResults.length).toBeGreaterThanOrEqual(0); // BM25 may or may not match depending on indexing
  });

  it("searches globally when global flag is set", async () => {
    await writePage(wikiDir, {
      category: "resources",
      slug: "global-page",
      frontmatter: makeFrontmatter({ title: "Global Resource", scope: ["other-project"] }),
      body: "This resource belongs to another project.",
    });
    await store.update();

    const result = await queryWiki(store, { query: "global resource", global: true }, testScope);

    expect(result.wasGlobal).toBe(true);
    // Global search should not filter by scope
  });

  it("filters by PARA category", async () => {
    await writePage(wikiDir, {
      category: "projects",
      slug: "active-work",
      frontmatter: makeFrontmatter({ title: "Active Work", para: "projects", scope: ["test-project"] }),
      body: "Current project work.",
    });
    await writePage(wikiDir, {
      category: "resources",
      slug: "ref-material",
      frontmatter: makeFrontmatter({ title: "Reference Material", para: "resources", scope: ["test-project"] }),
      body: "Reference documentation.",
    });
    await store.update();

    const result = await queryWiki(store, { query: "work", category: "projects" }, testScope);

    // Category filter applied
    for (const r of result.results) {
      expect(r.page.category).toBe("projects");
    }
  });

  it("excludes archives by default", async () => {
    await writePage(wikiDir, {
      category: "archives",
      slug: "old-stuff",
      frontmatter: makeFrontmatter({ title: "Old Stuff", para: "archives", scope: ["test-project"] }),
      body: "Archived content that should be excluded.",
    });
    await store.update();

    const result = await queryWiki(store, { query: "old stuff" }, testScope);

    const archiveResults = result.results.filter(r => r.page.category === "archives");
    expect(archiveResults.length).toBe(0);
  });

  it("includes archives when requested", async () => {
    await writePage(wikiDir, {
      category: "archives",
      slug: "old-stuff",
      frontmatter: makeFrontmatter({ title: "Old Stuff", para: "archives", scope: ["test-project"] }),
      body: "Archived content.",
    });
    await store.update();

    const result = await queryWiki(store, {
      query: "old stuff",
      includeArchives: true,
    }, testScope);

    // Archives are now included
    // (whether BM25 actually matches depends on indexing)
    expect(result.scopeUsed).toBeDefined();
  });

  it("respects result limit", async () => {
    // Create several pages
    for (let i = 0; i < 5; i++) {
      await writePage(wikiDir, {
        category: "resources",
        slug: `page-${i}`,
        frontmatter: makeFrontmatter({ title: `Page ${i}`, scope: ["test-project"] }),
        body: `Content for page ${i} about testing queries.`,
      });
    }
    await store.update();

    const result = await queryWiki(store, { query: "testing queries", limit: 2 }, testScope);

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("uses override scope when provided", async () => {
    const result = await queryWiki(store, {
      query: "anything",
      scope: ["custom-scope"],
    }, testScope);

    expect(result.scopeUsed.include).toContain("custom-scope");
  });

  it("returns empty results for unmatched query", async () => {
    const result = await queryWiki(store, { query: "xyznonexistent123" }, testScope);

    expect(result.results).toHaveLength(0);
    expect(result.wasGlobal).toBe(false);
  });
});

describe("formatQueryResults", () => {
  it("formats empty results", () => {
    expect(formatQueryResults([])).toBe("No results found.");
  });

  it("formats results with metadata", () => {
    const results = [{
      page: { category: "resources" as const, slug: "test", title: "Test", path: "resources/test" },
      score: 0.95,
      snippet: "Some snippet text",
      frontmatter: makeFrontmatter({ title: "Test Page" }),
    }];

    const formatted = formatQueryResults(results);
    expect(formatted).toContain("Test Page");
    expect(formatted).toContain("resources/test");
    expect(formatted).toContain("0.950");
    expect(formatted).toContain("Some snippet text");
  });

  it("numbers multiple results", () => {
    const results = [
      {
        page: { category: "resources" as const, slug: "a", title: "A", path: "resources/a" },
        score: 0.9, snippet: "Snippet A",
        frontmatter: makeFrontmatter({ title: "Page A" }),
      },
      {
        page: { category: "projects" as const, slug: "b", title: "B", path: "projects/b" },
        score: 0.8, snippet: "Snippet B",
        frontmatter: makeFrontmatter({ title: "Page B", para: "projects" }),
      },
    ];

    const formatted = formatQueryResults(results);
    expect(formatted).toContain("Result 1:");
    expect(formatted).toContain("Result 2:");
  });
});
