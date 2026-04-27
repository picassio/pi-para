import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWiki } from "../src/wiki.js";
import {
  saveRawSource,
  appendSessionDigest,
  readSessionDigests,
} from "../src/raw.js";
import type { SessionDigest } from "../src/raw.js";

let wikiDir: string;

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "pi-para-raw-test-"));
  await initWiki(wikiDir);
});

afterEach(async () => {
  await rm(wikiDir, { recursive: true, force: true });
});

// -- saveRawSource -----------------------------------------------------------

describe("saveRawSource", () => {
  it("saves URL source to raw/articles/", async () => {
    const path = await saveRawSource(wikiDir, {
      type: "url",
      content: "# SSL Certs\nHow to renew them.\n",
      originalPath: "https://example.com/blog/ssl-certs",
    });

    expect(path).toMatch(/^raw\/articles\//);
    expect(path).toMatch(/\.md$/);

    const fullPath = join(wikiDir, path);
    const s = await stat(fullPath);
    expect(s.isFile()).toBe(true);

    const content = await readFile(fullPath, "utf-8");
    expect(content).toContain("source_type: url");
    expect(content).toContain("https://example.com/blog/ssl-certs");
    expect(content).toContain("# SSL Certs");
  });

  it("saves file source to raw/docs/", async () => {
    const path = await saveRawSource(wikiDir, {
      type: "file",
      content: "Document content here.\n",
      originalPath: "/home/user/docs/architecture-notes.pdf",
    });

    expect(path).toMatch(/^raw\/docs\//);
    expect(path).toContain("architecture-notes");

    const content = await readFile(join(wikiDir, path), "utf-8");
    expect(content).toContain("source_type: file");
    expect(content).toContain("architecture-notes.pdf");
    expect(content).toContain("Document content here.");
  });

  it("saves text source to raw/notes/", async () => {
    const path = await saveRawSource(wikiDir, {
      type: "text",
      content: "Some quick notes about deployment.\n",
      originalPath: "manual input",
    });

    expect(path).toMatch(/^raw\/notes\//);
    expect(path).toMatch(/^raw\/notes\/note-/);

    const content = await readFile(join(wikiDir, path), "utf-8");
    expect(content).toContain("source_type: text");
    expect(content).toContain("Some quick notes about deployment.");
  });

  it("returns saved file path relative to wikiDir", async () => {
    const path = await saveRawSource(wikiDir, {
      type: "url",
      content: "Content.",
      originalPath: "https://docs.example.com/api/v2/auth",
    });

    // Path is relative: raw/<subdir>/<slug>.md
    expect(path.startsWith("raw/")).toBe(true);
    expect(path.endsWith(".md")).toBe(true);

    // The actual file exists at wikiDir + path
    const s = await stat(join(wikiDir, path));
    expect(s.isFile()).toBe(true);
  });

  it("handles duplicate slugs with numeric suffix", async () => {
    const path1 = await saveRawSource(wikiDir, {
      type: "url",
      content: "First article.",
      originalPath: "https://example.com/page",
    });
    const path2 = await saveRawSource(wikiDir, {
      type: "url",
      content: "Second article.",
      originalPath: "https://example.com/page",
    });

    expect(path1).not.toBe(path2);

    const content1 = await readFile(join(wikiDir, path1), "utf-8");
    expect(content1).toContain("First article.");
    const content2 = await readFile(join(wikiDir, path2), "utf-8");
    expect(content2).toContain("Second article.");
  });

  it("includes frontmatter with metadata", async () => {
    const path = await saveRawSource(wikiDir, {
      type: "file",
      content: "Body text.\n",
      originalPath: "/path/to/report.md",
    });

    const content = await readFile(join(wikiDir, path), "utf-8");
    // Should have YAML frontmatter delimiters
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("source_type: file");
    expect(content).toContain('original_path: "/path/to/report.md"');
    expect(content).toContain("ingested_at:");
  });

  it("creates raw subdirectory if missing", async () => {
    // Remove the raw/articles dir that initWiki created
    const { rm: rmDir } = await import("node:fs/promises");
    await rmDir(join(wikiDir, "raw", "articles"), { recursive: true, force: true });

    const path = await saveRawSource(wikiDir, {
      type: "url",
      content: "Content.",
      originalPath: "https://test.com/article",
    });

    expect(path).toMatch(/^raw\/articles\//);
    const s = await stat(join(wikiDir, path));
    expect(s.isFile()).toBe(true);
  });
});

// -- appendSessionDigest -----------------------------------------------------

describe("appendSessionDigest", () => {
  it("appends entry to sessions.md", async () => {
    const digest: SessionDigest = {
      date: "2026-04-27",
      project: "pi-mono",
      sessionFile: "~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-27_abc123.jsonl",
      scope: "pi-mono",
      capturedPages: ["ssl-cert-gotchas"],
      summary: "Debugged SSL cert renewal failure in CI. Root cause was expired intermediate cert.",
    };

    await appendSessionDigest(wikiDir, digest);

    const content = await readFile(join(wikiDir, "sessions.md"), "utf-8");
    expect(content).toContain("# Session Digests");
    expect(content).toContain("## [2026-04-27] pi-mono |");
    expect(content).toContain("- **Session**: `~/.pi/agent/sessions/");
    expect(content).toContain("- **Scope**: pi-mono");
    expect(content).toContain("- **Captured**: [[ssl-cert-gotchas]]");
    expect(content).toContain("- **Summary**: Debugged SSL cert renewal failure");
  });

  it("creates sessions.md if it does not exist", async () => {
    // Remove sessions.md
    const { unlink } = await import("node:fs/promises");
    await unlink(join(wikiDir, "sessions.md"));

    const digest: SessionDigest = {
      date: "2026-04-26",
      project: "agent-board",
      sessionFile: "~/.pi/agent/sessions/--home-ubuntu-projects-agent-board--/2026-04-26_def456.jsonl",
      scope: "agent-board",
      capturedPages: ["dashboard-layout-decisions"],
      summary: "Switched from CSS Grid to flexbox for the main dashboard.",
    };

    await appendSessionDigest(wikiDir, digest);

    const content = await readFile(join(wikiDir, "sessions.md"), "utf-8");
    expect(content).toContain("# Session Digests");
    expect(content).toContain("## [2026-04-26] agent-board |");
    expect(content).toContain("[[dashboard-layout-decisions]]");
  });

  it("appends multiple entries in order", async () => {
    await appendSessionDigest(wikiDir, {
      date: "2026-04-25",
      project: "proj-a",
      sessionFile: "/sessions/a.jsonl",
      scope: "proj-a",
      capturedPages: ["page-a"],
      summary: "First session.",
    });

    await appendSessionDigest(wikiDir, {
      date: "2026-04-26",
      project: "proj-b",
      sessionFile: "/sessions/b.jsonl",
      scope: "proj-b",
      capturedPages: ["page-b"],
      summary: "Second session.",
    });

    const content = await readFile(join(wikiDir, "sessions.md"), "utf-8");
    const idxA = content.indexOf("proj-a");
    const idxB = content.indexOf("proj-b");
    expect(idxA).toBeLessThan(idxB);
  });

  it("formats multiple captured pages as wikilinks", async () => {
    await appendSessionDigest(wikiDir, {
      date: "2026-04-27",
      project: "multi",
      sessionFile: "/sessions/multi.jsonl",
      scope: "multi",
      capturedPages: ["page-one", "page-two", "page-three"],
      summary: "Multi-page capture.",
    });

    const content = await readFile(join(wikiDir, "sessions.md"), "utf-8");
    expect(content).toContain("[[page-one]], [[page-two]], [[page-three]]");
  });

  it("handles empty captured pages", async () => {
    await appendSessionDigest(wikiDir, {
      date: "2026-04-27",
      project: "empty",
      sessionFile: "/sessions/empty.jsonl",
      scope: "empty",
      capturedPages: [],
      summary: "Nothing captured.",
    });

    const content = await readFile(join(wikiDir, "sessions.md"), "utf-8");
    expect(content).toContain("- **Captured**: none");
  });
});

// -- readSessionDigests ------------------------------------------------------

describe("readSessionDigests", () => {
  async function seedDigests(): Promise<void> {
    await appendSessionDigest(wikiDir, {
      date: "2026-04-25",
      project: "pi-mono",
      sessionFile: "/sessions/pi-mono-1.jsonl",
      scope: "pi-mono",
      capturedPages: ["ssl-certs"],
      summary: "SSL cert debugging session.",
    });
    await appendSessionDigest(wikiDir, {
      date: "2026-04-26",
      project: "agent-board",
      sessionFile: "/sessions/agent-board-1.jsonl",
      scope: "agent-board",
      capturedPages: ["dashboard-layout"],
      summary: "Dashboard layout refactor.",
    });
    await appendSessionDigest(wikiDir, {
      date: "2026-04-27",
      project: "pi-mono",
      sessionFile: "/sessions/pi-mono-2.jsonl",
      scope: "pi-mono",
      capturedPages: ["auth-patterns", "jwt-refresh"],
      summary: "Auth patterns and JWT refresh token design.",
    });
  }

  it("reads all digest entries", async () => {
    await seedDigests();

    const digests = await readSessionDigests(wikiDir);
    expect(digests).toHaveLength(3);
    expect(digests[0].date).toBe("2026-04-25");
    expect(digests[0].project).toBe("pi-mono");
    expect(digests[0].scope).toBe("pi-mono");
    expect(digests[0].capturedPages).toEqual(["ssl-certs"]);
    expect(digests[0].summary).toBe("SSL cert debugging session.");

    expect(digests[1].date).toBe("2026-04-26");
    expect(digests[1].project).toBe("agent-board");
    expect(digests[1].capturedPages).toEqual(["dashboard-layout"]);

    expect(digests[2].date).toBe("2026-04-27");
    expect(digests[2].capturedPages).toEqual(["auth-patterns", "jwt-refresh"]);
  });

  it("filters by scope", async () => {
    await seedDigests();

    const piMono = await readSessionDigests(wikiDir, { scope: "pi-mono" });
    expect(piMono).toHaveLength(2);
    expect(piMono[0].date).toBe("2026-04-25");
    expect(piMono[1].date).toBe("2026-04-27");

    const agentBoard = await readSessionDigests(wikiDir, { scope: "agent-board" });
    expect(agentBoard).toHaveLength(1);
    expect(agentBoard[0].project).toBe("agent-board");
  });

  it("limits results (returns most recent)", async () => {
    await seedDigests();

    const limited = await readSessionDigests(wikiDir, { limit: 2 });
    expect(limited).toHaveLength(2);
    // Should be the last 2 entries
    expect(limited[0].date).toBe("2026-04-26");
    expect(limited[1].date).toBe("2026-04-27");
  });

  it("combines scope and limit filters", async () => {
    await seedDigests();

    const filtered = await readSessionDigests(wikiDir, {
      scope: "pi-mono",
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    // Last pi-mono entry
    expect(filtered[0].date).toBe("2026-04-27");
    expect(filtered[0].project).toBe("pi-mono");
  });

  it("returns empty array for missing sessions.md", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(wikiDir, "sessions.md"));

    const digests = await readSessionDigests(wikiDir);
    expect(digests).toEqual([]);
  });

  it("returns empty array for empty sessions.md", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(wikiDir, "sessions.md"), "# Session Digests\n", "utf-8");

    const digests = await readSessionDigests(wikiDir);
    expect(digests).toEqual([]);
  });

  it("returns empty array when scope matches nothing", async () => {
    await seedDigests();

    const digests = await readSessionDigests(wikiDir, { scope: "nonexistent-project" });
    expect(digests).toEqual([]);
  });

  it("parses session file paths correctly", async () => {
    const longPath = "~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-27T10-12-37_d35783d1.jsonl";
    await appendSessionDigest(wikiDir, {
      date: "2026-04-27",
      project: "pi-mono",
      sessionFile: longPath,
      scope: "pi-mono",
      capturedPages: ["test-page"],
      summary: "Test session.",
    });

    const digests = await readSessionDigests(wikiDir);
    expect(digests).toHaveLength(1);
    expect(digests[0].sessionFile).toBe(longPath);
  });
});
