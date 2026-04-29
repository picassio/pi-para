/**
 * Slash command registrations for user interaction.
 *
 * Commands: /wiki, /wiki-ingest, /wiki-lint, /wiki-capture,
 *           /wiki-scope, /wiki-search, /wiki-summarize,
 *           /wiki-daemon, /wiki-settings
 */

import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { QMDStore } from "@picassio/qmd";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ProjectScope } from "./scope.js";
import type { LintReport } from "./lint.js";
import { lintWiki } from "./lint.js";
import { listPages, readPage, writePage, movePage, writeIndex, PARA_CATEGORIES } from "./wiki.js";
import type { ParaCategory, PageRef } from "./wiki.js";
import { searchWiki } from "./store.js";
import {
  CURRENT_SCHEMA_VERSION,
  migrateToLatest,
  parseFrontmatter,
  validateFrontmatter,
} from "./frontmatter.js";

// -- Helpers -----------------------------------------------------------------

/** Convert raw text to a kebab-case slug. */
function toKebabSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Convert a slug to title case. */
function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Rebuild index.md from all pages on disk. */
async function rebuildIndexFromDisk(wikiDir: string): Promise<void> {
  const allPages = await listPages(wikiDir);
  const sections: Record<ParaCategory, string[]> = {
    projects: [],
    areas: [],
    resources: [],
    archives: [],
  };
  for (const ref of allPages) {
    const page = await readPage(wikiDir, ref.category, ref.slug);
    const title = page?.frontmatter.title ?? ref.title;
    const summary =
      page?.body
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"))
        ?.trim() ?? "";
    const desc = summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
    sections[ref.category].push(
      `- [[${ref.slug}]] \u2014 ${title}${desc ? ": " + desc : ""}`,
    );
  }
  const indexLines = [
    "# Wiki Index",
    "",
    "## Projects",
    "",
    sections.projects.length > 0
      ? sections.projects.join("\n")
      : "_No active projects yet._",
    "",
    "## Areas",
    "",
    sections.areas.length > 0
      ? sections.areas.join("\n")
      : "_No areas defined yet._",
    "",
    "## Resources",
    "",
    sections.resources.length > 0
      ? sections.resources.join("\n")
      : "_No resources yet._",
    "",
    "## Archives",
    "",
    sections.archives.length > 0
      ? sections.archives.join("\n")
      : "_No archived items._",
  ];
  await writeIndex(wikiDir, indexLines.join("\n"));
}

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
    description: "Capture knowledge from this session into the wiki (runs in background via daemon)",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file found", "warning");
        return;
      }

      // Register the session for daemon capture — runs in background, doesn't block user
      try {
        const registry = join(wikiDir, ".completed-sessions");
        const entry = `${new Date().toISOString()}|${sessionFile}\n`;
        await appendFile(registry, entry);

        ctx.ui.notify(
          "Session queued for wiki capture (daemon will process in background).\n" +
          "Check progress: /wiki-daemon status\n" +
          "Tip: Set \"daemonModel\" in ~/.pi/wiki/config.json for better capture quality.",
          "info",
        );
        ctx.ui.setStatus("pi-para", "wiki: capture queued");
        setTimeout(() => ctx.ui.setStatus("pi-para", undefined), 5000);
      } catch (err) {
        ctx.ui.notify(
          `Failed to queue capture: ${err instanceof Error ? err.message : String(err)}`,
          "error",
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
    description: "Check daemon status and capture history",
    getArgumentCompletions: (prefix) => {
      const cmds = ["status", "history"];
      const filtered = cmds.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      const subcmd = args.trim().split(/\s+/)[0] || "status";

      // Read state directly from the state DB — fast, no subprocess needed
      const { StateDB } = await import("./state.js");
      const state = new StateDB(wikiDir);

      try {
        switch (subcmd) {
          case "status": {
            const pid = state.getState("daemon_pid");
            const startedAt = state.getState("daemon_started_at");
            const history = state.getHistory(undefined, 5);
            const failed = state.getFailed();

            let running = false;
            if (pid) {
              try { process.kill(parseInt(pid), 0); running = true; } catch {}
            }

            const lines = [
              `Daemon: ${running ? `running (PID ${pid})` : "not running"}`,
              startedAt ? `Started: ${startedAt}` : "",
              `Failed: ${failed.length}`,
              "",
              "Recent captures:",
            ];
            if (history.length === 0) {
              lines.push("  (none)");
            } else {
              for (const h of history) {
                const status = h.error
                  ? `ERROR: ${h.error.slice(0, 50)}`
                  : h.pagesCreated.length > 0
                    ? `${h.pagesCreated.length} page(s)`
                    : "skipped";
                lines.push(`  ${h.processedAt.slice(0, 19)} | ${h.scope} | ${status}`);
              }
            }
            ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
            break;
          }
          case "history": {
            const scope = getScope();
            const history = state.getHistory(scope.name, 15);

            if (history.length === 0) {
              ctx.ui.notify(`No capture history for scope: ${scope.name}`, "info");
              break;
            }

            const lines = [`Capture history (${scope.name}):\n`];
            for (const h of history) {
              const status = h.error
                ? `ERROR: ${h.error.slice(0, 60)}`
                : h.pagesCreated.length > 0
                  ? `${h.pagesCreated.length} page(s): ${h.pagesCreated.join(", ")}`
                  : "skipped";
              lines.push(`${h.processedAt.slice(0, 19)} | ${status}`);
            }
            ctx.ui.notify(lines.join("\n"), "info");
            break;
          }
          default:
            ctx.ui.notify(`Usage: /wiki-daemon [status|history]`, "error");
        }
      } finally {
        state.close();
      }
    },
  });

  // ---- /wiki-migrate — batch schema migration ------------------------------

  pi.registerCommand("wiki-migrate", {
    description: "Migrate all wiki pages to the current schema version",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Migrating wiki pages to schema version ${CURRENT_SCHEMA_VERSION}...`, "info");

      const allPages = await listPages(wikiDir);
      let migratedCount = 0;

      for (const ref of allPages) {
        const page = await readPage(wikiDir, ref.category, ref.slug);
        if (!page) continue;

        const version = page.frontmatter.schemaVersion ?? 1;
        if (version >= CURRENT_SCHEMA_VERSION) continue;

        const rawObj = page.frontmatter as unknown as Record<string, unknown>;
        const result = migrateToLatest(rawObj, page.body);

        const migratedFm = result.fm as unknown as import("./wiki.js").PageFrontmatter;
        migratedFm.updated = new Date().toISOString();
        await writePage(wikiDir, {
          category: ref.category,
          slug: ref.slug,
          frontmatter: migratedFm,
          body: result.body,
        });
        migratedCount++;
      }

      ctx.ui.notify(
        migratedCount > 0
          ? `Migrated ${migratedCount} page(s) to schema version ${CURRENT_SCHEMA_VERSION}.`
          : `All ${allPages.length} page(s) already at schema version ${CURRENT_SCHEMA_VERSION}.`,
        "info",
      );
    },
  });

  // ---- /wiki-project — project lifecycle management ------------------------

  pi.registerCommand("wiki-project", {
    description:
      "Create a project page (/wiki-project <name> <goal>) or archive it (/wiki-project done <name>)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);

      if (parts.length === 0 || !parts[0]) {
        ctx.ui.notify(
          "Usage: /wiki-project <name> <goal>\n       /wiki-project done <name>",
          "error",
        );
        return;
      }

      if (parts[0] === "done") {
        // ---------- Archive a project ----------
        const rawName = parts.slice(1).join("-");
        if (!rawName) {
          ctx.ui.notify("Usage: /wiki-project done <name>", "error");
          return;
        }

        const slug = toKebabSlug(rawName);
        if (!slug) {
          ctx.ui.notify(
            "Invalid project name — must contain at least one alphanumeric character.",
            "error",
          );
          return;
        }

        const page = await readPage(wikiDir, "projects", slug);
        if (!page) {
          ctx.ui.notify(`Project not found: projects/${slug}`, "error");
          return;
        }

        const ref: PageRef = {
          category: "projects",
          slug,
          title: page.frontmatter.title,
          path: `projects/${slug}.md`,
        };
        await movePage(wikiDir, ref, "archives");
        await rebuildIndexFromDisk(wikiDir);

        ctx.ui.notify(
          `Archived project: ${page.frontmatter.title} → archives/${slug}`,
          "info",
        );
        return;
      }

      // ---------- Create a new project ----------
      const rawName = parts[0];
      const goal = parts.slice(1).join(" ");

      if (!goal) {
        ctx.ui.notify(
          "Usage: /wiki-project <name> <goal>\n       /wiki-project done <name>",
          "error",
        );
        return;
      }

      const slug = toKebabSlug(rawName);
      if (!slug) {
        ctx.ui.notify(
          "Invalid project name — must contain at least one alphanumeric character.",
          "error",
        );
        return;
      }

      const title = slugToTitle(slug);
      const scope = getScope();
      const now = new Date().toISOString();

      const body = `# ${title}

## Goal
${goal}

## Status
- [ ] Define scope and milestones
- [ ] Implementation
- [ ] Verification

## End Condition
${goal} — verified and complete.

## Connections
(add related wiki pages here)`;

      const frontmatter = validateFrontmatter({
        title,
        para: "projects",
        scope: [scope.name],
        tags: [],
        sources: [],
        created: now,
        updated: now,
        links: [],
      });

      await writePage(wikiDir, {
        category: "projects",
        slug,
        frontmatter,
        body,
      });

      await rebuildIndexFromDisk(wikiDir);

      ctx.ui.notify(
        `Created project: projects/${slug} — "${title}"`,
        "info",
      );
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
          `[Search]  Limit: ${config.searchLimit ?? 10}, Graph boost: ${config.searchGraphBoost ?? true}`,
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
          const sub = await ctx.ui.select("Search Settings", [
            `Limit: ${config.searchLimit ?? 10}`,
            `Graph boost: ${config.searchGraphBoost ?? true}`,
          ]);
          if (sub?.startsWith("Limit")) {
            const val = await ctx.ui.input("Search result limit:", String(config.searchLimit ?? 10));
            if (val) {
              config.searchLimit = parseInt(val) || 10;
              await writeFileAsync(configPath, JSON.stringify(config, null, 2));
              ctx.ui.notify(`Set searchLimit = ${config.searchLimit}`, "info");
            }
          } else if (sub?.startsWith("Graph boost")) {
            config.searchGraphBoost = !(config.searchGraphBoost ?? true);
            await writeFileAsync(configPath, JSON.stringify(config, null, 2));
            ctx.ui.notify(`Set searchGraphBoost = ${config.searchGraphBoost}`, "info");
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
          try {
            const { getProviders, getModels } = await import("@mariozechner/pi-ai");
            const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
            const authStorage = AuthStorage.create();

            // Find providers that have auth configured
            const allProviders = getProviders();
            const availableProviders: string[] = [];
            for (const p of allProviders) {
              if (authStorage.hasAuth(p)) availableProviders.push(p);
            }

            if (availableProviders.length === 0) {
              ctx.ui.notify("No providers configured. Log in with pi first.", "warning");
            } else {
              // Let user pick provider
              const providerChoice = await ctx.ui.select(
                "Select provider",
                ["auto (best available)", ...availableProviders],
              );

              if (providerChoice === "auto (best available)") {
                config.daemonModel = null;
                await writeFileAsync(configPath, JSON.stringify(config, null, 2));
                ctx.ui.notify("Set daemonModel = auto", "info");
              } else if (providerChoice) {
                // Show models for selected provider
                const models = getModels(providerChoice as any)
                  .sort((a: any, b: any) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
                const modelOptions = models.map((m: any) =>
                  `${m.id} (${Math.round((m.contextWindow ?? 0) / 1000)}k ctx${m.reasoning ? ", reasoning" : ""})`
                );
                const modelChoice = await ctx.ui.select(
                  `Select ${providerChoice} model`,
                  modelOptions,
                );
                if (modelChoice) {
                  const modelId = modelChoice.split(" (")[0];
                  config.daemonModel = `${providerChoice}/${modelId}`;
                  await writeFileAsync(configPath, JSON.stringify(config, null, 2));
                  ctx.ui.notify(`Set daemonModel = ${config.daemonModel}`, "info");
                }
              }
            }
          } catch (err) {
            // Fallback to manual input if AuthStorage not available
            const val = await ctx.ui.input(
              "Daemon model (provider/model-id, or empty for auto):",
              config.daemonModel ? String(config.daemonModel) : "",
            );
            config.daemonModel = val?.trim() || null;
            await writeFileAsync(configPath, JSON.stringify(config, null, 2));
            ctx.ui.notify(`Set daemonModel = ${config.daemonModel ?? "auto"}`, "info");
          }
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
