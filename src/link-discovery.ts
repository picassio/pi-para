/**
 * Link discovery — finds related wiki pages and adds [[wikilinks]].
 *
 * Uses BM25 search to find pages that are semantically related but
 * not yet linked. Runs as a periodic daemon job or on-demand.
 *
 * Strategy:
 * 1. For each page, search the wiki using its title + key terms
 * 2. Filter results to pages not already linked
 * 3. If a related page scores above threshold, add it to ## Connections
 * 4. Sync frontmatter.links
 */

import {
  listPages,
  readPage,
  writePage,
} from "./wiki.js";
import type { WikiPage } from "./wiki.js";
import { searchWiki } from "./store.js";
import type { QMDStore } from "./store.js";
import { extractWikilinks, syncFrontmatterLinks } from "./link-utils.js";

// -- Types -------------------------------------------------------------------

export interface LinkDiscoveryResult {
  pagesUpdated: number;
  linksAdded: number;
  discoveries: Array<{
    page: string;
    newLinks: string[];
  }>;
}

export interface LinkDiscoveryOptions {
  /** Minimum BM25 score to consider a page related (0-1). Default 0.3 */
  minScore?: number;
  /** Max new links to add per page per run. Default 5 */
  maxLinksPerPage?: number;
  /** Dry run — report but don't write. Default false */
  dryRun?: boolean;
}

// -- Discovery ---------------------------------------------------------------

/**
 * Discover and add missing [[wikilinks]] between related pages.
 *
 * For each page:
 * 1. Search wiki using the page's title as query
 * 2. Find high-scoring pages not already linked
 * 3. Add them to ## Connections section
 * 4. Sync frontmatter.links
 */
export async function discoverLinks(
  wikiDir: string,
  store: QMDStore,
  options?: LinkDiscoveryOptions,
): Promise<LinkDiscoveryResult> {
  const minScore = options?.minScore ?? 0.3;
  const maxLinksPerPage = options?.maxLinksPerPage ?? 5;
  const dryRun = options?.dryRun ?? false;

  const refs = await listPages(wikiDir);
  const pages: WikiPage[] = [];
  for (const ref of refs) {
    const page = await readPage(wikiDir, ref.category, ref.slug);
    if (page) pages.push(page);
  }

  const allSlugs = new Set(pages.map(p => p.slug));
  const result: LinkDiscoveryResult = {
    pagesUpdated: 0,
    linksAdded: 0,
    discoveries: [],
  };

  for (const page of pages) {
    // Get existing outgoing links
    const existingLinks = new Set(extractWikilinks(page.body));
    // Also include frontmatter links
    for (const l of page.frontmatter.links) existingLinks.add(l);

    // Search for related pages using title
    const query = page.frontmatter.title;
    let related;
    try {
      related = await searchWiki(store, query, { limit: 10 });
    } catch {
      continue; // search failure — skip this page
    }

    // Filter: not self, not already linked, above score threshold
    const candidates = related
      .filter(r =>
        r.page.slug !== page.slug &&
        !existingLinks.has(r.page.slug) &&
        r.score >= minScore
      )
      .slice(0, maxLinksPerPage);

    if (candidates.length === 0) continue;

    const newLinks = candidates.map(c => c.page.slug);

    // Build ## Connections addition
    const connectionsLines = newLinks.map(slug => {
      const targetPage = pages.find(p => p.slug === slug);
      const title = targetPage?.frontmatter.title ?? slug;
      return `- [[${slug}]] — ${title}`;
    });

    // Update page body
    let newBody = page.body;
    const hasConnections = /^## Connections/m.test(newBody);

    if (hasConnections) {
      // Append to existing Connections section
      // Find the end of the Connections section (next ## heading or EOF)
      const connectionsIdx = newBody.indexOf("## Connections");
      const afterConnections = newBody.indexOf("\n## ", connectionsIdx + 1);
      const insertPos = afterConnections === -1 ? newBody.length : afterConnections;

      // Insert before the next section
      const insertion = "\n" + connectionsLines.join("\n");
      newBody = newBody.slice(0, insertPos) + insertion + newBody.slice(insertPos);
    } else {
      // Add new Connections section at the end (before ## Sources or ## Open Questions if they exist)
      const sourcesIdx = newBody.indexOf("\n## Sources");
      const questionsIdx = newBody.indexOf("\n## Open Questions");
      const insertBefore = Math.min(
        sourcesIdx === -1 ? Infinity : sourcesIdx,
        questionsIdx === -1 ? Infinity : questionsIdx,
      );

      const section = "\n\n## Connections\n" + connectionsLines.join("\n");

      if (insertBefore === Infinity) {
        newBody = newBody.trimEnd() + section + "\n";
      } else {
        newBody = newBody.slice(0, insertBefore) + section + newBody.slice(insertBefore);
      }
    }

    // Sync frontmatter.links
    const updatedLinks = syncFrontmatterLinks(newBody);

    if (!dryRun) {
      const updatedPage: WikiPage = {
        ...page,
        body: newBody,
        frontmatter: {
          ...page.frontmatter,
          links: updatedLinks,
          updated: new Date().toISOString(),
        },
      };
      await writePage(wikiDir, updatedPage);
    }

    result.pagesUpdated++;
    result.linksAdded += newLinks.length;
    result.discoveries.push({
      page: `${page.category}/${page.slug}`,
      newLinks,
    });
  }

  return result;
}
