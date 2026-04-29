/**
 * YAML frontmatter parsing and serialization for wiki pages.
 *
 * Handles the `---\n...\n---` frontmatter block in markdown files.
 * Uses the `yaml` package for robust parsing. Preserves unknown fields.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PageFrontmatter, ParaCategory } from "./wiki.js";

// -- Schema versioning -------------------------------------------------------

/** Current schema version. Bump when frontmatter/body format changes. */
export const CURRENT_SCHEMA_VERSION = 1;

/** A migration transforms pages from one schema version to the next. */
export interface Migration {
  from: number;
  to: number;
  migrate: (fm: Record<string, unknown>, body: string) => { fm: Record<string, unknown>; body: string };
  description: string;
}

/**
 * Registry of all schema migrations, ordered by `from` version.
 * Empty while CURRENT_SCHEMA_VERSION = 1 — add entries when bumping.
 */
export const MIGRATIONS: Migration[] = [];

/**
 * Apply all applicable migrations to bring a page up to CURRENT_SCHEMA_VERSION.
 *
 * Chains migrations sequentially: 1→2, 2→3, etc.
 * If `schemaVersion` is already >= CURRENT_SCHEMA_VERSION, returns as-is (no downgrade).
 * If `schemaVersion` is missing, defaults to 1.
 */
export function migrateToLatest(
  fm: Record<string, unknown>,
  body: string,
): { fm: Record<string, unknown>; body: string } {
  let version = typeof fm.schemaVersion === "number" ? fm.schemaVersion : 1;

  // Don't downgrade pages ahead of current version
  if (version >= CURRENT_SCHEMA_VERSION) {
    return { fm: { ...fm, schemaVersion: version }, body };
  }

  let currentFm = { ...fm };
  let currentBody = body;

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === version);
    if (!migration) {
      // No migration path — stop at current version
      break;
    }
    const result = migration.migrate(currentFm, currentBody);
    currentFm = result.fm;
    currentBody = result.body;
    version = migration.to;
  }

  currentFm.schemaVersion = version;
  return { fm: currentFm, body: currentBody };
}

const VALID_PARA_CATEGORIES = new Set<string>([
  "projects",
  "areas",
  "resources",
  "archives",
]);

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/;

// -- Functions ---------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown content.
 *
 * Expects content starting with `---\n...\n---`. If no frontmatter block
 * is found, returns default frontmatter and the entire content as body.
 * If the YAML is malformed, throws with a descriptive error.
 */
export function parseFrontmatter(content: string): {
  frontmatter: PageFrontmatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      frontmatter: validateFrontmatter({}),
      body: content,
    };
  }

  const rawYaml = match[1];
  const body = match[2];

  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed YAML frontmatter: ${msg}`);
  }

  if (parsed == null || typeof parsed !== "object") {
    return {
      frontmatter: validateFrontmatter({}),
      body,
    };
  }

  return {
    frontmatter: validateFrontmatter(parsed as Record<string, unknown>),
    body,
  };
}

/**
 * Serialize frontmatter and body back to a markdown string with YAML
 * frontmatter block.
 */
export function serializeFrontmatter(
  frontmatter: PageFrontmatter,
  body: string,
): string {
  // Always write the current schema version on serialize
  const fmWithVersion = { ...frontmatter, schemaVersion: CURRENT_SCHEMA_VERSION };
  const yaml = stringifyYaml(fmWithVersion, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Validate and normalize a raw frontmatter object into a PageFrontmatter.
 *
 * Required field: `title` (defaults to "Untitled" if missing).
 * All other fields get sensible defaults. Unknown fields are preserved.
 */
export function validateFrontmatter(
  fm: Record<string, unknown>,
): PageFrontmatter {
  const now = new Date().toISOString();

  const title =
    typeof fm.title === "string" && fm.title.length > 0
      ? fm.title
      : "Untitled";

  const para = validateParaCategory(fm.para);
  const scope = toStringArray(fm.scope);
  const tags = toStringArray(fm.tags);
  const sources = toStringArray(fm.sources);
  const links = toStringArray(fm.links);
  const created =
    typeof fm.created === "string" && fm.created.length > 0
      ? fm.created
      : now;
  const updated =
    typeof fm.updated === "string" && fm.updated.length > 0
      ? fm.updated
      : now;

  const schemaVersion =
    typeof fm.schemaVersion === "number" ? fm.schemaVersion : 1;

  // Build result with known fields first, then spread unknown fields underneath.
  // Known fields override any unknown fields with the same name.
  const knownKeys = new Set([
    "title",
    "para",
    "scope",
    "tags",
    "sources",
    "created",
    "updated",
    "links",
    "schemaVersion",
  ]);
  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!knownKeys.has(key)) {
      unknownFields[key] = value;
    }
  }

  return {
    ...unknownFields,
    title,
    para,
    scope,
    tags,
    sources,
    created,
    updated,
    links,
    schemaVersion,
  } as PageFrontmatter;
}

// -- Helpers -----------------------------------------------------------------

function validateParaCategory(value: unknown): ParaCategory {
  if (typeof value === "string" && VALID_PARA_CATEGORIES.has(value)) {
    return value as ParaCategory;
  }
  return "resources";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}
