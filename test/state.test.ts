import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDB } from "../src/state.js";
import type { PageSummary } from "../src/state.js";

describe("page summary cache", () => {
  let wikiDir: string;
  let db: StateDB;

  beforeEach(async () => {
    wikiDir = await mkdtemp(join(tmpdir(), "pi-para-state-test-"));
    db = new StateDB(wikiDir);
  });

  afterEach(async () => {
    db.close();
    await rm(wikiDir, { recursive: true, force: true });
  });

  it("upserts and retrieves a page summary", () => {
    db.upsertPageSummary(
      "my-page",
      "resources",
      ["pi-para"],
      ["architecture"],
      "This is a page about architecture.",
      "2026-04-29T00:00:00.000Z",
    );

    const summaries = db.getPageSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].slug).toBe("my-page");
    expect(summaries[0].category).toBe("resources");
    expect(summaries[0].scope).toEqual(["pi-para"]);
    expect(summaries[0].tags).toEqual(["architecture"]);
    expect(summaries[0].firstParagraph).toBe("This is a page about architecture.");
    expect(summaries[0].updatedAt).toBe("2026-04-29T00:00:00.000Z");
  });

  it("updates existing summary on upsert", () => {
    db.upsertPageSummary("my-page", "resources", ["pi-para"], [], "Old summary.", "2026-01-01T00:00:00.000Z");
    db.upsertPageSummary("my-page", "areas", ["global"], ["ops"], "New summary.", "2026-04-29T00:00:00.000Z");

    const summaries = db.getPageSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].category).toBe("areas");
    expect(summaries[0].firstParagraph).toBe("New summary.");
  });

  it("filters by scope using include", () => {
    db.upsertPageSummary("a", "resources", ["pi-para"], [], "A", "2026-01-01T00:00:00.000Z");
    db.upsertPageSummary("b", "resources", ["qmd"], [], "B", "2026-01-01T00:00:00.000Z");
    db.upsertPageSummary("c", "resources", ["global"], [], "C", "2026-01-01T00:00:00.000Z");

    const scope = { name: "pi-para", include: ["pi-para"], exclude: [] };
    const filtered = db.getPageSummaries(scope);
    expect(filtered).toHaveLength(2); // pi-para + global
    expect(filtered.map(s => s.slug).sort()).toEqual(["a", "c"]);
  });

  it("excludes by scope exclude list", () => {
    db.upsertPageSummary("a", "resources", ["global", "health"], [], "A", "2026-01-01T00:00:00.000Z");
    db.upsertPageSummary("b", "resources", ["global"], [], "B", "2026-01-01T00:00:00.000Z");

    const scope = { name: "test", include: ["test"], exclude: ["health"] };
    const filtered = db.getPageSummaries(scope);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].slug).toBe("b");
  });

  it("returns all summaries when no scope provided", () => {
    db.upsertPageSummary("a", "resources", ["pi-para"], [], "A", "2026-01-01T00:00:00.000Z");
    db.upsertPageSummary("b", "resources", ["qmd"], [], "B", "2026-02-01T00:00:00.000Z");

    const all = db.getPageSummaries();
    expect(all).toHaveLength(2);
  });

  it("deletes a page summary", () => {
    db.upsertPageSummary("to-delete", "resources", [], [], "Delete me.", "2026-01-01T00:00:00.000Z");
    expect(db.getPageSummaries()).toHaveLength(1);

    db.deletePageSummary("to-delete");
    expect(db.getPageSummaries()).toHaveLength(0);
  });

  it("returns summaries sorted by updated_at descending", () => {
    db.upsertPageSummary("old", "resources", ["global"], [], "Old", "2025-01-01T00:00:00.000Z");
    db.upsertPageSummary("new", "resources", ["global"], [], "New", "2026-06-01T00:00:00.000Z");
    db.upsertPageSummary("mid", "resources", ["global"], [], "Mid", "2026-03-01T00:00:00.000Z");

    const summaries = db.getPageSummaries();
    expect(summaries[0].slug).toBe("new");
    expect(summaries[1].slug).toBe("mid");
    expect(summaries[2].slug).toBe("old");
  });
});
