/**
 * Wiki health checks — validates wiki structure and content integrity.
 *
 * Checks for orphan pages, broken links, stale pages, scope drift,
 * archive candidates, missing pages, frontmatter issues, index drift,
 * empty categories, and duplicate slugs.
 *
 * When autoFix is true (default), fixable issues are repaired in-place:
 * broken links removed, index rebuilt for drift, missing frontmatter fields set.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listPages,
  readPage,
  writePage,
  readIndex,
  writeIndex,
  PARA_CATEGORIES,
} from "./wiki.js";
import type { ParaCategory, WikiPage, PageRef } from "./wiki.js";
import {
  extractWikilinks,
  removeWikilink,
  autoLinkSlugs,
  findUnlinkedSlugs,
  syncFrontmatterLinks,
} from "./link-utils.js";
import { normalizeTags, normalizeScopes } from "./tag-registry.js";
import { containsSecrets, redactSecrets } from "./redact.js";
import {
  CURRENT_SCHEMA_VERSION,
  migrateToLatest,
  parseFrontmatter,
  serializeFrontmatter,
} from "./frontmatter.js";

// -- Types ------------------------------------------------------------------

export interface LintOptions {
  staleDays?: number; // days before a page is "stale" (default 90)
  autoFix?: boolean; // auto-fix fixable issues (default true)
}

export interface LintReport {
  issues: LintIssue[];
  fixed: LintIssue[];
  stats: WikiStats;
}

export interface LintIssue {
  severity: "error" | "warning" | "info";
  category: string; // "orphan" | "broken-link" | "stale" | etc.
  page?: string;
  message: string;
  autoFixable: boolean;
}

export interface WikiStats {
  totalPages: number;
  byCategory: Record<ParaCategory, number>;
  totalLinks: number;
  brokenLinks: number;
  orphanPages: number;
  oldestPage: string;
  newestPage: string;
  lastIngest: string;
}

// -- Helpers ----------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

function makeStats(
  pages: WikiPage[],
  totalLinks: number,
  brokenLinks: number,
  orphanCount: number,
  logContent: string,
): WikiStats {
  const byCategory: Record<ParaCategory, number> = {
    projects: 0,
    areas: 0,
    resources: 0,
    archives: 0,
  };
  let oldest = "";
  let newest = "";
  for (const p of pages) {
    byCategory[p.category]++;
    const created = p.frontmatter.created;
    if (!oldest || created < oldest) oldest = created;
    if (!newest || created > newest) newest = created;
  }

  // Find last ingest date from log
  let lastIngest = "";
  const ingestRe = /## \[(\d{4}-\d{2}-\d{2})\] ingest/g;
  let match: RegExpExecArray | null;
  while ((match = ingestRe.exec(logContent)) !== null) {
    if (!lastIngest || match[1] > lastIngest) lastIngest = match[1];
  }

  return {
    totalPages: pages.length,
    byCategory,
    totalLinks,
    brokenLinks,
    orphanPages: orphanCount,
    oldestPage: oldest,
    newestPage: newest,
    lastIngest,
  };
}

// -- Checks -----------------------------------------------------------------

/** 1. Orphan pages: no inbound [[wikilinks]] from any other page */
function checkOrphans(
  pages: WikiPage[],
  allSlugs: Set<string>,
): LintIssue[] {
  // Build inbound link map
  const inbound = new Set<string>();
  for (const p of pages) {
    const bodyLinks = extractWikilinks(p.body);
    const fmLinks = p.frontmatter.links;
    for (const link of [...bodyLinks, ...fmLinks]) {
      inbound.add(link);
    }
  }

  const issues: LintIssue[] = [];
  for (const p of pages) {
    if (!inbound.has(p.slug)) {
      issues.push({
        severity: "info",
        category: "orphan",
        page: `${p.category}/${p.slug}`,
        message: `Orphan page — no inbound [[wikilinks]] to "${p.frontmatter.title}"`,
        autoFixable: false,
      });
    }
  }
  return issues;
}

