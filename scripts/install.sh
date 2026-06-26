#!/usr/bin/env bash
set -euo pipefail

# pi-para — Interactive Setup
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.sh | bash

PACKAGE="pi-para"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=12

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  local version major minor
  version=$(node -v 2>/dev/null | sed 's/^v//')
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)

  if [ "${major:-0}" -lt "$MIN_NODE_MAJOR" ]; then
    return 1
  fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "${minor:-0}" -lt "$MIN_NODE_MINOR" ]; then
    return 1
  fi
  return 0
}

main() {
  echo ""
  echo "  🗂️  pi-para — Setup"
  echo "  ──────────────────"
  echo ""

  if check_node_version && command -v npx >/dev/null 2>&1; then
    local node_version
    node_version=$(node -v 2>/dev/null | sed 's/^v//')
    echo "  → Using npx (Node $node_version)"
    echo ""

    # Always pin @latest so npx does a registry lookup instead of reusing an
    # older cached package. Redirect stdin from /dev/tty when available so
    # interactive prompts still work under curl | bash.
    if [ -r /dev/tty ]; then
      npx -y "$PACKAGE@latest" setup "$@" </dev/tty
    else
      npx -y "$PACKAGE@latest" setup "$@"
    fi
  else
    echo "  ✗ Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR+ with npx is required."
    echo ""
    echo "  Install Node from https://nodejs.org, then run:"
    echo ""
    echo "    npx $PACKAGE@latest setup"
    echo ""
    exit 1
  fi
}

main "$@"
