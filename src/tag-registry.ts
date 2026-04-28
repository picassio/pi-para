/**
 * Canonical tag registry — normalizes and deduplicates wiki page tags.
 *
 * Rules:
 * 1. Spaces → hyphens ("session files" → "session-files")
 * 2. Lowercase everything
 * 3. Map aliases → canonical tags
 * 4. Remove tags that duplicate scope values on the same page
 * 5. Deduplicate
 */

// -- Scope normalization -----------------------------------------------------

/**
 * Normalize a scope value.
 *
 * Scope should be a project name (kebab-case, single token), not a topic
 * description. The daemon LLM sometimes writes freeform multi-word
 * descriptions like "session exploration" or "mono project" as scope.
 *
 * Rules:
 * 1. Trim + lowercase
 * 2. If the value contains a known project name as a prefix, extract it
 *    (e.g. "pi-para daemon" → "pi-para", "pi-mono project" → "pi-mono")
 * 3. If still multi-word after extraction, drop it — it's a topic
 *    description, not a project name
 * 4. Return the clean kebab-case scope
 *
 * This is project-agnostic — works for any project, not just pi-para.
 */
export function normalizeScope(scope: string): string | null {
  const s = scope.trim().toLowerCase();
  if (!s) return null;

  // Already clean (no spaces) — pass through
  if (!s.includes(" ")) return s;

  // Try to extract a kebab-case project name prefix.
  // Multi-word scopes from the LLM follow the pattern:
  //   "<project-name> <topic words>"  e.g. "pi-mono project", "pi-para daemon"
  // Extract the first kebab-case token if it looks like a project name.
  const firstToken = s.split(" ")[0];
  if (firstToken && firstToken.includes("-")) {
    // Looks like a kebab-case project name (e.g. "pi-mono", "pi-para")
    return firstToken;
  }

  // Multi-word without a kebab prefix → topic description, drop it
  return null;
}

/**
 * Normalize a full scope list:
 * 1. Normalize each value
 * 2. Deduplicate
 * 3. Ensure at least one scope remains (fallback to "global")
 */
export function normalizeScopes(scopes: string[]): string[] {
  const result = new Set<string>();
  for (const s of scopes) {
    const normalized = normalizeScope(s);
    if (normalized) result.add(normalized);
  }
  if (result.size === 0) result.add("global");
  return [...result].sort();
}

// -- Tag normalization -------------------------------------------------------

/** Canonical tag → list of aliases that map to it. */
const TAG_ALIASES: Record<string, string[]> = {
  // session/capture family
  "session-capture": ["capture", "background-capture", "session"],
  "session-files": ["session files"],

  // project identity
  "pi-para": ["para"],
  "pi-mono": ["mono"],
  "coding-agent": ["agent"],

  // tech
  "node-llama-cpp": [],
  "qmd-search": ["bm25"],
  "lazy-loading": [],

  // kebab-case normalization
  "scope-detection": ["scope detection"],
  "project-structure": ["project structure", "structure"],
  "model-registry": ["model registry"],
  "thinking-level": ["thinking level"],
  "interactive-mode": ["interactive mode"],
  "exploration-incomplete": ["exploration incomplete"],
  "ui-component": ["UI component"],
  "scoped-models": ["scopedModels"],
  "github-packages": [],
  "architecture-pattern": [],
  "knowledge-management": ["knowledge-base"],

  // UI
  "webui": ["ui", "frontend", "react"],
};

/** Build reverse lookup: alias → canonical. */
function buildAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(TAG_ALIASES)) {
    for (const alias of aliases) {
      map.set(alias.toLowerCase(), canonical);
    }
  }
  return map;
}

const ALIAS_MAP = buildAliasMap();

/**
 * Normalize a single tag:
 * 1. Trim + lowercase
 * 2. Spaces → hyphens
 * 3. Resolve alias → canonical
 */
export function normalizeTag(tag: string): string {
  let t = tag.trim().toLowerCase().replace(/\s+/g, "-");
  const canonical = ALIAS_MAP.get(t);
  if (canonical) t = canonical;
  return t;
}

/**
 * Normalize a full tag list for a page, given its scope.
 *
 * 1. Normalize each tag
 * 2. Remove tags that exactly match a scope value
 * 3. Deduplicate
 * 4. Sort alphabetically
 */
export function normalizeTags(tags: string[], scope: string[]): string[] {
  const scopeSet = new Set(scope.map(s => s.toLowerCase()));
  const normalized = new Set<string>();

  for (const tag of tags) {
    const t = normalizeTag(tag);
    if (!t) continue;
    // Don't add tags that duplicate scope
    if (scopeSet.has(t)) continue;
    normalized.add(t);
  }

  return [...normalized].sort();
}

/**
 * Get the full alias map for external inspection (e.g., lint reporting).
 */
export function getAliasMap(): ReadonlyMap<string, string> {
  return ALIAS_MAP;
}
