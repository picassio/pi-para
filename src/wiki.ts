/**
 * Wiki filesystem operations — manages ~/.pi/wiki/ directory structure.
 *
 * Handles CRUD for wiki pages (markdown + YAML frontmatter), index/log
 * maintenance, page moves between PARA categories, and wiki initialization.
 */

import {
  readFile,
  writeFile,
  mkdir,
  unlink,
  readdir,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  parseFrontmatter,
  serializeFrontmatter,
} from "./frontmatter.js";
import type { StateDB } from "./state.js";

// -- Types ------------------------------------------------------------------

export type ParaCategory = "projects" | "areas" | "resources" | "archives";

export interface PageFrontmatter {
  title: string;
  para: ParaCategory;
  scope: string[];
  tags: string[];
  sources: string[];
  created: string; // ISO date
  updated: string; // ISO date
  links: string[]; // outgoing [[wikilinks]]
  schemaVersion: number; // schema version for migration tracking
}

export interface WikiPage {
  category: ParaCategory;
  slug: string;
  frontmatter: PageFrontmatter;
  body: string;
}

export interface PageRef {
  category: ParaCategory;
  slug: string;
  title: string;
  path: string; // relative path within wiki dir
}

export interface LogEntry {
  date: string;
  operation: "ingest" | "query" | "lint" | "capture" | "move" | "archive" | "edit";
  summary: string;
  pages: string[];
}

// -- Constants ---------------------------------------------------------------

export const PARA_CATEGORIES: readonly ParaCategory[] = [
  "projects",
  "areas",
  "resources",
  "archives",
];

const DEFAULT_SCHEMA = `# Wiki Schema

## Page Format

Every wiki page is a markdown file with YAML frontmatter:

\`\`\`yaml
---
title: Page Title
para: projects | areas | resources | archives
scope:
  - project-name
  - global
tags:
  - topic-tag
sources:
  - https://example.com
  - session:~/.pi/agent/sessions/.../file.jsonl
created: "2026-01-01"
updated: "2026-01-01"
links:
  - other-page-slug
---
\`\`\`

## PARA Categories

- **projects/**: Active, goal-defined work with an end date. Default scope: current project name.
- **areas/**: Ongoing responsibilities with no end date. Default scope: \`["global"]\`.
- **resources/**: Reference material, how-tos, patterns. Scope assigned by content analysis.
- **archives/**: Completed, deprecated, or inactive items. Moved from other categories.

## Naming Conventions

- Slugs: lowercase, hyphens, no special characters (e.g., \`ssl-cert-gotchas\`)
- One concept per page
- Use [[wikilinks]] for cross-references: \`[[slug]]\`

## Wiki Summary Format

\`\`\`markdown
## Topic
[What this page covers]

## Key Facts
- [Established knowledge points]

## Insights
- [Non-obvious findings, patterns, implications]

## Connections
- [[related-page]] — how this relates

## Open Questions
- [Gaps in knowledge, unresolved contradictions]

## Sources
- [Source URLs, file paths, session references]
\`\`\`

## Index Format

\`index.md\` is organized by PARA category with one-line summaries per page.

## Log Format

\`log.md\` uses the heading format: \`## [YYYY-MM-DD] operation | summary\`

## Tone

Technical, concise, factual. No fluff.

## Updates vs. New Pages

- Update an existing page when new information relates to the same concept
- Create a new page when the concept is distinct enough to stand alone
- When in doubt, create a new page and add [[wikilinks]]

## Archiving

Move projects to archives when:
- The project goal is completed
- No log entries in 90+ days
- Explicitly requested by user
`;

const DEFAULT_INDEX = `# Wiki Index

## Projects

_No active projects yet._

## Areas

_No areas defined yet._

## Resources

_No resources yet._

## Archives

_No archived items._
`;

const DEFAULT_LOG = "# Activity Log\n";

