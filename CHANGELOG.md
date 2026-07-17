# Changelog

## Unreleased

## [0.6.6] — 2026-07-17

### Fixed
- Restored Pi model and persisted-auth integration on Pi 0.80.10 by replacing removed `AuthStorage`/registry factory APIs with the supported awaited `ModelRuntime`, `ModelRegistry`, and `readStoredCredential` flow.
- Restored scheduler `capture-session` registration, capture-provider settings, doctor diagnostics, and legacy CLI model selection when using persisted Pi credentials or configured pi-para secrets.
- Print and JSON one-shot sessions no longer retain delayed status callbacks that can outlive the extension context and crash with a stale-context error.

### Changed
- Pi peer compatibility now starts at `0.80.10`; development validation pins the Pi packages exactly to `0.80.10`.
- User-facing credential terminology now says “persisted Pi auth” or “Pi credential store” instead of referring to the removed public `AuthStorage` API.

### Tests
- Added behavior regressions for ModelRuntime initialization/refresh ordering, stored credential resolution, CLI selection, settings enumeration, doctor diagnostics, scheduler handler registration, and print/JSON no-background behavior.

## [0.6.5] — 2026-07-16

### Fixed
- `wiki_lint` link-sync checks now use the same Markdown protected-range logic as auto-fix, eliminating false “auto-fixable” findings inside fenced code, inline code, headings, URLs, and existing links.
- Fixed backtick parsing that could start at a closing code-fence backtick and incorrectly protect hundreds of characters of ordinary Markdown.
- Auto-fix passes now compose safely on pages with multiple issue types (for example secret redaction plus wikilinking) instead of a later stale page object overwriting an earlier fix.
- `wiki_lint` now honors configured `lint.autoFix` and `lint.staleDays`; explicit tool arguments still override auto-fix mode.
- Successful lint mutations now enqueue normal wiki/QMD maintenance so context and search indexes converge.

### Performance
- Auto-fix only runs each fixer on pages identified by its checker, and page bodies load in parallel. On the 645-page live wiki, no-op/mixed auto-fix fell from ~16.2s to ~3.6s.

## [0.6.4] — 2026-07-14

### Fixed
- Background `qmd-embed` no longer attempts embedding when no real API provider is configured (inert-shim stores are detected and skipped). Previously this produced repeated `embed error: fetch failed` noise on Linux and ~21s TCP connect hangs per attempt on Windows for provider-less installs.
- `pi-para status --json` now reports embedding state (`embedding.hasVectorIndex`, `embedding.needsEmbedding`) via a millisecond read-only probe of the QMD SQLite DB — no store open, status stays fast.

### CI/Tests
- Full Windows unit-test parity: fixed POSIX-biased tests (path splitting, permission-bit asserts, HOME-only overrides, SQLite handles held open across temp-dir cleanup, perf thresholds). The Windows CI job now runs the unit test suite as a blocking step.

## [0.6.3] — 2026-07-14

### Fixed
- `capture-session` now chains the deduplicated `qmd-embed` task after writing pages, so knowledge captured mid-session becomes vector-searchable immediately instead of waiting for the next Pi startup drain (capture reindexes BM25 inline but never embedded).

## [0.6.2] — 2026-07-14

### Added
- `/wiki-settings` gained a `[Secrets]` menu (creates `~/.pi/para/secrets.json` with 0600 permissions on first save; add/update/remove API keys with redacted listing) and preset-based provider selection for embedding/rerank profiles (OpenAI, OpenRouter, Gemini, Mistral, Voyage, Jina, Ollama — base URL/API format/default model prefilled, with inline API key entry), plus `custom` manual entry.

### Fixed
- **Embeddings were never generated automatically.** Pi startup opens the QMD store with `backgroundEmbed: false` (for fast print-mode exits) and nothing called `embedIfNeeded()` afterwards, so searches silently stayed BM25-only even with a correct remote embedding provider. A new deduplicated `qmd-embed` scheduler task (cross-process lease, gated by `qmd.embedEnabled`) now drains the `needsEmbedding` backlog at interactive session startup and is chained after every `wiki-maintenance` reindex. Provider failures are recorded and retried with backoff; BM25 keeps working regardless. Print mode is unaffected.
- `pi-para doctor` now reports vector-index availability, pending embedding count, and the active embedding provider/model/endpoint host (never credentials).

