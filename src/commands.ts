/**
 * Slash command registrations for user interaction.
 *
 * Commands: /wiki, /wiki-ingest, /wiki-lint, /wiki-capture,
 *           /wiki-scope, /wiki-search, /wiki-summarize,
 *           /wiki-daemon, /wiki-settings
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { QMDStore } from "@picassio/qmd";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ProjectScope } from "./scope.js";
import type { LintReport } from "./lint.js";
import { lintWiki } from "./lint.js";
import { listPages, PARA_CATEGORIES } from "./wiki.js";
import type { ParaCategory } from "./wiki.js";
import { searchWiki } from "./store.js";

// -- Helpers -----------------------------------------------------------------

/** Parse log.md and return the last N entries as text lines. */
async function readLastLogEntries(
  wikiDir: string,
  count: number,
): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(join(wikiDir, "log.md"), "utf-8");
  } catch {
    return [];
  }

  // Find all entry start positions (each begins with "## [")
  const starts: number[] = [];
  const pattern = /^## \[/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    starts.push(match.index);
  }

  // Extract the last `count` entries
  const selected = starts.slice(-count);
  const entries: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const start = selected[i];
    const nextIdx = starts.indexOf(start) + 1;
    const end = nextIdx < starts.length ? starts[nextIdx] : content.length;
    entries.push(content.slice(start, end).trim());
  }

  return entries;
}

/** Format lint report for display via notify. */
function formatLintNotify(report: LintReport): string {
  const { issues, fixed, stats } = report;
  const lines: string[] = [];

  lines.push(`Pages: ${stats.totalPages} (${PARA_CATEGORIES.map((c) => `${c}: ${stats.byCategory[c]}`).join(", ")})`);
  lines.push(`Links: ${stats.totalLinks} | Broken: ${stats.brokenLinks} | Orphans: ${stats.orphanPages}`);

  if (fixed.length > 0) {
    lines.push(`Auto-fixed: ${fixed.length} issue(s)`);
    for (const f of fixed.slice(0, 5)) {
      lines.push(`  [fix] ${f.page ?? ""}: ${f.message}`);
    }
    if (fixed.length > 5) {
      lines.push(`  ... and ${fixed.length - 5} more`);
    }
  }

  if (issues.length > 0) {
    lines.push(`Remaining: ${issues.length} issue(s)`);
    for (const issue of issues.slice(0, 10)) {
      lines.push(`  [${issue.severity}] ${issue.page ?? issue.category}: ${issue.message}`);
    }
    if (issues.length > 10) {
      lines.push(`  ... and ${issues.length - 10} more`);
    }
  } else {
    lines.push("Wiki is healthy.");
  }

  return lines.join("\n");
}

// -- Public API --------------------------------------------------------------

/**
 * Register all slash commands with the pi extension API.
 */