/** 2. Broken links: [[wikilinks]] pointing to non-existent pages */
function checkBrokenLinks(
  pages: WikiPage[],
  allSlugs: Set<string>,
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    const bodyLinks = extractWikilinks(p.body);
    const fmLinks = p.frontmatter.links;
    const allLinks = new Set([...bodyLinks, ...fmLinks]);
    for (const link of allLinks) {
      if (!allSlugs.has(link)) {
        issues.push({
          severity: "error",
          category: "broken-link",
          page: `${p.category}/${p.slug}`,
          message: `Broken link [[${link}]] — target page does not exist`,
          autoFixable: true,
        });
      }
    }
  }
  return issues;
}

/** 3. Stale pages: not updated in > staleDays */
function checkStale(
  pages: WikiPage[],
  staleDays: number,
  now: Date,
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    if (p.category === "archives") continue; // archives are expected to be stale
    const updated = new Date(p.frontmatter.updated);
    if (daysBetween(updated, now) > staleDays) {
      issues.push({
        severity: "warning",
        category: "stale",
        page: `${p.category}/${p.slug}`,
        message: `Stale page — not updated in >${staleDays} days (last: ${p.frontmatter.updated})`,
        autoFixable: false,
      });
    }
  }
  return issues;
}

/** 4. Scope drift: projects/ pages where scope doesn't include the slug */
function checkScopeDrift(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    if (p.category !== "projects") continue;
    if (!p.frontmatter.scope.includes(p.slug)) {
      issues.push({
        severity: "warning",
        category: "scope-drift",
        page: `${p.category}/${p.slug}`,
        message: `Scope drift — projects/ page scope [${p.frontmatter.scope.join(", ")}] does not include its own slug "${p.slug}"`,
        autoFixable: true,
      });
    }
  }
  return issues;
}

/** 5. Archive candidates: project pages with no recent log entries */
function checkArchiveCandidates(
  pages: WikiPage[],
  logContent: string,
  staleDays: number,
  now: Date,
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    if (p.category !== "projects") continue;

    // Check if the page or its slug appears in any recent log entry
    const logEntryRe = /## \[(\d{4}-\d{2}-\d{2})\] \w+ \|[^\n]*/g;
    let hasRecentEntry = false;
    let m: RegExpExecArray | null;
    while ((m = logEntryRe.exec(logContent)) !== null) {
      const entryDate = new Date(m[0].match(/\d{4}-\d{2}-\d{2}/)![0]);
      const entryText = m[0];
      if (
        daysBetween(entryDate, now) <= staleDays &&
        (entryText.includes(p.slug) || entryText.includes(p.frontmatter.title))
      ) {
        hasRecentEntry = true;
        break;
      }
    }

    // Also check lines below each entry header for page references
    if (!hasRecentEntry) {
      const updated = new Date(p.frontmatter.updated);
      if (daysBetween(updated, now) > staleDays) {
        issues.push({
          severity: "info",
          category: "archive-candidate",
          page: `${p.category}/${p.slug}`,
          message: `Archive candidate — project has no recent log entries and hasn't been updated in >${staleDays} days`,
          autoFixable: false,
        });
      }
    }
  }
  return issues;
}

/** 6. Missing pages: slugs referenced in 2+ pages but lacking own page */
function checkMissing(
  pages: WikiPage[],
  allSlugs: Set<string>,
): LintIssue[] {
  // Count how many distinct pages reference each non-existent slug
  const refCounts = new Map<string, Set<string>>();
  for (const p of pages) {
    const bodyLinks = extractWikilinks(p.body);
    const fmLinks = p.frontmatter.links;
    const allLinks = new Set([...bodyLinks, ...fmLinks]);
    for (const link of allLinks) {
      if (!allSlugs.has(link)) {
        if (!refCounts.has(link)) refCounts.set(link, new Set());
        refCounts.get(link)!.add(p.slug);
      }
    }
  }

  const issues: LintIssue[] = [];
  for (const [slug, refs] of refCounts) {
    if (refs.size >= 2) {
      issues.push({
        severity: "info",
        category: "missing-page",
        message: `Missing page "[[${slug}]]" — referenced by ${refs.size} pages: ${[...refs].join(", ")}`,
        autoFixable: false,
      });
    }
  }
  return issues;
}