## [0.6.1] — 2026-07-14

### Removed
- **GEPA prompt optimizer removed entirely** (`pi-para gepa` CLI, `src/gepa/`, the Python/uv DSPy pipeline under `scripts/gepa/`, bundled optimized prompts, and the `gepa` config section). It added Python/uv overhead to the package for a rarely used offline workflow. Existing `gepa` keys in user config files are ignored harmlessly.

### Fixed
- **npm 0.6.0 tarball shipped without `dist/`** (the tag-triggered publish workflow ran `npm publish` on a fresh checkout without building), which broke `npx pi-para setup`, the PowerShell installer, and the `pi-para` bin on all platforms. The publish workflow now runs `npm ci` + typecheck + tests + build, packs a tarball, asserts `dist/cli.js`/`dist/index.js` exist inside it, smoke-runs `setup --yes --dry-run` from the packed tarball, and publishes that exact tarball.
- Added a `prepack` script (`npm run build`) as a second safeguard so `npm pack`/`npm publish` can never produce a dist-less artifact again.
- Documentation now uses the correct Pi command `pi install npm:pi-para` (bare `pi install pi-para` is interpreted as a local path by Pi 0.80+).

### Security
- npm publishing now runs in the `npm-publish` GitHub environment (required reviewer approval + `v*` tag deployment policy), and a repository ruleset restricts `v*` tag creation/update/deletion to repo admins.

## [0.6.0] — 2026-07-14

### Breaking
- Node.js >= 22 is now required (`engines.node`), matching the embedded qmd-engine SDK. Installers reject Node 20/21.

### Changed
- Upgraded `qmd-engine` to ^2.5.0 — `node-llama-cpp` is now an optional peer dependency upstream, so API-provider installs no longer pull the native llama.cpp toolchain.
- Upgraded `better-sqlite3` to ^12.8.0 (prebuilt binaries for current Node majors, including Node 25 on Windows).
- Wiki context is injected as a named `<system-reminder name="pi-para-wiki-context">` block with explicit wiki operating rules (search first, verify stale claims, persist decisions, prefer wiki_edit, no secrets).

### Performance
- `wiki_write` inline overhead cut from ~2.3s to ~0.6s on 500+ page wikis: single-pass parallel `rebuildIndex`, readdir-only slug scan for auto-linking, and QMD reindex deferred to the debounced background maintenance queue (same as `wiki_edit`).
- `wiki_query` self-heals stale search state: on zero results it refreshes the QMD filesystem index once and retries before reporting no matches.

### Fixed (Windows)
- `scripts/install.ps1` requires Node >= 22, invokes `npx.cmd` explicitly (bare `npx` resolves to npx.ps1 and is blocked under restricted execution policies), and propagates `$LASTEXITCODE`.
- `scripts/install.sh` minimum Node raised to 22.
- Build/clean npm scripts are cross-platform (Node-based asset copy instead of POSIX `mkdir -p`/`cp`/`rm -rf`).
- Fresh-install smoke test works on Windows (`fileURLToPath` for paths; sets both `HOME` and `USERPROFILE`).
- `pi-para doctor` no longer emits a false secrets-permission warning on Windows/NTFS.
- CI now includes a `windows-latest` job (typecheck, build, fresh-install smoke).

### Changed (docs/infra)
- Primary setup/runtime documentation now targets the no-daemon in-process scheduler architecture.
- Added cross-platform install wrappers in `scripts/install.sh` and `scripts/install.ps1`.
- Deprecated legacy daemon setup artifacts: `setup.sh` now delegates to the current setup flow, and `pi-para-daemon.service` / `DAEMON-PLAN.md` are marked legacy.
- Legacy daemon CLI commands (`start`, `stop`, `process`, `process-recent`, `retry-failed`, `history`, `legacy-status`) now print deprecation guidance toward scheduler/task commands.
- `pi-para status` now reports config/wiki/page/scheduler/QMD status instead of legacy daemon status; old daemon status moved to `pi-para legacy-status`.
- Added `pi-para status --json` and `npm run smoke:install` for fresh-install smoke validation.
- Added GitHub Actions CI for typecheck, tests, coverage, build, and fresh-install smoke validation.

## [0.5.5] — 2026-05-07

