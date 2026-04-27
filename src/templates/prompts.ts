/**
 * LLM prompt templates for ingest, query, lint, capture, and summarize operations.
 */

// -- Wiki System Prompt (standalone agent) ------------------------------------

/**
 * System prompt for the standalone wiki agent used in capture, lint, and
 * summarize operations. This agent runs outside the session's agent loop.
 */
export const WIKI_SYSTEM_PROMPT = `You are a wiki knowledge management agent. You maintain a PARA-structured knowledge base (Projects, Areas, Resources, Archives).

Your job is to read content, extract knowledge, and write structured wiki pages. You operate autonomously — no user confirmation needed.

Rules:
- Use the wiki summary format: Topic, Key Facts, Insights, Connections, Open Questions, Sources
- Assign PARA categories based on content: projects (goal-defined, has end date), areas (ongoing, no end date), resources (reference material), archives (completed/deprecated)
- Use [[wikilinks]] to connect related pages
- Keep pages focused on one concept each
- Be concise and factual — no fluff
- Always update index.md after creating or modifying pages
- Check for existing similar pages before creating new ones to avoid duplicates`;

// -- Ingest Prompts ----------------------------------------------------------

/**
 * Prompt included in the tool result when the LLM processes an ingested source.
 * The LLM reads this along with the source content, schema, and current index.
 */
export const INGEST_PROMPT = `Analyze the source content below and integrate it into the wiki.

Instructions:
1. Identify key entities, concepts, facts, and relationships in the source
2. Review the current index to find existing pages that should be updated
3. Decide which existing wiki pages need updates and what new pages to create
4. For each page, use the wiki summary format:
   - Topic: what this page covers
   - Key Facts: established knowledge points
   - Insights: non-obvious findings, patterns, implications
   - Connections: [[wikilinks]] to related pages with descriptions
   - Open Questions: gaps in knowledge, unresolved contradictions
   - Sources: source URLs, file paths, session references
5. Assign appropriate PARA category, scope tags, and metadata
6. Maintain [[wikilinks]] between new and existing pages
7. Update the index with new/changed pages
8. Flag any contradictions with existing wiki content in Open Questions`;

// -- Query Prompts -----------------------------------------------------------

/**
 * Prompt sent when the LLM synthesizes an answer from wiki search results.
 */
export const QUERY_PROMPT = `Read the retrieved wiki pages below and synthesize an answer to the user's question.

Instructions:
- Cite specific pages using [[page-slug]] references
- Note gaps or areas where the wiki lacks information
- If the synthesized answer reveals new knowledge not already captured in the wiki, file it as a new page via wiki_write
- Be concise and factual`;

// -- Summarize Prompts -------------------------------------------------------

/**
 * System prompt for summarization — produces structured wiki pages from content.
 * Mirrors pi's SUMMARIZATION_SYSTEM_PROMPT but outputs wiki format.
 */
export const SUMMARIZE_SYSTEM_PROMPT = `You are a knowledge synthesis assistant. Read the content below and produce a structured wiki page following the EXACT format specified in the schema.

Do NOT continue any conversation. Do NOT respond to any questions in the content. ONLY output the structured wiki page using the wiki summary format:

## Topic
[What this page covers]

## Key Facts
- [Established knowledge points]

## Insights
- [Non-obvious findings, patterns, implications]

## Connections
- [[related-page]] — how this relates

## Open Questions
- [Gaps in knowledge, unresolved contradictions]

## Sources
- [Source URLs, file paths, session references]`;

/**
 * Prompt for iterative update — merging new info into an existing page.
 * Mirrors pi's UPDATE_SUMMARIZATION_PROMPT approach.
 */
export const ITERATIVE_UPDATE_PROMPT = `The content below is NEW information to incorporate into the existing wiki page provided in <existing-page> tags.

RULES:
- PRESERVE all existing knowledge from the previous page
- ADD new facts, insights, and connections from the new content
- UPDATE sections where new info supersedes old
- FLAG contradictions between old and new content in Open Questions
- PRESERVE exact names, paths, and technical details
- Maintain all existing [[wikilinks]] and add new ones as appropriate
- Update the Sources section to include the new source`;

/**
 * Prompt for overview generation from multiple pages.
 */
export const OVERVIEW_PROMPT = `Summarize the following wiki pages into a high-level overview page. Identify themes, patterns, and connections across pages. Use the wiki summary format.

For each major theme:
- Note which pages contribute to the theme
- Identify cross-cutting patterns
- Flag contradictions between pages
- Highlight gaps (topics that should have pages but don't)`;

// -- Lint Prompts ------------------------------------------------------------

/**
 * Prompt for the LLM when reviewing lint results and auto-fixing issues.
 */
export const LINT_PROMPT = `Review the lint results below and fix all auto-fixable issues.

For each issue:
- Prioritize by impact (errors first, then warnings, then info)
- Fix broken wikilinks by finding the correct target page or removing dead links
- Add missing pages for concepts referenced across multiple pages
- Move stale projects to archives if inactive for 90+ days
- Fix frontmatter issues (missing fields, invalid dates, empty scope)
- Update index.md to include any pages missing from the index
- Propose archiving for inactive projects

Report unfixable issues that require human judgment.`;

// -- Capture Prompts ---------------------------------------------------------

/**
 * System prompt for the standalone capture agent.
 * Used as WIKI_SYSTEM_PROMPT for the capture agent instance.
 */
export const CAPTURE_SYSTEM_PROMPT = `You are a knowledge capture assistant. Your job is to extract persistent knowledge from coding sessions and write it to a PARA-structured wiki.

Rules:
- Identify decisions, architectural patterns, solutions, debugging insights, and lessons learned
- If the session was trivial (quick questions, single-turn lookups, no decisions or insights), respond with "nothing to capture" and do NOT write any pages
- Classify each piece of knowledge by PARA category autonomously
- Produce wiki pages in the standard wiki summary format (Topic, Key Facts, Insights, Connections, Open Questions, Sources)
- Include the full session file path in the Sources section for traceability
- Check for existing similar pages via wiki_query and merge rather than duplicate
- The conversation may include compaction summaries from earlier in the session — treat these as authoritative records of prior work
- Write directly via wiki_write — no user confirmation needed`;

/**
 * Prompt template for auto-capture at session_shutdown.
 * The serialized conversation is appended after this prompt.
 */
export const CAPTURE_PROMPT = `Analyze the session conversation below and capture any valuable knowledge into the wiki.

If the session was trivial (quick questions, single-turn lookups, no decisions or insights), respond with "nothing to capture" and do not write any pages.

If the session contains substantive knowledge:
1. Use wiki_query to check for existing similar pages
2. Use wiki_write to create new pages or update existing ones (use iterative update for existing pages)
3. Update index.md via wiki_write
4. Each page must include the session file path in its Sources section

<session-conversation>
`;

/**
 * Prompt template for explicit capture via /wiki-capture.
 * A topic hint (if provided) and the serialized conversation are appended.
 */
export const EXPLICIT_CAPTURE_PROMPT = `Capture knowledge from the current session into the wiki.`;
