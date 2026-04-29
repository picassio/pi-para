---
name: para
description: Active PARA knowledge management during work. Consult wiki before planning, write decisions as they happen, search for past solutions when debugging, check conventions when reviewing. Use when starting any task, making architecture decisions, debugging problems, or reviewing code.
---

# PARA Active Knowledge

Behavioral guidelines for actively using the PARA wiki during work — not just passively capturing at session end.

**The shift**: Wiki isn't just a record. It's a working tool. Consult it before acting. Write to it while acting.

## 1. PARA Categories — Know What Goes Where

**Most things are resources. Projects and areas are special.**

| Category | What it is | When to create/update |
|----------|-----------|----------------------|
| **resources/** | Reference material — architecture docs, debugging solutions, patterns, configs, how-tos | Default for almost everything. When you learn something, it's probably a resource. |
| **projects/** | A discrete goal with an **end condition** — "Ship feature X by date Y" | When the user defines a goal with a finish line. Update status as milestones are hit. Move to archives when done. |
| **areas/** | An ongoing responsibility with **quality standards** — "Keep wiki healthy", "Monitor prod uptime" | When there's a repeating responsibility that never "finishes". Update with current health/status. |
| **archives/** | Completed or inactive items | Don't create here. Move finished projects here via `wiki_move`. |

Common mistake: putting architecture docs about a project into `projects/`. A page like "pi-para daemon architecture" is a **resource** about pi-para, not a project.

## 2. Before You Start — Consult

**Don't plan from scratch. Check what's already known.**

Before starting any non-trivial task:
- `wiki_query` for the topic, feature area, or technology involved
- Read any relevant pages (architecture decisions, past debugging, conventions)
- Check for existing patterns that should be followed or pitfalls to avoid
- If the wiki has a `projects/` page for this work, read it for goals and constraints

Skip this for trivial tasks (typo fix, single-line change). Use judgment.

## 3. During Work — Write As You Go

**Don't wait for session end. Capture decisions when they're fresh.**

Write to the wiki immediately when you:
- Make an architecture or design decision ("chose X over Y because Z")
- Discover a non-obvious gotcha or constraint
- Solve a debugging problem (root cause + fix)
- Learn how a system actually works (vs. how you assumed)
- Establish a convention or pattern others should follow

Use `wiki_write(mode: 'edit')` for surgical updates to existing pages. Use `wiki_write(mode: 'append')` to add new sections. Don't defer — context and reasoning degrade with time.

## 4. When Debugging — Search First

**Someone may have solved this before.**

Before deep-diving into a bug:
- `wiki_query` for the error message, component name, or symptom
- Check for past debugging pages that describe similar root causes
- Look for operational knowledge (config paths, service dependencies, known failure modes)

After solving:
- Write the root cause + fix to the wiki immediately
- Include the exact error message (makes future searches find it)

## 5. When Reviewing — Check Conventions

**The wiki holds the team's agreed patterns.**

When reviewing or writing code that touches architecture:
- `wiki_query` for conventions in the relevant area
- Check existing architecture decision pages before proposing new approaches
- If you're contradicting an existing decision, note why in the wiki (update the page, don't just ignore it)

## 6. What Not To Do

- Don't dump every thought into the wiki — capture knowledge, not noise
- Don't create new pages when an existing page covers the topic — update it
- Don't skip the search step — duplicate pages degrade the wiki
- Don't include secrets — document WHERE keys are stored, not the values
