# pi-para v0.4.0 Roadmap

**Goal**: Harden pi-para for long-term growth — schema evolution, scale resilience, smarter search, and using PARA properly.

**Target**: When features are done (no artificial deadline — this is a `resources/` project until we define an end date).

---

## Current State (v0.3.2, 2026-04-29)

- 62 wiki pages (all in `resources/` and `archives/`)
- 9,647 lines of TypeScript across 28 source files
- 265 tests passing
- Daemon running: session capture, LLM maintenance (30 min cycle), web UI
- qmd v2.2.0: BM25 + vector + frontmatter metadata filtering (Phase A)
- Self-healing freshness verification system
- Zero `projects/` or `areas/` pages (by design — nothing misclassified)

---

## Phase 0: PARA Active Skill ✅ (done)

**Problem**: Agents only interact with the wiki passively — context is injected at session start, and knowledge is captured at session end. There's no instruction for agents to actively consult the wiki before planning, write decisions as they happen, search for past solutions when debugging, or check conventions when reviewing.

**Solution**: `skills/para/SKILL.md` — behavioral guidelines (like karpathy-guidelines) that teach agents to use the wiki as a working tool, not just a record.

**Covers**:
1. **Before work** — `wiki_query` for existing knowledge before starting any non-trivial task
2. **During work** — `wiki_write` decisions and insights immediately, not deferred to session end
3. **When debugging** — search wiki for past solutions before deep-diving
4. **When reviewing** — check wiki for conventions and architecture decisions

Registered in `package.json` → `pi.skills`, auto-discovered by pi's skill system.

---

## Phase 1: Schema Versioning & Migration (foundation for everything else)

**Problem**: No version field in frontmatter or schema.md. If we add/rename/remove fields, existing pages silently break. `validateFrontmatter()` silently fills defaults — no way to know if a page is v1 or v2 format.

**Changes**:

### 1.1 Add `schemaVersion` to frontmatter
```yaml
---
title: Example Page
para: resources
schemaVersion: 2          # NEW — integer, monotonically increasing
scope: [pi-para]
tags: [architecture]
# ... rest unchanged
---
```

- `validateFrontmatter()` reads `schemaVersion`, defaults to `1` if missing (all existing pages)
- `serializeFrontmatter()` always writes the current schema version
- No breaking change — version 1 = current format

### 1.2 Migration registry in `frontmatter.ts`
```typescript
interface Migration {
  from: number;
  to: number;
  migrate: (fm: Record<string, unknown>, body: string) => { fm: Record<string, unknown>; body: string };
  description: string;
}

const MIGRATIONS: Migration[] = [
  // Example future migration:
  // { from: 1, to: 2, migrate: (fm) => { fm.visibility = fm.visibility ?? "public"; return fm; }, description: "Add visibility field" }
];
```

### 1.3 `wiki migrate` command and lint check
- New lint check #15: `schema-version` — flags pages below current schema version
- `wiki_migrate` tool (LLM-callable): runs all pending migrations on matching pages
- `/wiki-migrate` slash command: batch-migrate all pages to current version
- Auto-migrate on read: `readPage()` applies pending migrations in memory (lazy), writes back on next `writePage()`

### 1.4 Version field in `schema.md`
```markdown
## Schema Version: 2
Last updated: 2026-XX-XX
Migration guide: run `/wiki-migrate` after updating pi-para.
```

**Tests**: migration roundtrip, skip-version chains (1→3 via 1→2→3), idempotency, unknown-version handling.

**Estimated effort**: ~200 lines + tests. Low risk — additive only.

---

## Phase 2: qmd Graph Boosting (Phase B)

**Problem**: Search only returns pages matching the query text/embedding. Related pages connected via wikilinks are invisible unless they happen to also match. For a 62+ page wiki with rich cross-references, this is leaving recall on the table.

**Design** (from [[qmd-frontmatter-graph-enhancement]]):

### 2.1 `document_links` edge table in qmd
```sql
CREATE TABLE IF NOT EXISTS document_links (
  source_path TEXT NOT NULL,     -- page that contains the [[wikilink]]
  target_slug TEXT NOT NULL,     -- slug being linked to
  UNIQUE(source_path, target_slug)
);
```

- Populated during `store.update()` — extract `[[slug]]` from markdown body
- Updated incrementally (delete old links for changed files, insert new)

### 2.2 Graph-boosted reranking
After normal search returns top-K results:
1. Collect all wikilink targets from top results (1-hop expansion)
2. Look up those pages in the index
3. Score expansion candidates: `expansion_score = base_relevance * 0.3 + link_weight`
4. `link_weight` = number of top-K pages linking to this candidate / total top-K count
5. Merge expansion candidates into results, below direct matches but above the relevance floor
6. Configurable: `graphBoost: boolean` in search options (default true for wiki collection)

### 2.3 pi-para integration
- `searchWiki()` in `store.ts` passes `graphBoost: true` by default
- Web UI graph view benefits — linked pages appear in search even without text match
- Maintenance agent's link discovery benefits — can now find semantically related pages via search expansion

**Where this is built**: In `@picassio/qmd` package (the fork), not in pi-para.

**Estimated effort**: ~300 lines in qmd + ~30 lines in pi-para store.ts. Medium risk — touches search ranking.

**Tests**: graph expansion with known link topology, score ordering, no expansion when `graphBoost: false`.

---

## Phase 3: Scale Resilience (100→500+ pages)

