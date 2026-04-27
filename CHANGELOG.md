# Changelog

## [Unreleased]

### Added

- PARA-structured wiki at `~/.pi/wiki/` (Projects, Areas, Resources, Archives)
- 7 LLM tools: `wiki_ingest`, `wiki_query`, `wiki_write`, `wiki_read`, `wiki_move`, `wiki_lint`, `wiki_summarize`
- 7 slash commands: `/wiki`, `/wiki-ingest`, `/wiki-lint`, `/wiki-capture`, `/wiki-scope`, `/wiki-search`, `/wiki-summarize`
- Auto-capture on session shutdown via standalone Agent from `@mariozechner/pi-agent-core`
- Mid-session capture via `/wiki-capture`
- Project scope detection (git remote, git root, dirname, `.pi/wiki-scope.json`)
- Context injection via `before_agent_start` with caching and dirty-flag invalidation
- Raw source vault (`~/.pi/wiki/raw/`) for ingested URLs and files
- Session digest log (`sessions.md`) for session-to-wiki traceability
- 10 lint checks with auto-fix (orphan pages, broken links, stale pages, scope drift, archive candidates, missing pages, empty categories, frontmatter issues, index drift, duplicate slugs)
- Wiki summary format adapted from pi's compaction system
- Hybrid search via `@picassio/qmd` (BM25 + vector + rerank) with scope filtering
- Deferred embedding strategy (BM25 immediate, vectors at startup/shutdown)
- Custom TUI renderers for all wiki tools
- Configurable via `~/.pi/wiki/config.json`
