# pi-para Daemon: Background Knowledge Capture

## Architecture Decisions

Decided via interview on 2026-04-28. See [[pi-para-daemon-decisions]].

| Question | Decision |
|---|---|
| Daemon vs cron | **Daemon with file watch** — near-instant processing |
| Capture strategy | **RLM only** — keep iterating until it works |
| Language | **TypeScript** — reuse wiki.ts, store.ts, frontmatter.ts |
| Active session detection | **Completed-sessions registry** — extension writes path on shutdown |
| Mid-session capture | **Accept gap** — daemon handles post-session, LLM handles mid-session best-effort |
| Budget | **No cap** — knowledge worth the cost |
| Timeline | **Build now** — sessions being lost |
| /wiki-capture | **Keep** — use session LLM directly, not standalone Agent |

## Design

### Two Components

**Extension (pi-para)** — lightweight, session-focused:
- Wiki tools (query, read, write, move, lint, summarize, ingest)
- Context injection (before_agent_start)
- `/wiki-capture` → session LLM calls `wiki_write` directly (via `pi.sendUserMessage`)
- On `session_shutdown`: append session path to completed-sessions registry, close store. No capture, no blocking.

**Daemon (pi-para-daemon)** — background worker:
- Watches completed-sessions registry for new entries
- Processes sessions with no time pressure
- Uses pi-agent-core Agent with session-exploration tools (TypeScript RLM equivalent)
- Writes wiki pages via shared wiki.ts modules
- Runs as a long-lived process (systemd/pm2)

### TypeScript RLM Equivalent

Since dspy.RLM is Python-only, the daemon uses `Agent` from `@mariozechner/pi-agent-core` with custom tools that replicate RLM's capabilities:

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: SESSION_EXPLORER_PROMPT,
    model,
    tools: [
      sessionSliceTool,    // read a range of the session: slice(start, end)
      sessionSearchTool,   // grep the session: search("keyword")
      sessionStatsTool,    // get session stats: message count, tool calls, topics
      wikiWriteTool,       // write a wiki page
      wikiQueryTool,       // search existing wiki for dedup
      wikiReadTool,        // read an existing wiki page
    ],
    messages: [],
  },
  getApiKey: ...,
});

// The agent explores the session iteratively:
// 1. Call sessionStats() to understand the session
// 2. Call sessionSearch("architecture") to find relevant sections
// 3. Call sessionSlice(5000, 10000) to read interesting sections
// 4. Call wikiQuery("similar topic") to check for duplicates
// 5. Call wikiWrite(...) to create/update pages
// 6. Repeat until done
await agent.prompt(CAPTURE_INSTRUCTIONS);
```

The session file content is loaded into memory. The tools provide slicing/searching over it. The Agent explores iteratively — same concept as RLM's REPL but in TypeScript with pi's Agent class.

**Advantages over dspy.RLM:**
- Same language, same modules, same tests
- No Python/dspy dependency
- Uses the same model as the extension (MiniMax via `@picassio/qmd` providers or pi's own model registry)
- Agent class is battle-tested in pi-mono
- Tool calls are structured and type-safe

### Session Explorer Tools

```typescript
// Read a slice of the serialized session
sessionSlice(params: { start: number; end: number }): string

// Search the session for a keyword, return matching sections with line numbers  
sessionSearch(params: { query: string; contextLines?: number }): string

// Get session overview: message count, user messages, tool calls, topics mentioned
sessionStats(): string

// Standard wiki tools (shared with extension)
wikiWrite, wikiRead, wikiQuery
```

### Completed-Sessions Registry

`~/.pi/wiki/.completed-sessions` — append-only text file:

```
2026-04-28T03:15:00Z|/home/ubuntu/.pi/agent/sessions/--home-ubuntu--/session1.jsonl
2026-04-28T04:20:00Z|/home/ubuntu/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/session2.jsonl
```

Extension appends on `session_shutdown` (instant, one line). Daemon reads and processes new entries.

### Daemon State

`~/.pi/wiki/.daemon.sqlite`:

```sql
CREATE TABLE processed_sessions (
  session_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  scope TEXT,
  pages_created TEXT,  -- JSON array
  pages_updated TEXT,  -- JSON array
  error TEXT
);
```

### Daemon Process

```
pi-para-daemon
├── src/
│   ├── daemon.ts          # main loop: watch registry, process queue
│   ├── watcher.ts         # watch .completed-sessions for new lines
│   ├── processor.ts       # session → Agent exploration → wiki pages
│   ├── session-tools.ts   # sessionSlice, sessionSearch, sessionStats
│   ├── state.ts           # SQLite state management
│   └── cli.ts             # start/stop/status/process CLI
├── package.json           # depends on @picassio/pi-para (shared modules)
├── tsconfig.json
└── README.md
```

The daemon imports directly from `@picassio/pi-para`:
- `wiki.ts` — readPage, writePage, listPages, readIndex, writeIndex, appendLog
- `store.ts` — openStore, searchWiki, reindex, closeStore
- `frontmatter.ts` — parseFrontmatter, serializeFrontmatter
- `scope.ts` — detectScope from session cwd
- `raw.ts` — appendSessionDigest

### Extension Changes

**Remove from extension:**
- `capture.ts` — entirely
- Standalone Agent in `session_shutdown`
- `capturedInSession` and `lastCapturedEntryId` tracking
- All threshold/timeout logic

**Change `/wiki-capture`:**
```typescript
pi.registerCommand("wiki-capture", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    const topic = args.trim();
    if (topic) {
      pi.sendUserMessage(
        `Save this to the wiki: ${topic}. Use wiki_write to create a page.`
      );
    } else {
      pi.sendUserMessage(
        "Review the recent conversation and save any valuable knowledge to the wiki using wiki_write."
      );
    }
  },
});
```

No standalone Agent. The session LLM handles it — it has full context and can call `wiki_write` directly.

**Simplify `session_shutdown`:**
```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  // 1. Register session as completed (for daemon to process)
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) {
    const registry = join(wikiDir, ".completed-sessions");
    const entry = `${new Date().toISOString()}|${sessionFile}\n`;
    await appendFile(registry, entry);
  }

  // 2. Close store (instant)
  if (store) {
    try { await closeStore(store); } catch {}
    store = null;
  }
});
```

Shutdown becomes instant.

## Implementation Plan

### Phase 1: Extension Simplification
1. Remove `capture.ts` and all capture logic from `index.ts`
2. Change `/wiki-capture` to use `pi.sendUserMessage()`
3. Simplify `session_shutdown` to registry append + store close
4. Remove `capturedInSession`, `lastCapturedEntryId` from state
5. Test: shutdown is instant, `/wiki-capture` works via session LLM

### Phase 2: Daemon Core
6. Create `~/projects/pi-para-daemon/` project
7. `state.ts` — SQLite state DB
8. `watcher.ts` — watch `.completed-sessions` for new lines
9. `session-tools.ts` — sessionSlice, sessionSearch, sessionStats
10. `processor.ts` — Agent with session explorer tools + wiki tools
11. `daemon.ts` — main loop
12. `cli.ts` — start/stop/status/process

### Phase 3: Integration Testing
13. Process small session (< 60K chars)
14. Process large session (256K+ chars)
15. Process session with existing wiki pages (dedup)
16. Concurrent: extension writes + daemon writes
17. Daemon restart recovery

### Phase 4: Production
18. systemd service file
19. Log rotation
20. `/wiki-daemon` command in extension to show daemon status
