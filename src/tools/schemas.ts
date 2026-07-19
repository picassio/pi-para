import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { LintReport } from "../lint.js";

// -- Parameter schemas -------------------------------------------------------

export const PARA_ENUM = StringEnum(
  ["projects", "areas", "resources", "archives"] as const,
  { description: "PARA category" },
);

export const PARA_ENUM_NO_ARCHIVES = StringEnum(
  ["projects", "areas", "resources"] as const,
  { description: "PARA category (archives excluded for new content)" },
);

export const WikiIngestParams = Type.Object({
  source: Type.String({ description: "URL, file path, or raw text to ingest" }),
  sourceType: Type.Optional(
    StringEnum(["url", "file", "text"] as const, {
      description: "Source type (auto-detected if omitted)",
    }),
  ),
  category: Type.Optional(PARA_ENUM_NO_ARCHIVES),
  scope: Type.Optional(
    Type.Array(Type.String(), { description: "Scope tags for the ingested content" }),
  ),
});

export const WikiQueryParams = Type.Object({
  query: Type.String({ description: "Natural language search query" }),
  global: Type.Optional(
    Type.Boolean({ description: "Search all scopes, not just current project" }),
  ),
  category: Type.Optional(PARA_ENUM),
  limit: Type.Optional(
    Type.Number({ description: "Max results (default 10)" }),
  ),
});

export const WikiEditSchema = Type.Object({
  oldText: Type.String({ description: "Exact text to find in the page body" }),
  newText: Type.String({ description: "Replacement text" }),
});

export const WikiWritePageSchema = Type.Object({
  category: PARA_ENUM,
  slug: Type.String({ description: "Page slug (lowercase, hyphens)" }),
  title: Type.String({ description: "Page title" }),
  scope: Type.Array(Type.String(), { description: "Scope tags" }),
  tags: Type.Array(Type.String(), { description: "Topic tags" }),
  body: Type.String({ description: "Page body in markdown (wiki summary format)" }),
  mode: StringEnum(["create", "replace", "append", "edit"] as const, {
    description: "Write mode: create new, replace existing, append to existing, or edit specific sections",
  }),
  edits: Type.Optional(Type.Array(WikiEditSchema, {
    description: "For mode=edit: targeted text replacements (oldText→newText). Page must exist.",
  })),
});

export const WikiWriteParams = Type.Object({
  pages: Type.Array(WikiWritePageSchema, {
    description: "Pages to write or update",
  }),
  // DEPRECATED: indexContent is ignored. Index is auto-rebuilt from all pages on disk.
  // Kept in schema to avoid breaking existing callers.
  indexContent: Type.Optional(
    Type.String({ description: "Updated index.md content (full replacement)" }),
  ),
  logSummary: Type.Optional(
    Type.String({ description: "One-line summary for log.md" }),
  ),
});

export const WikiEditParams = Type.Object({
  path: Type.String({ description: "Existing page path (e.g. 'resources/ssl-cert-gotchas')" }),
  edits: Type.Array(WikiEditSchema, {
    description: "Atomic exact text replacements. Every oldText must appear exactly once or no changes are written.",
  }),
  title: Type.Optional(Type.String({ description: "Optional replacement page title" })),
  scope: Type.Optional(Type.Array(Type.String(), { description: "Optional replacement scope tags" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Optional replacement topic tags" })),
  logSummary: Type.Optional(Type.String({ description: "One-line summary for log.md" })),
});

export const WikiReadParams = Type.Object({
  path: Type.String({
    description: "Page path (e.g. 'projects/auth-refactor') or page title",
  }),
});

export const WikiMoveParams = Type.Object({
  path: Type.String({
    description: "Current page path (e.g. 'projects/auth-refactor')",
  }),
  to: PARA_ENUM,
});

export const WikiLintParams = Type.Object({
  autoFix: Type.Optional(
    Type.Boolean({ description: "Auto-fix simple issues (default true)" }),
  ),
});

export const WikiMigrateParams = Type.Object({});

export const WikiSummarizeParams = Type.Object({
  target: Type.String({
    description: "Page path, category name (e.g. 'projects'), or 'all'",
  }),
  depth: Type.Optional(
    StringEnum(["brief", "detailed"] as const, {
      description: "Summary depth (default brief)",
    }),
  ),
});

// -- Detail types for tool results -------------------------------------------

export interface WikiIngestDetails {
  sourceType: "url" | "file" | "text";
  rawPath?: string;
  sourceLength: number;
}

export interface WikiQueryDetails {
  resultCount: number;
  scopeUsed: string;
}

export interface WikiWriteDetails {
  pagesWritten: string[];
  indexUpdated: boolean;
  logAppended: boolean;
  pagesSkipped?: string[];
}

export interface WikiReadDetails {
  found: boolean;
  path?: string;
}

export interface WikiMoveDetails {
  from: string;
  to: string;
}

export interface WikiLintDetails {
  issueCount: number;
  fixedCount: number;
  stats: LintReport["stats"];
}

export interface WikiSummarizeDetails {
  target: string;
  pageCount: number;
}