const DEFAULT_SESSIONS = "# Session Digests\n";

const DEFAULT_GITIGNORE = `# pi-para generated state (do not version)
.qmd.sqlite*
.daemon.sqlite*
.pi-para.sqlite*
gepa/input/
gepa/output/

# local caches/logs
*.tmp
`;

// -- Helpers -----------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedFile(path: string, content: string): Promise<void> {
  if (!(await fileExists(path))) {
    await writeFile(path, content, "utf-8");
  }
}

// -- Functions ---------------------------------------------------------------

/**
 * Initialize a wiki directory. Creates the PARA category directories,
 * raw source directories, and seeds schema.md, index.md, log.md, and
 * sessions.md if they do not already exist. Idempotent.
 */
export async function initWiki(wikiDir: string): Promise<void> {
  // Create PARA category directories
  for (const cat of PARA_CATEGORIES) {
    await mkdir(join(wikiDir, cat), { recursive: true });
  }

  // Create raw source directories
  for (const sub of ["articles", "docs", "notes"]) {
    await mkdir(join(wikiDir, "raw", sub), { recursive: true });
  }

  // Seed default files (only if missing)
  await seedFile(join(wikiDir, "schema.md"), DEFAULT_SCHEMA);
  await seedFile(join(wikiDir, "index.md"), DEFAULT_INDEX);
  await seedFile(join(wikiDir, "log.md"), DEFAULT_LOG);
  await seedFile(join(wikiDir, "sessions.md"), DEFAULT_SESSIONS);
  await seedFile(join(wikiDir, ".gitignore"), DEFAULT_GITIGNORE);
}

/**
 * Read a wiki page by category and slug. Returns null if the page does
 * not exist. Parses YAML frontmatter via frontmatter.ts.
 */
