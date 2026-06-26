#!/usr/bin/env bash
set -euo pipefail

# Legacy compatibility wrapper.
#
# Older pi-para docs instructed users to run ./setup.sh. The current setup path
# is cross-platform and daemon-free:
#
#   npx pi-para@latest setup
#   pi-para doctor
#
# This wrapper intentionally does NOT install global QMD, create QMD YAML with
# secrets, or install/start a systemd service. It delegates to the current setup
# command instead.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== pi-para legacy setup wrapper ==="
echo "setup.sh is deprecated. Delegating to the current no-daemon setup flow."
echo ""

if [ -f "$SCRIPT_DIR/dist/cli.js" ]; then
  echo "Using local build: $SCRIPT_DIR/dist/cli.js"
  exec node "$SCRIPT_DIR/dist/cli.js" setup --local "$SCRIPT_DIR" "$@"
fi

if [ -f "$SCRIPT_DIR/scripts/install.sh" ]; then
  echo "Local build not found; using scripts/install.sh (npx pi-para@latest setup)."
  exec bash "$SCRIPT_DIR/scripts/install.sh" "$@"
fi

echo "Could not find dist/cli.js or scripts/install.sh."
echo "Run: npx pi-para@latest setup"
exit 1
