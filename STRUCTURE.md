# pi-para Repository Structure

## Top level

```text
README.md                     # user overview
SETUP.md                      # current setup/onboarding
ARCHITECTURE.md               # runtime architecture
CONFIGURATION.md              # config schema and credentials
NO_DAEMON_REFACTOR_ROADMAP.md # implementation roadmap/history
PROVIDER_MODEL_SELECTION_PLAN.md
SETUP_SETTINGS_FLOW_PLAN.md
package.json
src/
test/
scripts/gepa/
skills/
```

## `src/`

### Extension entry and CLI

| Path | Purpose |
|---|---|
| `src/index.ts` | Pi extension entry point; registers lifecycle handlers/tools/commands/scheduler |
| `src/cli.ts` | `pi-para` and compatibility `pi-para-daemon` CLI |
| `src/commands.ts` | Pi slash commands |
| `src/tools.ts` | Pi tool definitions |

### Wiki core

| Path | Purpose |
|---|---|
| `src/wiki.ts` | Filesystem wiki operations, page writes, index/log maintenance |
| `src/frontmatter.ts` | Frontmatter parsing/formatting |
| `src/scope.ts` | Project scope detection and matching |
| `src/query.ts` | Query formatting and search orchestration |
| `src/ingest.ts` | Source ingestion |
| `src/raw.ts` | Raw source storage and session digest helpers |
| `src/lint.ts` | Wiki health checks/autofix |
| `src/summarize.ts` | Summary operations |
| `src/link-utils.ts`, `src/link-discovery.ts`, `src/tag-registry.ts` | Link/tag helpers |

### Runtime/search/state

| Path | Purpose |
|---|---|
| `src/store.ts` | QMD SDK store lifecycle, search, reindex/embed helpers |
| `src/qmd-providers.ts` | Convert pi-para provider profiles into QMD SDK provider config |
| `src/context.ts` | Wiki context injection into Pi sessions |
| `src/wiki-tool-guidance.ts` | Shared wiki tool descriptions, prompt snippets, and behavior guidance |
| `src/state.ts` | Legacy/session capture state DB helpers |

### Config/setup/diagnostics

| Path | Purpose |
|---|---|
| `src/paths.ts` | Cross-platform path resolution |
| `src/config.ts` | JSONC config defaults, migration, save/load |
| `src/credentials.ts` | Pi AuthStorage/local secret credential refs |
| `src/settings.ts` | Pure helpers for `/wiki-settings` updates |
| `src/setup.ts` | CLI setup flow |
| `src/status.ts` | Lightweight config/wiki/scheduler status summary |
| `src/doctor.ts` | Diagnostics and safe repairs |
| `src/repair.ts` | Repair helpers such as generated-state `.gitignore` and secret perms |
| `src/atomic-write.ts` | Atomic file writes |

### Scheduler

```text
src/scheduler/
├── index.ts           # scheduler lifecycle and task execution
├── state.ts           # queue/history/task SQLite tables
├── leases.ts          # SQLite lease acquire/release
├── controls.ts        # CLI/command observability helpers
└── session-capture.ts # completed-session registry and capture task handler
```

### GEPA

```text
src/gepa/index.ts       # TS orchestration/CLI integration
src/templates/prompts.ts
scripts/gepa/           # uv/DSPy Python optimizer
```

### Legacy/compatibility

| Path | Purpose |
|---|---|
| `src/daemon.ts` | Legacy daemon foreground mode |
| `src/watcher.ts` | Legacy `.completed-sessions` watcher |
| `src/processor.ts` | Legacy session processor |
| `src/session-tools.ts` | Session exploration tools used by capture |
| `src/maintainer.ts` | Legacy/maintenance helpers |

New code should avoid adding daemon-only dependencies unless intentionally maintaining compatibility.

## `test/`

Tests are Vitest-based. Important suites:

| Path | Purpose |
|---|---|
| `test/config.test.ts` | Config defaults/migration |
| `test/credentials.test.ts` | Credential refs and secrets |
| `test/settings.test.ts` | `/wiki-settings` pure helper behavior |
| `test/qmd-providers.test.ts` | QMD provider profile translation |
| `test/scheduler*.test.ts` | Scheduler state/controls |
| `test/session-capture.test.ts` | Completed-session parsing/enqueueing |
| `test/status.test.ts` | Status summary formatting/counts |
| `test/doctor.test.ts` | Diagnostics/repairs/provider checks |
| `test/index.test.ts` | Pi extension entry lifecycle |
| `test/tools.test.ts`, `test/commands.test.ts` | Tool/command behavior |

Run:

```bash
npm run check
npm test
npm run test:coverage
npm run build
```

## Packaging notes

`package.json` exposes public modules under `exports`. When adding a new public module, add it to both `exports` and tests/build expectations.

Primary binary:

```text
pi-para -> dist/cli.js
```

Compatibility binary:

```text
pi-para-daemon -> dist/cli.js
```
