#!/usr/bin/env python3
"""
RLM-based session knowledge capture for pi-para.

Uses dspy.RLM directly with MiniMaxLM (copied from rlm-dspy).
No rlm-dspy dependency — just dspy + anthropic SDK.

Usage:
    python3 rlm_capture.py <session_jsonl> <wiki_dir> <scope_name> [--already-captured slug1,slug2]

Output: JSON to stdout with pages to create/update.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import dspy
import yaml

from minimax_lm import MiniMaxLM


def load_session(session_path: str) -> str:
    """Load and serialize a session JSONL file into readable text."""
    entries = []
    with open(session_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    parts = []
    for entry in entries:
        if entry.get("type") != "message":
            if entry.get("type") == "compaction" and entry.get("summary"):
                parts.append(f"[Compaction Summary]:\n{entry['summary']}")
            continue

        msg = entry.get("message", {})
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role not in ("user", "assistant", "toolResult"):
            continue

        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text_parts = []
            tool_calls = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    text_parts.append(block["text"])
                elif block.get("type") == "thinking" and block.get("thinking"):
                    text_parts.append(f"[thinking] {block['thinking'][:500]}")
                elif block.get("type") == "toolCall":
                    name = block.get("name", "?")
                    args = block.get("arguments", {})
                    args_str = json.dumps(args)
                    if len(args_str) > 500:
                        args_str = args_str[:500] + "..."
                    tool_calls.append(f"{name}({args_str})")
            text = "\n".join(text_parts)
            if tool_calls:
                text += f"\n[Tool calls]: {'; '.join(tool_calls)}"
        else:
            continue

        if not text.strip():
            continue

        if role == "toolResult" and len(text) > 2000:
            text = text[:2000] + "\n[... truncated]"

        role_label = {"user": "User", "assistant": "Assistant", "toolResult": "Tool result"}.get(role, role)
        parts.append(f"[{role_label}]: {text}")

    return "\n\n".join(parts)


def load_wiki_pages(wiki_dir: str, slugs: list[str]) -> str:
    """Load already-captured wiki pages as context."""
    if not slugs:
        return ""

    pages = []
    categories = ["projects", "areas", "resources", "archives"]
    for slug in slugs:
        for cat in categories:
            path = Path(wiki_dir) / cat / f"{slug}.md"
            if path.exists():
                content = path.read_text()
                if content.startswith("---"):
                    end = content.find("---", 3)
                    if end > 0:
                        content = content[end + 3:].strip()
                pages.append(f"### [[{slug}]] ({cat})\n{content[:3000]}")
                break

    if not pages:
        return ""

    return "Already captured wiki pages:\n\n" + "\n\n".join(pages)


def setup_minimax_lm() -> MiniMaxLM:
    """Create MiniMaxLM from qmd config."""
    # Load key from env or qmd config
    api_key = os.environ.get("MINIMAX_CN_API_KEY")
    if not api_key:
        config_path = Path.home() / ".config" / "qmd" / "index.yml"
        if config_path.exists():
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
            chat = cfg.get("providers", {}).get("chat", {})
            if chat.get("key") and "minimaxi.com" in chat.get("url", ""):
                api_key = chat["key"]

    if not api_key:
        print("Error: No MiniMax API key. Set MINIMAX_CN_API_KEY or configure chat provider in ~/.config/qmd/index.yml", file=sys.stderr)
        sys.exit(1)

    os.environ["MINIMAX_CN_API_KEY"] = api_key
    return MiniMaxLM(model="MiniMax-M2.7-highspeed", china=True, max_tokens=8192)


def run_rlm_capture(
    session_text: str,
    wiki_context: str,
    scope_name: str,
    lm: MiniMaxLM,
) -> dict:
    """Run dspy.RLM directly to extract knowledge from session."""

    dspy.configure(lm=lm)

    # Use simple signature — context + query -> answer
    rlm = dspy.RLM(
        "context, query -> answer",
        max_iterations=40,
        max_llm_calls=80,
        max_output_chars=20_000,
        sub_lm=lm,
        verbose=True,
    )

    query = f"""Extract ALL valuable knowledge from this coding session and output as JSON.

For each piece of knowledge, create a wiki page entry. Output a JSON array of objects:
[
  {{
    "category": "projects|areas|resources|archives",
    "slug": "lowercase-hyphenated-name",
    "title": "Human Readable Title",
    "scope": ["{scope_name}"],
    "tags": ["tag1", "tag2"],
    "body": "## Topic\\n...\\n## Key Facts\\n- ...\\n## Insights\\n- ...\\n## Sources\\n- ..."
  }}
]

Capture ANY of these:
- Architecture decisions and rationale
- Debugging solutions (root cause + fix)
- Server/infrastructure details (IPs, paths, configs)
- Build and deployment procedures
- Tool configurations and setup steps
- Project conventions and coding patterns
- Dependencies and version constraints
- Operational knowledge (how to restart, deploy, rollback)

{wiki_context if wiki_context else "No pages captured yet."}

If pages are already captured, focus on NEW knowledge not yet in those pages.
Output ONLY the JSON array. No other text. Call SUBMIT() with the JSON array."""

    # Build context string
    context = session_text

    try:
        result = rlm(context=context, query=query)
        answer = result.answer.strip()
    except Exception as e:
        return {"pages": [], "error": str(e), "iterations": 0}

    # Extract JSON from potential markdown code blocks
    if "```" in answer:
        lines = answer.split("\n")
        in_block = False
        json_lines = []
        for line in lines:
            if line.strip().startswith("```"):
                in_block = not in_block
                continue
            if in_block:
                json_lines.append(line)
        if json_lines:
            answer = "\n".join(json_lines)

    # Try to find JSON array in the answer
    start = answer.find("[")
    end = answer.rfind("]")
    if start >= 0 and end > start:
        answer = answer[start:end + 1]

    try:
        pages = json.loads(answer)
        if isinstance(pages, list):
            return {"pages": pages, "error": None}
        return {"pages": [], "error": f"Expected array, got {type(pages).__name__}"}
    except json.JSONDecodeError as e:
        return {"pages": [], "error": f"JSON parse error: {e}\nRaw: {answer[:500]}"}


def main():
    parser = argparse.ArgumentParser(description="RLM-based session knowledge capture")
    parser.add_argument("session_jsonl", help="Path to session .jsonl file")
    parser.add_argument("wiki_dir", help="Path to wiki directory")
    parser.add_argument("scope_name", help="Project scope name")
    parser.add_argument("--already-captured", default="",
                        help="Comma-separated slugs of already-captured pages")

    args = parser.parse_args()

    # Setup MiniMax LM
    lm = setup_minimax_lm()

    # Load and serialize session
    print(f"Loading session: {args.session_jsonl}", file=sys.stderr)
    session_text = load_session(args.session_jsonl)
    print(f"Session serialized: {len(session_text)} chars", file=sys.stderr)

    if not session_text.strip():
        json.dump({"pages": [], "error": "empty session"}, sys.stdout)
        return

    # Load already-captured wiki pages
    already_captured = [s.strip() for s in args.already_captured.split(",") if s.strip()]
    wiki_context = load_wiki_pages(args.wiki_dir, already_captured)

    # Run RLM capture
    print("Running RLM capture (MiniMax-M2.7-highspeed)...", file=sys.stderr)
    result = run_rlm_capture(session_text, wiki_context, args.scope_name, lm)

    if result.get("error"):
        print(f"RLM error: {result['error']}", file=sys.stderr)

    print(f"RLM result: {len(result.get('pages', []))} pages", file=sys.stderr)
    json.dump(result, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
