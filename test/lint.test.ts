import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintWiki } from "../src/lint.js";
import type { LintOptions } from "../src/lint.js";
import { initWiki, writePage, readPage, readIndex, writeIndex } from "../src/wiki.js";
import { serializeFrontmatter } from "../src/frontmatter.js";
import type { WikiPage, PageFrontmatter } from "../src/wiki.js";

let wikiDir: string;

function fm(overrides: Partial<PageFrontmatter> = {}): PageFrontmatter {
  return {
    title: "Test Page",
    para: "resources",
    scope: ["global"],
    tags: [],
    sources: [],
    created: "2026-04-20T00:00:00.000Z",
    updated: "2026-04-20T00:00:00.000Z",
    links: [],
    ...overrides,
  };
}

function page(
  category: WikiPage["category"],
  slug: string,
  overrides: Partial<PageFrontmatter> = {},
  body = "",
): WikiPage {
  return {
    category,
    slug,
    frontmatter: fm({ title: slug, para: category, ...overrides }),
    body,
  };
}

async function writeLog(wikiDir: string, content: string): Promise<void> {
  await writeFile(join(wikiDir, "log.md"), content, "utf-8");
}

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "lint-test-"));
  await initWiki(wikiDir);
});

afterEach(async () => {
  await rm(wikiDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Orphan pages
// ---------------------------------------------------------------------------
describe("orphan pages", () => {
  it("detects pages with no inbound wikilinks", async () => {
    // page-a links to page-b, page-b links to page-a, page-c has no inbound
    await writePage(wikiDir, page("resources", "page-a", { links: ["page-b"] }, "See [[page-b]]"));
    await writePage(wikiDir, page("resources", "page-b", { links: ["page-a"] }, "See [[page-a]]"));
    await writePage(wikiDir, page("resources", "page-c", {}, "Standalone page"));

    // Update index to include all pages
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n- [[page-b]]\n- [[page-c]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const orphans = report.issues.filter((i) => i.category === "orphan");
    const orphanPages = orphans.map((i) => i.page);
    expect(orphanPages).toContain("resources/page-c");
    // page-a and page-b are not orphans
    expect(orphanPages).not.toContain("resources/page-a");
    expect(orphanPages).not.toContain("resources/page-b");
  });
});

// ---------------------------------------------------------------------------
// 2. Broken links
// ---------------------------------------------------------------------------
describe("broken links", () => {
  it("detects wikilinks to non-existent pages", async () => {
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["nonexistent"] }, "See [[nonexistent]] here"),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const broken = report.issues.filter((i) => i.category === "broken-link");
    expect(broken.length).toBe(1);
    expect(broken[0].page).toBe("resources/page-a");
    expect(broken[0].message).toContain("nonexistent");
    expect(broken[0].autoFixable).toBe(true);
  });

  it("auto-fixes broken links by removing them", async () => {
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["nonexistent", "also-gone"] }, "See [[nonexistent]] and [[also-gone]] here"),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n");

    const report = await lintWiki(wikiDir, { autoFix: true });
    // Should be in fixed list
    expect(report.fixed.filter((i) => i.category === "broken-link").length).toBe(2);

    // Verify file was updated
    const updated = await readPage(wikiDir, "resources", "page-a");
    expect(updated!.body).not.toContain("[[nonexistent]]");
    expect(updated!.body).not.toContain("[[also-gone]]");
    expect(updated!.frontmatter.links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Stale pages
// ---------------------------------------------------------------------------
describe("stale pages", () => {
  it("detects pages not updated in >staleDays", async () => {
    const oldDate = "2025-01-01T00:00:00.000Z";
    await writePage(
      wikiDir,
      page("resources", "old-page", { updated: oldDate, created: oldDate }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[old-page]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false, staleDays: 90 });
    const stale = report.issues.filter((i) => i.category === "stale");
    expect(stale.length).toBe(1);
    expect(stale[0].page).toBe("resources/old-page");
  });

  it("ignores archived pages for staleness", async () => {
    const oldDate = "2025-01-01T00:00:00.000Z";
    await writePage(
      wikiDir,
      page("archives", "old-archived", { updated: oldDate, created: oldDate }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Archives\n\n- [[old-archived]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false, staleDays: 90 });
    const stale = report.issues.filter((i) => i.category === "stale");
    expect(stale.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Scope drift
// ---------------------------------------------------------------------------
describe("scope drift", () => {
  it("detects projects/ pages whose scope does not include their slug", async () => {
    await writePage(
      wikiDir,
      page("projects", "my-project", { scope: ["other-project"] }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Projects\n\n- [[my-project]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const drift = report.issues.filter((i) => i.category === "scope-drift");
    expect(drift.length).toBe(1);
    expect(drift[0].page).toBe("projects/my-project");
  });

  it("does not flag projects/ pages that include their slug in scope", async () => {
    await writePage(
      wikiDir,
      page("projects", "my-project", { scope: ["my-project", "extra"] }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Projects\n\n- [[my-project]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const drift = report.issues.filter((i) => i.category === "scope-drift");
    expect(drift.length).toBe(0);
  });

  it("auto-fixes scope drift by adding slug to scope", async () => {
    await writePage(
      wikiDir,
      page("projects", "my-project", { scope: ["other"] }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Projects\n\n- [[my-project]]\n");

    const report = await lintWiki(wikiDir, { autoFix: true });
    expect(report.fixed.filter((i) => i.category === "scope-drift").length).toBe(1);

    const updated = await readPage(wikiDir, "projects", "my-project");
    expect(updated!.frontmatter.scope).toContain("my-project");
    expect(updated!.frontmatter.scope).toContain("other");
  });
});

// ---------------------------------------------------------------------------
// 5. Archive candidates
// ---------------------------------------------------------------------------
describe("archive candidates", () => {
  it("detects inactive projects with no recent log entries", async () => {
    const oldDate = "2025-01-01T00:00:00.000Z";
    await writePage(
      wikiDir,
      page("projects", "stale-project", {
        scope: ["stale-project"],
        updated: oldDate,
        created: oldDate,
      }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Projects\n\n- [[stale-project]]\n");
    // Log has no entries about this project
    await writeLog(wikiDir, "# Activity Log\n\n## [2025-01-01] ingest | something else\nPages: other-page\n");

    const report = await lintWiki(wikiDir, { autoFix: false, staleDays: 90 });
    const candidates = report.issues.filter((i) => i.category === "archive-candidate");
    expect(candidates.length).toBe(1);
    expect(candidates[0].page).toBe("projects/stale-project");
  });

  it("does not flag projects with recent log entries", async () => {
    const recentDate = new Date().toISOString();
    await writePage(
      wikiDir,
      page("projects", "active-project", {
        scope: ["active-project"],
        updated: recentDate,
        created: recentDate,
      }),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Projects\n\n- [[active-project]]\n");
    const today = new Date().toISOString().split("T")[0];
    await writeLog(wikiDir, `# Activity Log\n\n## [${today}] ingest | Updated active-project\nPages: active-project\n`);

    const report = await lintWiki(wikiDir, { autoFix: false, staleDays: 90 });
    const candidates = report.issues.filter((i) => i.category === "archive-candidate");
    expect(candidates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Missing pages
// ---------------------------------------------------------------------------
describe("missing pages", () => {
  it("detects concepts referenced in 2+ pages but lacking own page", async () => {
    // Both page-a and page-b reference "missing-concept" but it doesn't exist
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["missing-concept"] }, "See [[missing-concept]]"),
    );
    await writePage(
      wikiDir,
      page("resources", "page-b", { links: ["missing-concept"] }, "Also see [[missing-concept]]"),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n- [[page-b]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const missing = report.issues.filter((i) => i.category === "missing-page");
    expect(missing.length).toBe(1);
    expect(missing[0].message).toContain("missing-concept");
  });

  it("does not flag broken links referenced by only one page as missing", async () => {
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["only-one-ref"] }, "See [[only-one-ref]]"),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const missing = report.issues.filter((i) => i.category === "missing-page");
    expect(missing.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Empty categories
// ---------------------------------------------------------------------------
describe("empty categories", () => {
  it("detects PARA categories with zero pages", async () => {
    // Only add a resource — projects, areas are empty
    await writePage(wikiDir, page("resources", "sole-page"));
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[sole-page]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const empty = report.issues.filter((i) => i.category === "empty-category");
    const emptyNames = empty.map((i) => i.message);
    expect(emptyNames.some((m) => m.includes("projects"))).toBe(true);
    expect(emptyNames.some((m) => m.includes("areas"))).toBe(true);
    // archives being empty is fine
    expect(emptyNames.some((m) => m.includes("archives"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Frontmatter issues
// ---------------------------------------------------------------------------
describe("frontmatter issues", () => {
  it("detects missing title", async () => {
    await writePage(wikiDir, page("resources", "no-title", { title: "Untitled" }));
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[no-title]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const fmIssues = report.issues.filter(
      (i) => i.category === "frontmatter" && i.page === "resources/no-title",
    );
    expect(fmIssues.some((i) => i.message.includes("title"))).toBe(true);
  });

  it("detects empty scope", async () => {
    await writePage(wikiDir, page("resources", "no-scope", { scope: [] }));
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[no-scope]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const fmIssues = report.issues.filter(
      (i) => i.category === "frontmatter" && i.page === "resources/no-scope",
    );
    expect(fmIssues.some((i) => i.message.includes("scope"))).toBe(true);
  });

  it("auto-fixes missing title by deriving from slug", async () => {
    await writePage(wikiDir, page("resources", "my-cool-page", { title: "Untitled" }));
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[my-cool-page]]\n");

    const report = await lintWiki(wikiDir, { autoFix: true });
    const fixes = report.fixed.filter(
      (i) => i.category === "frontmatter" && i.message.includes("title"),
    );
    expect(fixes.length).toBe(1);

    const updated = await readPage(wikiDir, "resources", "my-cool-page");
    expect(updated!.frontmatter.title).toBe("My Cool Page");
  });

  it("auto-fixes empty scope with defaults", async () => {
    await writePage(wikiDir, page("areas", "testing", { scope: [] }));
    await writeIndex(wikiDir, "# Wiki Index\n\n## Areas\n\n- [[testing]]\n");

    const report = await lintWiki(wikiDir, { autoFix: true });

    const updated = await readPage(wikiDir, "areas", "testing");
    expect(updated!.frontmatter.scope).toEqual(["global"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Index drift
// ---------------------------------------------------------------------------
describe("index drift", () => {
  it("detects pages on disk not listed in index.md", async () => {
    await writePage(wikiDir, page("resources", "listed-page"));
    await writePage(wikiDir, page("resources", "unlisted-page"));
    // Only list one page in the index
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[listed-page]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    const drift = report.issues.filter((i) => i.category === "index-drift");
    expect(drift.length).toBe(1);
    expect(drift[0].page).toBe("resources/unlisted-page");
  });

  it("auto-fixes index drift by adding missing entries", async () => {
    await writePage(
      wikiDir,
      page("resources", "existing-page", { title: "Existing Page" }),
    );
    await writePage(
      wikiDir,
      page("projects", "new-project", { title: "New Project", scope: ["new-project"] }),
    );
    // Index only has existing-page
    await writeIndex(
      wikiDir,
      "# Wiki Index\n\n## Projects\n\n_No active projects yet._\n\n## Areas\n\n## Resources\n\n- [[existing-page]]\n\n## Archives\n",
    );

    const report = await lintWiki(wikiDir, { autoFix: true });
    const fixes = report.fixed.filter((i) => i.category === "index-drift");
    expect(fixes.length).toBe(1);
    expect(fixes[0].page).toBe("projects/new-project");

    const newIndex = await readIndex(wikiDir);
    expect(newIndex).toContain("[[new-project]]");
    expect(newIndex).toContain("[[existing-page]]");
    // Placeholder text should be removed
    expect(newIndex).not.toContain("No active projects yet");
  });
});

// ---------------------------------------------------------------------------
// 10. Duplicate slugs
// ---------------------------------------------------------------------------
describe("duplicate slugs", () => {
  it("detects same slug in different categories", async () => {
    await writePage(wikiDir, page("resources", "shared-slug", { title: "Resource Version" }));
    await writePage(wikiDir, page("projects", "shared-slug", { title: "Project Version", scope: ["shared-slug"] }));
    await writeIndex(
      wikiDir,
      "# Wiki Index\n\n## Projects\n\n- [[shared-slug]]\n\n## Resources\n\n- [[shared-slug]]\n",
    );

    const report = await lintWiki(wikiDir, { autoFix: false });
    const dupes = report.issues.filter((i) => i.category === "duplicate-slug");
    expect(dupes.length).toBe(1);
    expect(dupes[0].message).toContain("shared-slug");
    expect(dupes[0].autoFixable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Link-sync checker/fixer agreement
// ---------------------------------------------------------------------------
describe("link sync protected ranges", () => {
  it("ignores slug mentions in fenced code, inline code, headings, URLs, and existing links", async () => {
    await writePage(wikiDir, page("resources", "target-page", {}, "Target"));
    await writePage(
      wikiDir,
      page(
        "resources",
        "source-page",
        { links: ["target-page"] },
        [
          "# target-page heading",
          "",
          "```sh",
          "target-page command",
          "```",
          "",
          "Use `target-page command` inline.",
          "Visit https://example.com/target-page for docs.",
          "Already [[target-page]].",
        ].join("\n"),
      ),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[source-page]]\n- [[target-page]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    expect(report.issues.filter((issue) => issue.category === "link-sync" && issue.page === "resources/source-page")).toEqual([]);
  });

  it("composes secret redaction and link fixes without overwriting either", async () => {
    await writePage(wikiDir, page("resources", "target-page", {}, "Target"));
    await writePage(
      wikiDir,
      page(
        "resources",
        "source-page",
        {},
        `Authorization: Bearer ${"a".repeat(40)}\n\nSee target-page for details.`,
      ),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[source-page]]\n- [[target-page]]\n");

    const report = await lintWiki(wikiDir, { autoFix: true });
    expect(report.fixed.some((issue) => issue.category === "secrets")).toBe(true);
    expect(report.fixed.some((issue) => issue.category === "link-sync")).toBe(true);
    const updated = await readPage(wikiDir, "resources", "source-page");
    expect(updated!.body).toContain("Bearer <REDACTED>");
    expect(updated!.body).toContain("See [[target-page]] for details.");
    expect(updated!.body).not.toContain("a".repeat(40));
  });

  it("detects and fixes ordinary text after fenced and inline code", async () => {
    await writePage(wikiDir, page("resources", "target-page", {}, "Target"));
    const body = [
      "```sh",
      "echo target-page",
      "```",
      "",
      "Earlier `inline-code` must not protect the rest of the document.",
      "",
      "See target-page for the actual contract.",
    ].join("\n");
    await writePage(wikiDir, page("resources", "source-page", {}, body));
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[source-page]]\n- [[target-page]]\n");

    const before = await lintWiki(wikiDir, { autoFix: false });
    expect(before.issues.some((issue) => issue.category === "link-sync" && issue.page === "resources/source-page")).toBe(true);

    const fixed = await lintWiki(wikiDir, { autoFix: true });
    expect(fixed.fixed.some((issue) => issue.category === "link-sync" && issue.page === "resources/source-page")).toBe(true);
    const updated = await readPage(wikiDir, "resources", "source-page");
    expect(updated!.body).toContain("See [[target-page]] for the actual contract.");
    expect(updated!.body).toContain("echo target-page");
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
describe("wiki stats", () => {
  it("reports accurate stats", async () => {
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["page-b"], created: "2026-04-01" }, "See [[page-b]]"),
    );
    await writePage(
      wikiDir,
      page("resources", "page-b", { links: ["page-a"], created: "2026-04-10" }, "See [[page-a]]"),
    );
    await writePage(
      wikiDir,
      page("projects", "proj", { scope: ["proj"], created: "2026-04-05" }),
    );
    await writeIndex(
      wikiDir,
      "# Wiki Index\n\n## Projects\n\n- [[proj]]\n\n## Resources\n\n- [[page-a]]\n- [[page-b]]\n",
    );

    const report = await lintWiki(wikiDir, { autoFix: false });
    expect(report.stats.totalPages).toBe(3);
    expect(report.stats.byCategory.resources).toBe(2);
    expect(report.stats.byCategory.projects).toBe(1);
    expect(report.stats.oldestPage).toBe("2026-04-01");
    expect(report.stats.newestPage).toBe("2026-04-10");
  });

  it("counts broken links in stats", async () => {
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["gone1", "gone2"] }, "[[gone1]] [[gone2]]"),
    );
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n");

    const report = await lintWiki(wikiDir, { autoFix: false });
    expect(report.stats.brokenLinks).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// autoFix: false mode
// ---------------------------------------------------------------------------
describe("report-only mode", () => {
  it("does not modify files when autoFix is false", async () => {
    await writePage(
      wikiDir,
      page("resources", "page-a", { links: ["nonexistent"] }, "[[nonexistent]]"),
    );
    await writePage(wikiDir, page("resources", "unlisted", { title: "Untitled", scope: [] }));
    // Index only has page-a
    await writeIndex(wikiDir, "# Wiki Index\n\n## Resources\n\n- [[page-a]]\n");

    const indexBefore = await readIndex(wikiDir);
    const pageBefore = await readPage(wikiDir, "resources", "page-a");

    const report = await lintWiki(wikiDir, { autoFix: false });

    // No fixes applied
    expect(report.fixed.length).toBe(0);
    // Issues reported
    expect(report.issues.length).toBeGreaterThan(0);

    // Files unchanged
    const indexAfter = await readIndex(wikiDir);
    expect(indexAfter).toBe(indexBefore);
    const pageAfter = await readPage(wikiDir, "resources", "page-a");
    expect(pageAfter!.body).toBe(pageBefore!.body);
  });
});

// ---------------------------------------------------------------------------
// Combined scenario
// ---------------------------------------------------------------------------
describe("combined lint", () => {
  it("handles multiple issue types in one pass", async () => {
    // Orphan page (no inbound links)
    await writePage(wikiDir, page("resources", "orphan-r", { scope: ["global"] }));
    // Broken link
    await writePage(
      wikiDir,
      page("resources", "has-broken", { links: ["doesnt-exist"], scope: ["global"] }, "[[doesnt-exist]]"),
    );
    // Stale page
    await writePage(
      wikiDir,
      page("areas", "stale-area", {
        updated: "2024-01-01T00:00:00.000Z",
        created: "2024-01-01T00:00:00.000Z",
      }),
    );
    // Project with scope drift
    await writePage(
      wikiDir,
      page("projects", "drifted", { scope: ["wrong-scope"] }),
    );

    // Index missing some pages
    await writeIndex(
      wikiDir,
      "# Wiki Index\n\n## Projects\n\n## Areas\n\n- [[stale-area]]\n\n## Resources\n\n- [[has-broken]]\n\n## Archives\n",
    );

    const report = await lintWiki(wikiDir, { autoFix: true, staleDays: 90 });

    // Verify various issue types found or fixed
    const allCategories = [
      ...report.issues.map((i) => i.category),
      ...report.fixed.map((i) => i.category),
    ];
    expect(allCategories).toContain("orphan");
    expect(allCategories).toContain("stale");
    // broken-link should be fixed
    expect(report.fixed.some((i) => i.category === "broken-link")).toBe(true);
    // index-drift should be fixed for missing pages
    expect(report.fixed.some((i) => i.category === "index-drift")).toBe(true);
    // scope-drift should be fixed
    expect(report.fixed.some((i) => i.category === "scope-drift")).toBe(true);
  });
});