export async function readPage(
  wikiDir: string,
  category: ParaCategory,
  slug: string,
): Promise<WikiPage | null> {
  const filePath = join(wikiDir, category, `${slug}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const { frontmatter, body } = parseFrontmatter(content);
  return { category, slug, frontmatter, body };
}

/**
 * Write a wiki page. Creates the category directory if needed. Serializes
 * frontmatter and body via frontmatter.ts.
 *
 * If stateDb is provided, also updates the page summary cache.
 */
export async function writePage(
  wikiDir: string,
  page: WikiPage,
  stateDb?: StateDB,
): Promise<void> {
  const dirPath = join(wikiDir, page.category);
  await mkdir(dirPath, { recursive: true });
  const filePath = join(dirPath, `${page.slug}.md`);
  const content = serializeFrontmatter(page.frontmatter, page.body);
  await writeFile(filePath, content, "utf-8");

  // Update page summary cache if state DB is available
  if (stateDb) {
    const firstPara = extractFirstParagraphFromBody(page.body);
    stateDb.upsertPageSummary(
      page.slug,
      page.category,
      page.frontmatter.scope,
      page.frontmatter.tags,
      firstPara,
      page.frontmatter.updated,
    );
  }
}

/**
 * Delete a wiki page. No-op if the page does not exist.
 */
export async function deletePage(
  wikiDir: string,
  category: ParaCategory,
  slug: string,
): Promise<void> {
  const filePath = join(wikiDir, category, `${slug}.md`);
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

/**
 * Move a page between PARA categories. Updates the page's `para` and
 * `updated` frontmatter fields. The slug is preserved.
 */
export async function movePage(
  wikiDir: string,
  from: PageRef,
  toCategory: ParaCategory,
): Promise<void> {
  const srcPath = join(wikiDir, from.category, `${from.slug}.md`);
  const destDir = join(wikiDir, toCategory);
  const destPath = join(destDir, `${from.slug}.md`);

  // Read source
  const content = await readFile(srcPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Update frontmatter
  frontmatter.para = toCategory;
  frontmatter.updated = new Date().toISOString();

  // Write to new location, then remove old file
  await mkdir(destDir, { recursive: true });
  await writeFile(destPath, serializeFrontmatter(frontmatter, body), "utf-8");
  await unlink(srcPath);
}

/**
 * List pages across one or all PARA categories. Returns PageRef objects
 * sorted by category then slug.
 */
export async function listPages(
  wikiDir: string,
  category?: ParaCategory,
): Promise<PageRef[]> {
  const categories = category ? [category] : PARA_CATEGORIES;
  const refs: PageRef[] = [];

  for (const cat of categories) {
    const dirPath = join(wikiDir, cat);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue; // directory doesn't exist yet
    }

    const catRefs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".md"))
        .map(async (entry): Promise<PageRef> => {
          const slug = entry.slice(0, -3);
          const content = await readFile(join(dirPath, entry), "utf-8");
          const { frontmatter } = parseFrontmatter(content);
          return {
            category: cat,
            slug,
            title: frontmatter.title,
            path: `${cat}/${entry}`,
          };
        }),
    );
    refs.push(...catRefs);
  }

  // Sort by category order, then slug alphabetically
  refs.sort((a, b) => {
    const catCmp =
      PARA_CATEGORIES.indexOf(a.category) -
      PARA_CATEGORIES.indexOf(b.category);
    if (catCmp !== 0) return catCmp;
    return a.slug.localeCompare(b.slug);
  });

  return refs;
}

/**
 * List page slugs across all PARA categories without reading file contents.
 * Much cheaper than listPages() when only slugs are needed (e.g. auto-linking).
 */
export async function listPageSlugs(wikiDir: string): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const cat of PARA_CATEGORIES) {
    let entries: string[];
    try {
      entries = await readdir(join(wikiDir, cat));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) slugs.add(entry.slice(0, -3));
    }
  }
  return slugs;
}

/**
 * Read the wiki index (index.md).
 */
export async function readIndex(wikiDir: string): Promise<string> {
  return readFile(join(wikiDir, "index.md"), "utf-8");
}

/**
 * Write the wiki index (index.md).
 */
export async function writeIndex(
  wikiDir: string,
  content: string,
): Promise<void> {
  await writeFile(join(wikiDir, "index.md"), content, "utf-8");
}

/**
 * Append an entry to the activity log (log.md).
 */
export async function appendLog(
  wikiDir: string,
  entry: LogEntry,
): Promise<void> {
  const logPath = join(wikiDir, "log.md");
  const existing = await readFile(logPath, "utf-8");
  const pages = entry.pages.length > 0 ? entry.pages.join(", ") : "none";
  const line = `\n## [${entry.date}] ${entry.operation} | ${entry.summary}\nPages: ${pages}\n`;
  await writeFile(logPath, existing + line, "utf-8");
}

/**
 * Read the wiki schema (schema.md).
 */
export async function readSchema(wikiDir: string): Promise<string> {
  return readFile(join(wikiDir, "schema.md"), "utf-8");
}

// -- Git auto-commit ---------------------------------------------------------

/**
 * Run a git command in the wiki directory. Returns stdout or null on failure.
 */
function git(wikiDir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: wikiDir, timeout: 10_000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

// -- Index rebuild -----------------------------------------------------------

/**
 * Rebuild index.md deterministically from all pages on disk.
 *
 * Reads all pages, groups by PARA category, sorts alphabetically within
 * each category, and writes a standardized index.md with one-line summaries.
 */
export async function rebuildIndex(wikiDir: string): Promise<void> {
  const sections: Record<ParaCategory, string[]> = {
    projects: [],
    areas: [],
    resources: [],
    archives: [],
  };

  // Single pass: read each page file exactly once, in parallel per category.
  // (Previously this called listPages() and then readPage() per page, reading
  // every file twice sequentially — the dominant cost of wiki_write at scale.)
  for (const cat of PARA_CATEGORIES) {
    const dirPath = join(wikiDir, cat);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue; // directory doesn't exist yet
    }

    const lines = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => entry.slice(0, -3))
        .sort((a, b) => a.localeCompare(b))
        .map(async (slug) => {
          const entry = `${slug}.md`;
          const content = await readFile(join(dirPath, entry), "utf-8");
          const { frontmatter, body } = parseFrontmatter(content);
          const title = frontmatter.title;
          const summary = extractFirstParagraphFromBody(body);
          const desc = summary && summary !== "(no summary)"
            ? ": " + (summary.length > 120 ? summary.slice(0, 117) + "..." : summary)
            : "";
          return `- [[${slug}]] \u2014 ${title}${desc}`;
        }),
    );
    sections[cat].push(...lines);
  }

  const categoryLabels: Record<ParaCategory, string> = {
    projects: "Projects",
    areas: "Areas",
    resources: "Resources",
    archives: "Archives",
  };

  const lines: string[] = ["# Wiki Index", ""];
  for (const cat of PARA_CATEGORIES) {
    lines.push(`## ${categoryLabels[cat]}`, "");
    if (sections[cat].length > 0) {
      lines.push(...sections[cat]);
    } else {
      const emptyMsg: Record<ParaCategory, string> = {
        projects: "_No active projects yet._",
        areas: "_No areas defined yet._",
        resources: "_No resources yet._",
        archives: "_No archived items._",
      };
      lines.push(emptyMsg[cat]);
    }
    lines.push("");
  }

  // Remove trailing empty line to avoid double newlines
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  lines.push(""); // single trailing newline

  await writeIndex(wikiDir, lines.join("\n"));
}