### Changed
- `wiki_edit` stays fast but now schedules debounced background maintenance to rebuild `index.md` and refresh QMD search after surgical edits.

## [0.5.4] — 2026-05-07

### Fixed
- Wiki edits no longer stage generated SQLite/search state in git auto-commits.
- New wiki directories seed a `.gitignore` for `.qmd.sqlite*`, `.daemon.sqlite*`, and GEPA scratch output.

## [0.5.3] — 2026-05-02

### Changed
- `wiki_write` is now safer: `mode=create` skips existing pages instead of overwriting them.
- Added `wiki_edit` for atomic surgical page edits with exact `oldText→newText` replacements.
- Updated prompts/tool guidance to prefer `wiki_edit` for self-healing stale pages and reserve `wiki_write mode=replace` for intentional full-page rewrites.

## [0.5.2] — 2026-05-02

### Added
- **Configurable teacher/student/judge models** for GEPA optimization
  - `gepa.studentModel`: runs proxy (default: `claude-sonnet-4`) — fast, cheap, ~460 calls/target
  - `gepa.teacherModel`: proposes mutations (default: `claude-opus-4-6`) — smart, creative, ~30 calls/target
  - `gepa.judgeModel`: scores output (default: same as student) — fast, cheap
- CLI flags: `--student-model`, `--teacher-model`, `--judge-model` (+ `--model`/`--reflection-model` shorthands)
- All GEPA settings persisted in `config.json` and overridable via CLI
- `run-all.sh` helper script for sequential target optimization with proper token refresh
- OAuth token auto-refresh in `AnthropicOAuthLM` (prevents 401 on long runs)

## [0.5.1] — 2026-05-01

### Added
- **Bundled GEPA-optimized prompts** — ship pre-optimized `capture-prompt` with the package (32.4% improvement over baseline: 0.582 → 0.770)
- `getPrompt()` resolution order: user-generated → bundled optimized → original constant
- `gepa.useOptimized` defaults to `true` so users get optimized prompts out of the box
- Build copies `src/gepa/optimized/*.txt` into `dist/gepa/optimized/` automatically

## [0.5.0] — 2026-05-01

### Added
- **GEPA prompt optimizer** — automatically optimize all pi-para prompts, tool instructions, and skill guidelines using DSPy GEPA (Genetic-Pareto optimizer)
  - 22 optimization targets: 12 prompt templates, 8 tool instructions, 2 skills
  - Runs via `uv` with custom `dspy.BaseLM` subclasses — no litellm dependency
  - Custom `AnthropicOAuthLM` with Claude Code billing headers and user-agent for free OAuth usage
  - Custom `MiniMaxLM` (Anthropic-compatible API) and `OpenRouterLM` (OpenAI-compatible API)
  - LLM-as-judge metric scoring on 6 dimensions: structure, PARA compliance, cross-references, security, completeness, actionability
  - Trainset built from real wiki pages (no synthetic data)
  - Side-by-side deployment: optimized prompts saved to `~/.pi/wiki/gepa/optimized/`, toggled via `config.gepa.useOptimized`
  - API keys extracted from `~/.pi/agent/auth.json` and passed as env vars to `uv` subprocess
  - `PromptProxy` DSPy Module: 1 LLM call per eval instead of full agent loop (10-50 calls)
  - Version history per target in `~/.pi/wiki/gepa/history/`
- **CLI commands**: `pi-para-daemon gepa optimize|list|targets|compare`
- **`getPrompt(name)`** function in `src/templates/prompts.ts` — loads GEPA-optimized version at runtime when `config.gepa.useOptimized` is true
- **`gepa` config section** in `ParaConfig` with `useOptimized` toggle

## [0.4.5] — 2026-04-30

### Fixed
- **Daemon model change now auto-restarts daemon** — changing the daemon model via `/wiki-settings` → `[Daemon]` now automatically runs `systemctl --user restart pi-para-daemon` so the new model takes effect immediately
- **qmd FK constraint fix (v2.3.2)** — `deleteInactiveDocuments` now cleans up `document_links` and `document_metadata` before deleting inactive docs, fixing the second FK violation that blocked store opening

## [0.4.4] — 2026-04-29

