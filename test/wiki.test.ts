import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initWiki,
  readPage,
  writePage,
  deletePage,
  movePage,
  listPages,
  readIndex,
  writeIndex,
  appendLog,
  readSchema,
  PARA_CATEGORIES,
} from "../src/wiki.js";
import type { WikiPage, LogEntry, PageFrontmatter } from "../src/wiki.js";

let wikiDir: string;

function makeFrontmatter(overrides: Partial<PageFrontmatter> = {}): PageFrontmatter {
  return {
    title: "Test Page",
    para: "resources",
    scope: [],
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
    frontmatter: makeFrontmatter({ title: overrides.slug ?? "test-page" }),
    body: "Some content.\n",
    ...overrides,
  };
}

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "pi-para-wiki-test-"));
});

afterEach(async () => {
  await rm(wikiDir, { recursive: true, force: true });
});

describe("initWiki", () => {
  it("creates wiki directory structure", async () => {
    await initWiki(wikiDir);

    // PARA category dirs
    for (const cat of PARA_CATEGORIES) {
      const s = await stat(join(wikiDir, cat));
      expect(s.isDirectory()).toBe(true);
    }

    // raw source dirs
    for (const sub of ["articles", "docs", "notes"]) {
      const s = await stat(join(wikiDir, "raw", sub));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it("seeds schema.md, index.md, log.md, sessions.md", async () => {
    await initWiki(wikiDir);

    const schema = await readFile(join(wikiDir, "schema.md"), "utf-8");
    expect(schema).toContain("# Wiki Schema");
    expect(schema).toContain("PARA Categories");

    const index = await readFile(join(wikiDir, "index.md"), "utf-8");
    expect(index).toContain("# Wiki Index");

    const log = await readFile(join(wikiDir, "log.md"), "utf-8");
    expect(log).toContain("# Activity Log");

    const sessions = await readFile(join(wikiDir, "sessions.md"), "utf-8");
    expect(sessions).toContain("# Session Digests");
  });

  it("is idempotent on existing wiki", async () => {
    await initWiki(wikiDir);

    // Modify index.md
    const customIndex = "# Custom Index\nModified content.\n";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(wikiDir, "index.md"), customIndex, "utf-8");

    // Re-init should not overwrite existing files
    await initWiki(wikiDir);

    const index = await readFile(join(wikiDir, "index.md"), "utf-8");
    expect(index).toBe(customIndex);
  });
});

describe("readPage / writePage", () => {
  it("writes and reads back a page with correct frontmatter", async () => {
    await initWiki(wikiDir);

    const page = makePage({
      category: "projects",
      slug: "auth-refactor",
      frontmatter: makeFrontmatter({
        title: "Auth Refactor",
        para: "projects",
        scope: ["pi-mono"],
        tags: ["auth", "security"],
        sources: ["https://example.com"],
        links: ["ssl-certs"],
      }),
      body: "## Topic\nRefactoring the auth module.\n",
    });

    await writePage(wikiDir, page);
    const result = await readPage(wikiDir, "projects", "auth-refactor");

    expect(result).not.toBeNull();
    expect(result!.category).toBe("projects");
    expect(result!.slug).toBe("auth-refactor");
    expect(result!.frontmatter.title).toBe("Auth Refactor");
    expect(result!.frontmatter.para).toBe("projects");
    expect(result!.frontmatter.scope).toEqual(["pi-mono"]);
    expect(result!.frontmatter.tags).toEqual(["auth", "security"]);
    expect(result!.frontmatter.sources).toEqual(["https://example.com"]);
    expect(result!.frontmatter.links).toEqual(["ssl-certs"]);
    expect(result!.body).toBe("## Topic\nRefactoring the auth module.\n");
  });

  it("returns null for non-existent page", async () => {
    await initWiki(wikiDir);
    const result = await readPage(wikiDir, "projects", "does-not-exist");
    expect(result).toBeNull();
  });

  it("creates category directory if missing on write", async () => {
    // Don't call initWiki — directory doesn't exist
    const page = makePage({ category: "areas", slug: "health" });
    await writePage(wikiDir, page);

    const result = await readPage(wikiDir, "areas", "health");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("health");
  });
});

describe("deletePage", () => {
  it("deletes an existing page", async () => {
    await initWiki(wikiDir);
    await writePage(wikiDir, makePage({ category: "resources", slug: "to-delete" }));

    // Verify it exists
    expect(await readPage(wikiDir, "resources", "to-delete")).not.toBeNull();

    await deletePage(wikiDir, "resources", "to-delete");

    // Verify it's gone
    expect(await readPage(wikiDir, "resources", "to-delete")).toBeNull();
  });

  it("no-ops for non-existent page", async () => {
    await initWiki(wikiDir);
    // Should not throw
    await deletePage(wikiDir, "resources", "ghost-page");
  });
});

describe("movePage", () => {
  it("moves page between PARA categories", async () => {
    await initWiki(wikiDir);

    const page = makePage({
      category: "projects",
      slug: "done-project",
      frontmatter: makeFrontmatter({
        title: "Done Project",
        para: "projects",
        scope: ["my-project"],
      }),
      body: "This project is done.\n",
    });
    await writePage(wikiDir, page);

    const ref = {
      category: "projects" as const,
      slug: "done-project",
      title: "Done Project",
      path: "projects/done-project.md",
    };

    await movePage(wikiDir, ref, "archives");

    // Old location gone
    expect(await readPage(wikiDir, "projects", "done-project")).toBeNull();

    // New location exists with updated frontmatter
    const moved = await readPage(wikiDir, "archives", "done-project");
    expect(moved).not.toBeNull();
    expect(moved!.category).toBe("archives");
    expect(moved!.frontmatter.para).toBe("archives");
    expect(moved!.frontmatter.title).toBe("Done Project");
    expect(moved!.body).toBe("This project is done.\n");
  });

  it("updates frontmatter para and updated fields", async () => {
    await initWiki(wikiDir);

    const originalDate = "2025-06-15T12:00:00.000Z";
    const page = makePage({
      category: "resources",
      slug: "move-test",
      frontmatter: makeFrontmatter({
        title: "Move Test",
        para: "resources",
        updated: originalDate,
      }),
      body: "Content.\n",
    });
    await writePage(wikiDir, page);

    const ref = {
      category: "resources" as const,
      slug: "move-test",
      title: "Move Test",
      path: "resources/move-test.md",
    };

    await movePage(wikiDir, ref, "areas");

    const moved = await readPage(wikiDir, "areas", "move-test");
    expect(moved).not.toBeNull();
    expect(moved!.frontmatter.para).toBe("areas");
    // updated should be newer than original
    expect(new Date(moved!.frontmatter.updated).getTime()).toBeGreaterThan(
      new Date(originalDate).getTime(),
    );
  });

  it("throws when source page does not exist", async () => {
    await initWiki(wikiDir);
    const ref = {
      category: "projects" as const,
      slug: "nonexistent",
      title: "Ghost",
      path: "projects/nonexistent.md",
    };
    await expect(movePage(wikiDir, ref, "archives")).rejects.toThrow();
  });
});

describe("listPages", () => {
  it("lists all pages across categories", async () => {
    await initWiki(wikiDir);

    await writePage(wikiDir, makePage({
      category: "projects",
      slug: "proj-a",
      frontmatter: makeFrontmatter({ title: "Project A", para: "projects" }),
    }));
    await writePage(wikiDir, makePage({
      category: "resources",
      slug: "res-b",
      frontmatter: makeFrontmatter({ title: "Resource B", para: "resources" }),
    }));
    await writePage(wikiDir, makePage({
      category: "areas",
      slug: "area-c",
      frontmatter: makeFrontmatter({ title: "Area C", para: "areas" }),
    }));

    const all = await listPages(wikiDir);
    expect(all).toHaveLength(3);
    // Sorted by category order: projects, areas, resources, archives
    expect(all[0].category).toBe("projects");
    expect(all[0].slug).toBe("proj-a");
    expect(all[1].category).toBe("areas");
    expect(all[1].slug).toBe("area-c");
    expect(all[2].category).toBe("resources");
    expect(all[2].slug).toBe("res-b");
  });

  it("lists pages in a specific category", async () => {
    await initWiki(wikiDir);

    await writePage(wikiDir, makePage({
      category: "resources",
      slug: "alpha",
      frontmatter: makeFrontmatter({ title: "Alpha", para: "resources" }),
    }));
    await writePage(wikiDir, makePage({
      category: "resources",
      slug: "beta",
      frontmatter: makeFrontmatter({ title: "Beta", para: "resources" }),
    }));
    await writePage(wikiDir, makePage({
      category: "projects",
      slug: "proj",
      frontmatter: makeFrontmatter({ title: "Proj", para: "projects" }),
    }));

    const resources = await listPages(wikiDir, "resources");
    expect(resources).toHaveLength(2);
    expect(resources[0].slug).toBe("alpha");
    expect(resources[1].slug).toBe("beta");
  });

  it("returns empty array for empty wiki", async () => {
    await initWiki(wikiDir);
    const pages = await listPages(wikiDir);
    expect(pages).toEqual([]);
  });

  it("includes correct path and title", async () => {
    await initWiki(wikiDir);

    await writePage(wikiDir, makePage({
      category: "areas",
      slug: "devops",
      frontmatter: makeFrontmatter({ title: "DevOps Standards", para: "areas" }),
    }));

    const pages = await listPages(wikiDir, "areas");
    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe("areas/devops.md");
    expect(pages[0].title).toBe("DevOps Standards");
  });
});

describe("index and log", () => {
  it("reads and writes index.md", async () => {
    await initWiki(wikiDir);

    const original = await readIndex(wikiDir);
    expect(original).toContain("# Wiki Index");

    const updated = "# Wiki Index\n\n## Projects\n- [[auth-refactor]] — Auth overhaul\n";
    await writeIndex(wikiDir, updated);

    const result = await readIndex(wikiDir);
    expect(result).toBe(updated);
  });

  it("appends log entries", async () => {
    await initWiki(wikiDir);

    const entry1: LogEntry = {
      date: "2026-04-27",
      operation: "ingest",
      summary: "Ingested SSL article",
      pages: ["resources/ssl-certs"],
    };
    await appendLog(wikiDir, entry1);

    const entry2: LogEntry = {
      date: "2026-04-27",
      operation: "capture",
      summary: "Captured session insights",
      pages: ["projects/auth-refactor", "resources/jwt-patterns"],
    };
    await appendLog(wikiDir, entry2);

    const log = await readFile(join(wikiDir, "log.md"), "utf-8");
    expect(log).toContain("# Activity Log");
    expect(log).toContain("## [2026-04-27] ingest | Ingested SSL article");
    expect(log).toContain("Pages: resources/ssl-certs");
    expect(log).toContain("## [2026-04-27] capture | Captured session insights");
    expect(log).toContain("Pages: projects/auth-refactor, resources/jwt-patterns");
  });

  it("handles log entry with no pages", async () => {
    await initWiki(wikiDir);

    const entry: LogEntry = {
      date: "2026-04-27",
      operation: "lint",
      summary: "No issues found",
      pages: [],
    };
    await appendLog(wikiDir, entry);

    const log = await readFile(join(wikiDir, "log.md"), "utf-8");
    expect(log).toContain("Pages: none");
  });
});

describe("readSchema", () => {
  it("reads schema.md content", async () => {
    await initWiki(wikiDir);

    const schema = await readSchema(wikiDir);
    expect(schema).toContain("# Wiki Schema");
    expect(schema).toContain("PARA Categories");
    expect(schema).toContain("Naming Conventions");
    expect(schema).toContain("Wiki Summary Format");
    expect(schema).toContain("Archiving");
  });
});
