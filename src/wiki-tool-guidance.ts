export type WikiToolName =
  | "wiki_ingest"
  | "wiki_query"
  | "wiki_edit"
  | "wiki_write"
  | "wiki_read"
  | "wiki_move"
  | "wiki_lint"
  | "wiki_migrate"
  | "wiki_summarize";

export const WIKI_TOOL_DESCRIPTIONS: Record<WikiToolName, string> = {
  wiki_ingest: "Ingest a URL, file path, or raw text into the PARA wiki and save a raw source copy.",
  wiki_query: "Search the PARA wiki with scope/category filters and freshness metadata.",
  wiki_edit: "Atomically edit an existing wiki page with exact oldText→newText replacements.",
  wiki_write: "Create new pages, append sections, or intentionally replace complete wiki pages.",
  wiki_read: "Read index.md or a wiki page by path/title, including frontmatter and freshness metadata.",
  wiki_move: "Move a wiki page between PARA categories and update frontmatter.",
  wiki_lint: "Run wiki health checks and optionally auto-fix safe issues.",
  wiki_migrate: "Batch-migrate all wiki pages to the current schema version.",
  wiki_summarize: "Collect page/category/wiki content for an LLM-written summary.",
};

export const WIKI_TOOL_SNIPPETS: Record<WikiToolName, string> = {
  wiki_ingest: "Ingest a source into the PARA wiki.",
  wiki_query: "Search the PARA wiki for relevant knowledge.",
  wiki_edit: "Surgically edit an existing wiki page; every oldText must match exactly once.",
  wiki_write: "Create/append/replace PARA wiki pages; prefer wiki_edit for surgical updates.",
  wiki_read: "Read index.md or a wiki page and check freshness for page results.",
  wiki_move: "Move a wiki page between PARA categories.",
  wiki_lint: "Run wiki health checks and safe autofixes.",
  wiki_migrate: "Batch-migrate wiki pages to the current schema.",
  wiki_summarize: "Summarize wiki pages, categories, or the entire wiki.",
};

const TOOL_SPECIFIC_GUIDELINES: Record<WikiToolName, readonly string[]> = {
  wiki_ingest: [
    "Use wiki_ingest when the user provides a URL, file path, or text to add to the knowledge base.",
    "After ingesting, synthesize durable knowledge with wiki_write/wiki_edit when the source contains reusable facts.",
  ],
  wiki_query: [
    "Call wiki_query FIRST — before other tools — for any non-trivial planning, implementation, debugging, architecture, or review request; the wiki may hold prior decisions, root causes, and conventions.",
    "Use global=true only when the answer should search across project scopes.",
  ],
  wiki_edit: [
    "Use wiki_edit after wiki_read when fixing stale, incorrect, or incomplete content.",
    "Keep oldText as small as possible while still unique in the page body.",
  ],
  wiki_write: [
    "Use wiki_write for new pages, appending new sections, or intentional whole-page replacement.",
    "mode=create is safe: if a page exists it is skipped, not overwritten.",
    "Use mode=replace only when deliberately rewriting the entire page.",
  ],
  wiki_read: [
    "When wiki_read returns AGING/STALE/VERY STALE, verify code/config/API claims against source before trusting them.",
  ],
  wiki_move: [
    "Use wiki_move when a page's PARA lifecycle changes, such as archiving a completed project.",
  ],
  wiki_lint: [
    "Use wiki_lint to check orphan pages, broken links, stale pages, scope drift, frontmatter, index drift, and duplicate slugs.",
  ],
  wiki_migrate: [
    "Use wiki_migrate when schemaVersion changes or doctor/lint reports stale page schema.",
  ],
  wiki_summarize: [
    "Use wiki_summarize to gather source material for a synthesized summary; write a durable page only if the summary is worth preserving.",
  ],
};

export function getWikiToolGuidelines(name: WikiToolName): string[] {
  return [...TOOL_SPECIFIC_GUIDELINES[name]];
}

export function buildWikiToolGuidanceSection(): string {
  return [
    "## pi-para Wiki Tool Guidance",
    "",
    "- Start non-trivial work with wiki_query using keywords from the request; past architecture, debugging, conventions, domain facts, or prior discussion may already be documented.",
    "- Treat AGING/STALE/VERY STALE code/config/API claims as untrusted until verified against source; fix wrong pages with wiki_edit.",
    "- Persist major decisions/debugging/conventions without being asked. Use wiki_edit for surgical fixes; wiki_write create/append for new/additive knowledge; replace only for deliberate full rewrites.",
    "- Prefer resources/, kebab-case scope/tags, [[wikilinks]], and no secrets.",
  ].join("\n");
}
