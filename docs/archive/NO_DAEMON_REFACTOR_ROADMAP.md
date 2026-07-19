# pi-para No-Daemon Cross-Platform Refactor Roadmap

## Goal

Refactor pi-para from a Linux-oriented external daemon model to a Magic Context-style, in-process, cross-platform scheduler that runs inside the Pi extension process. Normal install and operation must work on Linux, macOS, and Windows without `systemd`, global `qmd`, shell shims, or a separately managed background service.

## Non-goals

- Do not remove wiki capture or maintenance behavior.
- Do not require users to run a persistent OS service.
- Do not require global QMD CLI installation.
- Do not break existing wiki data in `~/.pi/wiki`.
- Do not block foreground tool calls on slow maintenance/indexing work.

## Architecture decisions

1. **No required daemon**: `pi-para-daemon start` is deprecated as the primary runtime.
2. **In-process scheduler**: Pi extension startup registers a singleton scheduler per process.
3. **Durable coordination**: scheduler state and leases live in SQLite under the wiki directory.
4. **Startup catch-up**: if Pi was not running, the next Pi session scans queued/completed sessions and catches up.
5. **QMD SDK only**: pi-para uses `qmd-engine`/QMD SDK programmatically; QMD CLI is optional debugging only.
6. **Setup/doctor are first-class**: `pi-para setup` and `pi-para doctor` replace README-driven installation.
7. **Compatibility first**: keep old registry files and daemon CLI aliases during migration, but mark them deprecated.

## Target runtime shape

```text
Pi starts
  -> pi-para extension loads
  -> initWiki(wikiDir)
  -> open QMD SDK store lazily/safely
  -> startWikiScheduler({ wikiDir, storeProvider, status callbacks })
  -> scheduler startup tick
       -> acquire leases
       -> process queued session captures
       -> refresh stale search/index state
       -> run due maintenance tasks
  -> tools/commands enqueue scheduler tasks after mutations
Pi session compacts/shuts down
  -> append durable capture queue entry
  -> if process is alive, enqueue immediate capture attempt
  -> close store on shutdown
```

## Proposed files

### New

- `src/scheduler/index.ts` — public scheduler API and singleton lifecycle.
- `src/scheduler/tasks.ts` — task registry and task definitions.
- `src/scheduler/state.ts` — task state, queue, history, schema migrations.
- `src/scheduler/leases.ts` — SQLite lease acquire/renew/release helpers.
- `src/scheduler/session-capture.ts` — queued session capture task wrapper.
- `src/scheduler/qmd-maintenance.ts` — QMD update/embed/index tasks.
- `src/config.ts` — JSONC config loading/migration/schema.
- `src/doctor.ts` — install/runtime diagnostics.
- `src/setup.ts` — interactive/idempotent setup.
- `src/paths.ts` — cross-platform paths.
- `src/cli.ts` — migrate from daemon-only CLI to `pi-para` CLI commands.
- `scripts/install.sh` — optional POSIX one-liner setup wrapper.
- `scripts/install.ps1` — optional Windows PowerShell setup wrapper.
- `ARCHITECTURE.md`, `STRUCTURE.md`, `CONFIGURATION.md`.

### Changed

- `src/index.ts` — start scheduler on extension load/session start; stop on shutdown/dispose if available.
- `src/tools.ts` — replace ad hoc `scheduleWikiMaintenance()` with scheduler enqueue calls.
- `src/wiki.ts` — keep safe mutation primitives; no daemon assumptions.
- `src/store.ts` — keep QMD SDK usage; expose health/version helpers; avoid CLI assumptions.
- `src/commands.ts` — remove `qmd --version` shellout; add scheduler/task status.
- `package.json` — add `pi-para` bin; keep `pi-para-daemon` as deprecated alias temporarily.
- `README.md`, `SETUP.md`, `CHANGELOG.md` — update install/runtime model.
- `setup.sh`, `pi-para-daemon.service`, `DAEMON-PLAN.md` — deprecate or move to legacy docs.

## State schema

Use a renamed state DB for new code:

```text
~/.pi/wiki/.pi-para.sqlite
```

Keep reading old `.daemon.sqlite` for migration.

### Tables

```sql
create table if not exists scheduler_tasks (
  task_key text primary key,
  task_name text not null,
  scope text,
  schedule text,
  next_due_at text,
  last_run_at text,
  last_status text,
  retry_count integer not null default 0,
  updated_at text not null
);

create table if not exists scheduler_queue (
  id integer primary key autoincrement,
  task_name text not null,
  payload_json text not null,
  priority integer not null default 0,
  available_at text not null,
  dedupe_key text,
  status text not null default 'queued',
  attempts integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create unique index if not exists scheduler_queue_dedupe
  on scheduler_queue(dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

create table if not exists scheduler_leases (
  lease_key text primary key,
  holder_id text not null,
  expires_at text not null,
  heartbeat_at text not null,
  metadata_json text
);

create table if not exists scheduler_history (
  id integer primary key autoincrement,
  task_name text not null,
  payload_json text,
  status text not null,
  started_at text not null,
  finished_at text,
  duration_ms integer,
  error text
);
```

