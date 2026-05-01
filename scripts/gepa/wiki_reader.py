"""Read wiki pages from disk for training data.

Parses YAML frontmatter + markdown body from ~/.pi/wiki/{category}/{slug}.md.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml


PARA_CATEGORIES = ("projects", "areas", "resources", "archives")


@dataclass
class WikiPage:
    """A parsed wiki page."""
    category: str
    slug: str
    title: str
    scope: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    body: str = ""
    created: str = ""
    updated: str = ""

    @property
    def path(self) -> str:
        return f"{self.category}/{self.slug}"


def parse_page(filepath: str) -> WikiPage | None:
    """Parse a wiki markdown file into a WikiPage."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except (IOError, OSError):
        return None

    # Split frontmatter from body
    fm_match = re.match(r"^---\s*\n(.*?\n)---\s*\n(.*)", content, re.DOTALL)
    if not fm_match:
        return None

    try:
        fm = yaml.safe_load(fm_match.group(1))
    except yaml.YAMLError:
        return None

    if not isinstance(fm, dict):
        return None

    body = fm_match.group(2).strip()
    path = Path(filepath)
    slug = path.stem
    category = path.parent.name

    return WikiPage(
        category=category,
        slug=slug,
        title=fm.get("title", slug),
        scope=fm.get("scope", []) or [],
        tags=fm.get("tags", []) or [],
        links=fm.get("links", []) or [],
        body=body,
        created=str(fm.get("created", "")),
        updated=str(fm.get("updated", "")),
    )


def load_all_pages(wiki_dir: str) -> list[WikiPage]:
    """Load all wiki pages from disk."""
    pages = []
    for cat in PARA_CATEGORIES:
        cat_dir = os.path.join(wiki_dir, cat)
        if not os.path.isdir(cat_dir):
            continue
        for fname in sorted(os.listdir(cat_dir)):
            if not fname.endswith(".md"):
                continue
            page = parse_page(os.path.join(cat_dir, fname))
            if page:
                pages.append(page)
    return pages


def get_wiki_stats(wiki_dir: str) -> dict:
    """Get summary stats about the wiki."""
    pages = load_all_pages(wiki_dir)
    cat_counts = {}
    all_scopes = set()
    all_tags = set()
    total_links = 0

    for p in pages:
        cat_counts[p.category] = cat_counts.get(p.category, 0) + 1
        all_scopes.update(p.scope)
        all_tags.update(p.tags)
        total_links += len(p.links)

    return {
        "total_pages": len(pages),
        "categories": cat_counts,
        "unique_scopes": sorted(all_scopes),
        "unique_tags": sorted(all_tags)[:20],  # top 20
        "total_links": total_links,
        "avg_links_per_page": round(total_links / max(len(pages), 1), 1),
    }