**Problem**: At 62 pages, everything is fast. At 500+, three things break:
1. `index.md` grows linearly — context injection bloats
2. `listPages()` + `readPage()` loop in `context.ts` reads every page from disk every dirty rebuild
3. Web UI loads all pages upfront for graph view

### 3.1 Tiered index injection
Replace flat `index.md` injection with a two-tier strategy:

**Tier 1 — Always injected** (token-budgeted):
- Scope-filtered page titles + one-line summaries (current behavior, but capped)
- Max 40 pages in context (configurable). If more exist, show top-40 by recency within scope.

**Tier 2 — On-demand** (via wiki_query):
- Full index only returned when LLM calls `wiki_query` or `wiki_summarize`
- Prompt guidance: "If you need pages beyond the injected context, use wiki_query"

### 3.2 Page summary cache
Instead of reading every page from disk on context rebuild:
- SQLite cache table in `.daemon.sqlite`: `page_summaries(slug, category, scope_json, tags_json, first_paragraph, updated_at)`
- Populated by `writePage()` and `processor.ts` on every write
- `buildContext()` reads from cache (single SQL query) instead of N filesystem reads
- Invalidated per-page on write (not full rebuild)

**Perf target**: `buildContext()` stays <10ms at 500 pages (currently <5ms at 62).

### 3.3 Web UI pagination + virtual scroll
- Page list: paginate at 50 per page, virtual scroll for long lists
- Graph view: render only visible nodes + 1-hop neighbors, lazy-load rest
- Search: already paginated via qmd, no change needed

### 3.4 Index.md generation optimization
Currently the LLM regenerates the full `index.md` on every `wiki_write`. At 500+ pages, this means generating a 500-line document every write.

- Switch to **code-generated index**: `rebuildIndex()` function reads all pages from disk/cache, generates index deterministically
- Remove index generation from the LLM's responsibilities
- Index is rebuilt after every write (fast — template + sort)
- LLM still decides page content, PARA category, scope, etc. — just not the index

**Estimated effort**: ~400 lines + tests. Medium risk — changes context injection behavior.

---

## Phase 4: Use PARA Properly

**Problem**: `projects/` and `areas/` are empty. This is technically correct (no misclassification), but it also means PARA is being used as "R + A" (Resources + Archives). The P and A categories add real value when used.

### 4.1 Define what belongs in `projects/`
A project is a **discrete deliverable with an end condition**. Examples for pi-para:

| Project | End Condition | Status |
|---------|--------------|--------|
| `pi-para-v040-release` | All 4 phases shipped, CHANGELOG updated | Active |
| `qmd-graph-boost` | Phase B merged, tests passing | Active |

The project page tracks: goal, milestones, current status, blockers, completion criteria.

### 4.2 Define what belongs in `areas/`
An area is an **ongoing responsibility with standards**. Examples:

| Area | Standard |
|------|----------|
| `wiki-data-quality` | No stale pages >90 days, no broken links, no category misuse |
| `search-quality` | Relevant results in top-3 for common queries, <200ms p95 latency |

The area page tracks: what it covers, quality bar, how to check, recent health.

### 4.3 Teach the maintenance agent
Update maintainer.ts prompts to:
- Create a `projects/` page when someone defines a goal with an end date
- Create an `areas/` page when a repeating responsibility is identified
- Move completed projects to archives when their end condition is met
- Update area pages with latest health metrics during maintenance cycles

### 4.4 Project lifecycle commands
- `/wiki-project <name> <goal>` — create a project with end condition
- `/wiki-project done <name>` — archive a completed project
- These are convenience wrappers around `wiki_write` + `wiki_move`

**Estimated effort**: ~150 lines + prompt changes. Low risk — additive.

---

## Implementation Order

```
Phase 0 (PARA Skill) ✅
         ↓
Phase 1 (Schema) ──→ Phase 3.4 (Code-gen index) ──→ Phase 3.1-3.3 (Scale)
                  ↘                                ↗
                   Phase 2 (Graph Boost in qmd)
                  ↘
                   Phase 4 (PARA proper) ← can start immediately
```

- **Phase 0** done: PARA active skill created and registered
- **Phase 1** first: every other phase may add frontmatter fields, needs migration path
- **Phase 2** in parallel: lives in qmd repo, independent of pi-para schema
- **Phase 3.4** after Phase 1: code-gen index removes LLM bottleneck before scaling
- **Phase 3.1-3.3** after 3.4: context tier + cache + web UI pagination
- **Phase 4** anytime: no code dependency on other phases, mostly prompt + convention changes

---

## Out of Scope (v0.5+)

- **Multi-user / team wikis** — git-based sharing with conflict resolution
- **Obsidian plugin** — bidirectional sync between Obsidian and pi-para
- **Cross-wiki federation** — link pages across different wiki instances
- **Page templates** — predefined structures for common page types (ADR, runbook, post-mortem)
- **Analytics dashboard** — wiki growth, query patterns, capture rates, knowledge gaps

---

## Success Criteria

| Metric | Current (v0.3.2) | Target (v0.4.0) |
|--------|-------------------|-------------------|
| PARA active skill | None | Installed ✅ |
| Pages without version | 62 | 0 (all migrated) |
| Search recall (linked pages surfaced) | Low | High (graph boost) |
| Context rebuild at 500 pages | Untested | <10ms |
| `projects/` pages | 0 | ≥1 (this roadmap!) |
| `areas/` pages | 0 | ≥1 (wiki-data-quality) |
| Schema migrations runnable | No | Yes |
