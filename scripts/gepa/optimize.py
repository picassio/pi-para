#!/usr/bin/env python3
"""GEPA optimizer for pi-para prompts, tools, and skills.

Usage (via uv):
    uv run --project scripts/gepa scripts/gepa/optimize.py \
        --targets-file ~/.pi/wiki/gepa/input/targets.json \
        --wiki-dir ~/.pi/wiki \
        --output ~/.pi/wiki/gepa/output/results.json \
        --model anthropic/claude-sonnet-4-20250514 \
        --auto light

The TypeScript orchestrator prepares targets.json and reads results.json.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import dspy

# Local imports (same directory)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lm_providers import create_lm
from program import PromptProxy, extract_evolved_instruction
from metric import wiki_quality_metric, set_judge_lm
from dataset import build_dataset, get_wiki_context

logging.basicConfig(
    level=logging.INFO,
    format="[gepa] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# -- Target type mapping -------------------------------------------------------

TARGET_TYPE_MAP = {
    # Prompt templates
    "wiki-system-prompt": "system",
    "ingest-prompt": "ingest",
    "query-prompt": "query",
    "capture-system-prompt": "capture",
    "capture-prompt": "capture",
    "explicit-capture-prompt": "capture",
    "summarize-system-prompt": "system",
    "iterative-update-prompt": "ingest",
    "overview-prompt": "query",
    "lint-prompt": "maintenance",
    "maintenance-system-prompt": "maintenance",
    "processor-capture-prompt": "capture",
    # Tool instructions
    "tool-wiki-ingest": "tool",
    "tool-wiki-query": "tool",
    "tool-wiki-write": "tool",
    "tool-wiki-read": "tool",
    "tool-wiki-summarize": "tool",
    # Skill instructions
    "skill-para": "skill",
    "skill-setup": "skill",
}


def _patch_dspy_parallelizer():
    """Monkey-patch DSPy's ParallelExecutor to handle exceptions properly.
    
    DSPy bug: parallelizer returns exception objects, but Evaluate only
    handles None, causing 'too many values to unpack' errors.
    """
    try:
        from dspy.utils import parallelizer

        original_wrap = parallelizer.ParallelExecutor._wrap_function

        def patched_wrap(self, user_function):
            original_safe_func = original_wrap(self, user_function)
            def safer_func(item):
                result = original_safe_func(item)
                if isinstance(result, Exception):
                    return None
                return result
            return safer_func

        parallelizer.ParallelExecutor._wrap_function = patched_wrap
        logger.info("Applied DSPy parallelizer exception patch")
    except Exception as e:
        logger.warning("Failed to patch parallelizer: %s", e)


def run_gepa(
    target_name: str,
    instruction: str,
    target_type: str,
    wiki_dir: str,
    model_spec: str,
    reflection_model_spec: str | None,
    auto: str = "light",
    max_metric_calls: int | None = None,
    num_threads: int = 2,
    seed: int = 42,
) -> dict:
    """Run GEPA optimization on a single target.

    Args:
        target_name: Target identifier (e.g. 'capture-system-prompt')
        instruction: Current instruction/prompt text
        target_type: Type for dataset/metric (capture, ingest, query, etc.)
        wiki_dir: Path to wiki directory
        model_spec: Model for the proxy (e.g. 'anthropic/claude-sonnet-4-20250514')
        reflection_model_spec: Model for GEPA reflection (defaults to model_spec)
        auto: GEPA budget preset ('light', 'medium', 'heavy')
        max_metric_calls: Override auto with explicit budget
        num_threads: Parallel threads for evaluation
        seed: Random seed

    Returns:
        Result dict with optimized instruction, scores, etc.
    """
    logger.info("Optimizing target: %s (type: %s)", target_name, target_type)

    # 1. Create LM instances
    task_lm = create_lm(model_spec, temperature=0.0)
    reflection_lm = create_lm(
        reflection_model_spec or model_spec,
        temperature=1.0,
        max_tokens=8000,
    )

    # Use the same LM for judging (or a separate one if desired)
    judge_lm = create_lm(model_spec, temperature=0.0)
    set_judge_lm(judge_lm)

    # Configure DSPy with task LM
    dspy.configure(lm=task_lm)

    # 2. Build dataset
    logger.info("Building dataset from wiki pages...")
    try:
        trainset, valset = build_dataset(
            wiki_dir=wiki_dir,
            target_type=target_type,
            max_examples=50,
            val_ratio=0.4,
            seed=seed,
        )
    except ValueError as e:
        logger.error("Dataset build failed: %s", e)
        return {
            "target": target_name,
            "status": "error",
            "error": str(e),
        }

    logger.info("Dataset: %d train, %d val examples", len(trainset), len(valset))

    # 3. Create proxy from instruction
    proxy = PromptProxy.from_instruction(instruction)

    # 4. Compute baseline score
    logger.info("Computing baseline...")
    baseline_scores = []
    for ex in trainset[:min(5, len(trainset))]:
        try:
            pred = proxy(task_context=ex.task_context)
            result = wiki_quality_metric(ex, pred)
            baseline_scores.append(float(result.score))
        except Exception as e:
            logger.debug("Baseline eval failed: %s", e)
            baseline_scores.append(0.0)

    baseline_score = sum(baseline_scores) / len(baseline_scores) if baseline_scores else 0.0
    logger.info("Baseline score: %.3f", baseline_score)

    # 5. Patch DSPy parallelizer
    _patch_dspy_parallelizer()

    # 6. Run GEPA
    logger.info("Starting GEPA optimization (auto=%s)...", auto)

    gepa_kwargs = {
        "metric": wiki_quality_metric,
        "reflection_lm": reflection_lm,
        "reflection_minibatch_size": 3,
        "candidate_selection_strategy": "pareto",
        "skip_perfect_score": True,
        "use_merge": True,
        "num_threads": num_threads,
        "failure_score": 0.0,
        "perfect_score": 1.0,
        "track_stats": True,
        "seed": seed,
    }

    if max_metric_calls:
        gepa_kwargs["max_metric_calls"] = max_metric_calls
    else:
        gepa_kwargs["auto"] = auto

    try:
        optimizer = dspy.GEPA(**gepa_kwargs)
        optimized_proxy = optimizer.compile(
            student=proxy,
            trainset=trainset,
            valset=valset,
        )
    except Exception as e:
        logger.error("GEPA optimization failed: %s", e)
        return {
            "target": target_name,
            "status": "error",
            "error": str(e),
            "baseline_score": baseline_score,
        }

    # 7. Extract results
    evolved_instruction = extract_evolved_instruction(optimized_proxy)

    # Get optimized score
    optimized_score = baseline_score
    if hasattr(optimized_proxy, "detailed_results") and optimized_proxy.detailed_results:
        dr = optimized_proxy.detailed_results
        if hasattr(dr, "val_aggregate_scores") and dr.val_aggregate_scores:
            optimized_score = max(dr.val_aggregate_scores)
    else:
        # Fallback: manually evaluate
        opt_scores = []
        for ex in trainset[:min(5, len(trainset))]:
            try:
                pred = optimized_proxy(task_context=ex.task_context)
                result = wiki_quality_metric(ex, pred)
                opt_scores.append(float(result.score))
            except Exception:
                opt_scores.append(0.0)
        if opt_scores:
            optimized_score = sum(opt_scores) / len(opt_scores)

    improvement = (
        ((optimized_score - baseline_score) / baseline_score * 100)
        if baseline_score > 0 else 0.0
    )

    logger.info(
        "Optimization complete: %.3f → %.3f (%.1f%% improvement)",
        baseline_score, optimized_score, improvement,
    )

    return {
        "target": target_name,
        "status": "success",
        "baseline_score": round(baseline_score, 4),
        "optimized_score": round(optimized_score, 4),
        "improvement_pct": round(improvement, 1),
        "optimized_instruction": evolved_instruction or instruction,
        "original_instruction": instruction[:200] + "..." if len(instruction) > 200 else instruction,
        "model": model_spec,
        "auto": auto,
        "train_size": len(trainset),
        "val_size": len(valset),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# -- CLI entry point -----------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="GEPA optimizer for pi-para")
    parser.add_argument("--targets-file", required=True, help="JSON file with targets to optimize")
    parser.add_argument("--wiki-dir", default=os.path.expanduser("~/.pi/wiki"), help="Wiki directory")
    parser.add_argument("--output", required=True, help="Output JSON file for results")
    parser.add_argument("--model", default="anthropic/claude-sonnet-4-20250514", help="Task/judge model")
    parser.add_argument("--reflection-model", default=None, help="Reflection model (defaults to --model)")
    parser.add_argument("--auto", default="light", choices=["light", "medium", "heavy"], help="GEPA budget")
    parser.add_argument("--max-metric-calls", type=int, default=None, help="Override auto with explicit budget")
    parser.add_argument("--threads", type=int, default=2, help="Parallel eval threads")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--target", default=None, help="Optimize only this target (by name)")

    args = parser.parse_args()

    # Load targets
    with open(args.targets_file, "r") as f:
        targets_data = json.load(f)

    targets = targets_data.get("targets", [])
    if not targets:
        logger.error("No targets in %s", args.targets_file)
        sys.exit(1)

    # Filter to specific target if requested
    if args.target:
        targets = [t for t in targets if t["name"] == args.target]
        if not targets:
            logger.error("Target '%s' not found", args.target)
            sys.exit(1)

    logger.info("Optimizing %d target(s) with model %s, auto=%s", len(targets), args.model, args.auto)

    # Run GEPA for each target
    results = []
    for target in targets:
        name = target["name"]
        instruction = target["content"]
        target_type = TARGET_TYPE_MAP.get(name, "capture")

        result = run_gepa(
            target_name=name,
            instruction=instruction,
            target_type=target_type,
            wiki_dir=args.wiki_dir,
            model_spec=args.model,
            reflection_model_spec=args.reflection_model,
            auto=args.auto,
            max_metric_calls=args.max_metric_calls,
            num_threads=args.threads,
            seed=args.seed,
        )
        results.append(result)

    # Write output
    output_dir = os.path.dirname(args.output)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    output_data = {
        "results": results,
        "model": args.model,
        "auto": args.auto,
        "wiki_dir": args.wiki_dir,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    with open(args.output, "w") as f:
        json.dump(output_data, f, indent=2)

    logger.info("Results written to %s", args.output)

    # Print summary
    print("\n" + "=" * 60)
    print("GEPA Optimization Summary")
    print("=" * 60)
    for r in results:
        status = r.get("status", "unknown")
        if status == "success":
            print(
                f"  {r['target']}: {r['baseline_score']:.3f} → {r['optimized_score']:.3f} "
                f"({r['improvement_pct']:+.1f}%)"
            )
        else:
            print(f"  {r['target']}: ERROR — {r.get('error', 'unknown')}")
    print("=" * 60)


if __name__ == "__main__":
    main()
