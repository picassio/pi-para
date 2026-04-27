/**
 * Raw source vault and session digests.
 *
 * Manages immutable source material in ~/.pi/wiki/raw/ and
 * session digest entries in sessions.md.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, basename, extname } from "node:path";

// -- Types ------------------------------------------------------------------

export interface RawSource {
  type: "url" | "file" | "text";
  originalPath: string;
  savedPath: string; // path within raw/ directory
  ingestedAt: string; // ISO date
  wikiPages: string[]; // wiki pages derived from this source
}

export interface SessionDigest {
  date: string;
  project: string;
  sessionFile: string;
  scope: string;
  capturedPages: string[];
  summary: string;
}

// -- Helpers -----------------------------------------------------------------

const RAW_SUBDIRS: Record<"url" | "file" | "text", string> = {
  url: "articles",
  file: "docs",
  text: "notes",
};

/**
 * Slugify a string for use as a filename. Lowercase, hyphens, no special
 * characters. Collapses multiple hyphens. Trims leading/trailing hyphens.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive a filename slug from the original path based on source type.
 *
 * - URL: extract domain + path components
 * - file: use the filename without extension
 * - text: use a timestamp-based name
 */
function deriveSlug(type: "url" | "file" | "text", originalPath: string): string {
  if (type === "url") {
    try {
      const url = new URL(originalPath);
      const host = url.hostname.replace(/^www\./, "");
      const pathParts = url.pathname
        .split("/")
        .filter((p) => p.length > 0)
        .slice(0, 3);
      const raw = [host, ...pathParts].join("-");
      return slugify(raw) || "untitled";
    } catch {
      return slugify(originalPath) || "untitled";
    }
  }

  if (type === "file") {
    const name = basename(originalPath, extname(originalPath));
    return slugify(name) || "untitled";
  }

  // text: timestamp-based
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `note-${ts}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a unique filename by appending -2, -3, etc. if the slug already exists.
 */
async function uniquePath(dir: string, slug: string, ext: string): Promise<string> {
  let candidate = join(dir, `${slug}${ext}`);
  if (!(await fileExists(candidate))) return candidate;

  let i = 2;
  while (await fileExists(join(dir, `${slug}-${i}${ext}`))) {
    i++;
  }
  return join(dir, `${slug}-${i}${ext}`);
}

// -- Functions ---------------------------------------------------------------

/**
 * Save a raw source to the vault. URL sources go to raw/articles/,
 * file sources to raw/docs/, text sources to raw/notes/.
 *
 * The file is saved as markdown with a metadata header.
 * Returns the path relative to wikiDir (e.g. "raw/articles/example-com-page.md").
 */
export async function saveRawSource(
  wikiDir: string,
  source: {
    type: "url" | "file" | "text";
    content: string;
    originalPath: string;
  },
): Promise<string> {
  const subdir = RAW_SUBDIRS[source.type];
  const dir = join(wikiDir, "raw", subdir);
  await mkdir(dir, { recursive: true });

  const slug = deriveSlug(source.type, source.originalPath);
  const filePath = await uniquePath(dir, slug, ".md");
  const fileName = basename(filePath);

  const header = [
    "---",
    `source_type: ${source.type}`,
    `original_path: "${source.originalPath}"`,
    `ingested_at: "${new Date().toISOString()}"`,
    "---",
    "",
  ].join("\n");

  await writeFile(filePath, header + source.content, "utf-8");

  return `raw/${subdir}/${fileName}`;
}

/**
 * Append a session digest entry to sessions.md in the documented format:
 *
 * ```
 * ## [2026-04-27] pi-mono | SSL certificate debugging
 * - **Session**: `~/.pi/agent/sessions/.../file.jsonl`
 * - **Scope**: pi-mono
 * - **Captured**: [[ssl-cert-gotchas]]
 * - **Summary**: One-paragraph summary...
 * ```
 *
 * Creates sessions.md if it does not exist.
 */
export async function appendSessionDigest(
  wikiDir: string,
  digest: SessionDigest,
): Promise<void> {
  const sessionsPath = join(wikiDir, "sessions.md");

  let existing: string;
  try {
    existing = await readFile(sessionsPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = "# Session Digests\n";
    } else {
      throw err;
    }
  }

  const captured = digest.capturedPages.map((p) => `[[${p}]]`).join(", ");
  const heading = digest.summary.split(/[.!?\n]/)[0].trim() || "Session capture";

  const entry = [
    "",
    `## [${digest.date}] ${digest.project} | ${heading}`,
    `- **Session**: \`${digest.sessionFile}\``,
    `- **Scope**: ${digest.scope}`,
    `- **Captured**: ${captured || "none"}`,
    `- **Summary**: ${digest.summary}`,
    "",
  ].join("\n");

  await writeFile(sessionsPath, existing + entry, "utf-8");
}

/**
 * Parse sessions.md and return session digest entries.
 * Optionally filter by scope and/or limit the number of results.
 * Results are returned in file order (oldest first).
 */
export async function readSessionDigests(
  wikiDir: string,
  options?: { limit?: number; scope?: string },
): Promise<SessionDigest[]> {
  const sessionsPath = join(wikiDir, "sessions.md");

  let content: string;
  try {
    content = await readFile(sessionsPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const digests: SessionDigest[] = [];

  // Split on ## headings (session entries)
  const entryPattern = /^## \[([^\]]+)\] ([^|]+)\| (.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(content)) !== null) {
    const date = match[1].trim();
    const project = match[2].trim();
    // Extract the block after this heading until the next heading or end
    const startIdx = match.index + match[0].length;
    const nextHeading = content.indexOf("\n## ", startIdx);
    const block = nextHeading === -1
      ? content.slice(startIdx)
      : content.slice(startIdx, nextHeading);

    const sessionFile = extractField(block, "Session");
    const scope = extractField(block, "Scope");
    const capturedRaw = extractField(block, "Captured");
    const summary = extractField(block, "Summary");

    // Parse captured wikilinks: [[slug1]], [[slug2]]
    const capturedPages: string[] = [];
    const linkPattern = /\[\[([^\]]+)\]\]/g;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkPattern.exec(capturedRaw)) !== null) {
      capturedPages.push(linkMatch[1]);
    }

    digests.push({
      date,
      project,
      sessionFile,
      scope,
      capturedPages,
      summary,
    });
  }

  // Apply scope filter
  let filtered = digests;
  if (options?.scope) {
    const scopeFilter = options.scope;
    filtered = filtered.filter((d) => d.scope === scopeFilter);
  }

  // Apply limit (return the last N entries — most recent)
  if (options?.limit !== undefined && options.limit < filtered.length) {
    filtered = filtered.slice(filtered.length - options.limit);
  }

  return filtered;
}

/**
 * Extract a field value from a session digest block.
 * Matches lines like: `- **Field**: value` or `- **Field**: \`value\``
 */
function extractField(block: string, field: string): string {
  const pattern = new RegExp(`^- \\*\\*${field}\\*\\*:\\s*(.+)$`, "m");
  const match = pattern.exec(block);
  if (!match) return "";
  // Strip backticks wrapping the value
  return match[1].trim().replace(/^`|`$/g, "");
}
