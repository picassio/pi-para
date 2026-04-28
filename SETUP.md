# pi-para Setup Instructions

> This file is designed to be read by pi (the AI agent). Ask pi: "read SETUP.md and set up pi-para"

## Prerequisites

- pi (coding agent) installed and working
- Node.js available (`node --version`)
- Internet access for npm

## Step 1: Install the extension

```bash
pi install @picassio/pi-para
```

Verify it loaded — restart pi and check extensions list. You should see `pi-para` in the `[Extensions]` section.

## Step 2: Install qmd search engine (recommended)

qmd provides hybrid search (BM25 + vector + rerank). Without it, wiki search uses BM25 keyword matching only.

```bash
npm install -g @picassio/qmd
```

Verify: `qmd --version` should print a version number.

## Step 3: Configure search providers

Create `~/.config/qmd/index.yml` with your API providers. Choose based on what keys you have:

### Option A: OpenRouter (embedding) + MiniMax CN (chat)

```yaml
providers:
  embed:
    url: https://openrouter.ai/api/v1
    key: YOUR_OPENROUTER_KEY
    model: openai/text-embedding-3-small
    dims: 768
  chat:
    url: https://api.minimaxi.com/anthropic
    key: YOUR_MINIMAX_CN_KEY
    model: MiniMax-M2.7-highspeed
    api: anthropic
```

### Option B: OpenAI only

```yaml
providers:
  embed:
    url: https://api.openai.com/v1
    key: YOUR_OPENAI_KEY
    model: text-embedding-3-small
    dims: 1536
  chat:
    url: https://api.openai.com/v1
    key: YOUR_OPENAI_KEY
    model: gpt-4o-mini
```

### Option C: No providers (BM25 only)

Skip this step. Wiki search works with keyword matching. No API keys needed.

## Step 4: Configure daemon LLM (optional)

Edit `~/.pi/wiki/config.json` (created after first pi session) and set `daemonModel`:

```json
{
  "daemonModel": "anthropic/claude-sonnet-4"
}
```

If null, the daemon auto-detects from:
1. Pi's API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
2. qmd chat provider from Step 3

## Step 5: Start the background capture daemon

### Linux (systemd — recommended)

Run the setup script from the pi-para install directory:

```bash
# Find the install path
PARA_DIR="$(npm root -g)/@picassio/pi-para"
# Or if installed via pi:
# PARA_DIR="$HOME/.pi/agent/packages/npm/@picassio/pi-para"

cd "$PARA_DIR"

# Install tsx if not present
npm install tsx 2>/dev/null

# Create systemd user service
mkdir -p ~/.config/systemd/user
NODE_BIN="$(dirname "$(which node)")"

cat > ~/.config/systemd/user/pi-para-daemon.service << EOF
[Unit]
Description=pi-para knowledge capture daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$PARA_DIR
ExecStart=$PARA_DIR/node_modules/.bin/tsx src/cli.ts start
Restart=on-failure
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

# Enable, start, and survive SSH logout
systemctl --user daemon-reload
systemctl --user enable pi-para-daemon
systemctl --user start pi-para-daemon
sudo loginctl enable-linger $USER
```

Verify: `systemctl --user status pi-para-daemon`

### macOS / Manual

```bash
cd "$PARA_DIR" && npx tsx src/cli.ts start
```

Keep the terminal open, or use a process manager like pm2.

## Step 6: Verify everything works

In pi, run these commands:

1. `/wiki-settings` — should show config, search engine status, providers, daemon status
2. `/wiki` — should show "Pages: 0 total" (empty wiki)
3. Say: "save to wiki: this is a test page" — should create a page
4. `/wiki` — should show "Pages: 1 total"
5. Say: "search the wiki for test" — should find the test page

## Troubleshooting

### Extension not loading
- Check: `pi list` should show `@picassio/pi-para`
- Try: `pi -e npm:@picassio/pi-para` for a quick test

### qmd not found
- Check: `which qmd` and `qmd --version`
- Install: `npm install -g @picassio/qmd`

### Search not working (no results)
- BM25 works immediately after `wiki_write`
- Vector search needs providers configured in `~/.config/qmd/index.yml`
- Check: `/wiki-settings` shows providers

### Daemon not running
- Check: `systemctl --user status pi-para-daemon`
- Logs: `journalctl --user -u pi-para-daemon -n 20`
- Manual start: `cd <pi-para-dir> && npx tsx src/cli.ts start`

### Vulkan/CMake errors in logs
- These are from qmd's node-llama-cpp dependency (safe to ignore)
- They only appear if no API providers configured
- Fix: configure providers in `~/.config/qmd/index.yml`