/** 7. Empty categories: PARA categories with zero pages */
function checkEmptyCategories(
  pages: WikiPage[],
): LintIssue[] {
  const counts: Record<string, number> = {
    projects: 0,
    areas: 0,
    resources: 0,
    archives: 0,
  };
  for (const p of pages) {
    counts[p.category]++;
  }

  const issues: LintIssue[] = [];
  for (const cat of PARA_CATEGORIES) {
    if (cat === "archives") continue; // archives being empty is fine
    if (counts[cat] === 0) {
      issues.push({
        severity: "info",
        category: "empty-category",
        message: `Empty category "${cat}" — no pages`,
        autoFixable: false,
      });
    }
  }
  return issues;
}

/** 8. Frontmatter issues: missing required fields, empty scope */
function checkFrontmatter(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    const fm = p.frontmatter;
    if (!fm.title || fm.title === "Untitled") {
      issues.push({
        severity: "error",
        category: "frontmatter",
        page: `${p.category}/${p.slug}`,
        message: `Missing or default title`,
        autoFixable: true,
      });
    }
    if (fm.scope.length === 0) {
      issues.push({
        severity: "warning",
        category: "frontmatter",
        page: `${p.category}/${p.slug}`,
        message: `Empty scope — page has no scope tags`,
        autoFixable: true,
      });
    }
    if (!fm.created) {
      issues.push({
        severity: "error",
        category: "frontmatter",
        page: `${p.category}/${p.slug}`,
        message: `Missing created date`,
        autoFixable: true,
      });
    }
    if (!fm.updated) {
      issues.push({
        severity: "error",
        category: "frontmatter",
        page: `${p.category}/${p.slug}`,
        message: `Missing updated date`,
        autoFixable: true,
      });
    }
  }
  return issues;
}

/** 9. Index drift: pages on disk but not referenced in index.md */
function checkIndexDrift(
  pages: WikiPage[],
  indexContent: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    // Check if slug appears as [[slug]] in the index
    if (!indexContent.includes(`[[${p.slug}]]`)) {
      issues.push({
        severity: "warning",
        category: "index-drift",
        page: `${p.category}/${p.slug}`,
        message: `Page not listed in index.md`,
        autoFixable: true,
      });
    }
  }
  return issues;
}

/** 10. Duplicate slugs: same slug in different categories */
function checkDuplicateSlugs(pages: WikiPage[]): LintIssue[] {
  const slugMap = new Map<string, string[]>();
  for (const p of pages) {
    const existing = slugMap.get(p.slug) ?? [];
    existing.push(p.category);
    slugMap.set(p.slug, existing);
  }

  const issues: LintIssue[] = [];
  for (const [slug, categories] of slugMap) {
    if (categories.length > 1) {
      issues.push({
        severity: "warning",
        category: "duplicate-slug",
        message: `Duplicate slug "${slug}" exists in: ${categories.join(", ")}`,
        autoFixable: false,
      });
    }
  }
  return issues;
}

