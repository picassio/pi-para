import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSource,
  detectSourceType,
  truncateSource,
  MAX_SOURCE_LENGTH,
} from "../src/ingest.js";
import { initWiki, readIndex, readSchema } from "../src/wiki.js";
import type { ProjectScope } from "../src/scope.js";

const testScope: ProjectScope = {
  name: "test-project",
  include: ["test-project"],
  exclude: [],
  source: "dirname",
};

let wikiDir: string;

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "pi-para-ingest-test-"));
  await initWiki(wikiDir);
});

afterEach(async () => {
  await rm(wikiDir, { recursive: true, force: true });
});

describe("detectSourceType", () => {
  it("detects URLs", () => {
    expect(detectSourceType("https://example.com/article")).toBe("url");
    expect(detectSourceType("http://blog.test/post")).toBe("url");
  });

  it("detects file paths", () => {
    expect(detectSourceType("/home/user/doc.md")).toBe("file");
    expect(detectSourceType("./relative/path.txt")).toBe("file");
    expect(detectSourceType("~/notes/file.md")).toBe("file");
  });

  it("detects text", () => {
    expect(detectSourceType("This is some text\nwith newlines")).toBe("text");
    expect(detectSourceType("a".repeat(501))).toBe("text");
    expect(detectSourceType("just a short sentence")).toBe("text");
  });

  it("detects file-like strings with extensions", () => {
    expect(detectSourceType("notes.md")).toBe("file");
    expect(detectSourceType("report.pdf")).toBe("file");
  });
});

describe("truncateSource", () => {
  it("returns content unchanged if under limit", () => {
    const content = "short content";
    expect(truncateSource(content)).toBe(content);
  });

  it("truncates content over the limit", () => {
    const content = "a".repeat(MAX_SOURCE_LENGTH + 100);
    const result = truncateSource(content);
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("[... truncated]");
  });

  it("accepts custom max length", () => {
    const content = "a".repeat(200);
    const result = truncateSource(content, 100);
    expect(result).toContain("[... truncated]");
    expect(result.length).toBeLessThan(200);
  });
});

describe("resolveSource", () => {
  it("resolves a file source", async () => {
    const filePath = join(wikiDir, "test-source.md");
    await writeFile(filePath, "# Test Article\n\nSome content here.");

    const result = await resolveSource(wikiDir, {
      source: filePath,
      sourceType: "file",
    }, testScope);

    expect(result.sourceType).toBe("file");
    expect(result.content).toContain("# Test Article");
    expect(result.rawPath).toBeDefined();
    expect(result.schema).toBeTruthy();
    expect(result.index).toBeTruthy();
    expect(result.scopeName).toBe("test-project");
    expect(result.scopeTags).toEqual(["test-project"]);
  });

  it("resolves text source without saving to raw", async () => {
    const result = await resolveSource(wikiDir, {
      source: "Some inline text about testing",
      sourceType: "text",
    }, testScope);

    expect(result.sourceType).toBe("text");
    expect(result.content).toBe("Some inline text about testing");
    expect(result.rawPath).toBeUndefined();
  });

  it("auto-detects source type", async () => {
    const result = await resolveSource(wikiDir, {
      source: "This is a multi-line\ntext source for testing",
    }, testScope);

    expect(result.sourceType).toBe("text");
  });

  it("uses override scope tags when provided", async () => {
    const result = await resolveSource(wikiDir, {
      source: "test content\nwith newlines",
      sourceType: "text",
      scope: ["custom-scope", "another"],
    }, testScope);

    expect(result.scopeTags).toEqual(["custom-scope", "another"]);
  });

  it("passes category hint through", async () => {
    const result = await resolveSource(wikiDir, {
      source: "test content\nwith newlines",
      sourceType: "text",
      category: "resources",
    }, testScope);

    expect(result.categoryHint).toBe("resources");
  });

  it("reads schema and index from wiki", async () => {
    const result = await resolveSource(wikiDir, {
      source: "test\ncontent",
      sourceType: "text",
    }, testScope);

    const schema = await readSchema(wikiDir);
    const index = await readIndex(wikiDir);
    expect(result.schema).toBe(schema);
    expect(result.index).toBe(index);
  });

  it("saves URL sources to raw/articles", async () => {
    // Create a local file to simulate a "fetched" URL source
    // (actual URL fetching would need network access)
    const filePath = join(wikiDir, "fetched-article.md");
    await writeFile(filePath, "# Fetched Article");

    const result = await resolveSource(wikiDir, {
      source: filePath,
      sourceType: "file",
    }, testScope);

    expect(result.rawPath).toBeDefined();
    expect(result.rawPath).toContain("raw/");
  });

  it("saves file sources to raw/docs", async () => {
    const filePath = join(wikiDir, "test-doc.pdf.md");
    await writeFile(filePath, "# PDF converted to markdown");

    const result = await resolveSource(wikiDir, {
      source: filePath,
      sourceType: "file",
    }, testScope);

    expect(result.rawPath).toBeDefined();
  });
});
