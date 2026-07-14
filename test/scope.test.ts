import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import {
  detectScope,
  loadScopeConfig,
  matchesScope,
  extractRepoName,
} from "../src/scope.js";
import type { ProjectScope } from "../src/scope.js";

/** Create a temp dir that gets cleaned up after each test. */
let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-para-scope-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractRepoName
// ---------------------------------------------------------------------------

describe("extractRepoName", () => {
  it("extracts from SSH URL", () => {
    expect(extractRepoName("git@github.com:user/my-repo.git")).toBe("my-repo");
  });

  it("extracts from HTTPS URL with .git", () => {
    expect(
      extractRepoName("https://github.com/user/my-repo.git"),
    ).toBe("my-repo");
  });

  it("extracts from HTTPS URL without .git", () => {
    expect(extractRepoName("https://github.com/user/my-repo")).toBe("my-repo");
  });

  it("extracts from SSH protocol URL", () => {
    expect(
      extractRepoName("ssh://git@host.com/user/my-repo.git"),
    ).toBe("my-repo");
  });

  it("handles trailing slashes", () => {
    expect(extractRepoName("https://github.com/user/my-repo/")).toBe(
      "my-repo",
    );
  });

  it("returns null for empty string", () => {
    expect(extractRepoName("")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// loadScopeConfig
// ---------------------------------------------------------------------------

describe("loadScopeConfig", () => {
  it("loads valid config file", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({
        name: "my-project",
        include: ["shared-lib"],
        exclude: ["legacy"],
      }),
    );

    const config = await loadScopeConfig(dir);
    expect(config).toEqual({
      name: "my-project",
      include: ["shared-lib"],
      exclude: ["legacy"],
    });
  });

  it("loads config with name only", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({ name: "minimal" }),
    );

    const config = await loadScopeConfig(dir);
    expect(config).toEqual({ name: "minimal" });
  });

  it("returns null when file does not exist", async () => {
    const dir = await makeTempDir();
    expect(await loadScopeConfig(dir)).toBe(null);
  });

  it("returns null for invalid JSON", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "wiki-scope.json"), "not json {{{");

    expect(await loadScopeConfig(dir)).toBe(null);
  });

  it("returns null when name is missing", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({ include: ["foo"] }),
    );

    expect(await loadScopeConfig(dir)).toBe(null);
  });

  it("returns null when name is empty string", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({ name: "" }),
    );

    expect(await loadScopeConfig(dir)).toBe(null);
  });

  it("filters non-string values from include/exclude arrays", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({
        name: "test",
        include: ["valid", 123, null, "also-valid"],
        exclude: [true, "only-this"],
      }),
    );

    const config = await loadScopeConfig(dir);
    expect(config).toEqual({
      name: "test",
      include: ["valid", "also-valid"],
      exclude: ["only-this"],
    });
  });
});

// ---------------------------------------------------------------------------
// detectScope
// ---------------------------------------------------------------------------

