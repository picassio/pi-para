"""Build trainset/valset from real wiki pages.

Each example pairs a synthetic task context (derived from the page topic)
with the actual page body as expected output. The proxy module runs the
instruction on the task context; the metric scores how well the output
matches the gold page.
"""

from __future__ import annotations

import random
from typing import Any

import dspy

from wiki_reader import WikiPage, load_all_pages, get_wiki_stats


# -- Task context generators --------------------------------------------------

def _capture_context(page: WikiPage) -> str:
    """Generate a synthetic capture-style task context from a wiki page."""
    scope_str = ", ".join(page.scope) if page.scope else "unknown"
    tags_str = ", ".join(page.tags[:5]) if page.tags else ""
    # Simulate what a session about this topic would look like
    return (
        f"A coding session about '{page.title}' in the {scope_str} project. "
        f"Topics covered: {tags_str}. "
        f"Extract and organize the key knowledge from this session into a wiki page."
    )


def _ingest_context(page: WikiPage) -> str:
    """Generate a synthetic ingest-style task context."""
    return (
        f"Ingest the following source material about '{page.title}' "
        f"into the PARA wiki. Organize into a structured page with "
        f"proper frontmatter, sections, and cross-references."
    )


def _query_context(page: WikiPage) -> str:
    """Generate a synthetic query-style task context."""
    return (
        f"The user asked about '{page.title}'. "
        f"Search results returned pages related to: {', '.join(page.scope)}. "
        f"Synthesize a helpful answer citing specific wiki pages."
    )


def _maintenance_context(page: WikiPage) -> str:
    """Generate a synthetic maintenance-style task context."""
    link_count = len(page.links)
    return (
        f"Review the wiki page '{page.title}' ({page.category}/{page.slug}). "
        f"It has {link_count} outgoing links, scope [{', '.join(page.scope)}], "
        f"tags [{', '.join(page.tags[:5])}]. "
        f"Check for correct categorization, missing links, and content quality."
    )


def _tool_context(page: WikiPage) -> str:
    """Generate a task context for tool instruction optimization."""
    return (
        f"A user wants to work with the wiki page '{page.title}' "
        f"in category '{page.category}', scope [{', '.join(page.scope)}]. "
        f"Guide them on how to use wiki tools effectively."
    )


def _skill_context(page: WikiPage) -> str:
    """Generate a task context for skill optimization."""
    return (
        f"Working on a task related to '{page.title}' in the {', '.join(page.scope)} project. "
        f"Apply the PARA knowledge management methodology to this work."
    )


# Target type → context generator
CONTEXT_GENERATORS = {
    "capture": _capture_context,
    "ingest": _ingest_context,
    "query": _query_context,
    "maintenance": _maintenance_context,
    "tool": _tool_context,
    "skill": _skill_context,
    "system": _capture_context,  # system prompts use capture-style context
}


# -- Dataset builder -----------------------------------------------------------

def build_dataset(
    wiki_dir: str,
    target_type: str = "capture",
    max_examples: int = 50,
    val_ratio: float = 0.4,
    seed: int = 42,
) -> tuple[list[dspy.Example], list[dspy.Example]]:
    """Build train/val datasets from real wiki pages.

    Args:
        wiki_dir: Path to wiki directory (e.g. ~/.pi/wiki)
        target_type: Type of target being optimized (capture, ingest, query, etc.)
        max_examples: Maximum total examples
        val_ratio: Fraction of examples for validation
        seed: Random seed for reproducible splits

    Returns:
        (trainset, valset) — lists of dspy.Example
    """
    pages = load_all_pages(wiki_dir)

    if not pages:
        raise ValueError(f"No wiki pages found in {wiki_dir}")

    # Filter to pages with substantial content (at least 200 chars body)
    good_pages = [p for p in pages if len(p.body) >= 200]

    if len(good_pages) < 4:
        raise ValueError(f"Need at least 4 pages with content, found {len(good_pages)}")

    # Shuffle deterministically
    rng = random.Random(seed)
    rng.shuffle(good_pages)

    # Limit to max_examples
    good_pages = good_pages[:max_examples]

    # Get context generator for this target type
    gen_context = CONTEXT_GENERATORS.get(target_type, _capture_context)

    # Build examples
    examples = []
    for page in good_pages:
        task_context = gen_context(page)

        # Gold output: the actual page body (truncated to keep examples manageable)
        expected_output = page.body[:3000] if len(page.body) > 3000 else page.body

        example = dspy.Example(
            task_context=task_context,
            expected_output=expected_output,
            # Metadata for the metric
            expected_category=page.category,
            expected_scope=",".join(page.scope),
            expected_slug=page.slug,
            expected_title=page.title,
            page_link_count=str(len(page.links)),
        ).with_inputs("task_context")

        examples.append(example)

    # Split into train/val
    split_idx = max(1, int(len(examples) * (1 - val_ratio)))
    trainset = examples[:split_idx]
    valset = examples[split_idx:]

    # Ensure minimum sizes
    if len(trainset) < 2:
        trainset = examples[:max(2, len(examples) // 2)]
        valset = examples[len(trainset):]
    if len(valset) < 2:
        valset = trainset[-2:]  # share a few from train if needed

    return trainset, valset


def get_wiki_context(wiki_dir: str) -> str:
    """Build a wiki context string for the metric/evaluator."""
    stats = get_wiki_stats(wiki_dir)
    pages = load_all_pages(wiki_dir)

    # Build a brief summary of existing pages for context
    page_summaries = []
    for p in pages[:30]:  # Top 30 pages
        first_line = ""
        for line in p.body.split("\n"):
            line = line.strip()
            if line and not line.startswith("#"):
                first_line = line[:100]
                break
        page_summaries.append(f"  - [[{p.slug}]] ({p.category}): {p.title}")

    context = f"""Wiki has {stats['total_pages']} pages across categories: {stats['categories']}.
Scopes: {', '.join(stats['unique_scopes'][:10])}.
Avg links/page: {stats['avg_links_per_page']}.

Existing pages:
{chr(10).join(page_summaries)}"""

    return context
