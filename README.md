# pi-para

A [pi](https://github.com/badlogic/pi-mono) extension that maintains a persistent, LLM-curated personal knowledge base structured by the [PARA method](https://fortelabs.com/blog/para/) (Projects, Areas, Resources, Archives). Inspired by [Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

The LLM writes and maintains the entire wiki autonomously. You provide sources and ask questions. Search powered by [@picassio/qmd](https://github.com/picassio/qmd).

## Install

```bash
pi install @picassio/pi-para
```

That's it. Start pi and the extension loads automatically. Wiki directory is created on first session.

### Optional: Enhanced search

Without qmd, the wiki uses BM25 keyword search. For hybrid search (BM25 + vector + rerank):

```bash
npm install -g @picassio/qmd
```

Then configure providers in `~/.config/qmd/index.yml`.

### Optional: Background capture daemon

The daemon processes session files in the background after you quit pi:

```bash
# Start manually
cd ~/.pi/agent/packages/npm/@picassio/pi-para && npx tsx src/cli.ts start

# Or install as systemd user service (Linux)
./setup.sh  # only needed for daemon auto-start
```

### Configure search providers (optional)

Create `~/.config/qmd/index.yml`:

```yaml
providers:
  embed:
    url: https://api.openai.com/v1
    key: sk-...
    model: text-embedding-3-small
    dims: 1536
  chat:
    url: https://openrouter.ai/api/v1
    key: sk-or-...
    model: google/gemini-2.5-flash
  rerank:
    url: https://api.jina.ai/v1
    key: jina_...
    model: jina-reranker-v2-base-multilingual
```

MiniMax CN is also supported:

```yaml
providers:
  chat:
    url: https://api.minimaxi.com/anthropic
    key: sk-cp-...
    model: MiniMax-M2.7-highspeed
    api: anthropic
```

Or use environment variables:

```bash
export QMD_EMBED_URL=https://api.openai.com/v1
export QMD_EMBED_KEY=sk-...
export QMD_EMBED_MODEL=text-embedding-3-small
```

## Usage

### Ingest sources

Tell the LLM to ingest content, or use the shortcut:

```
> ingest this article: https://example.com/ssl-guide
> /wiki-ingest ~/docs/architecture.md
```

The LLM reads the source, extracts knowledge, creates wiki pages with PARA classification, cross-references, and updates the index. Raw sources are saved to `~/.pi/wiki/raw/`.

### Search the wiki

```
> search the wiki for SSL certificate renewal
> /wiki-search database migration patterns
```

Results are scoped to the current project by default. The LLM synthesizes answers from matching pages and can file new knowledge back into the wiki.

### Session capture

Knowledge is captured automatically on every session exit. The extension serializes the conversation, spins up a standalone agent, and writes wiki pages for any decisions, solutions, or patterns worth persisting.

For mid-session capture:

```
> save this to the wiki
> /wiki-capture the SSL fix we just did
```

### Wiki management

```
/wiki              # status: scope, page counts, recent log
/wiki-lint         # health checks with auto-fix
/wiki-scope        # show or override project scope
/wiki-summarize    # summarize pages, categories, or the whole wiki
```

## Architecture

```
~/.pi/wiki/
├── config.json        # extension settings
├── schema.md          # PARA conventions (LLM reads this)
├── index.md           # page catalog (LLM-maintained)
├── log.md             # activity log
├── sessions.md        # session digest log
├── projects/          # active, goal-defined work
├── areas/             # ongoing responsibilities
├── resources/         # reference material
├── archives/          # completed/deprecated
└── raw/               # immutable source material
    ├── articles/
    ├── docs/
    └── notes/
```

Three layers (Karpathy model):
1. **Raw sources** — immutable, LLM never modifies
2. **Wiki** — LLM-generated synthesis, LLM owns entirely
3. **Schema** — conventions and rules

### Project scoping

Every wiki page has a `scope` field in frontmatter:

```yaml
---
title: SSL Certificate Guide
para: resources
scope: [pi-mono, global]
tags: [ssl, security]
---
```

The extension auto-detects the current project from git and only injects relevant pages into the LLM context. Pages in `areas/` default to `scope: ["global"]`. Pages in `projects/` default to the current project name.

Override per-project with `.pi/wiki-scope.json`:

```json
{
  "name": "my-project",
  "include": ["my-project", "typescript"],
  "exclude": ["health", "travel"]
}
```

### Tools

| Tool | Description |
|------|-------------|
| `wiki_ingest` | Ingest a URL, file, or text into the wiki |
| `wiki_query` | Search the wiki with scope filtering |
| `wiki_write` | Create or update wiki pages |
| `wiki_read` | Read a specific wiki page |
| `wiki_move` | Move a page between PARA categories |
| `wiki_lint` | Run health checks and auto-fix issues |
| `wiki_summarize` | Summarize pages, categories, or the entire wiki |

### How the LLM is used

**During a session**: tools are called *by* the LLM in the normal pi agent loop. The extension handles I/O; the LLM handles synthesis.

**Outside the session** (capture, lint, summarize): a standalone `Agent` from `@mariozechner/pi-agent-core` runs with wiki-only tools. Same model and API key, separate context, invisible to the session.

## Configuration

`~/.pi/wiki/config.json` (created automatically on first run):

```json
{
  "wikiDir": "~/.pi/wiki",
  "contextMaxTokens": 4000,
  "contextIncludeSchema": true,
  "contextIncludeIndex": true,
  "autoCapture": true,
  "autoCaptureTimeoutMs": 30000,
  "lintAutoFix": true,
  "lintStaleDays": 90,
  "searchLimit": 10,
  "searchIncludeArchives": false
}
```

## Obsidian compatibility

The wiki is a directory of markdown files with YAML frontmatter and `[[wikilinks]]`. Open `~/.pi/wiki/` as an Obsidian vault for:

- Graph view showing page connections
- Dataview queries on frontmatter fields
- Real-time preview as the LLM writes pages
- Manual editing alongside LLM maintenance

## Development

```bash
git clone https://github.com/picassio/pi-para.git
cd pi-para
npm install
npm run check    # TypeScript check
npm test         # Run tests (265 tests)
npm run build    # Compile to dist/

# Dev mode: symlink extension (changes take effect on /reload)
mkdir -p ~/.pi/agent/extensions
ln -sf $(pwd) ~/.pi/agent/extensions/pi-para

# Run daemon locally
npx tsx src/cli.ts start
```

## License

MIT
