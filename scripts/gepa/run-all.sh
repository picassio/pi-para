#!/bin/bash
# Run GEPA optimization one target at a time.
# Default: Sonnet for task/judge (fast, cheap), Opus for reflection (smart mutations).
# Each target invocation re-reads auth.json for fresh token.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODEL="${1:-anthropic/claude-sonnet-4-20250514}"
REFLECTION_MODEL="${2:-anthropic/claude-opus-4-6}"
AUTO="${3:-light}"

echo "[gepa-all] Model: $MODEL | Reflection: $REFLECTION_MODEL | Budget: $AUTO"
echo "[gepa-all] Started at $(date)"

# Get target list
TARGETS=$(cd "$PROJECT_DIR" && node dist/cli.js gepa targets 2>/dev/null | awk '{print $1}')

TOTAL=$(echo "$TARGETS" | wc -l)
CURRENT=0
SUCCEEDED=0
FAILED=0

for TARGET in $TARGETS; do
  CURRENT=$((CURRENT + 1))
  echo ""
  echo "================================================================"
  echo "[gepa-all] [$CURRENT/$TOTAL] Optimizing: $TARGET"
  echo "[gepa-all] $(date)"
  echo "================================================================"
  
  cd "$PROJECT_DIR"
  if node dist/cli.js gepa optimize \
    --target "$TARGET" \
    --model "$MODEL" \
    --reflection-model "$REFLECTION_MODEL" \
    --auto "$AUTO" 2>&1; then
    SUCCEEDED=$((SUCCEEDED + 1))
    echo "[gepa-all] ✅ $TARGET done"
  else
    FAILED=$((FAILED + 1))
    echo "[gepa-all] ❌ $TARGET failed"
  fi
  
  # Brief pause between targets to avoid rate limits
  sleep 5
done

echo ""
echo "================================================================"
echo "[gepa-all] ALL DONE at $(date)"
echo "[gepa-all] Succeeded: $SUCCEEDED / $TOTAL, Failed: $FAILED"
echo "================================================================"
