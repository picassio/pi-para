# pi-para

A [pi](https://github.com/badlogic/pi-mono) extension that maintains a persistent, LLM-curated personal knowledge base structured by the [PARA method](https://fortelabs.com/blog/para/) (Projects, Areas, Resources, Archives). Inspired by [Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

The LLM writes and maintains the wiki autonomously. You provide sources and ask questions. Search powered by [@picassio/qmd](https://github.com/picassio/qmd-1).

## Install

```bash
pi install @picassio/pi-para
```

Start pi — the extension loads automatically. Wiki directory is created on first session.

## Features

### Wiki Tools (7)

| Tool | Description |
|------|-------------|
| `wiki_ingest` | Ingest a URL, file, or text into the wiki |
| `wiki_query` | Search the wiki with scope filtering + freshness indicators |
| `wiki_write` | Create or update wiki pages |
| `wiki_read` | Read a specific wiki page + freshness indicator |
| `wiki_move` | Move pages between PARA categories |
| `wiki_lint` | Run health checks and auto-fix |
| `wiki_summarize` | Summarize pages, categories, or entire wiki |

### Commands (9)

| Command | Description |
|---------|-------------|
| `/wiki` | Status overview (scope, pages, log) |
| `/wiki-search <query>` | Search the wiki |
| `/wiki-ingest <url>` | Quick ingest |
| `/wiki-capture [topic]` | Ask LLM to save knowledge via wiki_write |
| `/wiki-scope` | Show or override project scope |
| `/wiki-lint` | Run health checks |
| `/wiki-summarize [target]` | Summarize wiki content |
| `/wiki-settings` | Interactive settings (providers, daemon, web UI) |
| `/wiki-daemon <cmd>` | Manage background capture daemon |

### Web Wiki UI

Browser-based wiki viewer, editor, and graph visualization.

```
/wiki-settings → [WebWiki] → Enabled: true
```

Access at `http://<LAN-IP>:10973`. Features:
- Page tree by PARA category (sidebar)
- Markdown viewer with clickable `[[wikilinks]]`
- Inline page editor
- D3 force-directed graph view (page relationships)
- Search
- Move pages between categories
- Activity log and session digests
- Mobile-first responsive design, dark/light theme

### Background Capture Daemon

Processes session files in the background after you quit pi:

```bash
# Via extension command
/wiki-daemon start
/wiki-daemon status

# Via CLI
pi-para-daemon start
pi-para-daemon process-recent --hours 24
```

The daemon uses an Agent with session exploration tools (session_slice, session_search, session_stats) to iteratively explore sessions of any size and extract knowledge.

Auto-starts via systemd on Linux — run `./setup.sh` once for daemon service setup.

## Architecture

```
~/.pi/wiki/
├── config.json        # all settings (context, search, daemon, web UI)
├── schema.md          # PARA conventions
├── index.md           # page catalog (auto-rebuilt)
├── log.md             # activity log
├── sessions.md        # session digest log
├── .completed-sessions # daemon registry
├── .daemon.sqlite     # daemon state
├── .qmd.sqlite        # search index
├── projects/          # active, goal-defined work
├── areas/             # ongoing responsibilities
├── resources/         # reference material
├── archives/          # completed/deprecated
└── raw/               # immutable source material
```

### How it works

1. **During a session** — LLM uses wiki tools (query, write, ingest). Context injection provides wiki knowledge on every turn.
2. **On /quit** — session registered in `.completed-sessions` (instant, <10ms)
3. **Background** — daemon picks up session, Agent explores with tools, writes wiki pages
4. **Next session** — new wiki pages appear in context injection

### Freshness Verification

Every `wiki_query` and `wiki_read` result includes a freshness indicator based on the page's last-updated date:

| Age | Indicator | LLM Behavior |
|-----|-----------|---------------|
| < 7 days | ✅ FRESH | Trust normally |
| 7-14 days | ✅ Recent | Trust normally |
| 14-30 days | ⚠️ AGING | Verify claims about code/configs before trusting |
| 30-90 days | ⚠️ STALE | Verify before trusting |
| > 90 days | 🚨 VERY STALE | Likely outdated, verify everything |

The LLM is instructed to:
- **Verify** stale claims by checking actual code, configs, or files
- **Self-heal** — fix incorrect wiki pages via `wiki_write(mode: 'edit')` when it discovers they're wrong
- **Flag uncertainty** — tell the user when a claim can't be verified (e.g. external services)

### Configuration

All settings via `/wiki-settings` interactive menu, or edit `~/.pi/wiki/config.json`:

```json
{
  "contextMaxTokens": 4000,
  "searchLimit": 10,
  "lintAutoFix": true,
  "lintStaleDays": 90,
  "daemonModel": null,
  "webWiki": { "enabled": true, "host": "0.0.0.0", "port": 10973 }
}
```

Search providers in `~/.config/qmd/index.yml`:

```yaml
providers:
  embed:
    url: https://openrouter.ai/api/v1
    key: sk-or-...
    model: openai/text-embedding-3-small
  chat:
    url: https://api.minimaxi.com/anthropic
    key: sk-cp-...
    model: MiniMax-M2.7-highspeed
    api: anthropic
```

### Optional: Enhanced search

```bash
npm install -g @picassio/qmd
```

Without qmd: BM25 keyword search. With qmd + providers: hybrid BM25 + vector + rerank.

## Obsidian Compatibility

The wiki is a directory of markdown files with YAML frontmatter and `[[wikilinks]]`. Open `~/.pi/wiki/` as an Obsidian vault for graph view, Dataview queries, and manual editing.

## Development

```bash
git clone https://github.com/picassio/pi-para.git
cd pi-para
npm install
npm run check    # TypeScript check
npm test         # Run tests (265 tests)
npm run build    # Compile to dist/

# Dev mode: symlink extension
ln -sf $(pwd) ~/.pi/agent/extensions/pi-para

# Run daemon locally
npx tsx src/cli.ts start
```

## License

MIT
