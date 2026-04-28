# Wiki Schema

## Page Format

Every wiki page is a markdown file with YAML frontmatter:

```yaml
---
title: Page Title
para: projects | areas | resources | archives
scope:
  - project-name
tags:
  - topic-tag
sources:
  - https://example.com
created: "2026-01-01"
updated: "2026-01-01"
links:
  - other-page-slug
---
```

## PARA Categories

- **resources/**: Reference material, architecture docs, how-tos, patterns, debugging solutions, implementation notes. **Use this for almost everything.** If you're documenting how something works, put it here.
- **areas/**: Ongoing responsibilities with no end date — server configs, deployment procedures, infrastructure. Default scope: `["global"]`.
- **projects/**: ONLY for actual project goals with a defined end date and completion criteria (e.g. "migrate auth to OAuth2"). Do NOT use for documentation about a project's internals. A page about "pi-para daemon architecture" is a resource, not a project.
- **archives/**: Completed or deprecated items. Never create pages here — pages get moved here when done.

### Category decision rule

Ask: "Is this a goal I'm trying to accomplish, or knowledge I'm recording?"
- **Goal with end date** → projects/
- **Knowledge/reference** → resources/
- **Ongoing responsibility** → areas/

## Scope

Scope is the **project name** this page relates to. Must be kebab-case, single token.

✅ Correct: `pi-para`, `qmd`, `pi-mono`, `my-app`
❌ Wrong: `session exploration`, `daemon implementation`, `project structure`

Pages relevant to all projects use `global`.

## Tags

Tags are topic classifiers. Must be kebab-case (no spaces).

✅ Correct: `session-capture`, `lazy-loading`, `architecture`
❌ Wrong: `session files`, `UI component`, `model registry`

Don't duplicate scope values as tags — if scope is `pi-para`, don't also tag `pi-para`.

## Naming Conventions

- Slugs: lowercase, hyphens, no special characters (e.g., `ssl-cert-gotchas`)
- One concept per page

## Wikilinks

Use `[[slug]]` to connect related pages. Every page should link to related pages in a `## Connections` section:

```markdown
## Connections
- [[related-page]] — how this relates
- [[another-page]] — why it's relevant
```

The `links` frontmatter field is auto-synced from body `[[wikilinks]]` — don't set it manually.

## Wiki Summary Format

```markdown
## Topic
[What this page covers]

## Key Facts
- [Established knowledge points]

## Insights
- [Non-obvious findings, patterns, implications]

## Connections
- [[related-page]] — how this relates

## Open Questions
- [Gaps in knowledge, unresolved contradictions]

## Sources
- [Source URLs, file paths, session references]
```

## Updates vs. New Pages

- Update an existing page when new information relates to the same concept
- Create a new page when the concept is distinct enough to stand alone
- When in doubt, create a new page and add [[wikilinks]]

## Secrets

NEVER include secrets in wiki pages:
- API keys, tokens, passwords, private keys
- Connection strings with credentials
- Any value that would be dangerous if exposed

Instead, document WHERE the secret is stored:
- ✅ `API key stored in ~/.config/qmd/index.yml on server 10.88.1.8`
- ❌ `key: sk-or-v1-abc123...`

Secrets are automatically redacted on write. If you see `<REDACTED>` in a page, it was stripped for security.

## Tone

Technical, concise, factual. No fluff.
