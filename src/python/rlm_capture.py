#!/usr/bin/env python3
"""
RLM-based session knowledge capture for pi-para.

Uses dspy.RLM with MiniMaxLM to extract knowledge from arbitrarily
large pi sessions. RLM handles chunking itself via sandboxed Python REPL.

Usage:
    python3 rlm_capture.py <session_jsonl> <wiki_dir> <scope_name> [--already-captured slug1,slug2]
"""

import argparse
import json
import os
import sys
from pathlib import Path

import dspy
import yaml

sys.path.insert(0, str(Path(__file__).parent))
from minimax_lm import MiniMaxLM


def load_session(session_path: str) -> str:
    """Load and serialize a session JSONL file."""
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
                elif block.get("type") == "toolCall":
                    name = block.get("name", "?")
                    args_str = json.dumps(block.get("arguments", {}))
                    if len(args_str) > 300:
                        args_str = args_str[:300] + "..."
                    tool_calls.append(f"{name}({args_str})")
            text = "\n".join(text_parts)
            if tool_calls:
                text += f"\n[Tools]: {'; '.join(tool_calls)}"
        else:
            continue

        if not text.strip():
            continue
        if role == "toolResult" and len(text) > 1000:
            text = text[:1000] + "\n[truncated]"

        label = {"user": "User", "assistant": "Assistant", "toolResult": "Tool"}.get(role, role)
        parts.append(f"[{label}]: {text}")

    return "\n\n".join(parts)


def load_wiki_pages(wiki_dir: str, slugs: list[str]) -> str:
    if not slugs:
        return ""
    pages = []
    for slug in slugs:
        for cat in ["projects", "areas", "resources", "archives"]:
            path = Path(wiki_dir) / cat / f"{slug}.md"
            if path.exists():
                content = path.read_text()
                if content.startswith("---"):
                    end = content.find("---", 3)
                    if end > 0:
                        content = content[end + 3:].strip()
                pages.append(f"[[{slug}]]: {content[:2000]}")
                break
    return "\n\n".join(pages) if pages else ""


def setup_lm() -> MiniMaxLM:
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
        print("Error: No MiniMax API key.", file=sys.stderr)
        sys.exit(1)

    os.environ["MINIMAX_CN_API_KEY"] = api_key
    return MiniMaxLM(model="MiniMax-M2.7-highspeed", china=True, max_tokens=8192)


def run_capture(session_text: str, wiki_context: str, scope: str, lm: MiniMaxLM) -> dict:
    dspy.configure(lm=lm)

    rlm = dspy.RLM(
        "context, query -> answer",
        max_iterations=50,
        max_llm_calls=100,
        max_output_chars=30_000,
        sub_lm=lm,
        verbose=True,
    )

    query = f"""You have a large coding session transcript in the `context` variable ({len(session_text)} chars).
It's too large to process in one llm_query() call. Use Python to work with it efficiently:

1. Use Python string slicing to examine sections: context[:5000], context[5000:10000], etc.
2. Use Python's `in` operator or string methods to search: "keyword" in context, context.find("...")
3. For each interesting section found, use llm_query() on SMALL excerpts (under 20000 chars)
4. Accumulate findings in a Python list

{f"Already captured (skip these topics): {wiki_context}" if wiki_context else ""}

Extract ALL valuable knowledge:
- Architecture decisions, debugging solutions, server details
- Build/deploy procedures, tool configs, package names+versions
- File paths, conventions, operational knowledge

When done, SUBMIT a JSON array:
[{{"category":"projects|areas|resources|archives","slug":"name","title":"Title","scope":["{scope}"],"tags":["t1"],"body":"## Topic\\n...\\n## Key Facts\\n- ..."}}]

If nothing valuable found, SUBMIT: []"""

    try:
        result = rlm(context=session_text, query=query)
        answer = result.answer.strip()
    except Exception as e:
        return {"pages": [], "error": str(e)}

    # Extract JSON
    if "```" in answer:
        lines = answer.split("\n")
        json_lines = []
        in_block = False
        for line in lines:
            if line.strip().startswith("```"):
                in_block = not in_block
                continue
            if in_block:
                json_lines.append(line)
        if json_lines:
            answer = "\n".join(json_lines)

    start = answer.find("[")
    end = answer.rfind("]")
    if start >= 0 and end > start:
        answer = answer[start:end + 1]

    try:
        pages = json.loads(answer)
        return {"pages": pages, "error": None} if isinstance(pages, list) else {"pages": [], "error": "not array"}
    except json.JSONDecodeError as e:
        return {"pages": [], "error": f"JSON: {e}\nRaw: {answer[:500]}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("session_jsonl")
    parser.add_argument("wiki_dir")
    parser.add_argument("scope_name")
    parser.add_argument("--already-captured", default="")
    args = parser.parse_args()

    lm = setup_lm()

    print(f"Loading: {args.session_jsonl}", file=sys.stderr)
    session_text = load_session(args.session_jsonl)
    print(f"Serialized: {len(session_text)} chars", file=sys.stderr)

    if not session_text.strip():
        json.dump({"pages": [], "error": "empty"}, sys.stdout)
        return

    already = [s.strip() for s in args.already_captured.split(",") if s.strip()]
    wiki_context = load_wiki_pages(args.wiki_dir, already)

    print("Running RLM capture...", file=sys.stderr)
    result = run_capture(session_text, wiki_context, args.scope_name, lm)

    if result.get("error"):
        print(f"Error: {result['error']}", file=sys.stderr)
    print(f"Result: {len(result.get('pages', []))} pages", file=sys.stderr)
    json.dump(result, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