describe("detectScope", () => {
  it("reads .pi/wiki-scope.json when present (highest priority)", async () => {
    const dir = await makeTempDir();
    // Also init a git repo to prove config takes priority
    git(dir, "init");
    git(dir, "remote", "add", "origin", "git@github.com:user/git-name.git");

    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({
        name: "config-name",
        include: ["extra"],
        exclude: ["banned"],
      }),
    );

    const scope = await detectScope(dir);
    expect(scope.name).toBe("config-name");
    expect(scope.source).toBe("config");
    expect(scope.include).toContain("config-name");
    expect(scope.include).toContain("extra");
    expect(scope.exclude).toEqual(["banned"]);
  });

  it("config include always contains the project name", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({ name: "my-proj", include: ["other"] }),
    );

    const scope = await detectScope(dir);
    expect(scope.include).toContain("my-proj");
    expect(scope.include).toContain("other");
  });

  it("config include deduplicates name", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "wiki-scope.json"),
      JSON.stringify({ name: "dup", include: ["dup", "other"] }),
    );

    const scope = await detectScope(dir);
    // "dup" should appear only once
    expect(scope.include.filter((t) => t === "dup")).toHaveLength(1);
  });

  it("detects scope from git remote", async () => {
    const dir = await makeTempDir();
    git(dir, "init");
    git(
      dir,
      "remote",
      "add",
      "origin",
      "https://github.com/user/awesome-lib.git",
    );

    const scope = await detectScope(dir);
    expect(scope.name).toBe("awesome-lib");
    expect(scope.source).toBe("git-remote");
    expect(scope.include).toEqual(["awesome-lib"]);
    expect(scope.exclude).toEqual([]);
  });

  it("falls back to git root directory name when no remote", async () => {
    const dir = await makeTempDir();
    git(dir, "init");
    // No remote added

    const scope = await detectScope(dir);
    // The git root is dir itself, so name = basename(dir)
    const expected = basename(dir);
    expect(scope.name).toBe(expected);
    expect(scope.source).toBe("git-root");
    expect(scope.include).toEqual([expected]);
  });

  it("falls back to cwd basename when not a git repo", async () => {
    const dir = await makeTempDir();
    // No git init — just a plain directory

    const scope = await detectScope(dir);
    const expected = basename(dir);
    expect(scope.name).toBe(expected);
    expect(scope.source).toBe("dirname");
    expect(scope.include).toEqual([expected]);
    expect(scope.exclude).toEqual([]);
  });

  it("detects from git remote in a subdirectory", async () => {
    const dir = await makeTempDir();
    git(dir, "init");
    git(dir, "remote", "add", "origin", "git@github.com:org/sub-detect.git");

    const subDir = join(dir, "packages", "core");
    await mkdir(subDir, { recursive: true });

    const scope = await detectScope(subDir);
    expect(scope.name).toBe("sub-detect");
    expect(scope.source).toBe("git-remote");
  });
});

// ---------------------------------------------------------------------------
// matchesScope
// ---------------------------------------------------------------------------

describe("matchesScope", () => {
  const projectScope: ProjectScope = {
    name: "my-project",
    include: ["my-project", "shared"],
    exclude: ["deprecated"],
    source: "git-remote",
  };

  it("matches page with global scope", () => {
    expect(matchesScope(["global"], projectScope)).toBe(true);
  });

  it("matches page with matching include tag", () => {
    expect(matchesScope(["my-project"], projectScope)).toBe(true);
    expect(matchesScope(["shared"], projectScope)).toBe(true);
  });

  it("matches page with global and include tag", () => {
    expect(matchesScope(["global", "my-project"], projectScope)).toBe(true);
  });

  it("excludes page with matching exclude tag", () => {
    expect(matchesScope(["deprecated"], projectScope)).toBe(false);
  });

  it("exclude takes priority over include", () => {
    // Page has both an include tag and an exclude tag
    expect(matchesScope(["my-project", "deprecated"], projectScope)).toBe(
      false,
    );
  });

  it("exclude takes priority over global", () => {
    expect(matchesScope(["global", "deprecated"], projectScope)).toBe(false);
  });

  it("rejects page with no matching scope", () => {
    expect(matchesScope(["other-project"], projectScope)).toBe(false);
  });

  it("rejects page with empty scope", () => {
    expect(matchesScope([], projectScope)).toBe(false);
  });

  it("matches when scope has mixed matching and non-matching tags", () => {
    expect(matchesScope(["unrelated", "shared", "other"], projectScope)).toBe(
      true,
    );
  });

  it("works with empty exclude list", () => {
    const noExclude: ProjectScope = {
      name: "proj",
      include: ["proj"],
      exclude: [],
      source: "dirname",
    };
    expect(matchesScope(["proj"], noExclude)).toBe(true);
    expect(matchesScope(["other"], noExclude)).toBe(false);
    expect(matchesScope(["global"], noExclude)).toBe(true);
  });
});
