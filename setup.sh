#!/bin/bash
# pi-para setup script
# Installs extension, qmd, configures providers, starts daemon

set -e

echo "=== pi-para setup ==="
echo ""

# 1. Check node
if ! command -v node &>/dev/null; then
  echo "Error: node not found. Install Node.js first."
  exit 1
fi
echo "Node: $(node --version)"

# 2. Install @picassio/qmd globally (search engine)
echo ""
echo "Installing @picassio/qmd..."
if command -v qmd &>/dev/null; then
  echo "  qmd already installed: $(qmd --version 2>/dev/null)"
else
  npm install -g @picassio/qmd
  echo "  qmd installed: $(qmd --version 2>/dev/null)"
fi

# 3. Install extension dependencies
echo ""
echo "Installing pi-para dependencies..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
npm install --omit=dev 2>/dev/null || npm install
echo "  Done"

# 4. Symlink extension
echo ""
echo "Setting up extension symlink..."
mkdir -p ~/.pi/agent/extensions
if [ -L ~/.pi/agent/extensions/pi-para ]; then
  echo "  Symlink already exists"
else
  ln -sf "$SCRIPT_DIR" ~/.pi/agent/extensions/pi-para
  echo "  Linked: ~/.pi/agent/extensions/pi-para -> $SCRIPT_DIR"
fi

# 5. Configure qmd providers (if not already configured)
echo ""
QMD_CONFIG=~/.config/qmd/index.yml
if [ -f "$QMD_CONFIG" ]; then
  echo "qmd config exists: $QMD_CONFIG"
else
  echo "No qmd config found. Creating default..."
  mkdir -p ~/.config/qmd
  cat > "$QMD_CONFIG" << 'YAML'
# qmd search providers
# Uncomment and configure the providers you want to use.
# Without providers, BM25 keyword search still works.

#providers:
#  embed:
#    url: https://api.openai.com/v1
#    key: sk-...
#    model: text-embedding-3-small
#    dims: 1536
#  chat:
#    url: https://api.minimaxi.com/anthropic
#    key: sk-cp-...
#    model: MiniMax-M2.7-highspeed
#    api: anthropic
YAML
  echo "  Created: $QMD_CONFIG (edit to add API keys)"
fi

# 6. Install systemd service (Linux only)
echo ""
if command -v systemctl &>/dev/null; then
  echo "Setting up daemon service..."
  mkdir -p ~/.config/systemd/user

  NODE_BIN="$(dirname "$(which node)")"
  TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"

  if [ ! -f "$TSX_BIN" ]; then
    npm install -D tsx 2>/dev/null
  fi

  cat > ~/.config/systemd/user/pi-para-daemon.service << EOF
[Unit]
Description=pi-para knowledge capture daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$TSX_BIN src/cli.ts start
Restart=on-failure
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable pi-para-daemon
  systemctl --user start pi-para-daemon
  sudo loginctl enable-linger "$USER" 2>/dev/null || true
  echo "  Daemon enabled and started"
  systemctl --user status pi-para-daemon --no-pager 2>&1 | head -5
else
  echo "systemd not available — start daemon manually:"
  echo "  cd $SCRIPT_DIR && npx tsx src/cli.ts start"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Extension: ~/.pi/agent/extensions/pi-para"
echo "Wiki dir:  ~/.pi/wiki/ (created on first pi session)"
echo "Config:    ~/.pi/wiki/config.json"
echo "qmd:       $QMD_CONFIG"
echo ""
echo "Start pi and the extension loads automatically."
echo "Use /wiki-settings to check configuration."
