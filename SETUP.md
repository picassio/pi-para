# pi-para Setup

This is the current setup flow for pi-para. It is cross-platform and does not require `systemd`, a long-running daemon, or a global QMD CLI.

## Prerequisites

- Pi installed and working.
- Node.js/npm available.
- A restarted Pi session after install/config changes.

## Standard install

```bash
pi install pi-para
```

Then restart Pi.

Run diagnostics:

```bash
pi-para doctor
```

If needed, apply safe repairs:

```bash
pi-para doctor --fix
```

## npx setup flow

For a fresh machine or scripted install:

```bash
npx pi-para@latest setup
```

POSIX one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.sh | bash
```

Windows PowerShell one-liner:

```powershell
irm https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.ps1 | iex
```

Non-interactive defaults:

```bash
npx pi-para@latest setup --yes
```

Dry run:

```bash
npx pi-para@latest setup --dry-run
```

Local development install:

```bash
cd /path/to/pi-para
npm install
npm run build
node ./dist/cli.js setup --local .
```

Restart Pi after setup.

## What setup does

`pi-para setup` is idempotent. It may:

1. locate Pi settings,
2. register the pi-para extension,
3. initialize `~/.pi/wiki/`,
4. create or migrate `~/.pi/para/config.jsonc`,
5. repair generated-state `.gitignore` entries,
6. validate the embedded QMD SDK,
7. print next steps.

It does **not** install a system daemon by default, does **not** require global `qmd`, and does **not** copy secrets unless you explicitly store one.

## Configuration locations

Canonical:

```text
~/.pi/para/config.jsonc
~/.pi/para/secrets.json
~/.pi/wiki/
~/.pi/wiki/.pi-para.sqlite
~/.pi/wiki/.qmd.sqlite
```

Legacy migration inputs:

```text
~/.pi/wiki/config.json
~/.pi/wiki/.daemon.sqlite
~/.config/qmd/index.yml
```

## Provider credentials

Credential refs use:

```text
pi-auth:<provider>
secret:<name>
none
```

Examples:

```bash
pi-para providers
pi-para providers set-secret embedding sk-...
pi-para providers remove-secret embedding
```

Recommended order:

1. Pi AuthStorage (`~/.pi/agent/auth.json`),
2. pi-para secrets (`~/.pi/para/secrets.json`),
3. `none` for local/no-auth endpoints.

No env-var setup path is required.

## Configure inside Pi

Run:

```text
/wiki-settings
```

The settings menu writes through the same config service as the CLI. It can configure:

- context token budget,
- search limit and graph boost,
- lint autofix/stale days,
- capture model,
- WebWiki host/port/enabled,
- embedding and rerank provider profiles,
- local secrets.

## Verify inside Pi

Useful commands:

```text
/wiki
/wiki-search test
/wiki-settings
/wiki-scheduler status
/wiki-lint --report-only
```

Try a smoke test:

```text
Save this to the wiki as a test note: pi-para setup succeeded.
```

Then:

```text
/wiki-search setup succeeded
```

## Background capture

No daemon needs to be started.

pi-para queues completed/compacted sessions and processes them when a Pi session with pi-para is open. If Pi is closed, queued work resumes on the next startup.

Inspect queue/history:

```bash
pi-para tasks
pi-para tasks history
pi-para capture-recent --hours 24
```

Inside Pi:

```text
/wiki-scheduler queue
/wiki-scheduler history
/wiki-scheduler capture-history
```

`/wiki-daemon` and `pi-para-daemon` remain compatibility aliases for older workflows.

## QMD search

Global QMD CLI is not required. pi-para uses embedded `qmd-engine` SDK.

- BM25 search works with no providers.
- Embeddings/rerank use provider profiles in `~/.pi/para/config.jsonc`.
- Legacy `~/.config/qmd/index.yml` is read only for compatibility.

Doctor check:

```bash
pi-para doctor
```

Provider/model diagnostic:

```bash
pi-para doctor --test-capture-model
pi-para status --json
```

## Troubleshooting

### Extension changed but behavior did not

Restart Pi. Existing sessions keep loaded extension code.

### Missing or stale provider credentials

Run:

```bash
pi-para doctor
pi-para providers
```

Store a local secret only if you do not want to use Pi AuthStorage:

```bash
pi-para providers set-secret embedding <key>
```

### Search works but embeddings fail

BM25 search remains available. Check:

```bash
pi-para doctor
/wiki-settings
```

Then configure or disable embedding.

### Old daemon/systemd service exists

The old service is no longer required. You can leave it stopped while using the in-process scheduler. Do not start both old daemon capture and the scheduler for the same wiki unless you are intentionally testing legacy behavior.
