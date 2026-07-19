import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { CURRENT_SCHEMA_VERSION, migrateToLatest } from "../frontmatter.js";
import { listPages, readPage, writePage, type PageFrontmatter } from "../wiki.js";

// -- Factory: wiki_migrate execute -------------------------------------------

export function createMigrateExecute(
  wikiDir: string,
) {
  return async (): Promise<AgentToolResult<{ migratedCount: number; totalPages: number }>> => {
    const allRefs = await listPages(wikiDir);
    let migratedCount = 0;

    for (const ref of allRefs) {
      const page = await readPage(wikiDir, ref.category, ref.slug);
      if (!page) continue;

      const version = page.frontmatter.schemaVersion ?? 1;
      if (version >= CURRENT_SCHEMA_VERSION) continue;

      const rawObj = page.frontmatter as unknown as Record<string, unknown>;
      const result = migrateToLatest(rawObj, page.body);

      const migratedFm = result.fm as unknown as PageFrontmatter;
      migratedFm.updated = new Date().toISOString();
      await writePage(wikiDir, {
        category: ref.category,
        slug: ref.slug,
        frontmatter: migratedFm,
        body: result.body,
      });
      migratedCount++;
    }

    const summary = migratedCount > 0
      ? `Migrated ${migratedCount} page(s) to schema version ${CURRENT_SCHEMA_VERSION}.`
      : `All ${allRefs.length} page(s) already at schema version ${CURRENT_SCHEMA_VERSION}.`;

    return {
      content: [{ type: "text", text: summary }],
      details: { migratedCount, totalPages: allRefs.length },
    };
  };
}
