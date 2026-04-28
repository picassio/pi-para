#!/bin/bash
# pi-para setup script
# Installs extension via pi/npm, qmd search engine, configures providers, starts daemon

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

# 3. Install pi-para extension
echo ""
echo "Installing pi-para extension..."
if command -v pi &>/dev/null; then
  pi install @picassio/pi-para
  echo "  Installed via pi install"
else
  npm install -g @picassio/pi-para
  # Link into pi extensions dir
  PARA_PATH="$(npm root -g)/@picassio/pi-para"
  mkdir -p ~/.pi/agent/extensions
  ln -sf "$PARA_PATH" ~/.pi/agent/extensions/pi-para
  echo "  Installed via npm + symlinked to ~/.pi/agent/extensions/"
fi

# 4. Configure qmd providers (if not already configured)
echo ""
QMD_CONFIG=~/.config/qmd/index.yml
if [ -f "$QMD_CONFIG" ]; then
  echo "qmd config exists: $QMD_CONFIG"
else
  echo "No qmd config found. Creating template..."
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
  echo "  Created: $QMD_CONFIG"
  echo "  Edit this file to add API keys for hybrid search."
fi

# 5. Install systemd daemon service (Linux only)
echo ""
if command -v systemctl &>/dev/null; then
  echo "Setting up daemon service..."
  mkdir -p ~/.config/systemd/user

  # Use login shell approach — works with any node version manager
  # (mise, nvm, fnm, volta, or system node)
  if ! command -v node &>/dev/null; then
    echo "  Warning: node not found in PATH. Daemon setup skipped."
    echo "  Install Node.js first, then re-run setup."
  else
    cat > ~/.config/systemd/user/pi-para-daemon.service << EOF
[Unit]
Description=pi-para knowledge capture daemon
After=network.target

[Service]
Type=simple
# Login shell inherits PATH from ~/.profile (picks up mise, nvm, fnm, volta, etc.)
ExecStart=/bin/bash -lc 'exec npx pi-para-daemon start'
Restart=on-failure
RestartSec=10
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable pi-para-daemon
    systemctl --user start pi-para-daemon
    sudo loginctl enable-linger "$USER" 2>/dev/null || true
    echo "  Daemon enabled and started (node: $(which node))"
  fi
else
  echo "systemd not available — start daemon manually:"
  echo "  npx @picassio/pi-para daemon start"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Wiki dir:  ~/.pi/wiki/ (created on first pi session)"
echo "Config:    ~/.pi/wiki/config.json (created on first pi session)"
echo "qmd:       ~/.config/qmd/index.yml"
echo ""
echo "Start pi and the extension loads automatically."
echo "Use /wiki-settings to check configuration."
echo "Use /wiki-daemon status to check the background capture daemon."
