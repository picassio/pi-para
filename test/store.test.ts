import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWiki, writePage } from "../src/wiki.js";
import {
  openStore,
  closeStore,
  searchWiki,
  reindex,
} from "../src/store.js";
import type { QMDStore } from "../src/store.js";
import type { WikiPage } from "../src/wiki.js";
import type { ProjectScope } from "../src/scope.js";

// Helper to create a page with full frontmatter
function makePage(
  category: "projects" | "areas" | "resources" | "archives",
  slug: string,
  overrides: Partial<WikiPage> & { frontmatter?: Partial<WikiPage["frontmatter"]> } = {},
): WikiPage {
  return {
    category,
    slug,
    frontmatter: {
      title: overrides.frontmatter?.title ?? slug,
      para: category,
      scope: overrides.frontmatter?.scope ?? ["global"],
      tags: overrides.frontmatter?.tags ?? [],
      sources: overrides.frontmatter?.sources ?? [],
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      links: overrides.frontmatter?.links ?? [],
    },
    body: overrides.body ?? `# ${slug}\n\nContent about ${slug}.`,
  };
}

function makeScope(name: string, extra?: Partial<ProjectScope>): ProjectScope {
  return {
    name,
    include: [name, ...(extra?.include ?? [])],
    exclude: extra?.exclude ?? [],
    source: extra?.source ?? "git-remote",
  };
}

