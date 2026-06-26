# pi-para Setup and Settings Flow Plan

## Goal

Make pi-para installable and configurable on Linux, macOS, and Windows without a daemon, global QMD CLI, or manual README surgery. Setup should be safe, idempotent, and explain exactly what changed. Settings should be editable both from the CLI and from inside Pi.

## Principles

1. **One command to start**: `npx pi-para@latest setup` should be enough for most users.
2. **No secrets copied**: setup may detect auth/provider availability but must not print or persist API keys unless the user explicitly enters one.
3. **Idempotent and reversible**: every config write should be atomic, backed up when replacing existing config, and shown in a summary.
4. **Cross-platform paths**: no Linux-only assumptions in the primary flow.
5. **No daemon requirement**: setup registers the extension and scheduler, not `systemd`.
6. **QMD SDK bundled**: setup/doctor validate embedded QMD SDK health, not a global `qmd` binary.
7. **Progressive disclosure**: novice flow asks only core questions; advanced settings are available but not mandatory.

## Primary user flows

### Fresh install

```bash
npx pi-para@latest setup
```

Flow:

1. Preflight environment.
2. Locate Pi config.
3. Register pi-para extension.
4. Initialize wiki.
5. Create/migrate pi-para config.
6. Detect provider/auth availability.
7. Choose recommended model defaults.
8. Validate QMD SDK/index.
9. Run a tiny write/read/query smoke test.
10. Print next steps: restart Pi, run `/wiki`, run `/wiki-settings`, run `pi-para doctor`.

### Non-interactive install

```bash
npx pi-para@latest setup --yes
```

Uses defaults, writes only safe config, never prompts for secrets.

### Local development install

```bash
node ./dist/cli.js setup --local /home/ubuntu/projects/pi-para
# or
pi-para setup --local .
```

Registers the local project path in Pi settings instead of npm package reference.

### Repair existing install

```bash
pi-para doctor --fix
```

Runs diagnostics and applies only safe fixes:

- create missing directories
- add `.gitignore` entries for generated SQLite
- migrate config with backup
- repair extension registration
- rebuild index/search if needed

### In-Pi settings

```text
/wiki-settings
```

Shows a native menu with current effective config and lets the user change common settings. Writes through the same config module as CLI setup, not ad hoc JSON writes.

## Config locations

### New canonical locations

Use Pi-adjacent locations because pi-para is a Pi extension:

```text
~/.pi/para/config.jsonc          # user-level pi-para config
<project>/.pi/para.jsonc         # optional project-level overrides
~/.pi/wiki/                      # default wiki data directory
~/.pi/wiki/.pi-para.sqlite       # scheduler/queue/lease state
~/.pi/wiki/.qmd.sqlite           # QMD SDK search index
```

### Legacy compatibility

Continue reading these during migration:

```text
~/.pi/wiki/config.json           # current pi-para config
~/.config/qmd/index.yml          # legacy QMD/provider config
~/.pi/wiki/.daemon.sqlite        # old daemon/capture state
```

Migration should:

1. Read legacy config.
2. Create `~/.pi/para/config.jsonc` if missing.
3. Copy known settings into the new schema.
4. Leave old files in place with a breadcrumb comment/file where possible.
5. Prefer new config after migration.

## Config precedence

Effective config should resolve in this order:

```text
defaults
  < user config (~/.pi/para/config.jsonc)
  < project config (<cwd>/.pi/para.jsonc)
  < session overrides from /wiki-settings where applicable
  < CLI flags
```

Legacy files are read only as migration/input compatibility, not as the highest-precedence long-term source.

## Proposed config schema

