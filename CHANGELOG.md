# Changelog

## [0.3.2] — 2026-04-29

### Added
- **Wiki freshness verification system** — prevents LLM from blindly trusting stale wiki content
  - `formatFreshness()` in `query.ts` computes age-based freshness tiers for every page
  - 5 tiers: ✅ FRESH (<7d), ✅ Recent (7-14d), ⚠️ AGING (14-30d), ⚠️ STALE (30-90d), 🚨 VERY STALE (>90d)
  - `wiki_query` results now include `Updated: ... | ⚠️ STALE — 45 days old` per result
  - `wiki_read` output includes freshness indicator in header line
  - `QUERY_PROMPT` gains "FRESHNESS VERIFICATION (critical)" section with 5 verification rules
  - `wiki_query` and `wiki_read` `promptGuidelines` instruct LLM to verify AGING/STALE pages
  - Context injection adds system prompt reminder about the self-healing loop
  - Maintenance agent gains task #6: staleness review for pages >30 days old making code/config claims
  - `INGEST_PROMPT` gains rule #9: check existing Key Facts accuracy when updating pages
- **Self-healing loop** — when LLM discovers wiki content is wrong during verification, it fixes the page immediately with `wiki_write(mode: 'edit')`, so future queries get correct answers

## [0.3.0] — 2026-04-28

### Added
- **Web Wiki UI** — React SPA served by daemon at configurable port
  - Design system: Inter font, 4px grid, semantic color tokens, dark/light toggle
  - Full accessibility: ARIA labels, focus rings, keyboard nav, skip links, reduced motion
  - 18 Lucide-style SVG icons (replaced all emojis)
  - Scope filter dropdown, debounced search, loading states, toast notifications
  - D3 force graph with legend (full-width), breadcrumbs, card-based layouts
  - Graph view: `main-wide` class for full-width display
- **Secret redaction** (`redact.ts`) — strips API keys, tokens, passwords from all wiki writes
  - 14 pattern types (OpenRouter, OpenAI, Anthropic, MiniMax, GitHub, AWS, Jina, Bearer, YAML, env vars)
  - Runs on every write path: tools.ts, processor.ts, webui server, lint auto-fix
- **Shared link utilities** (`link-utils.ts`) — centralized `extractWikilinks`, `autoLinkSlugs`, `syncFrontmatterLinks`
  - Replaces 4 duplicate implementations across codebase
  - Protected regions: fenced code, inline code, URLs, headings
  - Longest-slug-first matching, first-occurrence-only linking
- **Tag registry** (`tag-registry.ts`) — canonical tag normalization + scope validation
  - Alias mapping (capture→session-capture, para→pi-para, etc.)
  - Removes scope-tag duplicates, enforces kebab-case
  - Scope normalization: project-agnostic, extracts kebab prefix from multi-word scopes
- **LLM maintenance agent** (`maintainer.ts`) — replaces code-based maintenance
  - Runs every 30 min via daemon with wiki_list, wiki_read, wiki_query, wiki_write, wiki_merge, wiki_lint tools
  - Intelligent duplicate detection & merging, link discovery, category review, tag cleanup
- **Git auto-commit** (`wiki.ts`) — every wiki mutation committed with descriptive message
  - Auto-initializes git repo in wiki directory
  - Commit points: wiki_write, wiki_move, daemon capture, maintenance, webui PUT
- **Edit mode** for `wiki_write` — surgical `oldText→newText` replacements (like pi's edit tool)
- **Lint checks 11-14**: link-sync, tag-health, secrets, category-misuse
- **Scope filter** in web UI — dropdown to filter pages by project scope
- **`/wiki-daemon status`** — reads state DB directly (instant, no subprocess)
- **`/wiki-settings`** — provider/model picker from pi's auth storage

### Changed
- **Web server moved to daemon** — eliminates port conflicts between pi sessions
  - Extension just checks if daemon server is running, shows URL in status bar
- **`/wiki-capture`** — queues to daemon for background processing (non-blocking)
- **Daemon uses pi's auth.json** — OAuth token refresh for Anthropic, configurable model via `/wiki-settings`
- **Daemon scope detection** — reads session header first, falls back to `projects-` prefix extraction (fixes `agent-board` → `board` bug)
- **Capture prompts** — stronger dedup guidance ("search wiki_query FIRST, update existing pages")
- **PARA category prompts** — "resources/ for almost everything" across all prompt layers
- **Schema.md** — expanded with category decision rules, scope/tag format rules, ✅/❌ examples, secrets policy
- **systemd service** — `bash -lc` login shell (works with mise, nvm, fnm, volta, system node)

### Fixed
- 2 wiki pages contained live API keys — redacted
- 38 pages had empty `links: []` — bulk fix added wikilinks
- 9 tags had spaces — normalized to kebab-case
- 26 scope-tag duplicates — removed
- 14 multi-word scope values — cleaned (LLM wrote topic descriptions as scope)
- 11 pages in projects/ were reference docs — moved to resources/
- Duplicate pages merged (pi-para-web-wiki-ui, pi-para-extension-architecture, etc.)
- Graph view confined to 860px — now full-width
- Scroll container nesting — separated `.main-scroll` from `.main`

## [0.2.0] — 2026-04-27

### Added
- Web wiki UI — server + React SPA client
- Daemon (`pi-para-daemon`) for background session capture
- Interactive `/wiki-settings` with nested menus
- Configurable via `~/.pi/wiki/config.json`

## [0.1.0] — 2026-04-06

### Added
- PARA-structured wiki at `~/.pi/wiki/`
- 7 LLM tools: `wiki_ingest`, `wiki_query`, `wiki_write`, `wiki_read`, `wiki_move`, `wiki_lint`, `wiki_summarize`
- 7 slash commands: `/wiki`, `/wiki-ingest`, `/wiki-lint`, `/wiki-capture`, `/wiki-scope`, `/wiki-search`, `/wiki-summarize`
- Auto-capture on session shutdown
- Project scope detection
- Context injection with caching
- 10 lint checks with auto-fix
- Hybrid search via `@picassio/qmd`
