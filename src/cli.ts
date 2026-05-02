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

  // 0. Try config.json daemonModel
  if (!modelArg) {
    try {
      const configPath = join(homedir(), ".pi", "wiki", "config.json");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      if (config.daemonModel) {
        modelArg = config.daemonModel;
        console.log(`[daemon] Using model from config.json: ${modelArg}`);
      }
    } catch {
      // No config or no daemonModel — continue to auto-detect
    }
  }

  // 1. Try CLI --model arg or config daemonModel
  if (modelArg) {
    const [provider, ...rest] = modelArg.split("/");
    const modelId = rest.join("/");
    if (provider && modelId) {
      const model = getModel(provider as any, modelId as any);
      if (model) {
        // Resolve API key: try AuthStorage first (OAuth), then env vars
        let authStore: any = null;
        try {
          const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
          authStore = AuthStorage.create();
        } catch {}
        const getApiKey = async (p: string) => {
          if (authStore) {
            const k = await authStore.getApiKey(p);
            if (k) return k;
          }
          return getEnvApiKey(p) ?? "";
        };
        console.log(`[daemon] Using pi model: ${provider}/${modelId} (context: ${model.contextWindow})`);
        return { model, getApiKey };
      }
    }
  }

  // 2. Try pi's auth storage (auth.json) — supports OAuth (Anthropic, GitHub Copilot, etc.)
  try {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
    const authStorage = AuthStorage.create();
    const { getModels } = await import("@mariozechner/pi-ai");

    // Check providers in preference order: anthropic first (best quality)
    const preferredProviders = ["anthropic", "openai", "openrouter", "google-antigravity", "github-copilot"];
    for (const provider of preferredProviders) {
      if (!authStorage.hasAuth(provider)) continue;
      const key = await authStorage.getApiKey(provider);
      if (!key) continue;

      const models = getModels(provider as any);
      const sorted = [...models].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
      const picked = sorted.find(m => !m.reasoning) ?? sorted[0];
      if (picked) {
        const getApiKey = async (p: string) => {
          const k = await authStorage.getApiKey(p);
          return k ?? getEnvApiKey(p) ?? "";
        };
        console.log(`[daemon] Using pi auth: ${provider}/${picked.id} (context: ${picked.contextWindow})`);
        return { model: picked, getApiKey };
      }
    }
  } catch {
    // AuthStorage not available — continue to env/qmd fallback
  }

  // 3. Try env vars
  const providers = getProviders();
  for (const provider of providers) {
    const key = getEnvApiKey(provider);
    if (key) {
      const { getModels } = await import("@mariozechner/pi-ai");
      const models = getModels(provider as any);
      const sorted = [...models].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
      const picked = sorted.find(m => !m.reasoning) ?? sorted[0];
      if (picked) {
        const getApiKey = async (p: string) => getEnvApiKey(p) ?? "";
        console.log(`[daemon] Using env key: ${provider}/${picked.id} (context: ${picked.contextWindow})`);
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

      // Load web wiki config
      let webWiki: { enabled: boolean; host: string; port: number } | undefined;
      try {
        const { readFileSync } = await import("node:fs");
        const configPath = join(homedir(), ".pi", "wiki", "config.json");
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        if (config.webWiki?.enabled) {
          webWiki = {
            enabled: true,
            host: config.webWiki.host ?? "0.0.0.0",
            port: config.webWiki.port ?? 10973,
          };
        }
      } catch {
        // No config or parse error — skip web wiki
      }

      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey, webWiki });

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

    case "gepa": {
      const sub = args[1];
      const { runGEPA, listOptimized, compareTarget, extractTargets } = await import("./gepa/index.js");
      switch (sub) {
        case "optimize": {
          const g = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
          try {
            await runGEPA({
              target: g("--target"),
              studentModel: g("--student-model") ?? g("--model"),
              teacherModel: g("--teacher-model") ?? g("--reflection-model"),
              judgeModel: g("--judge-model"),
              auto: (g("--auto") ?? undefined) as "light" | "medium" | "heavy" | undefined,
              maxMetricCalls: g("--max-metric-calls") ? parseInt(g("--max-metric-calls")!) : undefined,
              threads: g("--threads") ? parseInt(g("--threads")!) : undefined,
              seed: g("--seed") ? parseInt(g("--seed")!) : undefined,
            });
          } catch (err) {
            console.error(`[gepa] Error: ${err instanceof Error ? err.message : err}`);
            process.exit(1);
          }
          break;
        }
        case "list": {
          const items = listOptimized();
          if (items.length === 0) { console.log("No optimized prompts. Run 'gepa optimize' first."); }
          else { for (const i of items) console.log(`  ${i.name}: score=${i.score.toFixed(3)} model=${i.model}`); }
          break;
        }
        case "targets": {
          for (const t of extractTargets()) console.log(`  ${t.name} (${t.type}): ${t.content.length} chars`);
          break;
        }
        case "compare": {
          const name = args[args.indexOf("--target") + 1];
          if (!name) { console.error("Usage: gepa compare --target <name>"); process.exit(1); }
          const d = compareTarget(name);
          if (!d) console.log(`No optimized version for '${name}'.`);
          else { console.log("=== ORIGINAL ===\n" + d.original.slice(0, 500)); console.log("\n=== OPTIMIZED ===\n" + d.optimized.slice(0, 500)); }
          break;
        }
        default:
          console.log(`pi-para-daemon gepa — GEPA prompt optimizer (DSPy GEPA via uv)

Subcommands:
  optimize   Run DSPy GEPA optimization
  list       Show optimized prompts and scores
  targets    List all 22 optimization targets
  compare    Compare original vs optimized for a target

Options (optimize):
  --target <name>           Optimize only this target
  --student-model <spec>    Student LM — runs proxy (default: anthropic/claude-sonnet-4-20250514)
  --teacher-model <spec>    Teacher/reflection LM — proposes mutations (default: anthropic/claude-opus-4-6)
  --judge-model <spec>      Judge LM — scores output (default: same as student)
  --model <spec>            Shorthand for --student-model
  --reflection-model <spec> Shorthand for --teacher-model
  --auto light|medium|heavy Budget preset (default: light)
  --max-metric-calls <N>    Override auto with explicit budget
  --threads <N>             Parallel eval threads (default: 2)
  --seed <N>                Random seed (default: 42)

Config (persistent defaults in ~/.pi/wiki/config.json):
  gepa.studentModel    gepa.teacherModel    gepa.judgeModel
  gepa.auto            gepa.threads         gepa.seed
  gepa.useOptimized    (toggle optimized prompts at runtime)`);
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
  gepa <subcommand>  GEPA prompt optimizer (optimize, list, targets, compare)

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