export function registerCommands(
  pi: ExtensionAPI,
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  setScope: (scope: ProjectScope) => void,
): void {
  // ---- /wiki — status overview ---------------------------------------------

  pi.registerCommand("wiki", {
    description: "Show wiki status overview (scope, page counts, recent log entries)",
    handler: async (_args, ctx) => {
      const scope = getScope();

      // Page counts by category
      const allPages = await listPages(wikiDir);
      const byCat: Record<string, number> = {};
      for (const cat of PARA_CATEGORIES) {
        byCat[cat] = 0;
      }
      for (const page of allPages) {
        byCat[page.category] = (byCat[page.category] ?? 0) + 1;
      }

      // Last 5 log entries
      const logEntries = await readLastLogEntries(wikiDir, 5);

      const lines: string[] = [];
      lines.push(`Scope: ${scope.name} (${scope.source})`);
      lines.push(`  include: ${scope.include.join(", ")}`);
      if (scope.exclude.length > 0) {
        lines.push(`  exclude: ${scope.exclude.join(", ")}`);
      }
      lines.push("");
      lines.push(`Pages: ${allPages.length} total`);
      for (const cat of PARA_CATEGORIES) {
        lines.push(`  ${cat}: ${byCat[cat]}`);
      }
      lines.push("");

      if (logEntries.length > 0) {
        lines.push("Recent activity:");
        for (const entry of logEntries) {
          // Compact each entry to one line
          const firstLine = entry.split("\n")[0];
          lines.push(`  ${firstLine.replace(/^## /, "")}`);
        }
      } else {
        lines.push("No activity logged yet.");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---- /wiki-ingest — quick ingest shortcut --------------------------------

  pi.registerCommand("wiki-ingest", {
    description: "Ingest a URL or file into the wiki",
    handler: async (args, ctx) => {
      const source = args.trim();
      if (!source) {
        ctx.ui.notify("Usage: /wiki-ingest <url-or-file>", "error");
        return;
      }

      await ctx.waitForIdle();
      pi.sendUserMessage(`Ingest this into the wiki: ${source}`);
    },
  });

  // ---- /wiki-lint — run lint checks ----------------------------------------

  pi.registerCommand("wiki-lint", {
    description: "Run wiki health checks (--report-only to skip auto-fix)",
    getArgumentCompletions: (prefix) => {
      if ("--report-only".startsWith(prefix)) {
        return [{ value: "--report-only", label: "--report-only" }];
      }
      return null;
    },
    handler: async (args, ctx) => {
      const reportOnly = args.trim() === "--report-only";

      ctx.ui.notify("Running wiki lint...", "info");

      const report = await lintWiki(wikiDir, {
        autoFix: !reportOnly,
      });

      ctx.ui.notify(formatLintNotify(report), "info");
    },
  });

  // ---- /wiki-capture — capture via session LLM ----------------------------

  pi.registerCommand("wiki-capture", {
    description: "Capture knowledge from the current session into the wiki",
    handler: async (args, ctx) => {
      const topic = args.trim();
      await ctx.waitForIdle();
      if (topic) {
        pi.sendUserMessage(
          `Save this to the wiki using wiki_write: ${topic}`,
        );
      } else {
        pi.sendUserMessage(
          "Review the recent conversation and save any valuable knowledge to the wiki using wiki_write. Look for architecture decisions, debugging solutions, server details, build procedures, tool configs, and operational knowledge.",
        );
      }
    },
  });

  // ---- /wiki-scope — show or override scope --------------------------------

  pi.registerCommand("wiki-scope", {
    description: "Show or override the current project scope",
    handler: async (args, ctx) => {
      const override = args.trim();

      if (!override) {
        // Show current scope
        const scope = getScope();
        const lines = [
          `Scope: ${scope.name}`,
          `Source: ${scope.source}`,
          `Include: ${scope.include.join(", ")}`,
        ];
        if (scope.exclude.length > 0) {
          lines.push(`Exclude: ${scope.exclude.join(", ")}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Override scope for this session
      const newScope: ProjectScope = {
        name: override,
        include: [override],
        exclude: [],
        source: "config", // treated as explicit override
      };
      setScope(newScope);
      ctx.ui.notify(`Scope overridden to: ${override}`, "info");
    },
  });

  // ---- /wiki-search — quick search -----------------------------------------

  pi.registerCommand("wiki-search", {
    description: "Search the wiki knowledge base",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /wiki-search <query>", "error");
        return;
      }

      const scope = getScope();
      const results = await searchWiki(store, query, {
        scope,
        limit: 10,
      });

      if (results.length === 0) {
        ctx.ui.notify(`No results for "${query}"`, "info");
        return;
      }

      const lines: string[] = [`Search: "${query}" (${results.length} result(s))\n`];
      for (const r of results) {
        const fm = r.frontmatter;
        const scorePct = (r.score * 100).toFixed(0);
        lines.push(`[${scorePct}%] ${fm.title} (${r.page.path})`);
        lines.push(`  ${fm.para} | ${fm.scope.join(", ")} | ${fm.tags.join(", ")}`);
        // Show first 120 chars of snippet
        const snippet = r.snippet.replace(/\n/g, " ").trim();
        if (snippet) {
          lines.push(`  ${snippet.length > 120 ? snippet.slice(0, 117) + "..." : snippet}`);
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---- /wiki-summarize — summarize pages/categories/wiki -------------------

  pi.registerCommand("wiki-summarize", {
    description: "Summarize a page, category, or the entire wiki",
    getArgumentCompletions: (prefix) => {
      // Offer category names and "all" as completions
      const options = [...PARA_CATEGORIES, "all"];
      const filtered = options.filter((o) => o.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((o) => ({ value: o, label: o }))
        : null;
    },
    handler: async (args, ctx) => {
      const target = args.trim() || "all";

      await ctx.waitForIdle();
      pi.sendUserMessage(`Summarize the wiki: target="${target}". Use wiki_summarize tool with target="${target}".`);
    },
  });

  // ---- /wiki-daemon — daemon management ------------------------------------

  pi.registerCommand("wiki-daemon", {
    description: "Manage the background knowledge capture daemon",
    getArgumentCompletions: (prefix) => {
      const cmds = ["start", "stop", "status", "process-recent", "retry-failed", "history"];
      const filtered = cmds.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      const subcmd = args.trim().split(/\s+/)[0] || "status";

      try {
        const { execSync } = await import("node:child_process");
        const daemonBin = join(wikiDir, "..", "..", "projects", "pi-para", "src", "cli.ts");
        const npxTsx = "npx tsx";

        switch (subcmd) {
          case "start": {
            const { spawn } = await import("node:child_process");
            const child = spawn("npx", ["tsx", daemonBin, "start"], {
              cwd: join(wikiDir, "..", "..", "projects", "pi-para"),
              detached: true,
              stdio: "ignore",
            });
            child.unref();
            ctx.ui.notify(`Daemon started (PID ${child.pid})`, "info");
            break;
          }
          case "stop": {
            const output = execSync(`${npxTsx} ${daemonBin} stop 2>&1`, { encoding: "utf-8", timeout: 10000 });
            ctx.ui.notify(output.trim(), "info");
            break;
          }
          case "status": {
            const output = execSync(`${npxTsx} ${daemonBin} status 2>&1`, { encoding: "utf-8", timeout: 10000 });
            ctx.ui.notify(output.trim(), "info");
            break;
          }
          case "process-recent": {
            ctx.ui.notify("Processing recent sessions...", "info");
            const output = execSync(`${npxTsx} ${daemonBin} process-recent 2>&1`, { encoding: "utf-8", timeout: 300000 });
            ctx.ui.notify(output.trim(), "info");
            break;
          }
          case "retry-failed": {
            const output = execSync(`${npxTsx} ${daemonBin} retry-failed 2>&1`, { encoding: "utf-8", timeout: 300000 });
            ctx.ui.notify(output.trim(), "info");
            break;
          }
          case "history": {
            const output = execSync(`${npxTsx} ${daemonBin} history 2>&1`, { encoding: "utf-8", timeout: 10000 });
            ctx.ui.notify(output.trim(), "info");
            break;
          }
          default:
            ctx.ui.notify(`Unknown daemon command: ${subcmd}. Use: start, stop, status, process-recent, retry-failed, history`, "error");
        }
      } catch (err) {
        ctx.ui.notify(`Daemon command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ---- /wiki-settings — interactive configuration --------------------------

  pi.registerCommand("wiki-settings", {
    description: "View and edit wiki configuration",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/wiki-settings requires interactive mode", "error");
        return;
      }

      const { writeFile: writeFileAsync } = await import("node:fs/promises");
      const { parse, stringify } = await import("yaml");
      const { homedir } = await import("node:os");
      const { execSync } = await import("node:child_process");

      // Load current config
      const configPath = join(wikiDir, "config.json");
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(await readFile(configPath, "utf-8"));
      } catch { /* defaults */ }

      // Load qmd config
      const qmdPath = join(homedir(), ".config", "qmd", "index.yml");
      let qmdConfig: Record<string, unknown> = {};
      try {
        qmdConfig = parse(await readFile(qmdPath, "utf-8")) ?? {};
      } catch { /* no qmd config */ }
      const providers = (qmdConfig.providers ?? {}) as Record<string, Record<string, string>>;

      // Check statuses
      let qmdVersion = "";
      try { qmdVersion = execSync("qmd --version 2>/dev/null", { encoding: "utf-8" }).trim(); } catch {}
      let daemonStatus = "not running";
      try { daemonStatus = execSync("systemctl --user is-active pi-para-daemon 2>/dev/null", { encoding: "utf-8" }).trim(); } catch {}

      // Main menu loop
      while (true) {
        const scope = getScope();
        const pageCount = (await listPages(wikiDir).catch(() => [])).length;

        const choice = await ctx.ui.select("Wiki Settings", [
          `[Context] Max tokens: ${config.contextMaxTokens ?? 4000}`,
          `[Search]  Limit: ${config.searchLimit ?? 10}`,
          `[Lint]    Auto-fix: ${config.lintAutoFix ?? true}, Stale days: ${config.lintStaleDays ?? 90}`,
          `[Daemon]  Model: ${config.daemonModel ?? "auto"}`,
          `[WebWiki] ${(config as any).webWiki?.enabled ? `Enabled at http://${(config as any).webWiki?.host ?? "0.0.0.0"}:${(config as any).webWiki?.port ?? 10973}` : "Disabled"}`,
          `[Embed]   ${providers.embed?.model ?? "not configured"} ${providers.embed?.url ? "at " + providers.embed.url : ""}`,
          `[Chat]    ${providers.chat?.model ?? "not configured"} ${providers.chat?.url ? "at " + providers.chat.url : ""}`,
          `[Rerank]  ${providers.rerank?.model ?? "not configured"} ${providers.rerank?.url ? "at " + providers.rerank.url : ""}`,
          `---`,
          `[Status]  Scope: ${scope.name} | Pages: ${pageCount} | qmd: ${qmdVersion || "not installed"} | Daemon: ${daemonStatus}`,
        ]);

        if (!choice) break;

        if (choice.startsWith("[Context]")) {
          const val = await ctx.ui.input("Context max tokens:", String(config.contextMaxTokens ?? 4000));
          if (val) {
            config.contextMaxTokens = parseInt(val) || 4000;
            await writeFileAsync(configPath, JSON.stringify(config, null, 2));
            ctx.ui.notify(`Set contextMaxTokens = ${config.contextMaxTokens}`, "info");
          }
        } else if (choice.startsWith("[Search]")) {
          const val = await ctx.ui.input("Search result limit:", String(config.searchLimit ?? 10));
          if (val) {
            config.searchLimit = parseInt(val) || 10;
            await writeFileAsync(configPath, JSON.stringify(config, null, 2));
            ctx.ui.notify(`Set searchLimit = ${config.searchLimit}`, "info");
          }
        } else if (choice.startsWith("[Lint]")) {
          const sub = await ctx.ui.select("Lint Settings", [
            `Auto-fix: ${config.lintAutoFix ?? true}`,
            `Stale days: ${config.lintStaleDays ?? 90}`,
          ]);
          if (sub?.startsWith("Auto-fix")) {
            config.lintAutoFix = !(config.lintAutoFix ?? true);
            await writeFileAsync(configPath, JSON.stringify(config, null, 2));
            ctx.ui.notify(`Set lintAutoFix = ${config.lintAutoFix}`, "info");
          } else if (sub?.startsWith("Stale")) {
            const val = await ctx.ui.input("Stale days threshold:", String(config.lintStaleDays ?? 90));
            if (val) {
              config.lintStaleDays = parseInt(val) || 90;
              await writeFileAsync(configPath, JSON.stringify(config, null, 2));
              ctx.ui.notify(`Set lintStaleDays = ${config.lintStaleDays}`, "info");
            }
          }
        } else if (choice.startsWith("[Daemon]")) {
          const val = await ctx.ui.input(
            "Daemon model (provider/model-id, or empty for auto):",
            config.daemonModel ? String(config.daemonModel) : "",
          );
          config.daemonModel = val?.trim() || null;
          await writeFileAsync(configPath, JSON.stringify(config, null, 2));
          ctx.ui.notify(`Set daemonModel = ${config.daemonModel ?? "auto"}`, "info");
        } else if (choice.startsWith("[WebWiki]")) {
          const webWiki = (config as any).webWiki ?? { enabled: false, host: "0.0.0.0", port: 10973 };
          const sub = await ctx.ui.select("Web Wiki Settings", [
            `Enabled: ${webWiki.enabled}`,
            `Host: ${webWiki.host}`,
            `Port: ${webWiki.port}`,
          ]);
          if (sub?.startsWith("Enabled")) {
            webWiki.enabled = !webWiki.enabled;
            (config as any).webWiki = webWiki;
            await writeFileAsync(configPath, JSON.stringify(config, null, 2));
            if (webWiki.enabled) {
              // Detect LAN IP
              const { networkInterfaces } = await import("node:os");
              const nets = networkInterfaces();
              let lanIp = webWiki.host;
              for (const ifaces of Object.values(nets)) {
                for (const iface of ifaces ?? []) {
                  if (iface.family === "IPv4" && !iface.internal) {
                    lanIp = iface.address;
                    break;
                  }
                }
              }
              ctx.ui.notify(`Web Wiki enabled at http://${lanIp}:${webWiki.port}\nRestart pi to apply.`, "info");
            } else {
              ctx.ui.notify("Web Wiki disabled. Restart pi to apply.", "info");
            }
          } else if (sub?.startsWith("Host")) {
            const val = await ctx.ui.input("Host (0.0.0.0 for LAN, 127.0.0.1 for local only):", webWiki.host);
            if (val) {
              webWiki.host = val;
              (config as any).webWiki = webWiki;
              await writeFileAsync(configPath, JSON.stringify(config, null, 2));
              ctx.ui.notify(`Set webWiki.host = ${webWiki.host}`, "info");
            }
          } else if (sub?.startsWith("Port")) {
            const val = await ctx.ui.input("Port:", String(webWiki.port));
            if (val) {
              webWiki.port = parseInt(val) || 10973;
              (config as any).webWiki = webWiki;
              await writeFileAsync(configPath, JSON.stringify(config, null, 2));
              ctx.ui.notify(`Set webWiki.port = ${webWiki.port}`, "info");
            }
          }
        } else if (choice.startsWith("[Embed]") || choice.startsWith("[Chat]") || choice.startsWith("[Rerank]")) {
          const providerType = choice.startsWith("[Embed]") ? "embed" : choice.startsWith("[Chat]") ? "chat" : "rerank";
          const current = providers[providerType] ?? {};

          const sub = await ctx.ui.select(`${providerType} provider`, [
            `URL: ${current.url ?? "not set"}`,
            `Key: ${current.key ? current.key.slice(0, 8) + "..." : "not set"}`,
            `Model: ${current.model ?? "not set"}`,
            ...(providerType === "embed" ? [`Dims: ${current.dims ?? "auto"}`] : []),
            ...(providerType === "chat" ? [`API format: ${current.api ?? "openai"}`] : []),
            `Remove this provider`,
          ]);

          if (sub?.startsWith("URL")) {
            const val = await ctx.ui.input(`${providerType} URL:`, current.url ?? "");
            if (val) { current.url = val; providers[providerType] = current; }
          } else if (sub?.startsWith("Key")) {
            const val = await ctx.ui.input(`${providerType} API key:`, "");
            if (val) { current.key = val; providers[providerType] = current; }
          } else if (sub?.startsWith("Model")) {
            const val = await ctx.ui.input(`${providerType} model:`, current.model ?? "");
            if (val) { current.model = val; providers[providerType] = current; }
          } else if (sub?.startsWith("Dims")) {
            const val = await ctx.ui.input("Embedding dimensions:", current.dims ?? "");
            if (val) { current.dims = val; providers[providerType] = current; }
          } else if (sub?.startsWith("API format")) {
            const fmt = await ctx.ui.select("API format", ["openai", "anthropic"]);
            if (fmt) { current.api = fmt; providers[providerType] = current; }
          } else if (sub?.startsWith("Remove")) {
            delete providers[providerType];
          }

          // Save qmd config
          qmdConfig.providers = providers;
          const { mkdirSync } = await import("node:fs");
          mkdirSync(join(homedir(), ".config", "qmd"), { recursive: true });
          await writeFileAsync(qmdPath, stringify(qmdConfig));
          ctx.ui.notify(`Updated ${qmdPath}`, "info");
        } else if (choice.startsWith("---") || choice.startsWith("[Status]")) {
          // Status row — just show, don't edit
          continue;
        }
      }
    },
  });
}
