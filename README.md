# pi-para

A [pi](https://github.com/badlogic/pi-mono) extension that maintains a persistent, LLM-curated personal knowledge base structured by the [PARA method](https://fortelabs.com/blog/para/) — Projects, Areas, Resources, Archives.

pi-para runs as a normal Pi extension: no required daemon, no `systemd`, and no global QMD CLI. Search/indexing uses the embedded QMD SDK, and background capture/maintenance is coordinated by an in-process scheduler while Pi is open.

## Install

```bash
pi install npm:pi-para
# or, for npm/npx setup flows:
npx pi-para@latest setup
```

POSIX one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.ps1 | iex
```

Restart Pi after installing or changing extension registration.

Then run:

```bash
pi-para doctor
```

## What pi-para creates

Default user files:

```text
~/.pi/para/config.jsonc       # canonical pi-para config
~/.pi/para/secrets.json       # optional local secrets, chmod 0600
~/.pi/wiki/                   # PARA markdown wiki
~/.pi/wiki/.pi-para.sqlite    # scheduler queue/history/leases
~/.pi/wiki/.qmd.sqlite        # QMD SDK search index
```

Legacy files such as `~/.pi/wiki/config.json`, `~/.pi/wiki/.daemon.sqlite`, and `~/.config/qmd/index.yml` are still read for migration/compatibility.

## Core commands

### Pi slash commands

| Command | Description |
|---|---|
| `/wiki` | Wiki status, current scope, page counts, recent log |
| `/wiki-search <query>` | Search the wiki |
| `/wiki-ingest <url-or-path-or-text>` | Ingest a source into `raw/` and synthesize pages |
| `/wiki-capture [topic]` | Queue/capture current session knowledge |
| `/wiki-scope [scope]` | Show or override current project scope |
| `/wiki-lint [--report-only]` | Run wiki health checks |
| `/wiki-summarize [target]` | Summarize a page/category/all |
| `/wiki-settings` | Interactive settings for config/providers/scheduler |
| `/wiki-scheduler [status\|queue\|history\|capture-history]` | Scheduler/capture observability |
| `/wiki-daemon ...` | Compatibility alias for `/wiki-scheduler` |
| `/wiki-migrate` | Batch-migrate pages to current schema |
| `/wiki-project <name> <goal>` | Create/archive project pages |

### CLI

```bash
pi-para setup [--yes] [--dry-run] [--local PATH]
pi-para doctor [--fix] [--json] [--test-capture-model]
pi-para tasks [--status queued|running|done|failed]
pi-para tasks show <id>
pi-para tasks history [--task NAME] [--limit N]
pi-para tasks retry [--task NAME]
pi-para status [--json]
pi-para capture-recent --hours 24
pi-para providers
pi-para providers set-secret <name> <value>
pi-para providers remove-secret <name>
```

`pi-para-daemon` remains as a temporary compatibility binary, but the primary runtime is the in-process scheduler. Legacy daemon status is available as `pi-para legacy-status` for troubleshooting old installs.

## Tools available to agents

| Tool | Description |
|---|---|
| `wiki_ingest` | Ingest URL/file/text into the wiki |
| `wiki_query` | Search with scope/category/freshness context |
| `wiki_edit` | Atomic exact `oldText → newText` page edits |
| `wiki_write` | Create/append/replace pages, or legacy edit mode |
| `wiki_read` | Read a page with freshness indicator |
| `wiki_move` | Move a page between PARA categories |
| `wiki_lint` | Run health checks and optional autofix |
| `wiki_migrate` | Batch-migrate pages to current schema |
| `wiki_summarize` | Summarize pages/categories/all |

Prefer `wiki_edit` for surgical updates to existing pages.

## Configuration

Use `/wiki-settings` or edit:

```text
~/.pi/para/config.jsonc
```

Credential refs use one of:

```text
pi-auth:<provider>   # Pi AuthStorage, e.g. ~/.pi/agent/auth.json
secret:<name>        # ~/.pi/para/secrets.json
none                 # local/no-auth provider
```

Setup does not require or write API-key environment variables.

See [CONFIGURATION.md](./CONFIGURATION.md) for the full schema.

## Search and QMD

QMD is used as an embedded SDK through `qmd-engine`; users do not need to install a global `qmd` CLI.

- BM25 keyword search works immediately.
- Embedding/rerank can be configured in `/wiki-settings` or `~/.pi/para/config.jsonc`.
- Legacy `~/.config/qmd/index.yml` is only a compatibility fallback.

## Background capture and maintenance

When Pi is running, pi-para starts an in-process scheduler. It handles:

- queued session capture,
- startup catch-up from `.completed-sessions`,
- index/search maintenance,
- queue/history/lease tracking in `.pi-para.sqlite`.

No background OS service is required. If Pi is closed, queued work resumes on the next Pi session.

## Web Wiki UI

The optional web wiki can be enabled from `/wiki-settings`:

```text
/wiki-settings → [WebWiki] Enabled
```

It serves the wiki viewer/editor/graph on the configured host/port.

## Obsidian compatibility

The wiki is plain markdown with YAML frontmatter and `[[wikilinks]]`. You can open `~/.pi/wiki/` as an Obsidian vault.

## Development

```bash
git clone https://github.com/picassio/pi-para.git
cd pi-para
npm install
npm run check
npm test
npm run test:coverage
npm run build
npm run smoke:install

# Local setup into Pi settings
node ./dist/cli.js setup --local .
```

More docs:

- [SETUP.md](./SETUP.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [STRUCTURE.md](./STRUCTURE.md)
- [CONFIGURATION.md](./CONFIGURATION.md)

## License

MIT
