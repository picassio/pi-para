# Wiki Schema

## Page Format

Every wiki page is a markdown file with YAML frontmatter:

```yaml
---
title: Page Title
para: projects | areas | resources | archives
scope:
  - project-name
  - global
tags:
  - topic-tag
sources:
  - https://example.com
  - session:~/.pi/agent/sessions/.../file.jsonl
created: "2026-01-01"
updated: "2026-01-01"
links:
  - other-page-slug
---
```

## PARA Categories

- **projects/**: Active, goal-defined work with an end date. Default scope: current project name.
- **areas/**: Ongoing responsibilities with no end date. Default scope: `["global"]`.
- **resources/**: Reference material, how-tos, patterns. Scope assigned by content analysis.
- **archives/**: Completed, deprecated, or inactive items. Moved from other categories.

## Naming Conventions

- Slugs: lowercase, hyphens, no special characters (e.g., `ssl-cert-gotchas`)
- One concept per page
- Use [[wikilinks]] for cross-references: `[[slug]]`

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

## Index Format

`index.md` is organized by PARA category with one-line summaries per page.

## Log Format

`log.md` uses the heading format: `## [YYYY-MM-DD] operation | summary`

## Tone

Technical, concise, factual. No fluff.

## Updates vs. New Pages

- Update an existing page when new information relates to the same concept
- Create a new page when the concept is distinct enough to stand alone
- When in doubt, create a new page and add [[wikilinks]]

## Archiving

Move projects to archives when:
- The project goal is completed
- No log entries in 90+ days
- Explicitly requested by user