```jsonc
{
  "$schema": "https://picassio.github.io/pi-para/config.schema.json",
  "version": 1,

  "wiki": {
    "dir": "~/.pi/wiki",
    "defaultScope": null,
    "autoCapture": true,
    "captureOnCompact": true,
    "captureOnStartup": true
  },

  "context": {
    "maxTokens": 4000,
    "includeSchema": true,
    "includeIndex": true,
    "searchLimit": 10,
    "searchGraphBoost": true
  },

  "scheduler": {
    "enabled": true,
    "startupCatchup": true,
    "intervalMinutes": 15,
    "maxConcurrentTasks": 1
  },

  "models": {
    "capture": "auto",
    "summarize": "auto",
    "judge": "anthropic/claude-sonnet-4-20250514"
  },

  "qmd": {
    "mode": "sdk",
    "embedEnabled": true,
    "providerConfig": "pi-para-profiles"
  },

  "lint": {
    "autoFix": true,
    "staleDays": 90
  },

  "webWiki": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 10973,
    "launch": "manual"
  },

  "gepa": {
    "useOptimized": false,
    "studentModel": "anthropic/claude-sonnet-4-20250514",
    "teacherModel": "anthropic/claude-opus-4-6",
    "judgeModel": "anthropic/claude-sonnet-4-20250514",
    "auto": "light",
    "threads": 2,
    "seed": 42
  }
}
```

## Setup wizard screens

### 1. Welcome / mode

Shows:

- pi-para version
- install source: npm/local/dev
- target OS
- what setup will change

Options:

- Standard setup (recommended)
- Advanced setup
- Repair existing setup
- Dry run

### 2. Pi installation detection

Checks:

- Pi config path exists
- Pi settings parse correctly
- extension registration method available
- current project path if local/dev

Output:

```text
✓ Found Pi settings: ~/.pi/agent/settings.json
✓ Will register extension: npm:pi-para
```

### 3. Wiki location

Default:

```text
~/.pi/wiki
```

Options:

- use default
- choose custom path
- import existing wiki

Setup initializes PARA directories but does not overwrite existing content.

### 4. Config migration

If legacy config exists:

```text
Found legacy config: ~/.pi/wiki/config.json
Create new config: ~/.pi/para/config.jsonc
Backup: ~/.pi/wiki/config.json.bak-YYYYMMDDHHmmss
```

User can review changes in advanced mode.

### 5. Provider/model detection

Detects, without printing secrets:

- Pi OAuth/auth state in `~/.pi/agent/auth.json`
- pi-para local secrets in `~/.pi/para/secrets.json`
- legacy QMD provider config
- configured Pi providers/models if accessible

Environment variables are diagnostic-only, not a recommended API key setup mechanism.

Recommended defaults:

- capture/summarize: auto or Sonnet
- GEPA student/judge: Sonnet
- GEPA teacher/reflection: Opus

If no model/auth is available, setup still completes but doctor reports capture disabled/degraded.

### 6. Scheduler settings

Default:

```text
Scheduler enabled: yes
Startup catch-up: yes
Interval: 15 minutes
Daemon/service: no
```

Explain that background work runs only while Pi is open, and missed work catches up on next Pi start.

### 7. Search/index validation

Runs SDK checks:

- import `qmd-engine`
- create/open `.qmd.sqlite`
- run `store.update()` on empty/new wiki
- run a simple search

No `qmd` CLI required.

### 8. Smoke test

Creates or uses a small setup verification page, then reads/searches it. If user does not want test content, use temp raw file and clean it up.

### 9. Summary and next steps

Example:

```text
Setup complete.

Changed:
  ✓ Registered pi-para in ~/.pi/agent/settings.json
  ✓ Created ~/.pi/para/config.jsonc
  ✓ Initialized ~/.pi/wiki
  ✓ Verified QMD SDK index

Next:
  1. Restart open Pi sessions.
  2. Run /wiki in Pi.
  3. Run /wiki-settings to customize.
  4. Run pi-para doctor any time.
```

## CLI settings commands

```bash
pi-para config path
pi-para config show
pi-para config get context.maxTokens
pi-para config set context.maxTokens 6000
pi-para config edit
pi-para config migrate
pi-para config doctor
```

All use the same schema validation and atomic write helpers as setup.

