#!/usr/bin/env tsx
/**
 * One-time bulk fix: auto-link slugs, normalize tags, sync frontmatter.links
 * across all wiki pages.
 *
 * Usage: npx tsx src/scripts/bulk-link-fix.ts [--dry-run]
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  listPages,
  readPage,
  writePage,
} from "../wiki.js";
import type { WikiPage } from "../wiki.js";
import { autoLinkSlugs, syncFrontmatterLinks } from "../link-utils.js";
import { normalizeTags, normalizeScopes } from "../tag-registry.js";

const WIKI_DIR = join(homedir(), ".pi", "wiki");
const dryRun = process.argv.includes("--dry-run");

async function main() {
  console.log(`\n📚 Bulk Wiki Fix — ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`   Wiki: ${WIKI_DIR}\n`);

  // Load all pages
  const refs = await listPages(WIKI_DIR);
  const pages: WikiPage[] = [];
  for (const ref of refs) {
    const page = await readPage(WIKI_DIR, ref.category, ref.slug);
    if (page) pages.push(page);
  }

  const allSlugs = new Set(pages.map(p => p.slug));
  console.log(`   Found ${pages.length} pages, ${allSlugs.size} unique slugs\n`);

  let linksAdded = 0;
  let tagsNormalized = 0;
  let frontmatterSynced = 0;
  let pagesChanged = 0;

  for (const page of pages) {
    const originalBody = page.body;
    const originalTags = [...page.frontmatter.tags];
    const originalLinks = [...page.frontmatter.links];

    const originalScope = [...page.frontmatter.scope];

    // 1. Normalize scopes first (tags depend on scope)
    const newScope = normalizeScopes(page.frontmatter.scope);

    // 2. Auto-link slug mentions in body
    let newBody = autoLinkSlugs(originalBody, allSlugs, page.slug);

    // 3. Sync frontmatter.links from body [[wikilinks]]
    const newLinks = syncFrontmatterLinks(newBody);

    // 4. Normalize tags (using normalized scope for dedup)
    const newTags = normalizeTags(page.frontmatter.tags, newScope);

    // Check what changed
    const bodyChanged = newBody !== originalBody;
    const linksChanged = JSON.stringify(newLinks.sort()) !== JSON.stringify(originalLinks.sort());
    const tagsChanged = JSON.stringify(newTags) !== JSON.stringify(originalTags.sort());
    const scopeChanged = JSON.stringify(newScope) !== JSON.stringify(originalScope.sort());

    if (!bodyChanged && !linksChanged && !tagsChanged && !scopeChanged) continue;

    pagesChanged++;

    const addedLinksCount = newLinks.filter(l => !originalLinks.includes(l)).length;
    linksAdded += addedLinksCount;
    if (tagsChanged) tagsNormalized++;
    if (linksChanged) frontmatterSynced++;

    // Report
    const changes: string[] = [];
    if (scopeChanged) {
      changes.push(`scope: [${originalScope.join(", ")}] → [${newScope.join(", ")}]`);
    }
    if (bodyChanged) {
      const addedLinks = newLinks.filter(l => !originalLinks.includes(l));
      changes.push(`+${addedLinks.length} wikilinks: ${addedLinks.join(", ")}`);
    }
    if (tagsChanged) {
      changes.push(`tags: [${originalTags.join(", ")}] → [${newTags.join(", ")}]`);
    }
    if (linksChanged && !bodyChanged) {
      changes.push(`frontmatter.links synced`);
    }

    console.log(`  ${dryRun ? "WOULD FIX" : "FIXED"} ${page.category}/${page.slug}`);
    for (const c of changes) {
      console.log(`    → ${c}`);
    }

    if (!dryRun) {
      const updatedPage: WikiPage = {
        ...page,
        body: newBody,
        frontmatter: {
          ...page.frontmatter,
          scope: newScope,
          tags: newTags,
          links: newLinks,
          updated: new Date().toISOString(),
        },
      };
      await writePage(WIKI_DIR, updatedPage);
    }
  }

  console.log(`\n━━━ Summary ━━━`);
  console.log(`  Pages changed:      ${pagesChanged} / ${pages.length}`);
  console.log(`  Wikilinks added:    ${linksAdded}`);
  console.log(`  Tags normalized:    ${tagsNormalized}`);
  console.log(`  Frontmatter synced: ${frontmatterSynced}`);
  if (dryRun) console.log(`\n  (dry run — no files modified, re-run without --dry-run to apply)`);
  console.log();
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