/** 11. Link sync: slug mentions in body not wrapped in [[wikilinks]] */
function checkLinkSync(
  pages: WikiPage[],
  allSlugs: Set<string>,
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    // Use the exact same protected-range semantics as the fixer so every
    // auto-fixable issue is actionable (no code-block/heading false positives).
    const unlinked = findUnlinkedSlugs(p.body, allSlugs, p.slug);

    if (unlinked.length > 0) {
      issues.push({
        severity: "warning",
        category: "link-sync",
        page: `${p.category}/${p.slug}`,
        message: `${unlinked.length} unlinked slug mention(s): ${unlinked.join(", ")}`,
        autoFixable: true,
      });
    }

    // Check frontmatter.links out of sync with body
    const expectedLinks = syncFrontmatterLinks(p.body);
    const fmSet = new Set(p.frontmatter.links);
    const expectedSet = new Set(expectedLinks);
    const missingInFm = expectedLinks.filter(l => !fmSet.has(l));
    const extraInFm = p.frontmatter.links.filter(l => !expectedSet.has(l));
    if (missingInFm.length > 0 || extraInFm.length > 0) {
      issues.push({
        severity: "warning",
        category: "link-sync",
        page: `${p.category}/${p.slug}`,
        message: `frontmatter.links out of sync with body [[wikilinks]]`,
        autoFixable: true,
      });
    }
  }
  return issues;
}

/** 12. Tag health: spaces, scope duplicates, non-canonical tags */
function checkTagHealth(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    const tags = p.frontmatter.tags;
    const scope = p.frontmatter.scope;
    const scopeSet = new Set(scope.map(s => s.toLowerCase()));

    // Check for tags with spaces
    const spaceTags = tags.filter(t => t.includes(" "));
    if (spaceTags.length > 0) {
      issues.push({
        severity: "warning",
        category: "tag-health",
        page: `${p.category}/${p.slug}`,
        message: `Tags with spaces: ${spaceTags.map(t => `"${t}"`).join(", ")}`,
        autoFixable: true,
      });
    }

    // Check for tags duplicating scope
    const scopeDupes = tags.filter(t => scopeSet.has(t.toLowerCase()));
    if (scopeDupes.length > 0) {
      issues.push({
        severity: "info",
        category: "tag-health",
        page: `${p.category}/${p.slug}`,
        message: `Tags duplicating scope: ${scopeDupes.join(", ")}`,
        autoFixable: true,
      });
    }

    // Check if normalization would change the tag list
    const normalized = normalizeTags(tags, scope);
    const currentSorted = [...tags].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(currentSorted)) {
      // Only report if not already covered by the above checks
      const aliasChanges = tags.filter(t => {
        const n = t.trim().toLowerCase().replace(/\s+/g, "-");
        return normalized.includes(n) === false && !scopeSet.has(n) && !t.includes(" ");
      });
      if (aliasChanges.length > 0) {
        issues.push({
          severity: "info",
          category: "tag-health",
          page: `${p.category}/${p.slug}`,
          message: `Tags to canonicalize: ${aliasChanges.join(", ")}`,
          autoFixable: true,
        });
      }
    }
  }
  return issues;
}

/** 13. Secrets: detect API keys, tokens, passwords in page content */
function checkSecrets(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    if (containsSecrets(p.body)) {
      issues.push({
        severity: "error",
        category: "secrets",
        page: `${p.category}/${p.slug}`,
        message: `Page contains potential secrets (API keys, tokens, passwords)`,
        autoFixable: true,
      });
    }
  }
  return issues;
}

/** 15. Schema version: pages below CURRENT_SCHEMA_VERSION need migration */
function checkSchemaVersion(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    const version = p.frontmatter.schemaVersion ?? 1;
    if (version < CURRENT_SCHEMA_VERSION) {
      issues.push({
        severity: "warning",
        category: "schema-version",
        page: `${p.category}/${p.slug}`,
        message: `Schema version ${version} is below current (${CURRENT_SCHEMA_VERSION}) — needs migration`,
        autoFixable: true,
      });
    }
  }
  return issues;
}

