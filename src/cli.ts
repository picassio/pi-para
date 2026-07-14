#!/usr/bin/env node
/**
 * CLI for pi-para.
 *
 * The old pi-para-daemon commands remain as deprecated compatibility aliases.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";

import { Daemon } from "./daemon.js";
import { StateDB } from "./state.js";
import { RegistryWatcher } from "./watcher.js";
import { formatLegacyDaemonWarning, isLegacyDaemonCommand } from "./cli-legacy.js";

// -- Model setup -------------------------------------------------------------
// Use MiniMax via the same config as qmd-engine

async function createModel(modelArg?: string) {
  const { parse } = await import("yaml");
  const { readFileSync } = await import("node:fs");
  const { getModel, getProviders, getEnvApiKey } = await import("@earendil-works/pi-ai/compat");

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
          const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
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
    const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
    const authStorage = AuthStorage.create();
    const { getModels } = await import("@earendil-works/pi-ai/compat");

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
      const { getModels } = await import("@earendil-works/pi-ai/compat");
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

  if (isLegacyDaemonCommand(command)) {
    console.warn(formatLegacyDaemonWarning(command));
    console.warn("");
  }

  switch (command) {
    case "setup": {
      const dryRun = args.includes("--dry-run");
      const localIdx = args.indexOf("--local");
      const localPath = localIdx >= 0 ? args[localIdx + 1] : undefined;
      const { runSetup, formatSetupResult } = await import("./setup.js");
      const result = await runSetup({ yes: args.includes("--yes"), dryRun, localPath });
      console.log(formatSetupResult(result));
      break;
    }

    case "doctor": {
      const json = args.includes("--json");
      const { runDoctor, formatDoctorResult } = await import("./doctor.js");
      const result = await runDoctor({
        fix: args.includes("--fix"),
        testCaptureModel: args.includes("--test-capture-model"),
      });
      console.log(json ? JSON.stringify(result, null, 2) : formatDoctorResult(result));
      break;
    }

    case "tasks": {
      const sub = args[1] ?? "list";
      const {
        listSchedulerTasks,
        retryFailedSchedulerTasks,
        getSchedulerTask,
        listSchedulerHistory,
        formatQueueItems,
        formatQueueItem,
        formatSchedulerHistory,
      } = await import("./scheduler/controls.js");
      if (sub === "retry") {
        const taskIdx = args.indexOf("--task");
        const taskName = taskIdx >= 0 ? args[taskIdx + 1] : undefined;
        const count = retryFailedSchedulerTasks(wikiDir, { taskName });
        console.log(`Requeued ${count} failed task${count === 1 ? "" : "s"}.`);
      } else if (sub === "show") {
        const id = parseInt(args[2] ?? "", 10);
        if (!Number.isFinite(id)) { console.error("Usage: pi-para tasks show <id>"); process.exit(1); }
        console.log(formatQueueItem(getSchedulerTask(wikiDir, id)));
      } else if (sub === "history") {
        const taskIdx = args.indexOf("--task");
        const limitIdx = args.indexOf("--limit");
        const taskName = taskIdx >= 0 ? args[taskIdx + 1] : undefined;
        const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "20", 10) : 20;
        console.log(formatSchedulerHistory(listSchedulerHistory(wikiDir, { taskName, limit })));
      } else {
        const statusIdx = args.indexOf("--status");
        const status = statusIdx >= 0 ? args[statusIdx + 1] as any : undefined;
        console.log(formatQueueItems(listSchedulerTasks(wikiDir, { status })));
      }
      break;
    }

    case "capture-recent": {
      const hoursIdx = args.indexOf("--hours");
      const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1] ?? "24") : 24;
      const { queueCaptureRecent, formatQueueCaptureRecentResult } = await import("./scheduler/controls.js");
      const result = await queueCaptureRecent({ wikiDir, hours });
      console.log(formatQueueCaptureRecentResult(result));
      console.log("Queued captures run when a Pi session with pi-para is open.");
      break;
    }

    case "providers": {
      const sub = args[1] ?? "list";
      const { readSecretStore, setSecret, removeSecret, redactCredential } = await import("./credentials.js");
      if (sub === "set-secret") {
        const name = args[2];
        const value = args[3];
        if (!name || !value) { console.error("Usage: pi-para providers set-secret <name> <value>"); process.exit(1); }
        await setSecret(name, value);
        console.log(`Stored secret:${name}`);
      } else if (sub === "remove-secret") {
        const name = args[2];
        if (!name) { console.error("Usage: pi-para providers remove-secret <name>"); process.exit(1); }
        await removeSecret(name);
        console.log(`Removed secret:${name}`);
      } else {
        const secrets = await readSecretStore();
        const names = Object.keys(secrets.secrets);
        console.log("pi-para providers");
        console.log("  Credential policy: Pi AuthStorage preferred; pi-para secrets fallback; env vars not used by setup.");
        if (names.length === 0) console.log("  No pi-para local secrets configured.");
        for (const name of names) console.log(`  secret:${name} = ${redactCredential(secrets.secrets[name])}`);
      }
      break;
    }

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
      const json = args.includes("--json");
      const { getPiParaStatus, formatPiParaStatus } = await import("./status.js");
      const result = await getPiParaStatus();
      console.log(json ? JSON.stringify(result, null, 2) : formatPiParaStatus(result));
      break;
    }

    case "legacy-status": {
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
      console.log(`pi-para — PARA wiki extension CLI

Primary commands:
  setup              Configure pi-para for this machine (--yes, --dry-run, --local PATH)
  doctor             Validate install/config/wiki/QMD health (--fix, --json, --test-capture-model)
  tasks              Show scheduler queue (--status queued|running|done|failed)
  tasks show <id>    Show one queued/running/done/failed task payload
  tasks history      Show scheduler history [--task NAME] [--limit N]
  tasks retry        Requeue failed scheduler tasks [--task NAME]
  status             Show config/wiki/scheduler status (--json)
  capture-recent     Queue recent completed sessions for capture (--hours N)
  providers          List credential refs and local secrets
  providers set-secret <name> <value>
  providers remove-secret <name>

Legacy compatibility commands:
  start              Deprecated daemon foreground mode
  stop               Deprecated daemon stop
  legacy-status      Legacy daemon status and recent history
  process <file>     Process a single session file
  process-recent     Process unprocessed sessions (--hours N, default 24)
  retry-failed       Retry all failed sessions
  history            Show processing history (--scope NAME to filter)

Credential policy:
  Use Pi AuthStorage or ~/.pi/para/secrets.json. Setup does not use env vars for API keys.`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
