#!/usr/bin/env node
/**
 * CLI for pi-para-daemon.
 *
 * Usage:
 *   pi-para-daemon start [--foreground]
 *   pi-para-daemon stop
 *   pi-para-daemon status
 *   pi-para-daemon process <session_file>
 *   pi-para-daemon process-recent [--hours N]
 *   pi-para-daemon retry-failed
 *   pi-para-daemon history [--scope NAME]
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";

import { Daemon } from "./daemon.js";
import { StateDB } from "./state.js";
import { RegistryWatcher } from "./watcher.js";

// -- Model setup -------------------------------------------------------------
// Use MiniMax via the same config as @picassio/qmd

async function createModel(modelArg?: string) {
  const { parse } = await import("yaml");
  const { readFileSync } = await import("node:fs");
  const { getModel, getProviders, getEnvApiKey } = await import("@mariozechner/pi-ai");

  // 1. Try CLI --model arg: "provider/model-id" (e.g. "anthropic/claude-sonnet-4")
  if (modelArg) {
    const [provider, ...rest] = modelArg.split("/");
    const modelId = rest.join("/");
    if (provider && modelId) {
      const model = getModel(provider as any, modelId as any);
      if (model) {
        const getApiKey = async (p: string) => getEnvApiKey(p) ?? "";
        console.log(`[daemon] Using pi model: ${provider}/${modelId} (context: ${model.contextWindow})`);
        return { model, getApiKey };
      }
    }
  }

  // 2. Try pi's model registry — find any provider with an API key
  const providers = getProviders();
  for (const provider of providers) {
    const key = getEnvApiKey(provider);
    if (key) {
      // Pick a cheap/fast model from this provider
      const { getModels } = await import("@mariozechner/pi-ai");
      const models = getModels(provider as any);
      // Prefer non-reasoning models with large context
      const sorted = [...models].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
      const picked = sorted.find(m => !m.reasoning) ?? sorted[0];
      if (picked) {
        const getApiKey = async (p: string) => getEnvApiKey(p) ?? "";
        console.log(`[daemon] Using pi model: ${provider}/${picked.id} (context: ${picked.contextWindow})`);
        return { model: picked, getApiKey };
      }
    }
  }

  // 3. Fall back to qmd config (MiniMax, OpenRouter, etc.)
  const configPath = join(homedir(), ".config", "qmd", "index.yml");
  if (existsSync(configPath)) {
    const cfg = parse(readFileSync(configPath, "utf-8"));
    const chat = cfg?.providers?.chat;
    if (chat?.url && chat?.key) {
      const model = {
        id: chat.model || "MiniMax-M2.7-highspeed",
        name: chat.model || "MiniMax-M2.7-highspeed",
        provider: "custom",
        api: chat.api === "anthropic" ? "anthropic-messages" as const : "openai-completions" as const,
        baseUrl: chat.url,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 196000,
        maxTokens: 8192,
      };
      const getApiKey = async (_provider: string) => chat.key as string;
      console.log(`[daemon] Using qmd provider: ${chat.model} at ${chat.url}`);
      return { model, getApiKey };
    }
  }

  console.error("Error: No LLM available. Set API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) or configure ~/.config/qmd/index.yml");
  process.exit(1);
}

// -- CLI ---------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const wikiDir = join(homedir(), ".pi", "wiki");

  switch (command) {
    case "start": {
      const modelIdx = args.indexOf("--model");
      const modelArg = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
      const { model, getApiKey } = await createModel(modelArg);
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });

      process.on("SIGINT", async () => {
        await daemon.stop();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await daemon.stop();
        process.exit(0);
      });

      await daemon.start();

      // Keep process alive
      await new Promise(() => {});
      break;
    }

    case "stop": {
      const state = new StateDB(wikiDir);
      const pid = state.getState("daemon_pid");
      state.close();
      if (pid) {
        try {
          process.kill(parseInt(pid), "SIGTERM");
          console.log(`Sent SIGTERM to daemon (PID ${pid})`);
        } catch {
          console.log(`Daemon not running (PID ${pid} not found)`);
        }
      } else {
        console.log("No daemon PID recorded.");
      }
      break;
    }

    case "status": {
      const state = new StateDB(wikiDir);
      const pid = state.getState("daemon_pid");
      const startedAt = state.getState("daemon_started_at");
      const history = state.getHistory(undefined, 5);
      const failed = state.getFailed();
      state.close();

      let running = false;
      if (pid) {
        try {
          process.kill(parseInt(pid), 0);
          running = true;
        } catch {}
      }

      console.log(`Daemon: ${running ? `running (PID ${pid})` : "not running"}`);
      if (startedAt) console.log(`Started: ${startedAt}`);
      console.log(`Failed: ${failed.length}`);
      console.log(`\nRecent history:`);
      for (const h of history) {
        const status = h.error ? `ERROR: ${h.error.slice(0, 50)}` : `${h.pagesCreated.length} pages`;
        console.log(`  ${h.processedAt} | ${h.scope} | ${status}`);
      }
      break;
    }

    case "process": {
      const sessionFile = args[1];
      if (!sessionFile) {
        console.error("Usage: pi-para-daemon process <session_file>");
        process.exit(1);
      }
      const modelIdx2 = args.indexOf("--model");
      const modelArg2 = modelIdx2 >= 0 ? args[modelIdx2 + 1] : undefined;
      const { model, getApiKey } = await createModel(modelArg2);
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });
      await daemon.start();
      await daemon.processOne(sessionFile);
      await daemon.stop();
      break;
    }

    case "process-recent": {
      const hoursIdx = args.indexOf("--hours");
      const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1] ?? "24") : 24;
      const cutoff = Date.now() - hours * 60 * 60 * 1000;

      // Find recent sessions from registry
      const watcher = new RegistryWatcher(wikiDir, () => {});
      const entries = watcher.getAllEntries().filter((e) => {
        const ts = new Date(e.timestamp).getTime();
        return ts > cutoff;
      });

      const state = new StateDB(wikiDir);
      const unprocessed = entries.filter((e) => !state.isProcessed(e.sessionPath));
      state.close();

      if (unprocessed.length === 0) {
        console.log(`No unprocessed sessions in the last ${hours} hour(s).`);
        break;
      }

      console.log(`Found ${unprocessed.length} unprocessed session(s)`);
      const { model, getApiKey } = await createModel();
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });
      await daemon.start();
      for (const entry of unprocessed) {
        await daemon.processOne(entry.sessionPath);
      }
      await daemon.stop();
      break;
    }

    case "retry-failed": {
      const { model, getApiKey } = await createModel();
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });
      await daemon.start();
      await daemon.retryFailed();
      await daemon.stop();
      break;
    }

    case "history": {
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const state = new StateDB(wikiDir);
      const history = state.getHistory(scope, 20);
      state.close();

      if (history.length === 0) {
        console.log("No processing history.");
        break;
      }

      for (const h of history) {
        const status = h.error
          ? `ERROR: ${h.error.slice(0, 60)}`
          : h.pagesCreated.length > 0
            ? `${h.pagesCreated.length} page(s): ${h.pagesCreated.join(", ")}`
            : "skipped";
        console.log(`${h.processedAt} | ${h.scope} | ${status}`);
      }
      break;
    }

    default:
      console.log(`pi-para-daemon — background knowledge capture

Commands:
  start              Start the daemon (foreground)
  stop               Stop the running daemon
  status             Show daemon status and recent history
  process <file>     Process a single session file
  process-recent     Process unprocessed sessions (--hours N, default 24)
  retry-failed       Retry all failed sessions
  history            Show processing history (--scope NAME to filter)

Options:
  --model <provider/id>  Use specific model (e.g. anthropic/claude-sonnet-4)

Model resolution order:
  1. --model flag
  2. Pi's model registry (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
  3. ~/.config/qmd/index.yml chat provider (MiniMax, OpenRouter, etc.)`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