/** 14. PARA category misuse: reference docs in projects/ instead of resources/ */
function checkCategoryMisuse(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // projects/ should have goal-defined work with end dates, not reference docs.
  // Heuristic: if a projects/ page's slug contains a scope project name as prefix
  // (e.g. "pi-para-daemon" in scope "pi-para"), it's likely a sub-topic reference
  // doc, not a standalone project.
  for (const p of pages) {
    if (p.category !== "projects") continue;

    // Check if the slug is a sub-topic of a scope value
    // e.g. slug "pi-para-daemon" with scope ["pi-para"] → sub-topic
    const isSubtopic = p.frontmatter.scope.some(
      (s) => s !== p.slug && s !== "global" && p.slug.startsWith(s + "-"),
    );

    if (isSubtopic) {
      issues.push({
        severity: "warning",
        category: "category-misuse",
        page: `${p.category}/${p.slug}`,
        message: `Likely a reference doc, not a project — slug "${p.slug}" is a sub-topic of scope [${p.frontmatter.scope.join(", ")}]. Consider moving to resources/.`,
        autoFixable: false,
      });
    }
  }

  return issues;
}

// -- Auto-fix ---------------------------------------------------------------

/** Fix secrets: redact API keys, tokens, passwords from page content */
async function fixSecrets(
  wikiDir: string,
  pages: WikiPage[],
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    if (!containsSecrets(p.body)) continue;

    const { text: redacted, redactions } = redactSecrets(p.body);
    if (redactions > 0) {
      const fixedPage: WikiPage = {
        ...p,
        body: redacted,
        frontmatter: {
          ...p.frontmatter,
          updated: new Date().toISOString(),
        },
      };
      p.body = fixedPage.body;
      p.frontmatter = fixedPage.frontmatter;
      await writePage(wikiDir, p);

      fixed.push({
        severity: "error",
        category: "secrets",
        page: `${p.category}/${p.slug}`,
        message: `Fixed: redacted ${redactions} secret(s)`,
        autoFixable: true,
      });
    }
  }
  return fixed;
}

/** Fix link sync: auto-link slug mentions and sync frontmatter.links */
async function fixLinkSync(
  wikiDir: string,
  pages: WikiPage[],
  allSlugs: Set<string>,
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    const originalBody = p.body;
    const originalLinks = [...p.frontmatter.links];

    // Auto-link slug mentions
    const newBody = autoLinkSlugs(p.body, allSlugs, p.slug);

    // Sync frontmatter.links
    const newLinks = syncFrontmatterLinks(newBody);

    // Check if anything changed
    const bodyChanged = newBody !== originalBody;
    const linksChanged = JSON.stringify(newLinks.sort()) !== JSON.stringify(originalLinks.sort());

    if (bodyChanged || linksChanged) {
      const addedLinks = newLinks.filter(l => !originalLinks.includes(l));

      const fixedPage: WikiPage = {
        ...p,
        body: newBody,
        frontmatter: {
          ...p.frontmatter,
          links: newLinks,
          updated: new Date().toISOString(),
        },
      };
      p.body = fixedPage.body;
      p.frontmatter = fixedPage.frontmatter;
      await writePage(wikiDir, p);

      if (addedLinks.length > 0) {
        fixed.push({
          severity: "warning",
          category: "link-sync",
          page: `${p.category}/${p.slug}`,
          message: `Fixed: auto-linked ${addedLinks.length} slug(s): ${addedLinks.join(", ")}`,
          autoFixable: true,
        });
      }
      if (linksChanged && addedLinks.length === 0) {
        fixed.push({
          severity: "warning",
          category: "link-sync",
          page: `${p.category}/${p.slug}`,
          message: `Fixed: synced frontmatter.links with body [[wikilinks]]`,
          autoFixable: true,
        });
      }
    }
  }
  return fixed;
}

