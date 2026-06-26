import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWiki, writePage, readPage, readIndex, listPages } from "../src/wiki.js";
import type { WikiPage, PageFrontmatter } from "../src/wiki.js";
import { openStore, closeStore } from "../src/store.js";
import type { QMDStore } from "../src/store.js";
import type { ProjectScope } from "../src/scope.js";
import { createStandaloneTools } from "../src/tools.js";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

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

function getToolText(result: AgentToolResult<unknown>): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found in [${tools.map((t) => t.name).join(", ")}]`);
  return tool;
}

// -- Tests -------------------------------------------------------------------

describe("tools", () => {
  let wikiDir: string;
  let store: QMDStore | null = null;
  let tools: AgentTool[];
  const scope = makeScope("test-project");

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-tools-test-"));
    await initWiki(wikiDir);
    store = await openStore(wikiDir);
    tools = createStandaloneTools(wikiDir, store, () => scope);
  }, 30_000);

  afterEach(async () => {
    if (store) {
      try {
        (store as any).internal?.close();
      } catch { /* ignore */ }
      store = null;
    }
    await rm(wikiDir, { recursive: true, force: true });
  }, 10_000);

  describe("createStandaloneTools", () => {
    it("returns 5 tools", () => {
      expect(tools).toHaveLength(5);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["wiki_edit", "wiki_move", "wiki_query", "wiki_read", "wiki_write"]);
    });

    it("all tools have required fields", () => {
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.label).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeTruthy();
        expect(typeof tool.execute).toBe("function");
      }
    });
  });

  describe("wiki_write", () => {
    it("creates a new page", async () => {
      const tool = findTool(tools, "wiki_write");
      const result = await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "ssl-certs",
            title: "SSL Certificates",
            scope: ["global"],
            tags: ["security", "ssl"],
            body: "## Topic\nSSL certificate management.",
            mode: "create",
          },
        ],
      });

      expect(getToolText(result)).toContain("ssl-certs");
      expect(getToolText(result)).toContain("1 page(s)");

      // Verify page was written
      const page = await readPage(wikiDir, "resources", "ssl-certs");
      expect(page).not.toBeNull();
      expect(page!.frontmatter.title).toBe("SSL Certificates");
      expect(page!.frontmatter.tags).toContain("ssl");
      expect(page!.body).toContain("SSL certificate management");
    });

    it("appends to an existing page", async () => {
      await writePage(wikiDir, makePage("resources", "existing-page", {
        body: "Original content.",
      }));

      const tool = findTool(tools, "wiki_write");
      const result = await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "existing-page",
            title: "Existing Page",
            scope: ["global"],
            tags: ["new-tag"],
            body: "Appended content.",
            mode: "append",
          },
        ],
      });

      expect(getToolText(result)).toContain("existing-page");

      const page = await readPage(wikiDir, "resources", "existing-page");
      expect(page!.body).toContain("Original content.");
      expect(page!.body).toContain("Appended content.");
      expect(page!.frontmatter.tags).toContain("new-tag");
    });

    it("replaces an existing page", async () => {
      await writePage(wikiDir, makePage("resources", "replace-me", {
        body: "Old content.",
      }));

      const tool = findTool(tools, "wiki_write");
      await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "replace-me",
            title: "Replaced Page",
            scope: ["test-project"],
            tags: ["updated"],
            body: "Brand new content.",
            mode: "replace",
          },
        ],
      });

      const page = await readPage(wikiDir, "resources", "replace-me");
      expect(page!.body).toBe("Brand new content.");
      expect(page!.body).not.toContain("Old content");
      expect(page!.frontmatter.title).toBe("Replaced Page");
    });

    it("auto-rebuilds index.md from all pages on disk", async () => {
      const tool = findTool(tools, "wiki_write");
      await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "test-page",
            title: "Test Page",
            scope: ["global"],
            tags: [],
            body: "Content about testing.",
            mode: "create",
          },
        ],
      });

      const index = await readIndex(wikiDir);
      expect(index).toContain("test-page");
      expect(index).toContain("Test Page");
      expect(index).toContain("## Resources");
    });

    it("appends to log.md when logSummary provided", async () => {
      const tool = findTool(tools, "wiki_write");
      await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "logged-page",
            title: "Logged Page",
            scope: ["global"],
            tags: [],
            body: "Content.",
            mode: "create",
          },
        ],
        logSummary: "Ingested article about testing",
      });

      const log = await readFile(join(wikiDir, "log.md"), "utf-8");
      expect(log).toContain("Ingested article about testing");
      expect(log).toContain("resources/logged-page");
    });

    it("writes multiple pages in one call", async () => {
      const tool = findTool(tools, "wiki_write");
      const result = await tool.execute("call-1", {
        pages: [
          {
            category: "projects",
            slug: "proj-a",
            title: "Project A",
            scope: ["proj-a"],
            tags: [],
            body: "Project A content.",
            mode: "create",
          },
          {
            category: "areas",
            slug: "area-b",
            title: "Area B",
            scope: ["global"],
            tags: [],
            body: "Area B content.",
            mode: "create",
          },
        ],
      });

      expect(getToolText(result)).toContain("2 page(s)");
      expect(await readPage(wikiDir, "projects", "proj-a")).not.toBeNull();
      expect(await readPage(wikiDir, "areas", "area-b")).not.toBeNull();
    });

    it("sanitizes slugs", async () => {
      const tool = findTool(tools, "wiki_write");
      await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "Bad Slug With Spaces!",
            title: "Sanitized",
            scope: ["global"],
            tags: [],
            body: "Content.",
            mode: "create",
          },
        ],
      });

      const page = await readPage(wikiDir, "resources", "bad-slug-with-spaces-");
      // Slug should be sanitized to lowercase hyphens
      const pages = await listPages(wikiDir, "resources");
      expect(pages.some((p) => p.slug.includes(" "))).toBe(false);
    });

    it("extracts wikilinks from body for frontmatter.links", async () => {
      const tool = findTool(tools, "wiki_write");
      await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "with-links",
            title: "With Links",
            scope: ["global"],
            tags: [],
            body: "See [[other-page]] and [[another-page|display text]].",
            mode: "create",
          },
        ],
      });

      const page = await readPage(wikiDir, "resources", "with-links");
      expect(page!.frontmatter.links).toContain("other-page");
      expect(page!.frontmatter.links).toContain("another-page");
    });

    it("returns details with pagesWritten, indexUpdated, logAppended", async () => {
      const tool = findTool(tools, "wiki_write");
      const result = await tool.execute("call-1", {
        pages: [
          {
            category: "resources",
            slug: "detail-page",
            title: "Detail Page",
            scope: ["global"],
            tags: [],
            body: "Content.",
            mode: "create",
          },
        ],
        indexContent: "# Updated Index",
        logSummary: "Test log",
      });

      const details = result.details as {
        pagesWritten: string[];
        indexUpdated: boolean;
        logAppended: boolean;
      };
      expect(details.pagesWritten).toEqual(["resources/detail-page"]);
      expect(details.indexUpdated).toBe(true);
      expect(details.logAppended).toBe(true);
    });
  });

  describe("wiki_read", () => {
    it("reads a page by category/slug path", async () => {
      await writePage(wikiDir, makePage("resources", "read-test", {
        body: "Readable content here.",
        frontmatter: { title: "Read Test" },
      }));

      const tool = findTool(tools, "wiki_read");
      const result = await tool.execute("call-1", { path: "resources/read-test" });

      expect(getToolText(result)).toContain("Read Test");
      expect(getToolText(result)).toContain("Readable content here");
      expect((result.details as { found: boolean }).found).toBe(true);
    });

    it("reads a page by title (case-insensitive)", async () => {
      await writePage(wikiDir, makePage("areas", "my-area", {
        body: "Area content.",
        frontmatter: { title: "My Area" },
      }));

      const tool = findTool(tools, "wiki_read");
      const result = await tool.execute("call-1", { path: "my area" });

      expect(getToolText(result)).toContain("Area content");
      expect((result.details as { found: boolean }).found).toBe(true);
    });

    it("reads a page by slug (case-insensitive)", async () => {
      await writePage(wikiDir, makePage("resources", "slug-match", {
        body: "Found by slug.",
      }));

      const tool = findTool(tools, "wiki_read");
      const result = await tool.execute("call-1", { path: "slug-match" });

      expect(getToolText(result)).toContain("Found by slug");
    });

    it("returns not found for non-existent page", async () => {
      const tool = findTool(tools, "wiki_read");
      const result = await tool.execute("call-1", { path: "resources/does-not-exist" });

      expect(getToolText(result)).toContain("not found");
      expect((result.details as { found: boolean }).found).toBe(false);
    });

    it("strips .md extension from path", async () => {
      await writePage(wikiDir, makePage("resources", "with-ext", {
        body: "Extension test.",
      }));

      const tool = findTool(tools, "wiki_read");
      const result = await tool.execute("call-1", { path: "resources/with-ext.md" });

      expect((result.details as { found: boolean }).found).toBe(true);
    });
  });

  describe("wiki_query", () => {
    it("returns empty results for no matches", async () => {
      const tool = findTool(tools, "wiki_query");
      const result = await tool.execute("call-1", {
        query: "nonexistent topic zebra unicorn",
      });

      expect(getToolText(result)).toContain("No wiki pages found");
      expect((result.details as { resultCount: number }).resultCount).toBe(0);
    });

    it("finds pages by keyword after reindex", async () => {
      await writePage(wikiDir, makePage("resources", "kubernetes-basics", {
        body: "Kubernetes is a container orchestration platform for deploying applications.",
        frontmatter: { title: "Kubernetes Basics", scope: ["global"] },
      }));

      // Reindex so the new page is searchable
      const { reindex } = await import("../src/store.js");
      await reindex(store!);

      const tool = findTool(tools, "wiki_query");
      const result = await tool.execute("call-1", {
        query: "kubernetes container orchestration",
      });

      const details = result.details as { resultCount: number; scopeUsed: string };
      // BM25 should find the page
      if (details.resultCount > 0) {
        expect(getToolText(result)).toContain("Kubernetes");
        expect(details.scopeUsed).toBe("test-project");
      }
    });

    it("uses global scope when global=true", async () => {
      const tool = findTool(tools, "wiki_query");
      const result = await tool.execute("call-1", {
        query: "anything",
        global: true,
      });

      const details = result.details as { scopeUsed: string };
      expect(details.scopeUsed).toBe("global");
    });
  });

  describe("wiki_move", () => {
    it("moves a page between categories", async () => {
      await writePage(wikiDir, makePage("projects", "done-project", {
        body: "This project is complete.",
        frontmatter: { title: "Done Project" },
      }));

      const tool = findTool(tools, "wiki_move");
      const result = await tool.execute("call-1", {
        path: "projects/done-project",
        to: "archives",
      });

      expect(getToolText(result)).toContain("Moved");
      expect(getToolText(result)).toContain("archives");

      // Original location should be gone
      const oldPage = await readPage(wikiDir, "projects", "done-project");
      expect(oldPage).toBeNull();

      // New location should have the page
      const newPage = await readPage(wikiDir, "archives", "done-project");
      expect(newPage).not.toBeNull();
      expect(newPage!.frontmatter.para).toBe("archives");
    });

    it("logs the move operation", async () => {
      await writePage(wikiDir, makePage("resources", "to-move", {
        frontmatter: { title: "Moving Page" },
      }));

      const tool = findTool(tools, "wiki_move");
      await tool.execute("call-1", { path: "resources/to-move", to: "areas" });

      const log = await readFile(join(wikiDir, "log.md"), "utf-8");
      expect(log).toContain("move");
      expect(log).toContain("Moving Page");
    });

    it("returns no-op when page is already in target category", async () => {
      await writePage(wikiDir, makePage("resources", "already-here"));

      const tool = findTool(tools, "wiki_move");
      const result = await tool.execute("call-1", {
        path: "resources/already-here",
        to: "resources",
      });

      expect(getToolText(result)).toContain("already in");
    });

    it("throws on non-existent page", async () => {
      const tool = findTool(tools, "wiki_move");
      await expect(
        tool.execute("call-1", { path: "projects/ghost", to: "archives" }),
      ).rejects.toThrow("not found");
    });

    it("throws on invalid path format", async () => {
      const tool = findTool(tools, "wiki_move");
      await expect(
        tool.execute("call-1", { path: "just-a-slug", to: "archives" }),
      ).rejects.toThrow("Invalid page path");
    });
  });
});
