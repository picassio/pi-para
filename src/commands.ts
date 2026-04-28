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

  // ---- /wiki-settings — view/edit configuration ----------------------------

  pi.registerCommand("wiki-settings", {
    description: "View wiki configuration, providers, and status",
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      // 1. Extension config
      try {
        const configPath = join(wikiDir, "config.json");
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content);
        lines.push(
          "Extension Config (~/.pi/wiki/config.json):",
          `  contextMaxTokens: ${config.contextMaxTokens ?? 4000}`,
          `  lintAutoFix: ${config.lintAutoFix ?? true}`,
          `  lintStaleDays: ${config.lintStaleDays ?? 90}`,
          `  searchLimit: ${config.searchLimit ?? 10}`,
          `  daemonModel: ${config.daemonModel ?? "auto (detect from pi env keys or qmd config)"}`,
        );
      } catch {
        lines.push("Extension Config: defaults (no config.json)");
      }

      // 2. qmd providers
      lines.push("");
      try {
        const { parse } = await import("yaml");
        const { homedir } = await import("node:os");
        const qmdPath = join(homedir(), ".config", "qmd", "index.yml");
        const qmdContent = await readFile(qmdPath, "utf-8");
        const qmd = parse(qmdContent);
        const providers = qmd?.providers ?? {};
        lines.push("Search Providers (~/.config/qmd/index.yml):");
        if (providers.embed) {
          lines.push(`  embed: ${providers.embed.model ?? "?"} at ${providers.embed.url ?? "?"}`);
        } else {
          lines.push("  embed: not configured (BM25 only)");
        }
        if (providers.chat) {
          lines.push(`  chat: ${providers.chat.model ?? "?"} at ${providers.chat.url ?? "?"}`);
        } else {
          lines.push("  chat: not configured");
        }
        if (providers.rerank) {
          lines.push(`  rerank: ${providers.rerank.model ?? "?"} at ${providers.rerank.url ?? "?"}`);
        }
      } catch {
        lines.push("Search Providers: not configured");
      }

      // 3. Current scope
      lines.push("");
      const scope = getScope();
      lines.push(`Scope: ${scope.name} (${scope.source})`);
      lines.push(`  include: ${scope.include.join(", ")}`);

      // 4. Wiki stats
      lines.push("");
      try {
        const pages = await listPages(wikiDir);
        const counts: Record<string, number> = { projects: 0, areas: 0, resources: 0, archives: 0 };
        for (const p of pages) counts[p.category] = (counts[p.category] ?? 0) + 1;
        lines.push(`Wiki: ${pages.length} pages (P:${counts.projects} A:${counts.areas} R:${counts.resources} Ar:${counts.archives})`);
      } catch {
        lines.push("Wiki: not initialized");
      }

      // 5. Daemon status
      lines.push("");
      try {
        const { execSync } = await import("node:child_process");
        const status = execSync("systemctl --user is-active pi-para-daemon 2>/dev/null", { encoding: "utf-8" }).trim();
        lines.push(`Daemon: ${status}`);
      } catch {
        lines.push("Daemon: not running");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