/** Fix tag health: normalize all tags via registry */
async function fixTagHealth(
  wikiDir: string,
  pages: WikiPage[],
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    const original = [...p.frontmatter.tags];
    const normalized = normalizeTags(p.frontmatter.tags, p.frontmatter.scope);

    if (JSON.stringify(original.sort()) !== JSON.stringify(normalized)) {
      const removed = original.filter(t => !normalized.includes(t.trim().toLowerCase().replace(/\s+/g, "-")));

      p.frontmatter.tags = normalized;
      p.frontmatter.updated = new Date().toISOString();
      await writePage(wikiDir, p);

      fixed.push({
        severity: "warning",
        category: "tag-health",
        page: `${p.category}/${p.slug}`,
        message: `Fixed: normalized tags [${original.join(", ")}] → [${normalized.join(", ")}]`,
        autoFixable: true,
      });
    }
  }
  return fixed;
}

/** Fix broken links: remove [[broken]] from body and frontmatter.links */
async function fixBrokenLinks(
  wikiDir: string,
  pages: WikiPage[],
  allSlugs: Set<string>,
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    const bodyLinks = extractWikilinks(p.body);
    const fmLinks = p.frontmatter.links;
    const allLinks = new Set([...bodyLinks, ...fmLinks]);
    const broken = [...allLinks].filter((l) => !allSlugs.has(l));
    if (broken.length === 0) continue;

    let newBody = p.body;
    for (const link of broken) {
      newBody = removeWikilink(newBody, link);
    }
    const newFmLinks = fmLinks.filter((l) => allSlugs.has(l));

    const fixedPage: WikiPage = {
      ...p,
      body: newBody,
      frontmatter: { ...p.frontmatter, links: newFmLinks },
    };
    p.body = fixedPage.body;
    p.frontmatter = fixedPage.frontmatter;
    await writePage(wikiDir, p);

    for (const link of broken) {
      fixed.push({
        severity: "error",
        category: "broken-link",
        page: `${p.category}/${p.slug}`,
        message: `Fixed: removed broken link [[${link}]]`,
        autoFixable: true,
      });
    }
  }
  return fixed;
}

/** Fix index drift: rebuild index.md to include all pages */
async function fixIndexDrift(
  wikiDir: string,
  pages: WikiPage[],
  indexContent: string,
): Promise<LintIssue[]> {
  const missing: WikiPage[] = [];
  for (const p of pages) {
    if (!indexContent.includes(`[[${p.slug}]]`)) {
      missing.push(p);
    }
  }
  if (missing.length === 0) return [];

  // Group missing pages by category
  const byCategory = new Map<ParaCategory, WikiPage[]>();
  for (const p of missing) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  // Append missing entries to each category section in the index
  let newIndex = indexContent;
  for (const cat of PARA_CATEGORIES) {
    const catPages = byCategory.get(cat);
    if (!catPages || catPages.length === 0) continue;

    // Find the category section header
    const headerRe = new RegExp(
      `(## ${cat.charAt(0).toUpperCase() + cat.slice(1)}[^\n]*\n)`,
      "i",
    );
    const headerMatch = newIndex.match(headerRe);
    if (headerMatch && headerMatch.index !== undefined) {
      const insertPos = headerMatch.index + headerMatch[0].length;
      const lines = catPages
        .map((p) => `- [[${p.slug}]] — ${p.frontmatter.title}\n`)
        .join("");
      newIndex =
        newIndex.slice(0, insertPos) + lines + newIndex.slice(insertPos);
    }
  }

  // Remove placeholder lines like "_No active projects yet._"
  newIndex = newIndex.replace(/\n_No [^_]*yet\._\n?/g, "\n");

  await writeIndex(wikiDir, newIndex);

  return missing.map((p) => ({
    severity: "warning",
    category: "index-drift",
    page: `${p.category}/${p.slug}`,
    message: `Fixed: added [[${p.slug}]] to index.md`,
    autoFixable: true,
  }));
}

