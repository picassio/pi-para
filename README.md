# pi-para

A [pi](https://github.com/badlogic/pi-mono) extension that maintains a persistent, LLM-curated personal knowledge base structured by the [PARA method](https://fortelabs.com/blog/para/) (Projects, Areas, Resources, Archives). Inspired by [Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

The LLM writes and maintains the wiki autonomously. You provide sources and ask questions. Search powered by [@picassio/qmd](https://github.com/picassio/qmd-1).

## Install

```bash
pi install @picassio/pi-para
```

Start pi — the extension loads automatically. Wiki directory is created on first session.

## Features

### Wiki Tools (8)

| Tool | Description |
|------|-------------|
| `wiki_ingest` | Ingest a URL, file, or text into the wiki |
| `wiki_query` | Search the wiki with scope filtering, graph boost, freshness indicators |
| `wiki_write` | Create or update wiki pages |
| `wiki_read` | Read a specific wiki page + freshness indicator |
| `wiki_move` | Move pages between PARA categories |
| `wiki_lint` | Run health checks and auto-fix |
| `wiki_summarize` | Summarize pages, categories, or entire wiki |
| `wiki_migrate` | Batch-migrate all pages to current schema version |

### Commands (11)

| Command | Description |
|---------|-------------|
| `/wiki` | Status overview (scope, pages, log) |
| `/wiki-search <query>` | Search the wiki |
| `/wiki-ingest <url>` | Quick ingest |
| `/wiki-capture [topic]` | Ask LLM to save knowledge via wiki_write |
| `/wiki-scope` | Show or override project scope |
| `/wiki-lint` | Run health checks |
| `/wiki-summarize [target]` | Summarize wiki content |
| `/wiki-settings` | Interactive settings (search, context, daemon, web UI, providers) |
| `/wiki-daemon <cmd>` | Manage background capture daemon |
| `/wiki-migrate` | Migrate all pages to current schema version |
| `/wiki-project <name> <goal>` | Create or archive (`done`) a project page |

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

### GEPA Prompt Optimizer

Automatically optimize all pi-para prompts, tool instructions, and skill guidelines using [DSPy GEPA](https://arxiv.org/abs/2507.19457) (Genetic-Pareto optimizer). Runs via `uv` with custom LLM providers — no litellm.

```bash
# List all 22 optimization targets
pi-para-daemon gepa targets

# Optimize a single target (uses config defaults: sonnet student + opus teacher)
pi-para-daemon gepa optimize --target capture-prompt

# Optimize all targets sequentially
bash scripts/gepa/run-all.sh

# Override models via CLI
pi-para-daemon gepa optimize --target skill-para \
  --student-model anthropic/claude-sonnet-4-20250514 \
  --teacher-model anthropic/claude-opus-4-6 \
  --judge-model anthropic/claude-sonnet-4-20250514

# Shorthand (--model = student, --reflection-model = teacher)
pi-para-daemon gepa optimize --model anthropic/claude-sonnet-4-20250514 --reflection-model anthropic/claude-opus-4-6

# See results
pi-para-daemon gepa list

# Compare original vs optimized
pi-para-daemon gepa compare --target capture-prompt
```

**How it works:**

1. TypeScript extracts all prompt/tool/skill texts from source files
2. Calls `uv run scripts/gepa/optimize.py` with API keys from `~/.pi/agent/auth.json`
3. Python builds a trainset from real wiki pages (93 pages → 30 train / 20 val)
4. DSPy GEPA evolves each instruction using a lightweight proxy module (1 LLM call per eval, not 10-50)
5. **Teacher** (Opus) proposes instruction mutations based on metric feedback
6. **Student** (Sonnet) runs the proxy to generate output from the instruction
7. **Judge** (Sonnet) scores on 6 dimensions: structure, PARA compliance, cross-references, security, completeness, actionability
8. Optimized prompts saved to `~/.pi/wiki/gepa/optimized/`

**Teacher/Student/Judge pattern** (DSPy GEPA):

| Role | Default Model | What It Does | Calls/target |
|------|---------------|--------------|--------|
| **Student** | `claude-sonnet-4` | Runs proxy (generates wiki output) | ~460 |
| **Teacher** | `claude-opus-4-6` | Proposes mutations via reflection | ~30 |
| **Judge** | `claude-sonnet-4` | Scores output (LLM-as-judge metric) | ~460 |

**22 optimization targets:**

| Category | Targets |
|----------|--------|
| Prompt templates (12) | System, ingest, query, capture (×3), maintenance, processor, summarize, iterative, overview, lint |
| Tool instructions (9) | wiki_ingest, wiki_query, wiki_write, wiki_edit, wiki_read, wiki_move, wiki_lint, wiki_migrate, wiki_summarize |
| Skills (2) | para (active PARA workflow), setup (installation guide) |

**LLM providers** (custom `dspy.BaseLM` subclasses, no litellm):

| Provider | Auth | Notes |
|----------|------|-------|
| Anthropic | OAuth token from `auth.json` | Claude Code billing headers + user-agent, auto token refresh |
| MiniMax | API key | Via Anthropic-compatible API |
| OpenRouter | API key | Via OpenAI-compatible API |

**Configuration** (`~/.pi/wiki/config.json`):

```json
{
  "gepa": {
    "useOptimized": true,
    "studentModel": "anthropic/claude-sonnet-4-20250514",
    "teacherModel": "anthropic/claude-opus-4-6",
    "judgeModel": null,
    "auto": "light",
    "threads": 2,
    "seed": 42
  }
}
```

- `useOptimized: true` — load optimized prompts at runtime (enabled by default)
- `studentModel` — fast model for running proxy + judging (Sonnet recommended)
- `teacherModel` — smart model for proposing mutations (Opus recommended)
- `judgeModel` — model for scoring output (defaults to studentModel if null)
- All settings overridable via CLI flags

When `useOptimized` is enabled, `getPrompt(name)` checks: user-generated → bundled optimized → original. Originals are always preserved.

**Budget presets:**

| Preset | Rollouts | Time estimate | When to use |
|--------|----------|---------------|-------------|
| `light` | ~460 | 1-2 hours | Quick sanity check |
| `medium` | ~1500 | 4-6 hours | Everyday optimization |
| `heavy` | ~5000 | 12-24 hours | Final tuning |

**Prerequisites:** `uv` (Python package manager). DSPy + anthropic SDK installed automatically on first run.

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
├── config.json        # all settings (context, search, daemon, web UI, gepa)
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
├── raw/               # immutable source material
└── gepa/              # GEPA optimizer state
    ├── input/         # targets.json (generated per run)
    ├── output/        # results.json (GEPA output)
    ├── optimized/     # deployed optimized prompts (*.txt)
    └── history/       # version history per target
```

**Python scripts (GEPA optimizer):**

```
scripts/gepa/
├── pyproject.toml     # uv project (dspy, anthropic, openai deps)
├── optimize.py        # Main entry — runs DSPy GEPA
├── lm_providers.py    # Custom BaseLM: AnthropicOAuthLM, MiniMaxLM, OpenRouterLM
├── program.py         # PromptProxy DSPy Module (1 LLM call per eval)
├── metric.py          # LLM-as-judge metric (6 dimensions)
├── dataset.py         # Build train/val from real wiki pages
└── wiki_reader.py     # Read wiki pages from disk
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
- **Self-heal** — fix incorrect wiki pages via `wiki_edit` when it discovers they're wrong
- **Flag uncertainty** — tell the user when a claim can't be verified (e.g. external services)

### Configuration

All settings via `/wiki-settings` interactive menu, or edit `~/.pi/wiki/config.json`:

```json
{
  "contextMaxTokens": 4000,
  "searchLimit": 10,
  "searchGraphBoost": true,
  "lintAutoFix": true,
  "lintStaleDays": 90,
  "daemonModel": null,
  "webWiki": { "enabled": true, "host": "0.0.0.0", "port": 10973 },
  "gepa": { "useOptimized": false }
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
npm test         # Run tests (301 tests)
npm run build    # Compile to dist/

# Dev mode: symlink extension
ln -sf $(pwd) ~/.pi/agent/extensions/pi-para

# Run daemon locally
npx tsx src/cli.ts start
```

## License

MIT