### Fixed
- **Lazy store retry** — if qmd store fails to open at session start (db locked, transient error), retries automatically on first tool use instead of staying disabled for the entire session
  - Store proxy intercepts calls when `storeDisabled` is true and attempts `openStore()` before throwing
  - On successful retry, marks context dirty so wiki context is rebuilt
  - Prevents guard against concurrent retry attempts

## [0.4.3] — 2026-04-29

### Added
- **Mid-session capture on compaction** — registers session for daemon capture when auto/manual compaction fires
  - Hooks into `session_compact` event — fires after context compaction
  - Compaction signals the session has accumulated enough content that details are about to be compressed
  - Perfect capture trigger: knowledge is captured before details are lost in the summary
  - Shows status line feedback: "wiki: capture queued (compaction)"
  - Works alongside existing `session_shutdown` capture — sessions now captured at both compaction and quit

### Fixed
- Skill name mismatch: `skills/setup/SKILL.md` name field changed from `pi-para-setup` to `setup` to match directory

## [0.4.2] — 2026-04-29

### Added
- **Configurable graph-boosted search** — `searchGraphBoost` setting in `config.json`
  - Previously hardcoded to `true` in `store.ts`
  - Now controllable via `/wiki-settings` → `[Search]` → `Graph boost: true/false`
  - Threads through the full pipeline: `config` → `registerTools` → `createQueryExecute` → `queryWiki` → `searchWiki` → `store.searchLex`
  - `WikiSearchOptions.graphBoost` and `QueryOptions.graphBoost` added to public interfaces
  - Default remains `true` (1-hop wikilink expansion after BM25 search)
- `/wiki-settings` `[Search]` now opens a submenu with `Limit` and `Graph boost` options

### Changed
- README updated: 8 tools (added `wiki_migrate`), 11 commands (added `/wiki-migrate`, `/wiki-project`), `searchGraphBoost` in config example, 301 tests

## [0.4.1] — 2026-04-29

### Added
- Web UI graph: scope filter dropdown + max nodes slider

## [0.4.0] — 2026-04-29

### Added
- **Schema versioning & migration** — future-proof wiki format evolution
  - `schemaVersion` integer field in frontmatter (defaults to 1 for existing pages)
  - Migration registry in `frontmatter.ts` — chain of `from→to` transforms
  - `migrateToLatest()` applies all pending migrations sequentially
  - `wiki_migrate` tool (LLM-callable) for batch migration
  - `/wiki-migrate` command — migrates all pages, reports count
  - Lint check #15: `schema-version` — flags pages below current version, auto-fixes
- **qmd graph-boosted search** (requires @picassio/qmd 2.3.0)
  - `document_links` edge table tracks `[[wikilinks]]` between pages
  - 1-hop graph expansion after BM25 search — surfaces wikilink-connected pages
  - `graphBoost: true` in `searchWiki()` — related pages appear in results even without text match
  - `extractWikilinks()` exported from qmd for reuse
- **Scale resilience** — tested for 500+ page wikis
  - Code-generated `index.md` via `rebuildIndex()` — deterministic, no LLM generation needed
  - Tiered context injection — max 40 scope-filtered pages in system prompt, rest via `wiki_query`
  - Page summary cache in SQLite — `buildContext()` reads cache instead of N disk reads
  - Web UI pagination — `?page=N&limit=50` on `/api/pages`, `?maxNodes=100` on graph endpoint
- **PARA project lifecycle**
  - `/wiki-project <name> <goal>` — creates structured project page with goal, status checklist, end condition
  - `/wiki-project done <name>` — archives completed project
  - Maintenance agent reviews projects for completion signals, suggests archiving
  - Maintenance agent updates areas with latest health metrics
- **PARA active skill** (`skills/para/SKILL.md`)
  - Behavioral guidelines for actively using wiki during work (not just passive capture)
  - Covers: consult before planning, write during work, search when debugging, check conventions when reviewing
  - PARA category decision guide — when to use projects/ vs areas/ vs resources/

### Changed
- `wiki_write` no longer accepts `indexContent` — index is auto-rebuilt from disk after every write
- `wiki_move` auto-rebuilds index after moving pages
- Capture and ingest prompts no longer instruct LLM to generate index
- Context injection sorts pages by recency, caps at 40 pages with overflow note

### Dependencies
- Requires @picassio/qmd ≥2.3.0 (graph boost support)

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