## Task registry

Initial tasks:

| Task | Trigger | Lease/conflict domain | Purpose |
|---|---|---|---|
| `capture-queued-sessions` | startup, every 5m, compact/shutdown enqueue | `capture` | Process `.completed-sessions` and queued session files. |
| `capture-current-session` | session compact, manual command | `capture:<session>` | Capture one active/session file immediately when safe. |
| `rebuild-index` | debounced after wiki mutation | `index` | Rebuild `index.md` and backlinks/autolinks where needed. |
| `qmd-update` | debounced after mutation, startup if stale | `qmd` | Run `store.update()` via SDK. |
| `qmd-embed` | low-priority after `qmd-update` | `qmd-embed` | Run embeddings in background; failures non-fatal. |
| `git-commit` | after durable content changes | `git` | Commit markdown/wiki durable files only, never generated SQLite. |
| `wiki-lint` | manual, daily/weekly optional | `lint` | Run health checks and safe autofixes. |
| `link-discovery` | manual/weekly | `links` | Discover/repair wikilinks. |
| `doctor-check` | manual | none/diagnostic only | Validate installation/runtime state. |

## Scheduler behavior

- One scheduler per process; multiple processes coordinate via SQLite leases.
- Startup tick runs quickly and never blocks Pi startup for more than a small budget.
- Long tasks run asynchronously and update UI status opportunistically.
- Tasks acquire leases with `BEGIN IMMEDIATE` before durable mutation.
- Leases have holder ID, expiry, heartbeat, and best-effort release.
- Transient failures retry with bounded backoff.
- Foreground tools enqueue maintenance and return immediately unless their own write failed.
- Scheduler timers are `unref()` where available so they do not keep Node alive.

## Capture model without daemon

1. Preserve `.completed-sessions` as a durable compatibility queue.
2. On `session_compact`, append registry entry and enqueue `capture-current-session`.
3. On `session_shutdown`, append registry entry; do not do expensive LLM work during shutdown.
4. On next Pi startup, `capture-queued-sessions` scans registry + session history and processes unprocessed sessions.
5. Add `pi-para capture-recent --hours <n>` as explicit catch-up.
6. Add doctor warning when queued sessions are older than a threshold.

## QMD SDK plan

- Runtime search/indexing remains SDK-only through `src/store.ts`.
- Remove shellout to `qmd --version` from `/wiki status`.
- Add `getQmdHealth(store)` helper using SDK/package metadata and small test query/update.
- README must say global QMD CLI is not required.
- `doctor` validates SDK import, DB open, `store.update()`, and search behavior.
- Keep reading `~/.config/qmd/index.yml` only as backward-compatible provider config.
- Introduce pi-para JSONC config and migrate/breadcrumb old config.

## CLI plan

New primary binary:

```bash
pi-para setup
pi-para doctor
pi-para doctor --fix
pi-para doctor --issue
pi-para status
pi-para tasks
pi-para maintain
pi-para capture-recent --hours 24
pi-para gepa optimize ...
```

Temporary compatibility:

```bash
pi-para-daemon status   # prints deprecation notice and delegates to pi-para status
pi-para-daemon start    # deprecated; either no-op guidance or legacy foreground mode behind flag
pi-para-daemon stop     # deprecated; only stops legacy PID if present
```

## Setup plan

`pi-para setup` should be idempotent and OS-neutral:

1. Detect Pi config path.
2. Detect existing pi-para extension registration.
3. Register npm or local extension path.
4. Initialize wiki directories.
5. Write/migrate config.
6. Validate QMD SDK store opens.
7. Run a minimal write/read/query smoke test.
8. Print restart instructions for Pi sessions.
9. Never install `systemd` service by default.

## Doctor checks

- package version and install source.
- Pi extension registration.
- wiki directory exists and has valid PARA structure.
- config parse/schema/migration status.
- QMD SDK import/open/update/search.
- generated SQLite files are ignored by git.
- wiki git status and object bloat warning.
- scheduler DB schema and lease sanity.
- queued session backlog.
- stale failed captures.
- provider/auth availability without printing secrets.
- Windows path/PATH/shim warnings.
- optional sanitized issue bundle.

## Test plan

### Unit tests

- scheduler task registry ordering/dedupe.
- lease acquire/release/expiry races.
- queue dedupe and retry transitions.
- config migration.
- QMD health wrapper with mocked SDK.
- old daemon CLI alias deprecation behavior.

### Integration tests

- fresh temp wiki init.
- write page -> enqueue maintenance -> index rebuilt -> search finds page.
- edit page -> no full destructive rewrite -> QMD refresh eventually runs.
- completed session registry -> capture task claims and marks processed.
- two scheduler instances -> one lease winner.