/**
 * Extract the first non-empty paragraph from a markdown body.
 * Skips headings and blank lines. Returns a single line.
 */
function extractFirstParagraphFromBody(body: string): string {
  const lines = body.split("\n");
  const paragraphLines: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headings and empty lines before paragraph starts
    if (!inParagraph) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      inParagraph = true;
    }

    // End paragraph on blank line or heading
    if (inParagraph && (trimmed === "" || trimmed.startsWith("#"))) {
      break;
    }

    paragraphLines.push(trimmed);
  }

  const result = paragraphLines.join(" ");
  // Truncate long paragraphs
  if (result.length > 200) {
    return result.slice(0, 197) + "...";
  }
  return result || "(no summary)";
}

/**
 * Auto-commit all wiki changes with a descriptive message.
 *
 * Silently no-ops if:
 * - git is not installed
 * - wiki dir is not a git repo
 * - there are no changes to commit
 */
export async function gitCommit(
  wikiDir: string,
  message: string,
): Promise<boolean> {
  try {
    // Check if it's a git repo
    const isRepo = await git(wikiDir, ["rev-parse", "--git-dir"]);
    if (!isRepo) {
      // Auto-init if not a repo yet
      const initResult = await git(wikiDir, ["init"]);
      if (!initResult) return false;
    }

    // Stage durable wiki content only. Generated SQLite/search state can be large
    // and made wiki edits slow when `git add -A` tried to version it.
    const stageCandidates = [
      ".gitignore",
      "schema.md",
      "index.md",
      "log.md",
      "sessions.md",
      "config.json",
      ".completed-sessions",
      ...PARA_CATEGORIES,
    ];
    const stagePaths: string[] = [];
    for (const p of stageCandidates) {
      if (await fileExists(join(wikiDir, p))) stagePaths.push(p);
    }
    if (stagePaths.length > 0) {
      await git(wikiDir, ["add", "--", ...stagePaths]);
    }

    // Check if there's anything to commit
    const status = await git(wikiDir, ["status", "--porcelain"]);
    if (!status) return false; // nothing to commit

    // Commit
    const result = await git(wikiDir, ["commit", "-m", message, "--no-gpg-sign"]);
    return result !== null;
  } catch {
    return false;
  }
}
