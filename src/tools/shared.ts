import type { QMDStore } from "qmd-engine";
import { enqueueWikiMaintenance } from "../scheduler/index.js";
import { PARA_CATEGORIES, type ParaCategory } from "../wiki.js";

// -- Source resolution helpers -----------------------------------------------

/** Resolve a page path like "projects/auth-refactor" into category + slug. */
export function parsePagePath(
  path: string,
): { category: ParaCategory; slug: string } | null {
  const parts = path.split("/");
  if (parts.length === 2) {
    const cat = parts[0] as ParaCategory;
    if (PARA_CATEGORIES.includes(cat)) {
      const slug = parts[1].replace(/\.md$/, "");
      return { category: cat, slug };
    }
  }
  return null;
}

// -- Background maintenance --------------------------------------------------

/**
 * Schedule index rebuild + QMD reindex after latency-sensitive edits.
 * Debounced per wiki directory and coordinated through the scheduler queue so
 * multiple Pi processes do not run the same maintenance task concurrently.
 */
export function scheduleWikiMaintenance(
  wikiDir: string,
  store: QMDStore,
  markDirty: () => void,
): void {
  enqueueWikiMaintenance(wikiDir, store, markDirty);
}
