#!/usr/bin/env node
/**
 * CLI for pi-para.
 *
 * The pi-para-daemon binary remains only to report the legacy daemon removal.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { formatLegacyDaemonRemoval, isLegacyDaemonBinary, isLegacyDaemonCommand } from "./cli-legacy.js";

// -- CLI ---------------------------------------------------------------------

async function resolveWikiDir(): Promise<string> {
  const defaultWikiDir = join(homedir(), ".pi", "wiki");
  try {
    const { loadParaConfig } = await import("./config.js");
    return (await loadParaConfig()).paths.wikiDir;
  } catch {
    return defaultWikiDir;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (isLegacyDaemonBinary(process.argv[1]) || isLegacyDaemonCommand(command)) {
    console.error(formatLegacyDaemonRemoval(command ?? "pi-para-daemon"));
    process.exitCode = 1;
    return;
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
      const wikiDir = await resolveWikiDir();
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
      const wikiDir = await resolveWikiDir();
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
        console.log("  Credential policy: persisted Pi auth preferred; pi-para secrets fallback; env vars not used by setup.");
        if (names.length === 0) console.log("  No pi-para local secrets configured.");
        for (const name of names) console.log(`  secret:${name} = ${redactCredential(secrets.secrets[name])}`);
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

The legacy daemon commands were removed in 0.7; use tasks and doctor instead.

Credential policy:
  Use persisted Pi auth or ~/.pi/para/secrets.json. Setup does not use env vars for API keys.`);
      break;
  }
}

function isMainModule(entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
