"""LLM-as-judge metric for GEPA prompt optimization.

Returns dspy.Prediction(score=float, feedback=str) — GEPA reads the
textual feedback to guide instruction evolution.

One LLM judge call per (candidate, example) evaluation.
"""

from __future__ import annotations

import json
import logging
import re

import dspy

logger = logging.getLogger(__name__)

# -- Judge prompt template ----------------------------------------------------

JUDGE_SYSTEM = """You are an expert evaluator for PARA wiki knowledge management prompts and instructions.

You score how well a wiki system's output follows the PARA methodology:
- **Projects/**: Goals with end dates
- **Areas/**: Ongoing responsibilities
- **Resources/**: Reference docs, how-tos, patterns (default for most pages)
- **Archives/**: Completed items

Good wiki output has: structured sections (Topic, Key Facts, Connections), 
[[wikilinks]] to related pages, kebab-case scope/tags, no exposed secrets, 
and clear actionable content."""

JUDGE_PROMPT = """Evaluate the following wiki output produced by an instruction/prompt.

TARGET TYPE: {target_type}
TARGET PURPOSE: {target_purpose}

TASK CONTEXT (input given to the instruction):
{task_context}

PRODUCED OUTPUT (generated using the instruction):
{produced_output}

REFERENCE OUTPUT (real wiki page for comparison):
{expected_output}

Score on these 6 dimensions (each 0.0 to 1.0):

1. **Structure**: Has proper sections (Topic, Key Facts, Connections). Uses markdown headers. Reasonable length (200-5000 chars for body). Not just a wall of text.
2. **PARA Compliance**: Would produce correct category assignment. Scope mentions are kebab-case project names (not topic descriptions). Tags would be kebab-case.
3. **Cross-references**: Mentions or produces [[wikilinks]]. References related concepts. Would include a Connections section.
4. **Security**: Does not expose API keys, tokens, passwords. Documents WHERE secrets are stored, not values.
5. **Completeness**: Covers the topic adequately. Includes key facts. Doesn't miss obvious important aspects.
6. **Actionability**: Output is clear and specific. Follows concrete rules. Not vague or ambiguous.

Respond ONLY with valid JSON (no markdown fences):
{{"dimensions": [{{"name": "structure", "score": 0.0, "feedback": "..."}}, {{"name": "para_compliance", "score": 0.0, "feedback": "..."}}, {{"name": "cross_references", "score": 0.0, "feedback": "..."}}, {{"name": "security", "score": 0.0, "feedback": "..."}}, {{"name": "completeness", "score": 0.0, "feedback": "..."}}, {{"name": "actionability", "score": 0.0, "feedback": "..."}}], "overall_feedback": "..."}}"""


# -- Dimension weights --------------------------------------------------------

DIMENSION_WEIGHTS = {
    "structure": 0.15,
    "para_compliance": 0.20,
    "cross_references": 0.15,
    "security": 0.15,
    "completeness": 0.15,
    "actionability": 0.20,
}

# -- Target purposes ----------------------------------------------------------

TARGET_PURPOSES = {
    "capture": "Guide an LLM to extract knowledge from coding sessions into PARA wiki pages",
    "ingest": "Guide an LLM to organize ingested source material into structured wiki pages",
    "query": "Guide an LLM to synthesize answers from wiki search results with citations",
    "maintenance": "Guide an LLM to maintain wiki quality: dedup, links, categories, staleness",
    "tool": "Describe a wiki tool's purpose so the LLM knows when and how to use it",
    "skill": "Behavioral guidelines for actively using the PARA wiki during work",
    "system": "System prompt for a standalone wiki knowledge management agent",
}


# -- JSON parsing helpers -----------------------------------------------------

def _parse_judge_response(text: str) -> dict | None:
    """Parse JSON from LLM judge response, handling markdown fences."""
    # Strip markdown code fences
    text = text.strip()
    if text.startswith("```"):
        # Remove first and last lines (fences)
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try finding JSON in the text
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return None


def _compute_score(parsed: dict) -> tuple[float, str]:
    """Compute weighted score and formatted feedback from parsed judge response."""
    dimensions = parsed.get("dimensions", [])
    if not dimensions:
        return 0.0, "No dimensions in judge response"

    total_score = 0.0
    total_weight = 0.0
    feedback_parts = []

    for dim in dimensions:
        name = dim.get("name", "unknown")
        score = float(dim.get("score", 0.0))
        fb = dim.get("feedback", "")
        weight = DIMENSION_WEIGHTS.get(name, 1.0 / len(dimensions))

        total_score += score * weight
        total_weight += weight
        feedback_parts.append(f"{name}={score:.1f}: {fb}")

    overall = parsed.get("overall_feedback", "")
    if overall:
        feedback_parts.append(f"Overall: {overall}")

    final_score = total_score / total_weight if total_weight > 0 else 0.0
    feedback = " | ".join(feedback_parts)

    return final_score, feedback[:500]  # Cap feedback length