/** Fix frontmatter issues: set missing fields to defaults */
async function fixFrontmatter(
  wikiDir: string,
  pages: WikiPage[],
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    const fm = p.frontmatter;
    let changed = false;

    if (!fm.title || fm.title === "Untitled") {
      // Derive title from slug
      fm.title = p.slug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      changed = true;
      fixed.push({
        severity: "error",
        category: "frontmatter",
        page: `${p.category}/${p.slug}`,
        message: `Fixed: set title to "${fm.title}"`,
        autoFixable: true,
      });
    }

    if (fm.scope.length === 0) {
      // Default scope based on category
      if (p.category === "areas") {
        fm.scope = ["global"];
      } else if (p.category === "projects") {
        fm.scope = [p.slug];
      } else {
        fm.scope = ["global"];
      }
      changed = true;
      fixed.push({
        severity: "warning",
        category: "frontmatter",
        page: `${p.category}/${p.slug}`,
        message: `Fixed: set scope to [${fm.scope.join(", ")}]`,
        autoFixable: true,
      });
    }

    if (changed) {
      fm.updated = new Date().toISOString();
      await writePage(wikiDir, { ...p, frontmatter: fm });
    }
  }
  return fixed;
}

/** Fix schema version: run migrations on pages below current version */
async function fixSchemaVersion(
  wikiDir: string,
  pages: WikiPage[],
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    const version = p.frontmatter.schemaVersion ?? 1;
    if (version >= CURRENT_SCHEMA_VERSION) continue;

    // Read the raw file to get the original frontmatter as a plain object
    const filePath = join(wikiDir, p.category, `${p.slug}.md`);
    const content = await readFile(filePath, "utf-8");
    const { frontmatter: rawFm, body: rawBody } = parseFrontmatter(content);
    const rawObj = rawFm as unknown as Record<string, unknown>;

    const result = migrateToLatest(rawObj, rawBody);

    // Write back with migrated content
    const migratedFm = result.fm as unknown as import("./wiki.js").PageFrontmatter;
    migratedFm.updated = new Date().toISOString();
    await writePage(wikiDir, {
      category: p.category,
      slug: p.slug,
      frontmatter: migratedFm,
      body: result.body,
    });

    fixed.push({
      severity: "warning",
      category: "schema-version",
      page: `${p.category}/${p.slug}`,
      message: `Fixed: migrated schema version ${version} → ${migratedFm.schemaVersion}`,
      autoFixable: true,
    });
  }
  return fixed;
}

/** Fix scope drift: add slug to projects/ page scope */
async function fixScopeDrift(
  wikiDir: string,
  pages: WikiPage[],
): Promise<LintIssue[]> {
  const fixed: LintIssue[] = [];
  for (const p of pages) {
    if (p.category !== "projects") continue;
    if (p.frontmatter.scope.includes(p.slug)) continue;

    p.frontmatter.scope.push(p.slug);
    p.frontmatter.updated = new Date().toISOString();
    await writePage(wikiDir, p);

    fixed.push({
      severity: "warning",
      category: "scope-drift",
      page: `${p.category}/${p.slug}`,
      message: `Fixed: added "${p.slug}" to scope`,
      autoFixable: true,
    });
  }
  return fixed;
}

// -- Main -------------------------------------------------------------------

