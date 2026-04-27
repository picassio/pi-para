/**
 * Project scope detection and filtering.
 *
 * Determines which wiki pages are relevant to the current working context
 * by auto-detecting project name from cwd (git remote, git root, dirname)
 * or reading explicit config from .pi/wiki-scope.json.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

// -- Types ------------------------------------------------------------------

export interface ProjectScope {
  name: string;
  include: string[]; // scope tags to include (always includes name)
  exclude: string[]; // scope tags to exclude
  source: "config" | "git-remote" | "git-root" | "dirname";
}

/** .pi/wiki-scope.json schema */
export interface ScopeConfig {
  name: string;
  include?: string[];
  exclude?: string[];
}

// -- Helpers ----------------------------------------------------------------

/** Run a command and return trimmed stdout, or null on failure. */
function exec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const trimmed = (stdout ?? "").trim();
      resolve(trimmed || null);
    });
  });
}

/**
 * Extract a repo name from a git remote URL.
 *
 * Handles:
 *   git@github.com:user/repo.git  -> repo
 *   https://github.com/user/repo.git -> repo
 *   https://github.com/user/repo -> repo
 *   ssh://git@host/user/repo.git -> repo
 */
export function extractRepoName(remoteUrl: string): string | null {
  // Strip trailing slashes
  let url = remoteUrl.trim().replace(/\/+$/, "");
  // Strip .git suffix
  url = url.replace(/\.git$/, "");
  // Get the last path segment
  const lastSlash = url.lastIndexOf("/");
  const lastColon = url.lastIndexOf(":");
  const sep = Math.max(lastSlash, lastColon);
  if (sep < 0 || sep === url.length - 1) return null;
  const name = url.slice(sep + 1);
  return name || null;
}

// -- Public API -------------------------------------------------------------

/**
 * Load .pi/wiki-scope.json from the given directory.
 * Returns null if the file doesn't exist or is invalid JSON.
 */
export async function loadScopeConfig(
  cwd: string,
): Promise<ScopeConfig | null> {
  const configPath = join(cwd, ".pi", "wiki-scope.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).name !== "string" ||
    !(parsed as Record<string, unknown>).name
  ) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const config: ScopeConfig = { name: obj.name as string };

  if (Array.isArray(obj.include)) {
    config.include = obj.include.filter(
      (v: unknown) => typeof v === "string",
    );
  }
  if (Array.isArray(obj.exclude)) {
    config.exclude = obj.exclude.filter(
      (v: unknown) => typeof v === "string",
    );
  }

  return config;
}

/**
 * Auto-detect project scope from the working directory.
 *
 * Detection priority:
 *   1. .pi/wiki-scope.json (explicit config)
 *   2. Git remote origin URL -> repo name
 *   3. Git repository root directory name
 *   4. cwd basename (fallback)
 */
export async function detectScope(cwd: string): Promise<ProjectScope> {
  // 1. Explicit config
  const config = await loadScopeConfig(cwd);
  if (config) {
    const include = Array.from(
      new Set([config.name, ...(config.include ?? [])]),
    );
    return {
      name: config.name,
      include,
      exclude: config.exclude ?? [],
      source: "config",
    };
  }

  // 2. Git remote origin
  const remoteUrl = await exec("git", ["remote", "get-url", "origin"], cwd);
  if (remoteUrl) {
    const repoName = extractRepoName(remoteUrl);
    if (repoName) {
      return {
        name: repoName,
        include: [repoName],
        exclude: [],
        source: "git-remote",
      };
    }
  }

  // 3. Git root directory name
  const gitRoot = await exec(
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
  if (gitRoot) {
    const name = basename(gitRoot);
    if (name) {
      return {
        name,
        include: [name],
        exclude: [],
        source: "git-root",
      };
    }
  }

  // 4. Fallback to cwd basename
  const name = basename(cwd);
  return {
    name,
    include: [name],
    exclude: [],
    source: "dirname",
  };
}

/**
 * Check whether a page's scope tags match the project scope.
 *
 * Rules:
 *   - A page matches if its scope contains "global" OR any tag in projectScope.include
 *   - A page is excluded if its scope contains any tag in projectScope.exclude
 *   - Exclude takes priority over include
 */
export function matchesScope(
  pageScope: string[],
  projectScope: ProjectScope,
): boolean {
  // Exclude takes priority
  if (
    projectScope.exclude.length > 0 &&
    pageScope.some((tag) => projectScope.exclude.includes(tag))
  ) {
    return false;
  }

  // Match: "global" or any include tag
  if (pageScope.includes("global")) {
    return true;
  }

  return pageScope.some((tag) => projectScope.include.includes(tag));
}
