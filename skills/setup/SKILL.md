---
name: setup
description: Set up pi-para PARA knowledge base extension. Configures no-daemon scheduler runtime, embedded QMD SDK, provider profiles, and diagnostics. Use when user asks to install, set up, or configure pi-para wiki.
---

# pi-para Setup

Read and follow the instructions in `SETUP.md` at the root of the pi-para package.

The setup file is at: `{{skill_dir}}/../../SETUP.md`

Steps:
1. `pi install @picassio/pi-para` (extension)
2. `npm install -g @picassio/qmd` (search engine)
3. Configure `~/.config/qmd/index.yml` (providers)
4. Set `daemonModel` in `~/.pi/wiki/config.json` (daemon LLM)
5. Start systemd daemon service
6. Verify with `/wiki-settings`

Ask the user for their API keys if needed. Check what's already installed before re-installing.
