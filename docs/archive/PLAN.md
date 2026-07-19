# pi-para: PARA Knowledge Base Extension for pi

A pi extension that maintains a persistent, LLM-curated personal knowledge base structured by the PARA method (Projects, Areas, Resources, Archives). The LLM writes and maintains the entire wiki autonomously — no user approval steps, no confirmation prompts, no manual classification. The user's only jobs are: providing sources to ingest, asking questions, and (optionally) reviewing the wiki in Obsidian. Search powered by `@picassio/qmd`.

### Design Principle: Full Auto Mode

Every operation is autonomous by default:
- **Ingest**: LLM decides PARA category, scope tags, which pages to create/update, cross-references. No confirmation dialogs.
- **Capture**: session knowledge is captured automatically at session end. No opt-in, no approval prompts.
- **Lint**: auto-fix all fixable issues silently. Only report unfixable issues.
- **Scope**: auto-detected, never ask the user to classify.
- **Archiving**: LLM moves stale projects to archives automatically during lint.
- **Index/log maintenance**: fully automatic, never prompt.

The user can always override via slash commands (`/wiki-scope`, `/wiki-lint --report-only`) or by editing wiki files directly in Obsidian. But the default path is zero-friction.

### LLM Usage: Two Modes

The extension uses the LLM in two distinct ways:

**1. Agent-loop tools (during a session)**

Tools like `wiki_ingest`, `wiki_query`, `wiki_write`, `wiki_summarize`, `wiki_lint` are called *by* the LLM during the normal agent loop. The extension doesn't call the LLM — the LLM calls the extension's tools, reads the results, and decides what to do next. This uses pi's current session model.

Example flow:
```
User: "ingest this article about SSL certs"
  → LLM calls wiki_ingest(source="https://...")
  → tool fetches content, returns it + schema + index as tool result
  → LLM reads result, decides to create resources/ssl-certs.md
  → LLM calls wiki_write(pages=[{category: "resources", slug: "ssl-certs", ...}])
  → tool writes file, re-indexes, returns confirmation
```

No external LLM call. The session's model does all the thinking.

