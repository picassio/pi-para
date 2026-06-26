# pi-para Configuration

Canonical user config lives at:

```text
~/.pi/para/config.jsonc
```

The wiki defaults to:

```text
~/.pi/wiki
```

## Precedence

Current implemented precedence:

1. built-in defaults,
2. `~/.pi/para/config.jsonc`,
3. migrated legacy `~/.pi/wiki/config.json` when canonical config is missing,
4. command-specific CLI flags.

Planned/project-level overrides may use `<project>/.pi/para.jsonc` in a later slice.

## Minimal config

```jsonc
{
  "version": 1,
  "wiki": {
    "dir": "~/.pi/wiki",
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
    "judge": "auto"
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

## Credential refs

Config stores references, not secret values.

```text
pi-auth:<provider>   # Pi AuthStorage, e.g. ~/.pi/agent/auth.json
secret:<name>        # ~/.pi/para/secrets.json
none                 # local/no-auth endpoint
```

Examples:

```jsonc
{
  "models": {
    "capture": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "credentialRef": "pi-auth:anthropic"
    }
  }
}
```

```jsonc
{
  "qmd": {
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dims": 1536,
      "apiFormat": "openai",
      "credentialRef": "secret:embedding"
    },
    "rerank": {
      "provider": "jina",
      "model": "jina-reranker-v2-base-multilingual",
      "credentialRef": "secret:rerank"
    }
  }
}
```

Store local secrets with:

```bash
pi-para providers set-secret embedding <key>
pi-para providers set-secret rerank <key>
```

Inspect without leaking values:

```bash
pi-para providers
pi-para doctor
```

## Sections

### `wiki`

| Field | Meaning |
|---|---|
| `dir` | Wiki directory |
| `defaultScope` | Optional default project scope |
| `autoCapture` | Enable session capture features |
| `captureOnCompact` | Queue capture on Pi compaction |
| `captureOnStartup` | Catch up queued captures on startup |

### `context`

Controls wiki context injection and default search behavior.

| Field | Meaning |
|---|---|
| `maxTokens` | Context budget |
| `includeSchema` | Include schema/conventions in context |
| `includeIndex` | Include wiki index summary |
| `searchLimit` | Default search limit |
| `searchGraphBoost` | Enable wikilink graph boost in search |

### `scheduler`

Controls in-process background work. No OS daemon is required.

| Field | Meaning |
|---|---|
| `enabled` | Enable scheduler |
| `startupCatchup` | Enqueue/process missed sessions on startup |
| `intervalMinutes` | Periodic scheduler tick interval |
| `maxConcurrentTasks` | Local concurrency limit |

### `models`

Role-based model selections. Each value is either `"auto"` or a provider profile.

Currently used:

- `capture`: session capture model.

Planned/advanced:

- `summarize`,
- `judge`.

### `qmd`

QMD SDK configuration.

| Field | Meaning |
|---|---|
| `mode` | Always `sdk` for current runtime |
| `embedEnabled` | Whether to run background embeddings |
| `providerConfig` | `pi-para-profiles` or `legacy-qmd-compatible` |
| `embedding` | Optional embedding provider profile |
| `rerank` | Optional rerank provider profile or `null` |

`legacy-qmd-compatible` reads `~/.config/qmd/index.yml` for compatibility.

### `lint`

| Field | Meaning |
|---|---|
| `autoFix` | Default lint autofix behavior |
| `staleDays` | Age threshold for stale pages |

### `webWiki`

Optional browser UI.

| Field | Meaning |
|---|---|
| `enabled` | Show/use WebWiki status |
| `host` | Bind host |
| `port` | Port |
| `launch` | `manual` or `disabled` |

### `gepa`

DSPy GEPA optimizer defaults.

| Field | Meaning |
|---|---|
| `useOptimized` | Load optimized prompt overrides |
| `studentModel` | Proxy/evaluation model |
| `teacherModel` | Reflection/mutation model |
| `judgeModel` | LLM-as-judge model |
| `auto` | Budget preset: `light`, `medium`, `heavy` |
| `threads` | Parallel eval threads |
| `seed` | Reproducibility seed |

## Diagnostics

```bash
pi-para doctor
pi-para doctor --fix
pi-para doctor --test-capture-model
```

Doctor checks config, wiki directory, scheduler DB, secrets permissions, generated-state `.gitignore`, provider profiles, capture model credentials, QMD SDK health, and capture backlog.
