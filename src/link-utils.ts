/**
 * Shared wikilink utilities — extraction, auto-linking, and sync.
 *
 * Centralizes the [[wikilink]] logic that was duplicated across
 * tools.ts, lint.ts, processor.ts, and webui/server.ts.
 */

// -- Wikilink extraction ----------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** Extract all [[wikilink]] targets from markdown body. Returns deduplicated slugs. */
export function extractWikilinks(body: string): string[] {
  const links: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((m = re.exec(body)) !== null) {
    links.push(m[1].trim());
  }
  return [...new Set(links)];
}

/** Remove [[target]] (and optional display text) from body text. */
export function removeWikilink(body: string, target: string): string {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, "g");
  return body.replace(re, "");
}

// -- Auto-linking -----------------------------------------------------------

/**
 * Identify regions in markdown body that should NOT be auto-linked.
 * Returns array of [start, end] ranges to skip.
 *
 * Protected regions:
 * - Fenced code blocks (``` ... ```)
 * - Inline code (`...`)
 * - Existing [[wikilinks]]
 * - URLs (http:// https://)
 * - YAML frontmatter lines referencing slugs
 */
function findProtectedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Fenced code blocks
  const fencedRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fencedRe.exec(body)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Inline code. Keep spans on one line and skip fenced regions already
  // recorded above. The old /`[^`]+`/ pattern could start at a closing fence
  // backtick and protect hundreds of characters of ordinary Markdown.
  const inlineCodeRe = /`+[^`\n]+`+/g;
  while ((m = inlineCodeRe.exec(body)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (!isProtected(start, end, ranges)) ranges.push([start, end]);
  }

  // Existing [[wikilinks]]
  const wlRe = /\[\[[^\]]+\]\]/g;
  while ((m = wlRe.exec(body)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // URLs
  const urlRe = /https?:\/\/[^\s)>]+/g;
  while ((m = urlRe.exec(body)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Markdown headings (don't wrap slugs in heading lines)
  const headingRe = /^#{1,6}\s+.*$/gm;
  while ((m = headingRe.exec(body)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Check if a position falls inside any protected range.
 */
function isProtected(pos: number, end: number, ranges: Array<[number, number]>): boolean {
  for (const [rStart, rEnd] of ranges) {
    if (rStart > end) break; // ranges are sorted
    if (pos >= rStart && end <= rEnd) return true;
    if (pos < rEnd && end > rStart) return true; // overlap
  }
  return false;
}

/** Find plain-text slug mentions that autoLinkSlugs can actually fix. */
export function findUnlinkedSlugs(
  body: string,
  allSlugs: Set<string>,
  ownSlug?: string,
): string[] {
  if (allSlugs.size === 0) return [];
  const bodyLinks = new Set(extractWikilinks(body));
  const protectedRanges = findProtectedRanges(body);
  const unlinked: string[] = [];

  const sortedSlugs = [...allSlugs]
    .filter((slug) => slug !== ownSlug && !bodyLinks.has(slug))
    .sort((a, b) => b.length - a.length);

  for (const slug of sortedSlugs) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!isProtected(start, end, protectedRanges)) {
        unlinked.push(slug);
        break;
      }
    }
  }
  return unlinked;
}

/**
 * Auto-link page slug mentions while skipping code, URLs, headings, and
 * existing wikilinks. Only the first fixable occurrence of each slug is linked.
 */
export function autoLinkSlugs(
  body: string,
  allSlugs: Set<string>,
  ownSlug?: string,
): string {
  if (allSlugs.size === 0) return body;

  // Sort slugs longest-first so "pi-para-daemon" is matched before "pi-para"
  const sortedSlugs = [...allSlugs]
    .filter(s => s !== ownSlug)
    .sort((a, b) => b.length - a.length);

  const linkedSlugs = new Set(extractWikilinks(body));

  let result = body;

  for (const slug of sortedSlugs) {
    // Skip if already linked
    if (linkedSlugs.has(slug)) continue;

    // Build regex: match slug at word boundaries
    // Slug chars are [a-z0-9-], so word boundary = not preceded/followed by these chars
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Use negative lookbehind/lookahead for slug characters
    const re = new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, "g");

    // Re-compute protected ranges for current state of result
    const currentProtected = findProtectedRanges(result);

    let match: RegExpExecArray | null;
    let linked = false;

    // Reset regex
    re.lastIndex = 0;
    while ((match = re.exec(result)) !== null) {
      if (linked) break; // only link first occurrence

      const pos = match.index;
      const end = pos + match[0].length;

      if (isProtected(pos, end, currentProtected)) continue;

      // Replace this occurrence with [[slug]]
      const before = result.slice(0, pos);
      const after = result.slice(end);
      const replacement = `[[${slug}]]`;
      result = before + replacement + after;
      linked = true;

      // Update regex index to account for replacement length difference
      re.lastIndex = pos + replacement.length;
    }
  }

  return result;
}

/**
 * Sync frontmatter.links to match all [[wikilinks]] found in body text.
 */
export function syncFrontmatterLinks(body: string): string[] {
  return extractWikilinks(body);
}
