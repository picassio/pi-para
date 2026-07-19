# pi-para Provider, Model, Embedding, and API Key Selection Plan

## Goal

Give users a clear, safe way to choose LLMs, embedding providers, rerank providers, models, and credentials during `pi-para setup`, `pi-para config`, and `/wiki-settings` without requiring global QMD CLI or exposing secrets.

## Provider categories

pi-para needs separate provider choices for different jobs:

1. **Capture LLM** — summarizes completed sessions into wiki pages.
2. **Query/summary LLM** — optional answer synthesis, summaries, future RLM flows.
3. **Judge LLM** — lint/evaluation/GEPA judge roles.
4. **Embedding provider** — QMD vector index.
5. **Rerank provider** — optional QMD hybrid/rerank.
6. **GEPA roles** — student, teacher/reflection, judge.

These must be configured independently but setup should offer a simple recommended preset.

## Recommended defaults

If available:

- Capture LLM: `anthropic/claude-sonnet-4-20250514`
- Query/summary LLM: `anthropic/claude-sonnet-4-20250514`
- Judge LLM: `anthropic/claude-sonnet-4-20250514`
- GEPA student: `anthropic/claude-sonnet-4-20250514`
- GEPA teacher/reflection: `anthropic/claude-opus-4-6`
- GEPA judge: `anthropic/claude-sonnet-4-20250514`
- Embeddings: first configured embedding provider; otherwise prompt user.
- Rerank: optional/off by default unless configured.

If Anthropic OAuth/API auth is unavailable, setup should offer provider-specific alternatives from detected Pi providers, then manual provider entry.

## Credential storage model

Do not store secrets in the main JSONC config.

Main config stores a credential reference:

```jsonc
{
  "providers": {
    "llm": {
      "capture": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514",
        "credentialRef": "pi-auth:anthropic"
      }
    },
    "embedding": {
      "default": {
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiFormat": "openai",
        "model": "text-embedding-3-small",
        "dims": 1536,
        "credentialRef": "env:OPENAI_API_KEY"
      }
    }
  }
}
```

Supported credential reference kinds:

| Kind | Example | Use |
|---|---|---|
| `pi-auth:<provider>` | `pi-auth:anthropic` | Preferred. Reuse Pi AuthStorage/OAuth/API key in `~/.pi/agent/auth.json`. |
| `secret:<name>` | `secret:openai-embedding` | Fallback. pi-para local secrets file for providers Pi does not manage. |
| `none` | `none` | Local/no-auth provider. |

Do **not** use environment variables as a primary credential mechanism. pi-para may detect env vars for diagnostics during migration, but setup/settings should not ask users to configure API keys through env vars.

Local secret storage, if user explicitly chooses it:

```text
~/.pi/para/secrets.json
```

Requirements:

- chmod `0600` on POSIX when possible.
- never inside `~/.pi/wiki` git repo.
- never printed in doctor/setup logs.
- issue bundles redact values.
- migration from legacy `~/.config/qmd/index.yml` moves keys to `secrets.json` or leaves legacy file in place with a warning, depending user choice.

## Setup flow for providers

### Step 1 — Detect existing auth

Detect:

- Pi AuthStorage providers: `AuthStorage.create().hasAuth(provider)`.
- legacy QMD provider config in `~/.config/qmd/index.yml`.
- existing `~/.pi/para/secrets.json` entries.
- environment variables only as a diagnostic signal, not as a recommended setup target.

Display only presence, not secret values:

```text
Detected credentials:
  ✓ anthropic via Pi auth
  ✓ openai-embedding via pi-para secrets
  ⚠ legacy qmd embed key in ~/.config/qmd/index.yml
```

### Step 2 — Choose preset

Offer:

1. Recommended: Sonnet for capture/judge, Opus for GEPA teacher.
2. Use Pi default model for all LLM tasks.
3. Low-cost mode.
4. Local/custom providers.
5. Configure manually.

### Step 3 — Configure LLM tasks

For each LLM role:

1. Choose provider from detected providers + manual.
2. Choose credential source:
   - Pi auth (preferred)
   - store local pi-para secret
   - no auth/local
