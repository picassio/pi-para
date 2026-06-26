# pi-para Architecture

pi-para is a Pi extension that maintains a PARA markdown wiki with scoped search, context injection, safe mutation tools, and scheduler-backed background capture.

## High-level runtime

```text
Pi process
  └─ pi-para extension
      ├─ wiki filesystem (~/.pi/wiki)
      ├─ QMD SDK store (.qmd.sqlite)
      ├─ in-process scheduler (.pi-para.sqlite)
      ├─ tools + slash commands
      ├─ context injection
      └─ optional WebWiki UI
```

No separate OS daemon is required. The scheduler runs while Pi is open and catches up on the next startup if Pi was closed.

## Startup flow

```text
Pi starts
  -> pi-para loads ~/.pi/para/config.jsonc
  -> migrates legacy ~/.pi/wiki/config.json if needed
  -> registers tools and slash commands
  -> session_start
       -> initWiki(wikiDir)
       -> open QMD SDK store
       -> detect/restore project scope
       -> register capture handler if model/auth is available
       -> start scheduler
       -> enqueue completed-session catch-up
```

Failures in optional background systems are fail-open: Pi startup and foreground wiki tools should keep working whenever possible.

## Wiki filesystem

The wiki is durable markdown:

```text
~/.pi/wiki/
├── schema.md
├── index.md
├── log.md
├── sessions.md
├── projects/
├── areas/
├── resources/
├── archives/
├── raw/
├── .completed-sessions
├── .pi-para.sqlite
└── .qmd.sqlite
```

Generated SQLite files are ignored by git. Durable markdown, raw source markdown, and logs are the important user data.

## QMD SDK

`src/store.ts` opens QMD via `qmd-engine` SDK with inline collection config. It indexes:

- `wiki`: all markdown except `raw/**`,
- `raw`: source material, excluded from default query results.

Provider config precedence:

1. pi-para provider profiles from `~/.pi/para/config.jsonc`,
2. legacy `~/.config/qmd/index.yml` only when explicit compatibility mode is used,
3. an inert API provider shim when no provider is configured.

pi-para never uses QMD local/node-llama-cpp LLM defaults. BM25 search works without calling an LLM; accidental vector/chat calls without a configured API provider fail fast instead of downloading/building local models.

Global `qmd` CLI is optional for debugging and not part of normal runtime.

## Scheduler

`src/scheduler/` implements durable background work:

- queue/history tables,
- SQLite leases,
- bounded retries,
- periodic ticks,
- task handlers.

Initial tasks include:

- `wiki-maintenance`,
- `capture-session`.

The scheduler is process-local but coordinates via SQLite so multiple Pi processes do not process the same task concurrently.

## Capture flow

```text
session_compact/session_shutdown/manual capture
  -> append .completed-sessions entry
  -> enqueue capture-session task if scheduler is available
  -> scheduler handler runs createCaptureSessionHandler
  -> capture agent reads session file and uses wiki tools
  -> StateDB records processed session/history
```

Capture model selection uses `config.models.capture` and credential refs. If no model/auth is available, capture handler registration is skipped; queued entries remain for a later session.

## Config model

Canonical config:

```text
~/.pi/para/config.jsonc
```

The runtime still converts to a small legacy-compatible shape internally in some modules. New code should depend on `ParaUserConfig` from `src/config.ts` where possible.

Credential refs never store secret values in config:

```text
pi-auth:<provider>
secret:<name>
none
```

## Tool safety and guidance

Mutation tools are intentionally split:

- `wiki_edit`: atomic exact text replacements for existing pages.
- `wiki_write mode=create`: creates only, skips existing pages.
- `wiki_write mode=replace`: explicit full-page replacement.

This avoids accidental destructive rewrites from broad LLM edits.

Tool API contracts and behavioral guidance are separated:

- `src/wiki-tool-guidance.ts`: canonical tool descriptions, prompt snippets, per-tool guidelines, and shared wiki behavior guidance.
- `src/tools.ts`: host registration, schemas, rendering, and execution only.
- `src/context.ts`: injects the shared guidance once with wiki context so agents learn when to search, verify stale pages, and self-heal with `wiki_edit`.

## GEPA optimizer

GEPA lives in two layers:

- `src/gepa/index.ts`: TypeScript target extraction/orchestration and CLI.
- `scripts/gepa/`: Python/uv DSPy program, metric, dataset, custom LMs.

It uses DSPy GEPA, not a custom TypeScript optimizer, and uses custom `dspy.BaseLM` providers for Anthropic OAuth/MiniMax/OpenRouter.

## Compatibility surfaces

Kept temporarily:

- `pi-para-daemon` binary alias,
- `/wiki-daemon` slash command alias,
- legacy daemon CLI subcommands,
- legacy config migration from `~/.pi/wiki/config.json`,
- legacy QMD YAML provider fallback.

Primary docs and setup should point users to `pi-para`, `/wiki-scheduler`, and `~/.pi/para/config.jsonc`.