## `/wiki-settings` menu redesign

Top-level menu:

```text
pi-para settings

1. Status overview
2. Wiki and scope
3. Context injection
4. Search and QMD SDK
5. Capture and scheduler
6. Models and providers
7. GEPA optimization
8. Web Wiki
9. Lint/data quality
10. Open config file path
11. Run doctor
```

### Status overview

Shows effective config and source of each major setting:

```text
Wiki dir: ~/.pi/wiki                    user config
Scheduler: enabled, next tick in 12m    default
QMD SDK: ok, 452 docs indexed           runtime
Capture backlog: 3 queued               scheduler DB
Model: anthropic/claude-sonnet...       user config
```

### Capture and scheduler

Settings:

- enable scheduler
- capture on compact
- startup catch-up
- interval minutes
- show task queue
- run catch-up now

### Search and QMD SDK

Settings/actions:

- search limit
- graph boost
- embed enabled
- reindex now
- index health
- provider compatibility status

### Models and providers

Settings:

- capture model
- summarization model
- judge model
- provider source

Important: show where credentials are stored, never values.

### GEPA

Settings:

- use optimized prompts
- student model
- teacher/reflection model
- judge model
- budget
- threads
- seed

## Doctor output shape

Doctor should produce human-readable and JSON output:

```bash
pi-para doctor
pi-para doctor --json
pi-para doctor --fix
pi-para doctor --issue ./pi-para-issue.zip
```

Categories:

- install
- config
- wiki
- qmd
- scheduler
- capture
- git
- auth/providers
- docs/package

Severity:

- ok
- warn
- error
- fixable

## Atomic write requirements

Every setup/settings write must:

1. Read existing file.
2. Validate schema.
3. Write temp file in same directory.
4. fsync if practical.
5. Rename atomically.
6. Preserve formatting/comments for JSONC if possible.
7. Create backup for migrations.

## Implementation phases

### Phase A — Config module

- Extract config from `src/index.ts` into `src/config.ts`.
- Add path helpers.
- Add JSONC parser/stringifier.
- Add schema/defaults.
- Add legacy migration from `~/.pi/wiki/config.json`.

### Phase B — CLI setup skeleton

- Add `pi-para setup --dry-run --yes --local`.
- Implement preflight and extension registration.
- Initialize wiki and config.

### Phase C — Doctor core

- Add reusable diagnostics.
- Wire `pi-para doctor`.
- Add `--fix` for safe repairs.

### Phase D — Settings unification

- Rewrite `/wiki-settings` to call config service.
- Remove direct writes to `~/.pi/wiki/config.json` and `~/.config/qmd/index.yml` from command handlers.

### Phase E — QMD SDK/provider migration

- Move provider settings into pi-para config while preserving legacy reads.
- Remove status dependency on `qmd --version`.

### Phase F — Scheduler settings

- Add scheduler config section.
- Expose queue/status/run-now actions in CLI and `/wiki-settings`.

### Phase G — Docs/tests

- Add `CONFIGURATION.md`.
- Update README/SETUP.
- Add setup/doctor smoke tests.

## Open questions

1. Should canonical user config be `~/.pi/para/config.jsonc` or OS-native config dir (`~/.config/pi-para/config.jsonc`, `%APPDATA%/pi-para/config.jsonc`)? Recommendation: use `~/.pi/para/config.jsonc` for Pi ecosystem consistency.
2. Should project config be `<project>/.pi/para.jsonc` or `<project>/.pi-para.jsonc`? Recommendation: `<project>/.pi/para.jsonc` to keep project metadata grouped.
3. Should setup write a test page? Recommendation: avoid durable test page unless `--smoke-write` is explicit; use temp file or no-content validation by default.
4. How much provider setup should pi-para own vs delegate to Pi auth? Recommendation: use Pi AuthStorage as the preferred credential store; use pi-para's own `~/.pi/para/secrets.json` only for providers/embeddings Pi cannot represent. Do not use env vars as the setup path.