# -- Judge LM holder ----------------------------------------------------------

_judge_lm: dspy.LM | None = None


def set_judge_lm(lm) -> None:
    """Set the LLM used for judging. Must be called before using the metric."""
    global _judge_lm
    _judge_lm = lm


# -- Main metric function -----------------------------------------------------

def wiki_quality_metric(
    gold: dspy.Example,
    pred: dspy.Prediction | None,
    trace=None,
    pred_name: str | None = None,
    pred_trace=None,
) -> dspy.Prediction:
    """LLM-as-judge metric for wiki output quality.

    Scores on 6 dimensions with rich textual feedback.
    Returns dspy.Prediction(score=float, feedback=str).
    """
    # Handle failed prediction
    if pred is None:
        return dspy.Prediction(
            score=0.0,
            feedback="Prediction failed — no output generated."
        )

    produced_output = getattr(pred, "output", "") or ""
    if not produced_output.strip():
        return dspy.Prediction(
            score=0.0,
            feedback="Empty output — the instruction produced nothing."
        )

    task_context = getattr(gold, "task_context", "")
    expected_output = getattr(gold, "expected_output", "")

    # Determine target type from metadata or default
    target_type = getattr(gold, "target_type", "capture")
    target_purpose = TARGET_PURPOSES.get(target_type, TARGET_PURPOSES["capture"])

    # Truncate for judge context window
    produced_trunc = produced_output[:2000]
    expected_trunc = expected_output[:2000]
    context_trunc = task_context[:500]

    # Build judge prompt
    judge_prompt = JUDGE_PROMPT.format(
        target_type=target_type,
        target_purpose=target_purpose,
        task_context=context_trunc,
        produced_output=produced_trunc,
        expected_output=expected_trunc,
    )

    # Call judge LLM
    judge = _judge_lm or dspy.settings.lm
    if judge is None:
        # Fallback: basic heuristic if no judge LM available
        return _heuristic_fallback(produced_output, expected_output)

    try:
        response = judge(
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user", "content": judge_prompt},
            ],
            temperature=0.0,
            max_tokens=1000,
        )
        response_text = response[0].get("text", "") if response else ""
    except Exception as e:
        logger.warning("Judge LLM call failed: %s", e)
        return _heuristic_fallback(produced_output, expected_output)

    # Parse judge response
    parsed = _parse_judge_response(response_text)
    if not parsed:
        logger.warning("Failed to parse judge response: %s", response_text[:200])
        return _heuristic_fallback(produced_output, expected_output)

    score, feedback = _compute_score(parsed)

    return dspy.Prediction(score=score, feedback=feedback)


def _heuristic_fallback(output: str, expected: str) -> dspy.Prediction:
    """Simple heuristic scoring when judge LLM is unavailable."""
    score = 0.0
    parts = []

    # Structure check
    has_sections = bool(re.search(r"^## ", output, re.MULTILINE))
    if has_sections:
        score += 0.15
    else:
        parts.append("structure=0: no ## sections")

    # Wikilinks check
    has_wikilinks = "[[" in output and "]]" in output
    if has_wikilinks:
        score += 0.15
    else:
        parts.append("cross_refs=0: no [[wikilinks]]")

    # Length check
    if 200 <= len(output) <= 5000:
        score += 0.15
    else:
        parts.append(f"length issue: {len(output)} chars")

    # Security — no obvious secrets
    has_secrets = bool(re.search(r"sk-[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]\s*['\"][^'\"]{10,}", output, re.IGNORECASE))
    if not has_secrets:
        score += 0.15
    else:
        parts.append("security=0: possible secret detected")

    # Content overlap with expected
    expected_words = set(expected.lower().split())
    output_words = set(output.lower().split())
    if expected_words:
        overlap = len(expected_words & output_words) / len(expected_words)
        score += overlap * 0.2
    else:
        score += 0.1

    # Non-empty
    if len(output) > 100:
        score += 0.1

    feedback = " | ".join(parts) if parts else "Heuristic: acceptable output"
    return dspy.Prediction(score=min(score, 1.0), feedback=f"[heuristic] {feedback}")
