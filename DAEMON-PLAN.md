# pi-para Daemon: Background Knowledge Capture

## Problem

The current approach — capturing knowledge at `session_shutdown` — has fundamental issues:

1. **Blocks `/quit`** — the standalone Agent makes LLM calls during shutdown (30-60s)
2. **Trivial sessions waste tokens** — short sessions still trigger capture attempts
3. **Monster sessions fail** — 256K+ char sessions overwhelm the Agent's context window
4. **Incremental capture loses context** — only seeing recent messages misses cross-session knowledge
5. **Mid-session writes are unreliable** — the LLM often ignores promptGuidelines to proactively write

## Solution: Split into Extension + Daemon

### Extension (pi-para) — Lightweight, Session-Focused

Keep only:
- **Wiki tools** — `wiki_query`, `wiki_read`, `wiki_write`, `wiki_move`, `wiki_lint`, `wiki_summarize`, `wiki_ingest`
- **Context injection** — `before_agent_start` injects wiki context + reminder
- **Session tagging** — on `session_start`, tag the session with project scope (write a marker file or append metadata)
- **Slash commands** — `/wiki`, `/wiki-search`, `/wiki-scope`, `/wiki-lint`, `/wiki-summarize`, `/wiki-ingest`

Remove:
- Auto-capture at `session_shutdown`
- Standalone Agent for capture
- `/wiki-capture` command (replaced by daemon)
- All capture-related timeout/threshold logic

The extension becomes purely reactive — it responds to user/LLM requests during a session but does no background processing.

### Daemon (pi-para-daemon) — Background Knowledge Worker

A separate long-running process that:

1. **Watches** for session file changes (new sessions, session updates)
2. **Queues** sessions for processing
3. **Processes** sessions using RLM with MiniMax (no time pressure)
4. **Writes** wiki pages via filesystem operations
5. **Deduplicates** against existing wiki pages
6. **Logs** activity to `sessions.md` and `log.md`

---

## Daemon Architecture

```
pi-para-daemon
├── src/
│   ├── main.py              # entry point, CLI
│   ├── watcher.py           # file system watcher (inotify/polling)
│   ├── queue.py             # session processing queue with state
│   ├── processor.py         # session -> wiki pages (RLM or direct LLM)
│   ├── wiki_writer.py       # filesystem write + qmd reindex
│   ├── config.py            # daemon configuration
│   └── minimax_lm.py        # MiniMaxLM (copied from rlm-dspy)
├── pyproject.toml
└── README.md
```

### Trigger Modes

The daemon supports three modes:

#### 1. File Watch (primary)

Watches `~/.pi/agent/sessions/` for `.jsonl` file modifications. When a session file is updated (indicating the user quit and a new session started, or the session was compacted):

```
inotify/polling on ~/.pi/agent/sessions/**/*.jsonl
  → file modified
  → debounce 30s (wait for session to fully close)
  → add to processing queue
```

#### 2. Schedule (secondary)

Periodic sweep every N minutes (configurable, default 15):

```
every 15 min:
  → scan all session dirs for files newer than last_processed timestamp
  → add unprocessed sessions to queue
```

#### 3. Manual Trigger

```bash
pi-para-daemon process <session_file>
pi-para-daemon process-all
pi-para-daemon process-recent --hours 24
```

### Processing Pipeline

```
Session file (.jsonl)
  │
  ├─ 1. Check: already processed? (state DB)
  │     → skip if hash unchanged since last processing
  │
  ├─ 2. Check: worth processing? (quick heuristic)
  │     → count messages, tool calls, content size
  │     → skip if < 4 messages AND < 200 chars AND no tool calls
  │
  ├─ 3. Detect scope
  │     → from session header cwd → git repo name or dirname
  │
  ├─ 4. Load existing wiki pages for this scope
  │     → provides context for dedup
  │
  ├─ 5. Process via RLM (for large sessions) or direct LLM (for small)
  │     → small (<60K chars): single MiniMax call
  │     → large (>60K chars): dspy.RLM with chunking via REPL
  │
  ├─ 6. Parse structured output (JSON pages)
  │
  ├─ 7. Dedup against existing wiki pages
  │     → for each page: search qmd for similar pages
  │     → if found: merge (iterative update)
  │     → if not: create new
  │
  ├─ 8. Write pages to wiki filesystem
  │     → write .md files with frontmatter
  │     → auto-rebuild index.md
  │     → append to log.md and sessions.md
  │
  ├─ 9. Reindex qmd
  │     → store.update() for BM25
  │     → store.embed() for vectors (if providers configured)
  │
  └─ 10. Update state DB
       → mark session as processed with content hash
```

### State Management

The daemon tracks processing state in a SQLite database at `~/.pi/wiki/.daemon.sqlite`:

```sql
CREATE TABLE processed_sessions (
  session_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,       -- sha256 of file content
  processed_at TEXT NOT NULL,       -- ISO timestamp
  scope TEXT,                       -- detected project scope
  pages_created TEXT,               -- JSON array of page slugs
  pages_updated TEXT,               -- JSON array of page slugs
  error TEXT                        -- error message if failed
);

CREATE TABLE daemon_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Keys: last_sweep_at, daemon_pid, daemon_started_at
```

This ensures:
- Sessions are processed exactly once (unless content changes)
- Re-processing happens only when the session file is modified
- Failures are recorded and can be retried
- The daemon can restart without losing state

### Configuration

`~/.pi/wiki/daemon.json`:

```json
{
  "mode": "watch",
  "watchDebounceMs": 30000,
  "scheduleIntervalMin": 15,
  "sessionDirs": ["~/.pi/agent/sessions"],
  "model": "minimax/MiniMax-M2.7-highspeed",
  "rlmMaxIterations": 50,
  "rlmMaxLlmCalls": 100,
  "smallSessionThreshold": 60000,
  "skipThreshold": {
    "minMessages": 4,
    "minChars": 200,
    "requireToolCalls": false
  },
  "logLevel": "info"
}
```

### Session Scope Detection

The daemon detects project scope from the session file path and header:

```
~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-27.jsonl
                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                      encoded cwd → /home/ubuntu/projects/pi-mono → scope: pi-mono
```

Also reads the session header entry:
```json
{"type": "session", "cwd": "/home/ubuntu/projects/pi-mono"}
```

Falls back to:
1. Session header `cwd` → git repo name
2. Session dir name → decode path → basename
3. `"unknown"`

### Extension Changes

The pi-para extension becomes much simpler:

**Remove:**
- `capture.ts` — entirely
- Auto-capture in `session_shutdown` handler
- `/wiki-capture` command
- Standalone Agent creation
- `capturedInSession` state tracking
- `lastCapturedEntryId` state tracking
- All threshold/timeout logic

**Keep:**
- All wiki tools (query, read, write, move, lint, summarize, ingest)
- Context injection (before_agent_start with caching)
- `/wiki`, `/wiki-search`, `/wiki-scope`, `/wiki-lint`, `/wiki-summarize`, `/wiki-ingest` commands
- Status line during tool operations
- Session state for scope

**Simplify `session_shutdown`:**
```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  // Just close the store. No capture, no embedding, no blocking.
  if (store) {
    try { await closeStore(store); } catch {}
    store = null;
  }
});
```

Shutdown becomes instant.

### Communication: Extension ↔ Daemon

The extension and daemon share the wiki directory (`~/.pi/wiki/`). No IPC needed:

- Extension writes pages → daemon's qmd index picks them up on next reindex
- Daemon writes pages → extension's `before_agent_start` context injection picks them up (context dirty flag)
- Both use the same `index.md`, `log.md`, `sessions.md`
- Concurrent write safety: both use atomic file writes (write to temp → rename)

The extension can optionally signal the daemon via a trigger file:
```
touch ~/.pi/wiki/.daemon-trigger   # "hey, I just wrote something, reindex soon"
```

### CLI

```bash
# Start daemon
pi-para-daemon start
pi-para-daemon start --foreground

# Stop daemon
pi-para-daemon stop

# Check status
pi-para-daemon status

# Process manually
pi-para-daemon process <session_file>
pi-para-daemon process-all
pi-para-daemon process-recent --hours 24

# Reprocess failed sessions
pi-para-daemon retry-failed

# Show processing history
pi-para-daemon history
pi-para-daemon history --scope pi-mono
```

---

## Implementation Plan

### Phase 1: Daemon Core

1. `main.py` — CLI with typer, start/stop/status
2. `config.py` — load daemon.json, defaults
3. `queue.py` — SQLite state DB, session queue
4. `watcher.py` — file system watcher (watchdog or polling)
5. `processor.py` — session → knowledge extraction (direct LLM for small, RLM for large)
6. `wiki_writer.py` — write pages, rebuild index, append logs, reindex qmd
7. `minimax_lm.py` — copied from rlm-dspy

### Phase 2: Extension Simplification

8. Remove `capture.ts` and all capture-related code from the extension
9. Simplify `session_shutdown` to just close store
10. Remove `/wiki-capture` command
11. Remove capture-related state tracking
12. Add `/wiki-daemon` command to show daemon status

### Phase 3: Integration

13. Test daemon processing of various session sizes
14. Test concurrent extension writes + daemon writes
15. Add daemon trigger file for extension → daemon signaling
16. End-to-end testing: session → daemon → wiki pages → extension context injection

### Phase 4: Production

17. Systemd service file for daemon auto-start
18. Log rotation
19. Error alerting (notify on repeated failures)
20. Metrics (pages captured, sessions processed, LLM cost tracking)

---

## Cost Estimate

MiniMax-M2.7-highspeed pricing (approximate):
- Input: ~$0.001/1K tokens
- Output: ~$0.002/1K tokens

Per session processing:
- Small session (5K chars): ~$0.005
- Medium session (50K chars): ~$0.02
- Large session via RLM (256K chars, 5 sub-calls): ~$0.10

Daily cost estimate (10 sessions/day): ~$0.20-0.50

---

## Open Questions

1. **Daemon language**: Python (for dspy.RLM) or TypeScript (consistent with extension)? 
   → Python. RLM requires dspy which is Python. The daemon is a separate process anyway.

2. **qmd access**: daemon needs to reindex qmd. Use the Python SDK or shell out to `qmd` CLI?
   → Shell out to `qmd update` and `qmd embed`. Simpler, no qmd Python bindings needed.

3. **Session locking**: what if the daemon tries to process a session that pi is still writing to?
   → Use the debounce (30s after last modification). Also check if a `.lock` file exists.

4. **Multiple pi instances**: what if two pi sessions are running in different projects?
   → No conflict. Each session has its own `.jsonl` file. The daemon processes each independently.

5. **Wiki conflicts**: what if the daemon and extension write the same page simultaneously?
   → Unlikely but possible. Use file locking or accept last-writer-wins (both are additive operations).