describe("store", () => {
  let wikiDir: string;
  let store: QMDStore | null = null;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-store-test-"));
    await initWiki(wikiDir);
  }, 30_000);

  afterEach(async () => {
    if (store) {
      // Force-close without waiting for embed (tests don't need embed)
      try { store.internal.close(); } catch { /* ignore */ }
      store = null;
    }
    await rm(wikiDir, { recursive: true, force: true });
  }, 30_000);

  describe("openStore", () => {
    it("creates a store and indexes existing wiki files", async () => {
      await writePage(wikiDir, makePage("resources", "test-page", {
        body: "# Test\n\nSome searchable content about testing.",
      }));

      store = await openStore(wikiDir);
      expect(store).toBeDefined();
      expect(store.dbPath).toBe(join(wikiDir, ".qmd.sqlite"));

      const status = await store.getStatus();
      expect(status.totalDocuments).toBeGreaterThan(0);
    }, 30_000);

    it("sets up wiki and raw collections", async () => {
      store = await openStore(wikiDir);
      const collections = await store.listCollections();
      const names = collections.map((c) => c.name);
      expect(names).toContain("wiki");
      expect(names).toContain("raw");
    }, 30_000);

    it("marks raw collection as not included by default", async () => {
      store = await openStore(wikiDir);
      const collections = await store.listCollections();
      const raw = collections.find((c) => c.name === "raw");
      expect(raw).toBeDefined();
      expect(raw!.includeByDefault).toBe(false);
    }, 30_000);

    it("adds PARA category contexts", async () => {
      store = await openStore(wikiDir);
      const contexts = await store.listContexts();
      const wikiContexts = contexts.filter((c) => c.collection === "wiki");
      const paths = wikiContexts.map((c) => c.path);
      expect(paths).toContain("projects/");
      expect(paths).toContain("areas/");
      expect(paths).toContain("resources/");
      expect(paths).toContain("archives/");
    }, 30_000);

    it("adds raw collection context", async () => {
      store = await openStore(wikiDir);
      const contexts = await store.listContexts();
      const rawContexts = contexts.filter((c) => c.collection === "raw");
      expect(rawContexts.length).toBeGreaterThan(0);
      expect(rawContexts[0].context).toContain("Immutable source material");
    }, 30_000);
  });

  describe("searchWiki", () => {
    it("finds pages by keyword", async () => {
      await writePage(wikiDir, makePage("resources", "ssl-certs", {
        body: "# SSL Certificates\n\nHow to manage SSL certificates in production.",
      }));
      await writePage(wikiDir, makePage("resources", "docker-basics", {
        body: "# Docker Basics\n\nGetting started with Docker containers.",
      }));

      store = await openStore(wikiDir);
      const results = await searchWiki(store, "SSL certificates", {});

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].page.slug).toBe("ssl-certs");
      expect(results[0].page.category).toBe("resources");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].snippet).toBeDefined();
    }, 30_000);

    it("excludes archives by default", async () => {
      await writePage(wikiDir, makePage("archives", "old-project", {
        body: "# Old Project\n\nThis project about kubernetes is archived.",
      }));
      await writePage(wikiDir, makePage("resources", "kubernetes-guide", {
        body: "# Kubernetes Guide\n\nHow to configure kubernetes.",
      }));

      store = await openStore(wikiDir);
      const results = await searchWiki(store, "kubernetes", {});
      const slugs = results.map((r) => r.page.slug);
      expect(slugs).not.toContain("old-project");
      expect(slugs).toContain("kubernetes-guide");
    }, 30_000);

    it("includes archives when requested", async () => {
      await writePage(wikiDir, makePage("archives", "old-ssl", {
        body: "# Old SSL Setup\n\nArchived SSL configuration guide.",
      }));

      store = await openStore(wikiDir);
      const results = await searchWiki(store, "SSL", { includeArchives: true });
      const slugs = results.map((r) => r.page.slug);
      expect(slugs).toContain("old-ssl");
    }, 30_000);

    it("filters by category", async () => {
      await writePage(wikiDir, makePage("projects", "auth-refactor", {
        body: "# Auth Refactor\n\nRefactoring the authentication system.",
      }));
      await writePage(wikiDir, makePage("resources", "auth-patterns", {
        body: "# Auth Patterns\n\nCommon authentication patterns.",
      }));

      store = await openStore(wikiDir);
      const results = await searchWiki(store, "authentication", {
        category: "projects",
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.page.category).toBe("projects");
      }
    }, 30_000);

    it("filters by scope", async () => {
      await writePage(wikiDir, makePage("resources", "pi-mono-auth", {
        frontmatter: { scope: ["pi-mono"] },
        body: "# Pi Mono Auth\n\nAuthentication in pi-mono project.",
      }));
      await writePage(wikiDir, makePage("resources", "other-auth", {
        frontmatter: { scope: ["other-project"] },
        body: "# Other Auth\n\nAuthentication in another project.",
      }));

      store = await openStore(wikiDir);
      const scope = makeScope("pi-mono");
      const results = await searchWiki(store, "authentication", { scope });
      const slugs = results.map((r) => r.page.slug);
      expect(slugs).toContain("pi-mono-auth");
      expect(slugs).not.toContain("other-auth");
    }, 30_000);

    it("includes global-scoped pages regardless of project scope", async () => {
      await writePage(wikiDir, makePage("areas", "security-standards", {
        frontmatter: { scope: ["global"] },
        body: "# Security Standards\n\nGlobal security standards for all projects.",
      }));

      store = await openStore(wikiDir);
      const scope = makeScope("pi-mono");
      const results = await searchWiki(store, "security standards", { scope });
      const slugs = results.map((r) => r.page.slug);
      expect(slugs).toContain("security-standards");
    }, 30_000);

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await writePage(wikiDir, makePage("resources", `page-${i}`, {
          body: `# Page ${i}\n\nThis page discusses testing and quality assurance topic ${i}.`,
        }));
      }

      store = await openStore(wikiDir);
      const results = await searchWiki(store, "testing quality", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    }, 30_000);

    it("returns empty array for no matches", async () => {
      store = await openStore(wikiDir);
      const results = await searchWiki(store, "xyznonexistent", {});
      expect(results).toEqual([]);
    }, 30_000);

    it("returns frontmatter in results", async () => {
      await writePage(wikiDir, makePage("projects", "my-project", {
        frontmatter: {
          title: "My Project",
          scope: ["global"],
          tags: ["web", "api"],
        },
        body: "# My Project\n\nA project about building web APIs.",
      }));

      store = await openStore(wikiDir);
      const results = await searchWiki(store, "web APIs", {});
      const match = results.find((r) => r.page.slug === "my-project");
      expect(match).toBeDefined();
      expect(match!.frontmatter.title).toBe("My Project");
      expect(match!.frontmatter.tags).toContain("web");
      expect(match!.frontmatter.tags).toContain("api");
    }, 30_000);

    it("excludes scope via exclude list", async () => {
      await writePage(wikiDir, makePage("resources", "excluded-page", {
        frontmatter: { scope: ["excluded-tag", "global"] },
        body: "# Excluded Page\n\nThis page has an excluded scope tag about databases.",
      }));
      await writePage(wikiDir, makePage("resources", "included-page", {
        frontmatter: { scope: ["global"] },
        body: "# Included Page\n\nThis page is about databases too.",
      }));

      store = await openStore(wikiDir);
      const scope = makeScope("my-project", { exclude: ["excluded-tag"] });
      const results = await searchWiki(store, "databases", { scope });
      const slugs = results.map((r) => r.page.slug);
      expect(slugs).toContain("included-page");
      expect(slugs).not.toContain("excluded-page");
    }, 30_000);
  });

  describe("reindex", () => {
    it("picks up new files after reindex", async () => {
      store = await openStore(wikiDir);

      // Write a page after the store was opened
      await writePage(wikiDir, makePage("resources", "new-page", {
        body: "# New Page\n\nFreshly added content about kubernetes.",
      }));

      // Not found before reindex
      const before = await searchWiki(store, "kubernetes", {});
      expect(before.length).toBe(0);

      // Reindex and search again
      await reindex(store);
      const after = await searchWiki(store, "kubernetes", {});
      expect(after.length).toBeGreaterThan(0);
      expect(after[0].page.slug).toBe("new-page");
    }, 30_000);
  });

  describe("closeStore", () => {
    it("closes without error", async () => {
      store = await openStore(wikiDir);
      await closeStore(store);
      store = null; // Prevent double-close in afterEach
    }, 90_000);
  });
});
