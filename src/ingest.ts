/**
 * Ingest pipeline — processes sources and integrates knowledge into the wiki.
 *
 * Resolves source content (URL, file, text), saves raw copy to the vault,
 * and returns structured data for the caller (tool or standalone agent)
 * to pass to the LLM for synthesis into wiki pages.
 */

import { readFile } from "node:fs/promises";
import type { QMDStore } from "qmd-engine";
import type { ParaCategory, PageRef, LogEntry } from "./wiki.js";
import { readSchema, readIndex } from "./wiki.js";
import { saveRawSource } from "./raw.js";
import type { ProjectScope } from "./scope.js";

// -- Types ------------------------------------------------------------------

export interface IngestOptions {
  source: string; // URL, file path, or raw text
  sourceType?: "url" | "file" | "text"; // auto-detected if omitted
  scope?: string[]; // override auto-detected scope
  category?: ParaCategory; // hint for PARA classification
}

export interface IngestReport {
  pagesCreated: PageRef[];
  pagesUpdated: PageRef[];
  logEntry: LogEntry;
}

/** Structure returned by LLM during ingest. */
export interface IngestResult {
  newPages: Array<{
    category: ParaCategory;
    slug: string;
    title: string;
    scope: string[];
    tags: string[];
    body: string;
  }>;
  updatedPages: Array<{
    category: ParaCategory;
    slug: string;
    appendOrReplace: "append" | "replace";
    body: string;
  }>;
  indexUpdate: string;
  logSummary: string;
}

/** Resolved source data from the ingest pipeline. */
export interface ResolvedSource {
  /** Original source string (URL, path, or text) */
  source: string;
  /** Detected or explicit source type */
  sourceType: "url" | "file" | "text";
  /** Fetched/read source content */
  content: string;
  /** Path in raw/ vault (undefined for inline text) */
  rawPath: string | undefined;
  /** Schema.md content for LLM context */
  schema: string;
  /** Index.md content for LLM context */
  index: string;
  /** Scope tags to assign */
  scopeTags: string[];
  /** Scope name */
  scopeName: string;
  /** Category hint (if provided) */
  categoryHint: ParaCategory | undefined;
}

// -- Source resolution -------------------------------------------------------

/** Detect source type from the source string. */
export function detectSourceType(source: string): "url" | "file" | "text" {
  if (/^https?:\/\//i.test(source)) return "url";
  if (/^\/|^\.\/|^~\/|^[a-zA-Z]:\\/.test(source)) return "file";
  // Heuristic: if it contains newlines or is very long, treat as text
  if (source.includes("\n") || source.length > 500) return "text";
  // Check for file-like paths (has extension)
  if (/\.\w{1,10}$/.test(source) && !source.includes(" ")) return "file";
  return "text";
}

/** Fetch content from a URL. */
export async function fetchUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** Read content from a file path. */
export async function readFileSource(filePath: string): Promise<string> {
  const resolved = filePath.replace(/^~\//, `${process.env.HOME ?? ""}/`);
  return readFile(resolved, "utf-8");
}

// -- Main pipeline -----------------------------------------------------------

/**
 * Resolve a source and prepare it for LLM synthesis.
 *
 * This is the reusable library function. It:
 * 1. Detects or uses the explicit source type
 * 2. Fetches URL / reads file / uses text directly
 * 3. Saves a raw copy to the vault (for non-text sources)
 * 4. Reads schema.md and index.md for LLM context
 * 5. Returns everything the caller needs to build an LLM prompt
 *
 * The caller (tool or standalone agent) assembles the prompt and
 * passes it to the LLM, which calls wiki_write to create pages.
 */
export async function resolveSource(
  wikiDir: string,
  options: IngestOptions,
  scope: ProjectScope,
): Promise<ResolvedSource> {
  const sourceType = options.sourceType ?? detectSourceType(options.source);

  // Resolve source content
  let content: string;
  switch (sourceType) {
    case "url":
      content = await fetchUrl(options.source);
      break;
    case "file":
      content = await readFileSource(options.source);
      break;
    case "text":
      content = options.source;
      break;
  }

  // Save raw source (skip for inline text — it's ephemeral)
  let rawPath: string | undefined;
  if (sourceType !== "text") {
    rawPath = await saveRawSource(wikiDir, {
      type: sourceType,
      content,
      originalPath: options.source,
    });
  }

  // Read schema and index for LLM context
  const schema = await readSchema(wikiDir);
  const index = await readIndex(wikiDir);

  // Build scope info
  const scopeTags = options.scope ?? scope.include;

  return {
    source: options.source,
    sourceType,
    content,
    rawPath,
    schema,
    index,
    scopeTags,
    scopeName: scope.name,
    categoryHint: options.category,
  };
}

/** Maximum source content length before truncation. */
export const MAX_SOURCE_LENGTH = 50_000;

/**
 * Truncate source content if it exceeds the limit.
 * Returns the truncated content with a marker.
 */
export function truncateSource(content: string, maxLength: number = MAX_SOURCE_LENGTH): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + "\n\n[... truncated]";
}