3. Choose model:
   - picker from provider model catalog when available
   - manual model ID fallback
4. Run optional test call.

### Step 4 — Configure embeddings

Embedding provider wizard asks:

1. Provider:
   - OpenAI-compatible endpoint
   - OpenRouter/OpenAI/Minimax/Jina/custom
   - local endpoint
2. Base URL.
3. Credential source.
4. Model ID.
5. Dimensions:
   - auto if known
   - manual otherwise
6. Test embedding call.
7. Run tiny QMD SDK index/search validation.

### Step 5 — Configure rerank

Rerank is optional:

- off by default
- provider/base URL/model/credential same as embeddings
- test call if configured

## `/wiki-settings` UX

Add a `Models and Providers` section:

```text
Models and Providers

LLM roles
  Capture: anthropic/claude-sonnet-4-20250514 via pi-auth:anthropic
  Summary: auto
  Judge: anthropic/claude-sonnet-4-20250514 via pi-auth:anthropic

Search providers
  Embedding: openai/text-embedding-3-small via secret:openai-embedding
  Rerank: off

GEPA
  Student: anthropic/claude-sonnet-4-20250514
  Teacher: anthropic/claude-opus-4-6
  Judge: anthropic/claude-sonnet-4-20250514

Actions
  Test capture LLM
  Test embedding provider
  Test reranker
  Change credential source
  Add custom OpenAI-compatible provider
  Migrate legacy QMD provider config
```

Secret input must be masked where the Pi UI supports masking. If masking is unavailable, warn before accepting input and prefer env vars/Pi auth.

## CLI UX

```bash
pi-para providers list
pi-para providers detect
pi-para providers add llm
pi-para providers add embedding
pi-para providers test capture
pi-para providers test embedding
pi-para providers migrate-qmd

pi-para config set models.capture.provider anthropic
pi-para config set models.capture.model claude-sonnet-4-20250514
pi-para config set models.capture.credentialRef pi-auth:anthropic
```

## Doctor checks

Doctor should report:

- provider role configured/missing
- credential reference resolves/does not resolve
- selected model known/unknown
- embedding dimensions known/missing
- test call success/failure if `--test-providers`
- legacy QMD config contains inline keys
- environment-variable credential usage found and should be migrated
- secrets file permissions too open

Example:

```text
Providers
  ✓ Capture LLM: anthropic/claude-sonnet-4-20250514 via Pi auth
  ✓ Embeddings: openai/text-embedding-3-small via secret:openai-embedding
  ⚠ Rerank: disabled
  ⚠ Legacy QMD config contains provider keys; run pi-para providers migrate-qmd
```

## Runtime resolution

At runtime, resolve credentials based on explicit `credentialRef`:

1. `pi-auth:<provider>` -> Pi AuthStorage/provider OAuth/API-key handling.
2. `secret:<name>` -> `~/.pi/para/secrets.json`.
3. `none` -> no credential, for local/no-auth providers.
4. Legacy fallback -> `~/.config/qmd/index.yml`, only until migration completes.

Do not auto-scan env vars or pick surprising credentials once a role has explicit config. If Pi's own AuthStorage internally supports env fallbacks, pi-para should still prefer persisted Pi auth or pi-para secrets in its setup UI.

## Migration from current config

Current fields:

- `daemonModel` -> `models.capture` and maybe `models.summary`.
- `gepa.*` -> `gepa.*` unchanged but under new config file.
- QMD `providers.embed/chat/rerank` -> provider profiles + credential refs.

Migration modes:

1. Safe/default: keep legacy QMD config, create new config that references it as compatibility.
2. Secure: move keys into `~/.pi/para/secrets.json`, remove inline keys from legacy QMD config after backup.
3. Manual: print instructions and do not move secrets.

## Open questions

1. Whether Pi AuthStorage has a supported public write API for storing arbitrary provider API keys from extension setup. If not, only read Pi auth and use pi-para secrets/env for custom providers.
2. Whether QMD SDK accepts provider config with dynamic key injection at store creation. If not, adapt `src/store.ts` to translate provider profiles into the shape QMD expects.
3. Whether embedding model catalogs should be hardcoded initially or fetched from provider APIs.