### Smoke tests

- `npm pack` + install into temp project.
- `pi-para setup --yes`.
- `pi-para doctor` clean.
- Pi extension load test if harness supports it.
- Windows-like path with spaces.

## Rollout phases

### Phase 0 — Stabilize current branch

- Ensure current tests/typecheck pass.
- Publish current fixes once npm auth is fixed.
- Document no-daemon decision in README/CHANGELOG draft.

Exit criteria:

- `npm run check` passes.
- Current package can still load in Pi.

### Phase 1 — CLI rename and compatibility shell

- Add `pi-para` bin while keeping `pi-para-daemon` alias.
- Split CLI commands into explicit subcommands.
- Add deprecation notices for daemon commands.
- Add `status` that reports wiki/scheduler/store state, not daemon PID only.

Exit criteria:

- `pi-para status` works.
- `pi-para-daemon status` delegates with warning.

### Phase 2 — Scheduler state, queue, leases

- Add scheduler SQLite schema and migrations.
- Implement lease helpers using `BEGIN IMMEDIATE`.
- Implement queue enqueue/claim/complete/fail.
- Add task registry but no production tasks yet.

Exit criteria:

- Unit tests cover lease contention and queue dedupe.

### Phase 3 — In-process scheduler lifecycle

- Start scheduler from extension session startup.
- Add startup tick and interval tick.
- Add UI status callbacks.
- Ensure timers unref and stop/cleanup cleanly.

Exit criteria:

- Opening Pi starts scheduler without blocking startup.
- Multiple Pi sessions do not duplicate leased tasks.

### Phase 4 — Move maintenance onto scheduler

- Replace `scheduleWikiMaintenance()` in `src/tools.ts` with enqueue calls.
- Tasks perform `rebuildIndex`, `reindex/store.update`, optional `store.embed`, and `gitCommit` under leases.
- Ensure foreground `wiki_edit` remains surgical/fast.

Exit criteria:

- wiki edit returns quickly.
- background scheduler rebuilds index/search.
- generated SQLite is never committed.

### Phase 5 — Move capture off daemon

- On compact/shutdown, append queue entry and enqueue capture task.
- Add startup catch-up scanner.
- Reuse existing `Processor`/capture logic inside task implementation.
- Mark old daemon polling watcher legacy.

Exit criteria:

- Completed session is captured on next Pi startup without daemon running.
- `capture-recent` works manually.

### Phase 6 — QMD SDK cleanup

- Remove `qmd --version` shellout.
- Add SDK health helper.
- Update docs: no global QMD install.
- Make doctor validate SDK/index state.

Exit criteria:

- No runtime command requires `qmd` on PATH.
- `/wiki status` works on machines without QMD CLI.

### Phase 7 — Setup/doctor

- Implement `pi-para setup` idempotently.
- Implement `pi-para doctor`, `--fix`, and `--issue`.
- Add config migration to JSONC locations while preserving old config.

Exit criteria:

- New user can run `npx pi-para setup` and restart Pi.
- Doctor clean on fresh install.

### Phase 8 — Docs and architecture guardrails

- Add root architecture/config/structure docs.
- Update README and SETUP.
- Mark setup.sh/systemd service legacy.
- Add changelog migration instructions.

Exit criteria:

- Docs no longer instruct daemon/systemd as primary install.

### Phase 9 — CI/fresh-install smoke

- Add package install smoke tests.
- Add scheduler integration tests.
- Add Windows-ish path tests.
- Optional Docker test for clean Linux install.

Exit criteria:

- CI catches missing files, broken bin, setup failure, and QMD SDK open failures.

### Phase 10 — Deprecation release then removal

Release A:

- Ship no-daemon scheduler.
- Keep daemon aliases with warnings.

Release B:

- Remove daemon service docs/files from package or move to legacy.
- Keep `pi-para-daemon` alias only if users still depend on it.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Session shutdown cannot finish capture | only enqueue on shutdown; catch up on next startup. |
| Multiple Pi sessions duplicate work | SQLite leases and queue dedupe. |
| QMD DB contention | single-writer task leases; short transactions; lazy store reopen. |
| Windows native module issues | doctor detects SDK/native failures; long-term evaluate runtime SQLite or alternative package. |
| Users expect daemon web UI | launch WebWiki on demand or from `pi-para web`, not default daemon. |
| Old sessions still run old code | setup/doctor prints restart guidance. |

## Immediate next implementation slice

Start with the smallest vertical slice:

1. Add `pi-para` bin alias.
2. Add scheduler DB with leases and queue.
3. Add `pi-para tasks` debug command.
4. Start scheduler from `src/index.ts` on `session_start`.
5. Move only `wiki_edit` background maintenance to scheduler.
6. Add tests for queue/lease and one integration test for edit -> maintenance.

This proves the core architecture before moving capture and setup/doctor.
