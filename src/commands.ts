/**
 * Slash command registrations for user interaction.
 *
 * Commands: /wiki, /wiki-ingest, /wiki-lint, /wiki-capture,
 *           /wiki-scope, /wiki-search, /wiki-summarize,
 *           /wiki-scheduler, /wiki-daemon compatibility alias, /wiki-settings
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { QMDStore } from "qmd-engine";
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
import { appendCompletedSession } from "./scheduler/session-capture.js";

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
    description: "Queue this session for scheduler-backed wiki capture",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file found", "warning");
        return;
      }

      // Register the session for scheduler capture — runs in background, doesn't block user
      try {
        await appendCompletedSession(wikiDir, sessionFile);

        ctx.ui.notify(
          "Session queued for wiki capture (scheduler will process when Pi is open).\n" +
          "Check progress: /wiki-scheduler status\n" +
          "Tip: Set the capture model in /wiki-settings for better capture quality.",
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

  // ---- /wiki-scheduler — scheduler/capture queue status ----------------------

  const registerSchedulerStatusCommand = (name: "wiki-scheduler" | "wiki-daemon", legacy: boolean) => {
    pi.registerCommand(name, {
      description: legacy
        ? "Compatibility alias for /wiki-scheduler"
        : "Check scheduler queue, task history, and capture status",
      getArgumentCompletions: (prefix) => {
        const cmds = ["status", "queue", "history", "capture-history"];
        const filtered = cmds.filter((c) => c.startsWith(prefix));
        return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
      },
      handler: async (args, ctx) => {
        const subcmd = args.trim().split(/\s+/)[0] || "status";
        const { listSchedulerTasks, listSchedulerHistory, formatQueueItems, formatSchedulerHistory } = await import("./scheduler/controls.js");
        const { StateDB } = await import("./state.js");

        switch (subcmd) {
          case "status": {
            const queued = listSchedulerTasks(wikiDir, { status: "queued" }).length;
            const running = listSchedulerTasks(wikiDir, { status: "running" }).length;
            const failed = listSchedulerTasks(wikiDir, { status: "failed" }).length;
            const recent = listSchedulerHistory(wikiDir, { limit: 5 });
            const lines = [
              legacy ? "Scheduler: active (via /wiki-daemon compatibility alias)" : "Scheduler: active",
              `Queue: ${queued} queued, ${running} running, ${failed} failed`,
              "",
              "Recent scheduler history:",
              formatSchedulerHistory(recent).split("\n").map((line) => `  ${line}`).join("\n"),
            ];
            ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
            break;
          }
          case "queue": {
            ctx.ui.notify(formatQueueItems(listSchedulerTasks(wikiDir)), "info");
            break;
          }
          case "history": {
            ctx.ui.notify(formatSchedulerHistory(listSchedulerHistory(wikiDir, { limit: 15 })), "info");
            break;
          }
          case "capture-history": {
            const scope = getScope();
            const state = new StateDB(wikiDir);
            try {
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
            } finally {
              state.close();
            }
            break;
          }
          default:
            ctx.ui.notify(`Usage: /${name} [status|queue|history|capture-history]`, "error");
        }
      },
    });
  };

  registerSchedulerStatusCommand("wiki-scheduler", false);
  registerSchedulerStatusCommand("wiki-daemon", true);

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

      const { loadParaConfig, saveParaConfig } = await import("./config.js");
      const {
        modelSelectionLabel,
        providerProfileLabel,
        setContextMaxTokens,
        setSearchLimit,
        setLintStaleDays,
        toggleSearchGraphBoost,
        toggleLintAutoFix,
        setCaptureModelAuto,
        setCaptureModel,
        setWebWikiEnabled,
        setWebWikiHost,
        setWebWikiPort,
        ensureEmbeddingProfile,
        ensureRerankProfile,
        disableRerank,
        setProviderProfileField,
        setProviderDims,
      } = await import("./settings.js");
      const { listSchedulerTasks } = await import("./scheduler/controls.js");
      const { setSecret } = await import("./credentials.js");

      const loaded = await loadParaConfig({ migrate: true });
      const config = loaded.config;
      const persist = async () => saveParaConfig(config, { homeDir: loaded.paths.homeDir });

      while (true) {
        const scope = getScope();
        const pageCount = (await listPages(wikiDir).catch(() => [])).length;
        const queuedTasks = listSchedulerTasks(wikiDir, { status: "queued" }).length;
        const failedTasks = listSchedulerTasks(wikiDir, { status: "failed" }).length;

        const choice = await ctx.ui.select("Wiki Settings", [
          `[Context] Max tokens: ${config.context.maxTokens}`,
          `[Search]  Limit: ${config.context.searchLimit}, Graph boost: ${config.context.searchGraphBoost}`,
          `[Lint]    Auto-fix: ${config.lint.autoFix}, Stale days: ${config.lint.staleDays}`,
          `[Capture] Model: ${modelSelectionLabel(config.models.capture)}`,
          `[WebWiki] ${config.webWiki.enabled ? `Enabled at http://${config.webWiki.host}:${config.webWiki.port}` : "Disabled"}`,
          `[Embedding] ${providerProfileLabel(config.qmd.embedding)}`,
          `[Rerank]  ${providerProfileLabel(config.qmd.rerank)}`,
          `---`,
          `[Status]  Scope: ${scope.name} | Pages: ${pageCount} | qmd: SDK | Scheduler: ${queuedTasks} queued, ${failedTasks} failed`,
        ]);

        if (!choice) break;

        if (choice.startsWith("[Context]")) {
          const val = await ctx.ui.input("Context max tokens:", String(config.context.maxTokens));
          if (val) {
            setContextMaxTokens(config, val);
            await persist();
            ctx.ui.notify(`Set context.maxTokens = ${config.context.maxTokens}`, "info");
          }
        } else if (choice.startsWith("[Search]")) {
          const sub = await ctx.ui.select("Search Settings", [
            `Limit: ${config.context.searchLimit}`,
            `Graph boost: ${config.context.searchGraphBoost}`,
          ]);
          if (sub?.startsWith("Limit")) {
            const val = await ctx.ui.input("Search result limit:", String(config.context.searchLimit));
            if (val) {
              setSearchLimit(config, val);
              await persist();
              ctx.ui.notify(`Set context.searchLimit = ${config.context.searchLimit}`, "info");
            }
          } else if (sub?.startsWith("Graph boost")) {
            toggleSearchGraphBoost(config);
            await persist();
            ctx.ui.notify(`Set context.searchGraphBoost = ${config.context.searchGraphBoost}`, "info");
          }
        } else if (choice.startsWith("[Lint]")) {
          const sub = await ctx.ui.select("Lint Settings", [
            `Auto-fix: ${config.lint.autoFix}`,
            `Stale days: ${config.lint.staleDays}`,
          ]);
          if (sub?.startsWith("Auto-fix")) {
            toggleLintAutoFix(config);
            await persist();
            ctx.ui.notify(`Set lint.autoFix = ${config.lint.autoFix}`, "info");
          } else if (sub?.startsWith("Stale")) {
            const val = await ctx.ui.input("Stale days threshold:", String(config.lint.staleDays));
            if (val) {
              setLintStaleDays(config, val);
              await persist();
              ctx.ui.notify(`Set lint.staleDays = ${config.lint.staleDays}`, "info");
            }
          }
        } else if (choice.startsWith("[Capture]")) {
          try {
            const { getProviders, getModels } = await import("@mariozechner/pi-ai");
            const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
            const authStorage = AuthStorage.create();
            const availableProviders = getProviders().filter((p: string) => authStorage.hasAuth(p));

            if (availableProviders.length === 0) {
              ctx.ui.notify("No Pi auth providers configured. Use /login first or configure a pi-para secret for custom providers.", "warning");
            } else {
              const providerChoice = await ctx.ui.select("Select capture provider", ["auto (best available)", ...availableProviders]);
              if (providerChoice === "auto (best available)") {
                setCaptureModelAuto(config);
                await persist();
                ctx.ui.notify("Set capture model = auto. Restart open Pi sessions to apply.", "info");
              } else if (providerChoice) {
                const models = getModels(providerChoice as any)
                  .sort((a: any, b: any) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
                const modelChoice = await ctx.ui.select(
                  `Select ${providerChoice} model`,
                  models.map((m: any) => `${m.id} (${Math.round((m.contextWindow ?? 0) / 1000)}k ctx${m.reasoning ? ", reasoning" : ""})`),
                );
                if (modelChoice) {
                  setCaptureModel(config, providerChoice, modelChoice.split(" (")[0]);
                  await persist();
                  ctx.ui.notify(`Set capture model = ${modelSelectionLabel(config.models.capture)}. Restart open Pi sessions to apply.`, "info");
                }
              }
            }
          } catch {
            const val = await ctx.ui.input("Capture model (provider/model-id, empty for auto):", modelSelectionLabel(config.models.capture));
            if (!val?.trim()) setCaptureModelAuto(config);
            else {
              const slash = val.indexOf("/");
              if (slash <= 0) {
                ctx.ui.notify("Use provider/model-id format, or leave empty for auto.", "error");
                continue;
              }
              setCaptureModel(config, val.slice(0, slash), val.slice(slash + 1));
            }
            await persist();
            ctx.ui.notify(`Set capture model = ${modelSelectionLabel(config.models.capture)}. Restart open Pi sessions to apply.`, "info");
          }
        } else if (choice.startsWith("[WebWiki]")) {
          const sub = await ctx.ui.select("Web Wiki Settings", [
            `Enabled: ${config.webWiki.enabled}`,
            `Host: ${config.webWiki.host}`,
            `Port: ${config.webWiki.port}`,
          ]);
          if (sub?.startsWith("Enabled")) {
            setWebWikiEnabled(config, !config.webWiki.enabled);
            await persist();
            ctx.ui.notify(`Web Wiki ${config.webWiki.enabled ? "enabled" : "disabled"}. Restart open Pi sessions to apply.`, "info");
          } else if (sub?.startsWith("Host")) {
            const val = await ctx.ui.input("Host:", config.webWiki.host);
            if (val) { setWebWikiHost(config, val); await persist(); }
          } else if (sub?.startsWith("Port")) {
            const val = await ctx.ui.input("Port:", String(config.webWiki.port));
            if (val) { setWebWikiPort(config, val); await persist(); }
          }
        } else if (choice.startsWith("[Embedding]") || choice.startsWith("[Rerank]")) {
          const isEmbedding = choice.startsWith("[Embedding]");
          const profile = isEmbedding ? ensureEmbeddingProfile(config) : ensureRerankProfile(config);
          const sub = await ctx.ui.select(isEmbedding ? "Embedding provider" : "Rerank provider", [
            `Provider: ${profile.provider}`,
            `Base URL: ${profile.baseUrl ?? "not set"}`,
            `Model: ${profile.model ?? "not set"}`,
            ...(isEmbedding ? [`Dims: ${profile.dims ?? "auto"}`] : []),
            `API format: ${profile.apiFormat ?? "openai"}`,
            `Credential ref: ${profile.credentialRef}`,
            `Store/update local secret`,
            ...(!isEmbedding ? [`Disable rerank`] : []),
          ]);

          if (sub?.startsWith("Provider")) {
            const val = await ctx.ui.input("Provider id:", profile.provider);
            if (val) setProviderProfileField(profile, "provider", val);
          } else if (sub?.startsWith("Base URL")) {
            const val = await ctx.ui.input("Base URL:", profile.baseUrl ?? "");
            if (val) setProviderProfileField(profile, "baseUrl", val);
          } else if (sub?.startsWith("Model")) {
            const val = await ctx.ui.input("Model id:", profile.model ?? "");
            if (val) setProviderProfileField(profile, "model", val);
          } else if (sub?.startsWith("Dims")) {
            const val = await ctx.ui.input("Embedding dimensions:", profile.dims ? String(profile.dims) : "");
            if (val) setProviderDims(profile, val);
          } else if (sub?.startsWith("API format")) {
            const fmt = await ctx.ui.select("API format", ["openai", "anthropic", "custom"]);
            if (fmt) setProviderProfileField(profile, "apiFormat", fmt);
          } else if (sub?.startsWith("Credential ref")) {
            const val = await ctx.ui.input("Credential ref (pi-auth:<provider>, secret:<name>, or none):", profile.credentialRef);
            if (val) setProviderProfileField(profile, "credentialRef", val);
          } else if (sub?.startsWith("Store/update local secret")) {
            const name = await ctx.ui.input("Secret name:", profile.credentialRef.startsWith("secret:") ? profile.credentialRef.slice("secret:".length) : "");
            if (name) {
              const value = await ctx.ui.input("API key (stored in ~/.pi/para/secrets.json, not wiki git):", "");
              if (value) {
                await setSecret(name, value, loaded.paths.secretsPath);
                setProviderProfileField(profile, "credentialRef", `secret:${name}`);
              }
            }
          } else if (sub?.startsWith("Disable rerank")) {
            disableRerank(config);
          }

          await persist();
          ctx.ui.notify(`Updated ${isEmbedding ? "embedding" : "rerank"} provider config.`, "info");
        } else if (choice.startsWith("---") || choice.startsWith("[Status]")) {
          continue;
        }
      }
    },
  });

}