**2. Standalone mini-agent (outside the session's agent loop)**

Some operations need the LLM but happen outside the session's agent loop — in slash commands or lifecycle hooks where no agent turn is active. These operations need more than a single `completeSimple()` call because they involve multi-step reasoning: analyze content → decide what pages to create → write pages → update index → re-index.

`completeSimple()` (what pi's compaction uses) returns a single `AssistantMessage`. If the LLM needs to call tools, nobody executes them. You'd have to manually check for tool calls, execute them, build new messages with results, and call again — reimplementing the agent loop.

Instead, we use `Agent` from `@mariozechner/pi-agent-core`. It's a standalone agent with its own tool loop, completely independent from pi's session agent:

```typescript
import { Agent } from "@mariozechner/pi-agent-core";

const agent = new Agent({
  initialState: {
    systemPrompt: WIKI_SYSTEM_PROMPT,
    model: ctx.model,
    tools: [wikiWriteTool, wikiReadTool, wikiMoveTool],  // only wiki tools
    messages: [],
  },
  getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
});

// Subscribe to events (optional — for progress reporting)
agent.subscribe(async (event) => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    // LLM responded, maybe called tools
  }
});

// Run the prompt — agent loop handles tool calls automatically
await agent.prompt(capturePromptMessage);
// Agent has now called wiki_write, wiki_read, etc. as needed
```

The standalone `Agent`:
- Has its own message history (starts empty, not the session's history)
- Has its own tools (only wiki tools, not bash/read/edit/etc.)
- Runs its own tool loop (LLM calls tool → tool executes → result returned → LLM continues)
- Uses the same model and API key as the session (via `ctx.model` and `ctx.modelRegistry`)
- Is completely invisible to the pi session — no messages added, no context consumed

`ctx.model` and `ctx.modelRegistry` are accessible in all extension contexts: event handlers, command handlers, and `session_shutdown` (which fires before `dispose()`).

**Where the standalone agent is used:**

| Operation | When | Why not session agent loop? |
|---|---|---|
| Auto-capture | `session_shutdown` | Session agent loop is done. |
| `/wiki-capture` | Command handler (idle) | Would pollute session with wiki-maintenance messages. |
| `/wiki-lint` auto-fix | Command handler (idle) | Lint fixes are internal maintenance. |
| `/wiki-summarize` | Command handler (idle) | Same reasoning. |

**Why not `pi.sendUserMessage()`?**

Routing through the session's agent loop would:
- Inject wiki-maintenance messages into the session history, consuming context window
- Mix the user's actual work with wiki bookkeeping tool calls
- Get compacted later, adding noise to compaction summaries
- Require the session agent to be idle

The standalone agent is invisible to the session. Same LLM, same API key, separate context.

**Why not `completeSimple()`?**

For single-shot summarization (like pi's compaction), `completeSimple()` works because compaction has one job: read conversation, output summary text. No tools needed.

Wiki operations are multi-step:
1. LLM analyzes content and decides to create/update pages
2. LLM needs to search existing pages (calls `wiki_query` to check for duplicates)
3. LLM writes pages (calls `wiki_write` with structured data)
4. LLM updates index (calls `wiki_write` again for `index.md`)

This requires a tool loop. `completeSimple()` would force us to either:
- Cram everything into a single structured output (fragile, no validation, no dedup check)
- Manually re-implement the tool loop (parse tool calls, execute, re-call — `Agent` already does this)

**Exception: agent-loop tools used during conversation**

When the user says "ingest this article" or "search the wiki for X", the session's LLM calls `wiki_ingest`/`wiki_query` as tools in the normal pi agent loop. These *should* be in the session history — they're part of the user's work. Only maintenance operations (capture, lint, summarize) use the standalone agent.

**Tradeoff**: the standalone agent adds latency:
- Auto-capture at shutdown: 3-10 seconds (multi-turn tool loop)
- `/wiki-capture` mid-session: 3-10 seconds (user explicitly requested it)
- `/wiki-lint` with auto-fix: 5-15 seconds depending on issue count

Pi's own compaction makes a similar tradeoff (single LLM call during compaction). Our operations take slightly longer because they involve tool calls, but the user isn't waiting interactively — they're either leaving (shutdown) or explicitly asked for it (command).

If a call fails (network error, etc.), the extension catches the error and reports via `ctx.ui.notify()` (mid-session) or exits silently (shutdown). No data loss — the session file still exists for manual capture later.

### Interaction with Pi's Compaction

Pi's compaction summarizes old messages to free context window space. This affects the extension in several ways:

**What compaction does to our context:**
- Compaction replaces old messages with a structured summary (Goal, Progress, Decisions, etc.)
- After compaction, the full conversation history is gone from the LLM's context
- Only the summary + recent messages remain

**Impact on wiki tools during a session:**
- **No impact on `wiki_query`/`wiki_read`/`wiki_write`**: these are stateless tools. They read/write the filesystem and qmd index. They don't depend on conversation history.
- **No impact on `wiki_ingest`**: the tool returns the source content in its tool result. The LLM has everything it needs to synthesize wiki pages in that single tool result, regardless of what was compacted.
- **Minimal impact on context injection**: `before_agent_start` injects wiki context fresh every turn. Compaction doesn't remove it because it's in the system prompt, not in the message history.

**Impact on auto-capture at shutdown:**
- If compaction happened during the session, the full conversation is no longer available — only the compaction summary + recent messages
- This is actually fine: the compaction summary already distills the session's decisions, progress, and context. Auto-capture can work from the summary + recent messages just as well as from the full conversation.
- The capture prompt is aware of this: "The conversation may include compaction summaries from earlier in the session. Treat these as authoritative records of prior work."

**Should we hook `session_before_compact`?**

No. We don't need to customize pi's compaction. Our extension is a consumer of the session, not a modifier of it. Pi compacts for its own context management; we capture knowledge independently. The two systems are orthogonal:
- Pi compaction: manages context window, lossy, session-scoped
- Wiki capture: extracts persistent knowledge, additive, wiki-scoped

The only integration point is that auto-capture reads `ctx.sessionManager.getBranch()` which returns the post-compaction state. That's the correct input for capture — it's what the LLM was actually working with.

## Architecture

### Three Layers (Karpathy Model)

```
~/.pi/wiki/                        # The wiki (LLM-owned, user-readable)
├── .qmd.sqlite                    # qmd search index (hidden, auto-excluded)
├── config.json                    # extension settings (not indexed, not .md)
├── schema.md                      # PARA conventions, page formats
├── index.md                       # LLM-maintained catalog
├── log.md                         # append-only activity log
├── sessions.md                    # session digest log (searchable summaries)
├── projects/                      # active, goal-defined work (has an end date)
│   └── *.md
├── areas/                         # ongoing responsibilities (no end date)
│   └── *.md
├── resources/                     # reference material, how-tos, patterns
│   └── *.md
├── archives/                      # completed/deprecated/inactive
│   └── *.md
└── raw/                           # immutable source material (Karpathy layer 1)
    ├── articles/                  # web clips, saved articles
    ├── docs/                      # uploaded documents, PDFs-as-markdown
    └── notes/                     # manual notes, pasted text

~/.config/qmd/index.yml            # qmd config (providers for embed/chat/rerank)
```

### Extension Package

```
~/projects/pi-para/
├── PLAN.md                        # this file
├── package.json                   # @picassio/pi-para, depends on @picassio/qmd
├── tsconfig.json
├── src/
│   ├── index.ts                   # extension entry point (default export)
│   ├── wiki.ts                    # wiki filesystem operations
│   ├── store.ts                   # qmd store lifecycle (init, search, close)
│   ├── scope.ts                   # project scope detection and filtering
│   ├── frontmatter.ts             # YAML frontmatter parse/serialize
│   ├── raw.ts                     # raw source vault + session digests
│   ├── summarize.ts               # wiki summarization (adapted from pi compaction)
│   ├── ingest.ts                  # ingest pipeline (source -> wiki pages)
│   ├── query.ts                   # query pipeline (question -> search -> answer)
│   ├── lint.ts                    # wiki health checks
│   ├── context.ts                 # before_agent_start context injection
│   ├── capture.ts                 # session knowledge capture (mid-session + end)
│   ├── tools.ts                   # tool registrations (wiki_ingest, wiki_query, etc.)
│   ├── commands.ts                # slash command registrations (/wiki, /wiki-lint, etc.)
│   └── templates/
│       ├── schema.md              # default schema.md template
│       ├── index.md               # default index.md template
│       └── prompts.ts             # LLM prompt templates for ingest/query/lint/capture/summarize
└── test/
    ├── frontmatter.test.ts
    ├── scope.test.ts
    ├── wiki.test.ts
    ├── raw.test.ts
    ├── summarize.test.ts
    ├── ingest.test.ts
    ├── query.test.ts
    ├── capture.test.ts
    ├── lint.test.ts
    └── fixtures/
        └── sample-wiki/           # test wiki with pre-populated pages
```

---

## Detailed Component Design

### 1. Wiki Filesystem (`wiki.ts`)

Manages the `~/.pi/wiki/` directory structure.

**Responsibilities:**
- Initialize wiki directory on first run (create dirs, seed `schema.md`, `index.md`, `log.md`)
- Read/write/delete wiki pages (markdown files with frontmatter)
- List pages by PARA category
- Move pages between categories (e.g., project -> archive)
- Resolve page paths from titles (slugify)
- Validate wiki structure integrity

**Key functions:**
```typescript
initWiki(wikiDir: string): Promise<void>
readPage(wikiDir: string, category: ParaCategory, slug: string): Promise<WikiPage | null>
writePage(wikiDir: string, page: WikiPage): Promise<void>
deletePage(wikiDir: string, category: ParaCategory, slug: string): Promise<void>
movePage(wikiDir: string, from: PageRef, toCategory: ParaCategory): Promise<void>
listPages(wikiDir: string, category?: ParaCategory): Promise<PageRef[]>
readIndex(wikiDir: string): Promise<string>
writeIndex(wikiDir: string, content: string): Promise<void>
appendLog(wikiDir: string, entry: LogEntry): Promise<void>
readSchema(wikiDir: string): Promise<string>
```

**Types:**
```typescript
type ParaCategory = "projects" | "areas" | "resources" | "archives"

interface WikiPage {
  category: ParaCategory
  slug: string
  frontmatter: PageFrontmatter
  body: string
}

interface PageFrontmatter {
  title: string
  para: ParaCategory
  scope: string[]          // project names this page is relevant to
  tags: string[]           // topic tags
  sources: string[]        // source URLs/files this page was derived from
  created: string          // ISO date
  updated: string          // ISO date
  links: string[]          // outgoing [[wikilinks]]
}

interface PageRef {
  category: ParaCategory
  slug: string
  title: string
  path: string             // relative path within wiki dir
}

interface LogEntry {
  date: string
  operation: "ingest" | "query" | "lint" | "capture" | "move" | "archive"
  summary: string
  pages: string[]          // pages touched
}
```

### 2. qmd Store Lifecycle (`store.ts`)

Manages the `@picassio/qmd` store instance.

**Responsibilities:**
- Create/open the qmd store pointing at `~/.pi/wiki/`
- Configure the wiki collection in qmd
- Add qmd context annotations for PARA categories
- Expose search (hybrid, lex, vector) with scope filtering
- Re-index after wiki changes (ingest, move, delete)
- Embed new/changed pages
- Close store on session_shutdown

**Key functions:**
```typescript
openStore(wikiDir: string): Promise<QMDStore>
closeStore(store: QMDStore): Promise<void>
searchWiki(store: QMDStore, query: string, opts: WikiSearchOptions): Promise<WikiSearchResult[]>
reindex(store: QMDStore): Promise<void>       // fast: filesystem scan, BM25 ready immediately
embedIfNeeded(store: QMDStore): Promise<void>  // slow: generate vector embeddings for new/changed pages
```

**Deferred embedding strategy:**
- `store.update()` (filesystem scan) runs after every `wiki_write` — it's fast and makes new content BM25-searchable immediately
- `store.embed()` (vector embedding generation) runs only at:
  - Store initialization (startup) if there are stale/missing embeddings
  - `session_shutdown` before closing the store (batch embed everything written during the session)
- This avoids blocking tool responses with slow embedding calls. BM25 search works without embeddings. Hybrid search (BM25 + vector) improves on the next session after embeddings are generated.

**Types:**
```typescript
interface WikiSearchOptions {
  scope?: string[]           // filter by scope tags
  category?: ParaCategory    // filter by PARA category
  limit?: number
  includeArchives?: boolean  // default false
}

interface WikiSearchResult {
  page: PageRef
  score: number
  snippet: string
  frontmatter: PageFrontmatter
}
```

**Store initialization flow:**

Use inline config at `createStore()` time (not `addCollection()` after, since the SDK's `addCollection` doesn't expose `includeByDefault`):

```typescript
const store = await createStore({
  dbPath: join(wikiDir, ".qmd.sqlite"),
  config: {
    collections: {
      wiki: {
        path: wikiDir,
        pattern: "**/*.md",
        ignore: ["raw/**"],
      },
      raw: {
        path: join(wikiDir, "raw"),
        pattern: "**/*.md",
        includeByDefault: false,
      },
    },
  },
});
```

After store creation:
1. Add qmd context per PARA category:
   - `qmd://wiki/projects` -> "Active projects with defined goals and end dates"
   - `qmd://wiki/areas` -> "Ongoing responsibilities and standards"
   - `qmd://wiki/resources` -> "Reference material and how-to guides"
   - `qmd://wiki/archives` -> "Completed or deprecated items"
   - `qmd://raw` -> "Immutable source material: articles, documents, notes. Not synthesized."
2. Run `store.update()` to sync filesystem (fast, BM25 searchable immediately)
3. Schedule `store.embed()` in background (non-blocking) if stale embeddings exist. BM25 search works immediately; hybrid search improves once embedding completes.

`raw` collection has `includeByDefault: false`, so standard queries only search the wiki. Use `collections: ["wiki", "raw"]` to also search raw sources.

**Note on indexed files:** The `wiki` collection indexes all `.md` files in `~/.pi/wiki/` (excluding `raw/`). This includes `schema.md`, `index.md`, `log.md`, and `sessions.md` alongside PARA category pages. This is intentional — `log.md` and `sessions.md` contain searchable content (activity log entries, session digests). `config.json` is not indexed (not a `.md` file). `.qmd.sqlite` is auto-excluded by qmd (hidden file prefix).

**Search flow:**
1. Call `store.search({ query })` for hybrid search (or `store.searchLex()` if no embedding provider configured)
2. For each result, parse frontmatter
3. Filter by scope: keep pages where `scope` includes any of the requested scope tags, or `scope` includes "global"
4. Filter by category if requested
5. Exclude archives unless explicitly requested
6. Return sorted by relevance score

### 3. Project Scope Detection (`scope.ts`)

Determines which wiki pages are relevant to the current working context.

**Responsibilities:**
- Auto-detect project name from cwd (git repo name, directory name, or explicit config)
- Load project-specific scope overrides from `.pi/wiki-scope.json`
- Merge global and project scopes
- Provide scope tags for filtering

**Detection priority:**
1. `.pi/wiki-scope.json` in cwd (explicit)
2. Git remote name: `git remote get-url origin` -> extract repo name
3. Git repo root directory name
4. Fall back to cwd basename

**Key functions:**
```typescript
detectScope(cwd: string): Promise<ProjectScope>
loadScopeConfig(cwd: string): Promise<ScopeConfig | null>
matchesScope(pageScope: string[], projectScope: ProjectScope): boolean
```

**Types:**
```typescript
interface ProjectScope {
  name: string               // detected project name
  include: string[]          // scope tags to include (always includes name)
  exclude: string[]          // scope tags to exclude
  source: "config" | "git-remote" | "git-root" | "dirname"
}

// .pi/wiki-scope.json
interface ScopeConfig {
  name: string
  include?: string[]         // additional scope tags to include
  exclude?: string[]         // scope tags to exclude
}
```

**Scope matching rules:**
- A page matches if `page.scope` contains "global" OR any tag in `projectScope.include`
- A page is excluded if `page.scope` contains any tag in `projectScope.exclude`
- Exclude takes priority over include
- `areas/` pages default to `scope: ["global"]` at creation time
- `projects/` pages default to `scope: ["<current-project-name>"]` at creation time
- `resources/` pages get scope assigned by the LLM based on content analysis

### 4. Frontmatter (`frontmatter.ts`)

Parse and serialize YAML frontmatter in markdown files.

**Responsibilities:**
- Parse `---\n...\n---` frontmatter from markdown content
- Serialize frontmatter back to YAML
- Validate required fields
- Provide defaults for missing optional fields

**Key functions:**
```typescript
parseFrontmatter(content: string): { frontmatter: PageFrontmatter; body: string }
serializeFrontmatter(frontmatter: PageFrontmatter, body: string): string
validateFrontmatter(fm: Record<string, unknown>): PageFrontmatter
```

**Implementation:** Use a simple YAML parser (e.g., `yaml` npm package) rather than regex. Handle edge cases: missing frontmatter, malformed YAML, unknown fields (preserve them).

### 5. Ingest Pipeline (`ingest.ts`)

Processes a source and integrates its knowledge into the wiki.

**Responsibilities:**
- Accept sources: URL, file path, or raw text
- Fetch URL content (use pi's `fetch` or read file)
- Send source content to the LLM with the ingest prompt
- LLM returns structured output: new pages to create, existing pages to update, index updates
- Apply changes to the wiki filesystem
- Re-index and embed via qmd
- Append to log

**Ingest flow:**
1. Resolve source (fetch URL, read file, or use raw text)
2. Read current `schema.md` for conventions
3. Read current `index.md` for existing page catalog
4. Detect current project scope
5. Send to LLM with ingest prompt:
   - Source content
   - Schema conventions
   - Current index (so LLM knows what exists)
   - Current scope (for auto-tagging)
6. LLM returns JSON:
   ```typescript
   interface IngestResult {
     newPages: Array<{
       category: ParaCategory
       slug: string
       title: string
       scope: string[]
       tags: string[]
       body: string           // markdown with [[wikilinks]]
     }>
     updatedPages: Array<{
       category: ParaCategory
       slug: string
       appendOrReplace: "append" | "replace"
       body: string
     }>
     indexUpdate: string       // full new index.md content
     logSummary: string        // one-line summary for log.md
   }
   ```
7. Write new pages (with generated frontmatter)
8. Apply updates to existing pages
9. Write updated `index.md`
10. Append to `log.md`
11. Run `store.update()` to sync filesystem (fast). Embedding deferred to `session_shutdown`.

**Key functions:**
```typescript
interface IngestOptions {
  source: string              // URL, file path, or raw text
  sourceType?: "url" | "file" | "text"  // auto-detected if omitted
  scope?: string[]            // override auto-detected scope
  category?: ParaCategory     // hint for PARA classification
}

ingest(
  wikiDir: string,
  store: QMDStore,
  options: IngestOptions,
  scope: ProjectScope,
): Promise<IngestReport>

interface IngestReport {
  pagesCreated: PageRef[]
  pagesUpdated: PageRef[]
  logEntry: LogEntry
}
```

**LLM interaction:** The extension does NOT call the LLM directly. It uses pi's agent loop by returning tool results that instruct the LLM what to do. The `wiki_ingest` tool:
1. Fetches the source content
2. Returns it along with schema + index + instructions as the tool result
3. The LLM processes and calls `wiki_write` (internal tool) with the structured output
4. `wiki_write` applies the changes

This keeps the LLM in control of the synthesis while the extension handles I/O.

### 6. Query Pipeline (`query.ts`)

Searches the wiki and optionally files answers back as new pages.

**Responsibilities:**
- Accept a natural language query
- Search via qmd (scoped to current project)
- Return relevant pages with snippets
- LLM synthesizes an answer from the pages (via agent loop)
- LLM autonomously decides whether the answer is worth filing back as a wiki page

**Query flow:**
1. Detect current project scope
2. Search qmd with scope filtering
3. Return top results with content
4. LLM reads the returned pages and generates an answer
5. LLM decides whether the answer adds new knowledge — if so, calls `wiki_write` to save it. No user prompt.

**Key functions:**
```typescript
interface QueryOptions {
  query: string
  scope?: string[]            // override auto-detected scope
  global?: boolean            // search all scopes (ignore project filter)
  category?: ParaCategory     // restrict to PARA category
  limit?: number              // max results (default 10)
  includeArchives?: boolean   // search archives too (default false)
}

queryWiki(
  store: QMDStore,
  options: QueryOptions,
  scope: ProjectScope,
): Promise<QueryResult>

interface QueryResult {
  results: WikiSearchResult[]
  scopeUsed: ProjectScope
}
```

### 7. Lint Pipeline (`lint.ts`)

Health-checks the wiki.

**Checks:**
1. **Orphan pages**: pages with no inbound [[wikilinks]] from other pages
2. **Broken links**: [[wikilinks]] pointing to non-existent pages
3. **Stale pages**: pages not updated in >90 days (configurable)
4. **Scope drift**: pages in `projects/` with scope not matching their project name
5. **Archive candidates**: project pages where the project appears inactive (no recent log entries)
6. **Missing pages**: concepts mentioned in multiple pages but lacking their own page
7. **Empty categories**: PARA categories with zero pages
8. **Frontmatter issues**: missing required fields, invalid dates, empty scope
9. **Index drift**: pages that exist on disk but are missing from `index.md`
10. **Duplicate slugs**: same slug in different categories (allowed but flagged)

**Key functions:**
```typescript
interface LintOptions {
  staleDays?: number          // days before a page is "stale" (default 90)
  autoFix?: boolean           // auto-fix all fixable issues (default true). Set false for report-only mode.
}

lintWiki(wikiDir: string, options?: LintOptions): Promise<LintReport>

interface LintReport {
  issues: LintIssue[]
  stats: WikiStats
}

interface LintIssue {
  severity: "error" | "warning" | "info"
  category: string            // "orphan" | "broken-link" | "stale" | etc.
  page?: string               // affected page path
  message: string
  autoFixable: boolean
}

interface WikiStats {
  totalPages: number
  byCategory: Record<ParaCategory, number>
  totalLinks: number
  brokenLinks: number
  orphanPages: number
  oldestPage: string
  newestPage: string
  lastIngest: string
}
```

### 8. Context Injection (`context.ts`)

Injects relevant wiki knowledge into every agent turn.

**Responsibilities:**
- On `session_start`: detect scope, cache it for the session
- On `before_agent_start` (fires every turn, not just session start): inject wiki context into system prompt
- Keep injected context small: index + top relevant page summaries
- Rebuild context each turn (wiki may have changed between turns via `wiki_write`)

**Strategy:**
- Always inject: `schema.md` (conventions), `index.md` (catalog)
- Conditionally inject: summaries of pages matching current scope
- Token budget: configurable max tokens for wiki context (default 4000)
- If budget exceeded: inject only index + page titles, let the LLM query for details
- Scope detection is cached at `session_start` (cheap). Wiki context is rebuilt at `before_agent_start` (reads index.md + scope-filtered pages).

**Key functions:**
```typescript
interface ContextOptions {
  maxTokens?: number          // max tokens for wiki context (default 4000)
  includeSchema?: boolean     // include schema.md (default true on first session)
  includeIndex?: boolean      // include index.md (default true)
  includeSummaries?: boolean  // include page summaries (default true)
}

buildContext(
  wikiDir: string,
  store: QMDStore,
  scope: ProjectScope,
  options?: ContextOptions,
): Promise<string>
```

**Implementation via `before_agent_start`:**
```typescript
let cachedContext: string | null = null;
let contextDirty = true;  // set true by wiki_write/wiki_move tool executions

pi.on("session_start", async (_event, ctx) => {
  currentScope = await detectScope(ctx.cwd);
  contextDirty = true;  // force rebuild on new session
});

pi.on("before_agent_start", async (event, ctx) => {
  // Rebuild only if wiki was modified since last build
  if (contextDirty || !cachedContext) {
    cachedContext = await buildContext(wikiDir, store, currentScope);
    contextDirty = false;
  }
  if (cachedContext) {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + cachedContext,
    };
  }
});
```

### 9. Raw Sources & Session Digests (`raw.ts`)

Manages the raw source layer (Karpathy's layer 1) and session-to-wiki bridging.

**Why sessions are NOT stored as raw sources:**

Pi sessions are `.jsonl` files with structured entries (messages, tool calls, tool results, compaction entries, branch summaries). They are:
- **Not text** — qmd indexes text files. JSONL is structured data with nested JSON objects. BM25 would match on JSON keys (`"type"`, `"content"`) and vector search would embed JSON syntax noise alongside actual content.
- **Huge** — a single project's sessions can be 300MB+. The entire sessions directory can be 1GB+. Indexing this would dwarf the wiki and destroy search quality with noise.
- **Already persisted** — pi stores sessions at `~/.pi/agent/sessions/<project>/`. The data already exists. Copying it is pure waste.
- **Mostly noise** — 90%+ of a session is mechanical: file reads, edit diffs, bash output, debugging loops. The signal (decisions, solutions, insights) is 5-10%.

**What we do instead: session digests**

When knowledge is captured from a session, the extension:
1. Serializes the relevant conversation segment to text (using pi's `[User]:`, `[Assistant]:` format)
2. Generates a wiki page (the synthesis — stored in the wiki)
3. Appends a **session digest entry** to `sessions.md` (the reference — searchable via qmd)
4. The wiki page's frontmatter `sources` field links back to the original session file

**`sessions.md` format** (append-only, qmd-searchable):
```markdown
## [2026-04-27] pi-mono | SSL certificate debugging
- **Session**: `~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-27_abc123.jsonl`
- **Scope**: pi-mono
- **Captured**: [[ssl-cert-gotchas]]
- **Summary**: Debugged SSL cert renewal failure in CI. Root cause was expired intermediate cert cached by node. Solution: clear cert cache before renewal step.

## [2026-04-26] agent-board | Dashboard layout refactor
- **Session**: `~/.pi/agent/sessions/--home-ubuntu-projects-agent-board--/2026-04-26_def456.jsonl`
- **Scope**: agent-board
- **Captured**: [[dashboard-layout-decisions]]
- **Summary**: Switched from CSS Grid to flexbox for the main dashboard. Grid caused overflow issues on narrow viewports.
```

This gives you:
- **Searchability**: qmd indexes `sessions.md` as markdown, so "SSL cert" or "dashboard layout" queries find the digest
- **Traceability**: the session file path lets you open the original conversation
- **Lightweight**: one paragraph per session instead of megabytes of JSONL
- **Chronological**: append-only log of all sessions that produced wiki knowledge

**Raw sources (non-session):**

For deliberately ingested sources (URLs, articles, files), store a copy in `~/.pi/wiki/raw/`:

```typescript
interface RawSource {
  type: "url" | "file" | "text"
  originalPath: string           // URL or file path
  savedPath: string              // path within raw/ directory
  ingestedAt: string             // ISO date
  wikiPages: string[]            // wiki pages derived from this source
}
```

- `raw/articles/` — web clips saved as markdown (via fetch or Obsidian Web Clipper)
- `raw/docs/` — uploaded documents
- `raw/notes/` — manually pasted text

Raw sources are immutable — the LLM reads from them but never modifies them. They are the source of truth. The wiki pages are the LLM's synthesis.

qmd indexes `raw/` as a separate collection (pattern `**/*.md`). This means raw sources are searchable alongside wiki pages, but they're a distinct collection that can be filtered in/out of queries.

**Key functions:**
```typescript
// Save a raw source to the vault
saveRawSource(
  wikiDir: string,
  source: { type: "url" | "file" | "text"; content: string; originalPath: string },
): Promise<string>  // returns saved path

// Append a session digest entry
appendSessionDigest(
  wikiDir: string,
  digest: {
    date: string
    project: string
    sessionFile: string
    scope: string
    capturedPages: string[]   // wiki page slugs
    summary: string           // one-paragraph summary
  },
): Promise<void>

// Read session digest entries (for /wiki command status display)
readSessionDigests(
  wikiDir: string,
  options?: { limit?: number; scope?: string },
): Promise<SessionDigest[]>
```

**qmd store configuration:**

The store has two collections:
1. `wiki` — `~/.pi/wiki/` with pattern `**/*.md`, excluding `raw/**`
2. `raw` — `~/.pi/wiki/raw/` with pattern `**/*.md`

Default queries search only `wiki`. The `wiki_query` tool's `global` flag also searches `raw`. The `wiki_ingest` tool automatically saves to `raw/` when the source is a URL or file.

### 10. Session Capture (`capture.ts`)

Captures insights from completed sessions back into the wiki. Fully automatic.

**Responsibilities:**
- On `session_shutdown`: automatically analyze the session and capture valuable knowledge
- On explicit request: user says "save this to the wiki" or uses `/wiki-capture` mid-session
- Never prompt, never ask for approval, never show confirmation dialogs

**Capture modes:**

1. **Auto-capture** (default, always on) — on `session_shutdown`, the extension serializes the conversation, evaluates it for capturable knowledge, and writes wiki pages directly. No user interaction. If the session was trivial (< 3 turns, no decisions or insights), nothing is captured — silently.

2. **Explicit capture** — user says "save this to the wiki" mid-session. The LLM calls `wiki_write` with the distilled insight. Also fully automatic — no "are you sure?" dialogs.

**Capture strategy:**
- Auto-capture on every `session_shutdown` (not just long sessions)
- The LLM decides what's worth capturing — not a heuristic, not a turn count threshold
- Trivial sessions (quick questions, single-turn lookups) produce nothing — the LLM recognizes there's no persistent knowledge to extract
- Substantial sessions produce wiki pages automatically: decisions, solutions, patterns, architecture insights
- Duplicate detection: before writing, check if a similar page already exists via qmd search. If so, do an iterative update instead of creating a new page

**Session-to-wiki tracing:**
Every wiki page created from a session capture includes a `sources` entry with the full session file path (from `ctx.sessionManager.getSessionFile()`):
```yaml
sources:
  - session:~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-27T10-12-37_d35783d1.jsonl
  - https://example.com    # or other source URLs
```
This allows tracing from a wiki page back to the original conversation. The full path is used (not just the session ID) because pi's session directory structure encodes the project name, and the path can be opened directly.

**Key functions:**
```typescript
interface CaptureResult {
  pagesCreated: PageRef[]
  pagesUpdated: PageRef[]
  skipped: boolean              // true if session had nothing worth capturing
  reason?: string               // why it was skipped ("trivial session", etc.)
  digestEntry?: SessionDigest   // appended to sessions.md
}

// Called automatically on session_shutdown
// Spins up a standalone Agent with wiki tools, aborts after timeoutMs
autoCapture(
  wikiDir: string,
  store: QMDStore,
  messages: AgentMessage[],
  scope: ProjectScope,
  sessionFile: string,
  model: Model<any>,
  modelRegistry: ModelRegistry,   // for getApiKeyForProvider()
  timeoutMs?: number,             // default 30000 from config.json
): Promise<CaptureResult>

// Called when user explicitly requests capture mid-session via /wiki-capture
// Spins up a standalone Agent with wiki tools
explicitCapture(
  wikiDir: string,
  store: QMDStore,
  topic: string | undefined,    // user-specified topic or undefined for auto-detect
  messages: AgentMessage[],
  scope: ProjectScope,
  sessionFile: string,
  model: Model<any>,
  modelRegistry: ModelRegistry,
): Promise<CaptureResult>
```

**Auto-capture flow on `session_shutdown`:**
1. Get current model from `ctx.model`
2. Read session branch via `ctx.sessionManager.getBranch()` (post-compaction state)
3. Serialize the conversation to text (handles compaction summaries as first-class content)
4. Spin up a standalone `Agent` with wiki tools (`wiki_write`, `wiki_read`, `wiki_query`) and the session's model/API key
5. Prompt the agent with: serialized conversation + capture instructions
6. The agent's tool loop runs autonomously:
   - LLM analyzes the conversation
   - If trivial: LLM responds with "nothing to capture" → agent ends
   - If substantive: LLM calls `wiki_query` to check for existing similar pages
   - LLM calls `wiki_write` to create/update pages with dedup-aware mode
   - LLM calls `wiki_write` again to update `index.md`
7. After agent completes: append session digest to `sessions.md`, append to `log.md`
8. Run `store.update()` to sync any newly written pages
9. Run `store.embed()` to generate embeddings for all pages written during this session
10. Close qmd store

All of this happens synchronously during `session_shutdown` before pi exits. No background tasks, no deferred work.

The standalone agent runs with an `AbortController` governed by `autoCaptureTimeoutMs` (default 30 seconds from `config.json`). If it exceeds the timeout, the agent is aborted and capture is skipped silently. If it fails for any other reason (network error, etc.), catch the error and exit silently. No data loss — the session file still exists for manual capture later via `/wiki-capture`.

**Note**: this uses a standalone `Agent` from `@mariozechner/pi-agent-core`, not the session's agent loop and not `completeSimple()`. The standalone agent has its own tool loop, its own message history (starts with just the capture prompt), and is invisible to the pi session. See the "LLM Usage" section above for details.

### 11. Summarization (`summarize.ts`)

Adapts pi's compaction approach to produce structured wiki summaries.

Pi's compaction system is well-designed: it serializes conversations to text, sends them to the LLM with a structured format prompt, and produces summaries that preserve goals, decisions, progress, and critical context. We replicate this pattern but adapt it for wiki knowledge rather than session continuity.

**How pi's compaction works (what we borrow):**
- `serializeConversation()` converts messages to `[User]:`, `[Assistant]:`, `[Tool result]:` text format
- Structured summary format with Goal, Progress, Key Decisions, Next Steps, Critical Context sections
- Iterative summarization: when a previous summary exists, the LLM merges new info into it
- File operation tracking (read/modified files) appended as structured tags

**How wiki summarization differs:**

Pi compacts to free context window space — it discards the original messages and keeps only the summary. Wiki summarization produces a **persistent artifact** (a wiki page) that coexists with the source material. The summary is additive, not destructive.

We also shift from session-oriented structure to knowledge-oriented structure:

| Pi Compaction Format | Wiki Summary Format |
|---|---|
| Goal (what user wants) | Topic (what this knowledge is about) |
| Progress (done/in-progress/blocked) | Key Facts (established knowledge) |
| Key Decisions (choices made) | Insights (non-obvious findings) |
| Next Steps (what to do next) | Connections (links to related wiki pages) |
| Critical Context (data to continue) | Open Questions (gaps, contradictions) |
| Read/Modified Files | Sources (where this came from) |

**Wiki summary format:**
```markdown
## Topic
[What this page covers]

## Key Facts
- [Established knowledge points]

## Insights
- [Non-obvious findings, patterns, implications]

## Connections
- [[related-page]] — how this relates
- [[another-page]] — connection description

## Open Questions
- [Gaps in knowledge, unresolved contradictions]

## Sources
- [Source URLs, file paths, session references]
```

**Summarization modes:**

1. **Ingest summarization** — when a new source is ingested, the LLM produces wiki pages using the wiki summary format. This is the primary knowledge creation path.

2. **Session summarization** — when capturing from a session, the conversation is serialized using pi's `serializeConversation()` approach (or a compatible reimplementation), then summarized into the wiki format. The serialization prevents the LLM from trying to continue the conversation.

3. **Page summarization** — summarize an existing wiki page or group of pages into a higher-level overview page. Useful for `/wiki-summarize projects/` to get a project status overview.

4. **Iterative summarization** — when updating an existing wiki page with new information (e.g., ingesting a second source about the same topic), the LLM receives both the existing page content and the new source, then produces an updated page that merges both. Same principle as pi's `UPDATE_SUMMARIZATION_PROMPT`.

**Conversation serialization:**

For session capture, we serialize the conversation to prevent the LLM from treating it as a chat to continue. We reuse the same approach as pi's `serializeConversation()`:

```typescript
// Serialize pi agent messages to text
function serializeForWiki(messages: AgentMessage[]): string {
  // Same format as pi: [User]:, [Assistant]:, [Tool result]:
  // Tool results truncated to 2000 chars
  // Thinking content included as [Assistant thinking]:
  // Tool calls serialized as [Assistant tool calls]: name(args)
}
```

If `convertToLlm` and `serializeConversation` are importable from `@mariozechner/pi-coding-agent`, we use them directly. Otherwise we reimplement the same logic.

**Key functions:**
```typescript
interface SummarizeOptions {
  mode: "ingest" | "session" | "page" | "iterative"
  existingContent?: string       // for iterative mode
  scope: ProjectScope
  category?: ParaCategory
}

// Generate a wiki-format summary from raw content
generateSummary(
  content: string,               // source text or serialized conversation
  options: SummarizeOptions,
): string                         // returns the prompt to send to LLM

// Summarize multiple wiki pages into an overview
generateOverviewPrompt(
  pages: WikiPage[],
  scope: ProjectScope,
): string

// Serialize session messages for wiki capture
serializeSessionForWiki(
  messages: AgentMessage[],
): string
```

### 12. Tools (`tools.ts`)

Tools serve two consumers:
1. **Pi's session agent** — tools registered via `pi.registerTool()` for use during normal conversation
2. **Standalone mini-agent** — the same tool implementations wrapped as `AgentTool` for capture/lint/summarize

The tool *implementations* (the actual `execute` functions) are shared. Only the registration differs:
- For pi: wrapped with `pi.registerTool()` which adds rendering, prompt snippets, etc.
- For standalone agent: wrapped as plain `AgentTool` objects (no TUI rendering needed)

Tool implementations close over `wikiDir` and `store` from the extension scope. They do NOT use `ctx` (pi's `registerTool` passes `ctx: ExtensionContext` as 5th arg, but `AgentTool` has only 4 args: `toolCallId, params, signal?, onUpdate?`). This keeps implementations portable across both consumers.

```typescript
// Shared implementation — no ctx dependency, closes over wikiDir/store
function createWikiWriteExecute(wikiDir: string, store: QMDStore) {
  return async (params: WikiWriteParams): Promise<AgentToolResult<WikiWriteDetails>> => {
    // validate, write pages, update index, append log
    // run store.update() (fast) but NOT store.embed() (deferred to shutdown)
    return { content: [...], details: { ... } };
  };
}

// Registered for pi's session agent (5-arg execute, ignores ctx)
const sharedExecute = createWikiWriteExecute(wikiDir, store);
pi.registerTool({
  name: "wiki_write",
  execute: (toolCallId, params, signal, onUpdate, ctx) => sharedExecute(params),
  renderCall: ...,
  renderResult: ...,
});

// Used by standalone agent (4-arg execute)
const standaloneWikiWrite: AgentTool = {
  name: "wiki_write",
  label: "Wiki Write",
  description: "...",
  parameters: wikiWriteSchema,
  execute: (toolCallId, params) => sharedExecute(params),
};
```

LLM-callable tools registered via `pi.registerTool()`:

#### `wiki_ingest`

Ingest a source into the wiki.

```typescript
parameters: Type.Object({
  source: Type.String({ description: "URL, file path, or raw text to ingest" }),
  sourceType: Type.Optional(StringEnum(["url", "file", "text"] as const)),
  category: Type.Optional(StringEnum(["projects", "areas", "resources"] as const)),
  scope: Type.Optional(Type.Array(Type.String(), { description: "Scope tags for the ingested content" })),
})
```

**Execution flow:**
1. Resolve source (fetch URL / read file / use text)
2. Read `schema.md` and `index.md`
3. Return source content + schema + index + scope + summarization prompt as tool result
4. LLM synthesizes using wiki summary format and calls `wiki_write` to apply changes

#### `wiki_query`

Search the wiki.

```typescript
parameters: Type.Object({
  query: Type.String({ description: "Natural language search query" }),
  global: Type.Optional(Type.Boolean({ description: "Search all scopes, not just current project" })),
  category: Type.Optional(StringEnum(["projects", "areas", "resources", "archives"] as const)),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
})
```

**Execution flow:**
1. Search qmd with scope filtering
2. Return results with page content
3. LLM can read and synthesize

#### `wiki_write`

Write or update wiki pages (internal tool, called by LLM after ingest/query).

```typescript
parameters: Type.Object({
  pages: Type.Array(Type.Object({
    category: StringEnum(["projects", "areas", "resources", "archives"] as const),
    slug: Type.String(),
    title: Type.String(),
    scope: Type.Array(Type.String()),
    tags: Type.Array(Type.String()),
    body: Type.String(),
    mode: StringEnum(["create", "replace", "append"] as const),
  })),
  indexContent: Type.Optional(Type.String({ description: "Updated index.md content" })),
  logSummary: Type.Optional(Type.String({ description: "One-line log entry" })),
})
```

**Execution flow:**
1. Validate all pages (frontmatter, slugs, categories)
2. Write/update each page
3. Update `index.md` if provided
4. Append to `log.md` if summary provided
5. Run `store.update()` to sync filesystem (fast, BM25 searchable immediately)
6. Do NOT run `store.embed()` here — deferred to `session_shutdown` (embedding is slow and would block the tool response)
7. Return summary of changes

#### `wiki_read`

Read a specific wiki page by path or title.

```typescript
parameters: Type.Object({
  path: Type.String({ description: "Page path (e.g. 'projects/auth-refactor') or title" }),
})
```

#### `wiki_move`

Move a page between PARA categories.

```typescript
parameters: Type.Object({
  path: Type.String({ description: "Current page path (e.g. 'projects/auth-refactor')" }),
  to: StringEnum(["projects", "areas", "resources", "archives"] as const),
})
```

#### `wiki_lint`

Run wiki health checks.

```typescript
parameters: Type.Object({
  autoFix: Type.Optional(Type.Boolean({ description: "Auto-fix simple issues" })),
})
```

#### `wiki_summarize`

Summarize a page, category, or the entire wiki.

```typescript
parameters: Type.Object({
  target: Type.String({ description: "Page path, category name (e.g. 'projects'), or 'all'" }),
  depth: Type.Optional(StringEnum(["brief", "detailed"] as const)),
})
```

**Execution flow:**
1. Resolve target (single page, all pages in a category, or entire wiki)
2. Read page contents
3. Generate overview prompt using wiki summary format
4. Return content + prompt as tool result
5. LLM produces summary and optionally files it as a new overview page via `wiki_write`

### 13. Commands (`commands.ts`)

Slash commands for user interaction.

#### `/wiki`

Show wiki status overview. Displays:
- Current scope (project name, source)
- Page counts by PARA category
- Last 5 log entries
- Any pending capture candidates

#### `/wiki-ingest <url-or-file>`

Quick ingest shortcut. Waits for agent idle (`ctx.waitForIdle()`), then triggers via `pi.sendUserMessage("ingest <url-or-file> into the wiki")`.

#### `/wiki-lint [--report-only]`

Run lint. By default auto-fixes all fixable issues and reports unfixable ones. With `--report-only`, just reports without fixing.

#### `/wiki-capture [topic]`

Capture knowledge from the current session into the wiki immediately. No confirmation.
- With no args: LLM analyzes the current session and writes wiki pages for anything worth capturing
- With args: capture the specified topic directly (e.g., `/wiki-capture the SSL fix we just did`)
- Note: auto-capture also runs on `session_shutdown` — this command is for mid-session capture

#### `/wiki-scope`

Show or change the current project scope. With no args: display current scope. With args: override scope for this session.

#### `/wiki-search <query>`

Quick search. Runs `wiki_query` and displays results in a TUI overlay.

#### `/wiki-summarize [target]`

Summarize a page, category, or the entire wiki. Examples:
- `/wiki-summarize` — overview of the whole wiki
- `/wiki-summarize projects` — summary of all active projects
- `/wiki-summarize projects/auth-refactor` — summary of a specific page

---

## Prompt Templates (`templates/prompts.ts`)

### Ingest Prompt

Sent as part of the tool result when the LLM processes an ingested source. Instructs the LLM to:
- Read the source content
- Identify key entities, concepts, facts, and relationships
- Decide which existing wiki pages need updates
- Create new pages for new entities/concepts using the **wiki summary format** (Topic, Key Facts, Insights, Connections, Open Questions, Sources)
- Maintain [[wikilinks]] between pages
- Update the index
- Assign appropriate PARA category, scope tags, and metadata
- Flag contradictions with existing wiki content

### Query Prompt

Sent when the LLM synthesizes an answer from wiki search results. Instructs the LLM to:
- Read the retrieved wiki pages
- Synthesize an answer with citations (page references)
- Note gaps or areas where the wiki lacks information
- If the synthesized answer adds new knowledge not already in the wiki, file it as a new page via `wiki_write` automatically

### Summarize Prompt

Sent when summarizing pages or categories. Two variants:

**Single-page/source summarization** — produces a wiki page in the standard format:
```
You are a knowledge synthesis assistant. Read the content below and produce
a structured wiki page following the EXACT format specified in the schema.
Do NOT continue any conversation. ONLY output the structured wiki page.
```
(Mirrors pi's `SUMMARIZATION_SYSTEM_PROMPT` approach but outputs wiki format instead of compaction format.)

**Iterative update** — merges new information into an existing page:
```
The content below is NEW information to incorporate into the existing wiki
page provided in <existing-page> tags. RULES:
- PRESERVE all existing knowledge from the previous page
- ADD new facts, insights, and connections
- UPDATE sections where new info supersedes old
- FLAG contradictions between old and new content in Open Questions
- PRESERVE exact names, paths, and technical details
```
(Mirrors pi's `UPDATE_SUMMARIZATION_PROMPT` approach.)

### Lint Prompt

Sent when the LLM reviews lint results. Instructs the LLM to:
- Prioritize issues by impact
- Suggest specific fixes
- Identify pages that should be archived
- Propose new pages for missing concepts

### Capture Prompt

Sent when auto-capturing from a session (on `session_shutdown` or `/wiki-capture`). The session conversation is first **serialized to text** (using pi's `[User]:`, `[Assistant]:`, `[Tool result]:` format) to prevent the LLM from treating it as a chat to continue. Instructions:
- Identify decisions, patterns, solutions, and insights
- If nothing is worth capturing, return an empty result — do not force output from trivial sessions
- Classify each piece of knowledge by PARA category autonomously
- Produce wiki pages in the standard wiki summary format
- Include the full session file path in the Sources section for traceability
- Check for existing similar pages (provided via qmd search results) and merge rather than duplicate
- The conversation may include compaction summaries from earlier in the session — treat these as authoritative records of prior work
- No user confirmation — write directly

---

## Schema Template (`templates/schema.md`)

The default `schema.md` seeded on first run. Defines:

- **Page format**: YAML frontmatter fields, markdown body conventions
- **PARA rules**: what goes where, default scope assignments
- **Wikilinks**: `[[slug]]` format, resolution rules
- **Naming**: slug conventions (lowercase, hyphens, no special chars)
- **Index format**: how index.md is structured (by category, with one-line summaries)
- **Log format**: `## [YYYY-MM-DD] operation | summary` heading format
- **Tone**: technical, concise, factual. No fluff.
- **Updates**: when to update vs. create new pages
- **Cross-referencing**: when to add [[wikilinks]], how to handle contradictions
- **Archiving**: when to move projects to archives

---

## Configuration

### Extension Settings

Extensions don't have access to pi's settings API. Configuration is stored in the wiki directory itself:

`~/.pi/wiki/config.json`:
```json
{
  "wikiDir": "~/.pi/wiki",
  "contextMaxTokens": 4000,
  "contextIncludeSchema": true,
  "contextIncludeIndex": true,
  "autoCapture": true,
  "autoCaptureTimeoutMs": 30000,
  "lintAutoFix": true,
  "lintStaleDays": 90,
  "searchLimit": 10,
  "searchIncludeArchives": false
}
```

The extension reads this file at startup. If it doesn't exist, defaults are used and the file is created on first wiki init. The config file itself is excluded from qmd indexing (not a `.md` file).

### qmd Provider Configuration

Via `~/.config/qmd/index.yml` (already supported by `@picassio/qmd`):

```yaml
providers:
  embed:
    url: https://api.openai.com/v1
    key: sk-...
    model: text-embedding-3-small
    dims: 1536
  chat:
    url: https://openrouter.ai/api/v1
    key: sk-or-...
    model: google/gemini-2.5-flash
  rerank:
    url: https://api.jina.ai/v1
    key: jina_...
    model: jina-reranker-v2-base-multilingual
```

Or via environment variables:
```bash
export QMD_EMBED_URL=https://api.openai.com/v1
export QMD_EMBED_KEY=sk-...
export QMD_EMBED_MODEL=text-embedding-3-small
```

### Project Scope Override

`.pi/wiki-scope.json` in any project:

```json
{
  "name": "pi-mono",
  "include": ["pi-mono", "typescript", "coding-agents"],
  "exclude": ["health", "travel"]
}
```

---

## Session State

The extension stores minimal state in pi's session entries:

```typescript
// Persisted via pi.appendEntry()
interface ParaSessionState {
  lastScope: ProjectScope           // scope at last context injection
  capturedInSession: string[]       // slugs already captured this session (avoid duplicates)
  sessionFile: string | null        // from ctx.sessionManager.getSessionFile(), for tracing
}
```

State is reconstructed from session entries on `session_start` (same pattern as the todo extension example).

---

## Performance Impact on Pi Session

All pi extension handlers are `await`ed sequentially in the hot path. Our extension adds latency to several events. Here's the analysis:

### Hot path: `before_agent_start` (every user prompt)

This is the critical one. It fires before every LLM call — every time the user sends a prompt.

**What we do:** `buildContext()` reads `index.md` + scope-filtered pages to inject wiki context into the system prompt.

**Cost:**
- Read `index.md` from disk: ~1ms (small file, OS-cached after first read)
- Scope filtering: in-memory string comparison, negligible
- Assembling context string: negligible
- No qmd queries, no LLM calls, no network

**Estimated latency: <5ms.** Negligible compared to the LLM call that follows (1-30 seconds).

**Optimization:** Cache the built context string. Invalidate only when `wiki_write` or `wiki_move` modifies the wiki (tracked via an in-memory dirty flag). Most `before_agent_start` calls return the cached string without touching disk.

### Hot path: `session_start` (once per session)

**What we do:**
1. Detect project scope (may shell out to `git remote get-url origin`): ~50ms
2. Open qmd store (open sqlite, sync collections): ~100-200ms first time, ~20ms subsequent (DB cached)
3. Run `store.update()` (filesystem scan for changed files): ~50-200ms depending on wiki size
4. Run `store.embed()` if stale embeddings exist: 1-30 seconds (depends on provider and # of pages)
5. Reconstruct session state from entries: negligible

**Estimated latency: 200ms-500ms** without embedding, **1-30s** with embedding.

**Mitigation:**
- Embedding at startup is a one-time cost per session. If all embeddings are current, `store.embed()` returns immediately.
- `store.update()` only scans the wiki directory (~tens of files), not the entire filesystem.
- Consider running `store.embed()` in a background `setTimeout(0)` so `session_start` returns immediately and embedding happens concurrently with the user typing their first prompt. The first `wiki_query` may use BM25-only if embeddings haven't finished yet.

### Cold path: tool execution (only when LLM calls wiki tools)

**`wiki_query`**: qmd search + scope filtering. ~50-200ms depending on search mode (BM25 fast, hybrid with rerank slower). This is within a tool call that the LLM initiated — the user is already waiting for the LLM response.

**`wiki_write`**: filesystem writes + `store.update()`. ~10-100ms. No embedding (deferred).

**`wiki_read`**: single file read. ~1ms.

**`wiki_ingest`**: URL fetch (network-bound, 100ms-5s) + file writes. The LLM is driving this, so latency is expected.

None of these block the pi session loop — they're tool executions that happen within the agent turn.

### Cold path: `session_shutdown` (once, at exit)

**What we do:**
1. Auto-capture: standalone agent with 1-3 LLM calls (3-15 seconds)
2. `store.update()` + `store.embed()`: 50ms-30s depending on how many pages were written
3. Close qmd store: ~10ms

**Estimated latency: 5-30 seconds.**

**Mitigation:**
- `autoCaptureTimeoutMs` (default 30s) caps the total time
- If embedding provider is fast (API-based via `@picassio/qmd` fork), embedding is 1-5s for typical session output
- The user has already decided to quit — they're not waiting interactively

### Summary

| Event | Frequency | Our latency | Blocks user? |
|---|---|---|---|
| `session_start` | Once | 200ms-500ms (no embed) | Yes, but only at startup |
| `before_agent_start` | Every prompt | <5ms (cached) | Negligible |
| Tool calls | When LLM calls tools | 50-200ms | No (within agent turn) |
| `session_shutdown` | Once | 5-30s | User is exiting |

**Conclusion:** The only user-visible impact is `session_start` (200-500ms added to startup). The `before_agent_start` hook is the most critical for perceived performance, and it adds <5ms with caching. Session shutdown latency is invisible to the user's interactive experience.

---

## Error Handling

- **qmd store fails to open**: warn user, disable search tools, still allow manual wiki browsing via `wiki_read`
- **No qmd providers configured**: fall back to BM25-only search (keyword, no vectors). Notify user once that hybrid search requires provider config.
- **Wiki dir doesn't exist**: auto-create on first tool call or session_start
- **Frontmatter parse errors**: log warning, treat page as having default frontmatter
- **LLM produces invalid wiki_write args**: validate and return clear error in tool result
- **Source fetch fails (URL 404, file not found)**: return error in tool result, LLM retries or reports to user
- **Embedding fails**: search still works via BM25, warn user about degraded quality

---

## Testing Strategy

### Unit Tests

- `frontmatter.test.ts`: parse/serialize roundtrip, missing fields, malformed YAML, unknown fields preserved
- `scope.test.ts`: detection from git remote, git root, dirname; config file loading; scope matching logic
- `wiki.test.ts`: init, read/write/delete pages, move between categories, index/log operations
- `lint.test.ts`: each lint check type with fixture wiki

### Integration Tests

- `ingest.test.ts`: end-to-end ingest with mock LLM responses, verify wiki state after
- `query.test.ts`: search with scope filtering, verify result ordering and filtering

### Test Infrastructure

- Use temp directories for wiki state
- Mock qmd store (or use real qmd with in-memory sqlite)
- Mock LLM calls via pi's faux provider (per AGENTS.md rules)
- Fixture wiki in `test/fixtures/sample-wiki/` with pre-populated pages across all PARA categories

---

## Implementation Order

### Phase 1: Foundation
1. `frontmatter.ts` + tests
2. `wiki.ts` + tests (filesystem operations, init, CRUD)
3. `scope.ts` + tests (project detection, matching)
4. `store.ts` (qmd integration, search with scope filtering)

### Phase 2: Core Tools
5. `tools.ts` — register `wiki_query`, `wiki_read`, `wiki_write`, `wiki_move`
6. `context.ts` — `before_agent_start` context injection
7. `commands.ts` — `/wiki`, `/wiki-search`, `/wiki-scope`
8. `index.ts` — wire everything together, lifecycle management

### Phase 3: Raw Sources + Summarization + Ingest
9. `raw.ts` + tests — raw source vault, session digests, two-collection qmd setup
10. `summarize.ts` — wiki summary format, conversation serialization, iterative summarization
11. `ingest.ts` — ingest pipeline + `wiki_ingest` tool (uses summarize, saves to raw/)
12. `templates/prompts.ts` — all LLM prompt templates
13. `templates/schema.md` — default schema

### Phase 4: Capture
14. `capture.ts` — session analysis, mid-session capture, session-to-wiki tracing, session digest
15. `/wiki-capture` command
16. `/wiki-summarize` command + `wiki_summarize` tool

### Phase 5: Lint + Polish
17. `lint.ts` + tests — all lint checks
18. `/wiki-lint` command with TUI overlay
19. Custom tool renderers (compact TUI display for wiki operations)
20. End-to-end testing with faux provider

### Phase 6: Distribution
21. `package.json` setup for pi package distribution
22. README.md with setup instructions
23. CHANGELOG.md
24. Publish as `@picassio/pi-para` on npm

---

## Open Decisions

1. **Obsidian graph view compatibility**: wikilinks use `[[slug]]` format. Obsidian resolves these by filename. Our slugs are `category/slug` (e.g., `projects/auth-refactor`). Should we use flat slugs (Obsidian-native) or path-prefixed slugs (more structured)? **Recommendation**: flat slugs with category in frontmatter, so Obsidian graph view works naturally.

2. **qmd as dependency vs. peer dependency**: if `@picassio/qmd` is a direct dependency, it pulls in `node-llama-cpp` (heavy native dep). If it's a peer dep, user must install separately. **Recommendation**: peer dependency. User installs `@picassio/qmd` globally and the extension detects it. If not available, search features are disabled but wiki CRUD still works.

3. **Multi-user/team wikis**: out of scope for v1. The wiki is a local git repo of markdown files -- teams can share via git. But conflict resolution is not handled by the extension.

4. **Max wiki size**: qmd handles indexing. The extension should be tested with 500+ pages to verify context injection stays fast. Index.md may need pagination or summarization at scale.

5. **Schema evolution**: if we change frontmatter fields in a future version, we need a migration path. **Recommendation**: version field in `schema.md`, migration function in `wiki.ts`.

---

## API Verification

Verified against pi-mono codebase (2026-04-27):

- `Agent` class from `@mariozechner/pi-agent-core` — exported, standalone, has own tool loop with `agent.prompt()` that awaits the full run
- `AgentTool` interface — `execute(toolCallId, params, signal?, onUpdate?)` returns `Promise<AgentToolResult<T>>`
- `convertToLlm()` — exported from `@mariozechner/pi-coding-agent`
- `serializeConversation()` — exported from `@mariozechner/pi-coding-agent`
- `ModelRegistry` — exported, has `getApiKeyForProvider(provider): Promise<string | undefined>`
- `ctx.model` and `ctx.modelRegistry` — accessible in event handlers, command handlers, and `session_shutdown`
- `session_shutdown` fires before `dispose()` — extension context is still active
- qmd `createStore()` inline config supports `includeByDefault` on collections
- pi's `registerTool` execute has 5 args (includes `ctx: ExtensionContext`); `AgentTool` has 4 args (no `ctx`)