export async function lintWiki(
  wikiDir: string,
  options?: LintOptions,
): Promise<LintReport> {
  const staleDays = options?.staleDays ?? 90;
  const autoFix = options?.autoFix ?? true;
  const now = new Date();

  // Load all pages
  const refs = await listPages(wikiDir);
  const loadedPages = await Promise.all(
    refs.map((ref) => readPage(wikiDir, ref.category, ref.slug)),
  );
  const pages = loadedPages.filter((page): page is WikiPage => page !== null);

  // Build slug set
  const allSlugs = new Set(pages.map((p) => p.slug));

  // Load index and log
  const indexContent = await readIndex(wikiDir);
  let logContent = "";
  try {
    logContent = await readFile(join(wikiDir, "log.md"), "utf-8");
  } catch {
    // log.md may not exist
  }

  // Count total outgoing links
  let totalLinks = 0;
  for (const p of pages) {
    totalLinks += extractWikilinks(p.body).length;
    totalLinks += p.frontmatter.links.length;
  }

  // Run all checks
  const issues: LintIssue[] = [
    ...checkOrphans(pages, allSlugs),
    ...checkBrokenLinks(pages, allSlugs),
    ...checkStale(pages, staleDays, now),
    ...checkScopeDrift(pages),
    ...checkArchiveCandidates(pages, logContent, staleDays, now),
    ...checkMissing(pages, allSlugs),
    ...checkEmptyCategories(pages),
    ...checkFrontmatter(pages),
    ...checkIndexDrift(pages, indexContent),
    ...checkDuplicateSlugs(pages),
    ...checkLinkSync(pages, allSlugs),
    ...checkTagHealth(pages),
    ...checkCategoryMisuse(pages),
    ...checkSecrets(pages),
    ...checkSchemaVersion(pages),
  ];

  // Auto-fix if enabled
  const fixed: LintIssue[] = [];
  if (autoFix) {
    // Only run a fixer against pages its check identified. Previously every
    // fixer rescanned all P pages (and link sync scanned all S slugs per page)
    // even when that category had zero issues.
    const affectedPages = (category: LintIssue["category"]): WikiPage[] => {
      const paths = new Set(
        issues
          .filter((issue) => issue.category === category && issue.autoFixable && issue.page)
          .map((issue) => issue.page!),
      );
      return paths.size === 0
        ? []
        : pages.filter((page) => paths.has(`${page.category}/${page.slug}`));
    };
    const hasIssue = (category: LintIssue["category"]): boolean =>
      issues.some((issue) => issue.category === category && issue.autoFixable);

    // Fix secrets first — highest priority.
    const secretPages = affectedPages("secrets");
    if (secretPages.length > 0) fixed.push(...(await fixSecrets(wikiDir, secretPages)));
    const brokenPages = affectedPages("broken-link");
    if (brokenPages.length > 0) fixed.push(...(await fixBrokenLinks(wikiDir, brokenPages, allSlugs)));
    const linkPages = affectedPages("link-sync");
    if (linkPages.length > 0) fixed.push(...(await fixLinkSync(wikiDir, linkPages, allSlugs)));
    const tagPages = affectedPages("tag-health");
    if (tagPages.length > 0) fixed.push(...(await fixTagHealth(wikiDir, tagPages)));
    if (hasIssue("index-drift")) fixed.push(...(await fixIndexDrift(wikiDir, pages, indexContent)));
    const frontmatterPages = affectedPages("frontmatter");
    if (frontmatterPages.length > 0) fixed.push(...(await fixFrontmatter(wikiDir, frontmatterPages)));
    const scopePages = affectedPages("scope-drift");
    if (scopePages.length > 0) fixed.push(...(await fixScopeDrift(wikiDir, scopePages)));
    const schemaPages = affectedPages("schema-version");
    if (schemaPages.length > 0) fixed.push(...(await fixSchemaVersion(wikiDir, schemaPages)));
  }

  // Recount broken links for stats
  const brokenLinkCount = issues.filter(
    (i) => i.category === "broken-link",
  ).length;
  const orphanCount = issues.filter((i) => i.category === "orphan").length;

  const stats = makeStats(pages, totalLinks, brokenLinkCount, orphanCount, logContent);

  // Remove auto-fixed issues from the reported issues list
  const fixedKeys = new Set(
    fixed.map((f) => `${f.category}:${f.page ?? ""}:${f.message}`),
  );

  // Filter: keep issues that weren't fixed, or that aren't fixable
  const remainingIssues = autoFix
    ? issues.filter((i) => {
        if (!i.autoFixable) return true;
        // For fixable issues, check if a corresponding fix was applied
        // Match by category + page
        return !fixed.some(
          (f) => f.category === i.category && f.page === i.page,
        );
      })
    : issues;

  return { issues: remainingIssues, fixed, stats };
}
