/** Tool registration composition for pi sessions and standalone mini-agents. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { QMDStore } from "qmd-engine";

import type { ProjectScope } from "./scope.js";
import { detectSourceType } from "./ingest.js";
import { CURRENT_SCHEMA_VERSION } from "./frontmatter.js";
import { WIKI_TOOL_DESCRIPTIONS, WIKI_TOOL_SNIPPETS, getWikiToolGuidelines } from "./wiki-tool-guidance.js";
import { createIngestExecute } from "./tools/ingest.js";
import { createQueryExecute } from "./tools/query.js";
import { createWriteExecute } from "./tools/write.js";
import { createEditExecute, createReadExecute } from "./tools/edit-read.js";
import { createMoveExecute } from "./tools/move.js";
import { createLintExecute } from "./tools/lint.js";
import { createMigrateExecute } from "./tools/migrate.js";
import { createSummarizeExecute } from "./tools/summarize.js";
import {
  WikiIngestParams, WikiQueryParams, WikiEditParams, WikiWriteParams, WikiReadParams,
  WikiMoveParams, WikiLintParams, WikiMigrateParams, WikiSummarizeParams,
  type WikiIngestDetails, type WikiQueryDetails, type WikiWriteDetails,
  type WikiReadDetails, type WikiMoveDetails, type WikiLintDetails, type WikiSummarizeDetails,
} from "./tools/schemas.js";

// -- Public API: register tools for pi session -------------------------------

/**
 * Register all wiki tools with the pi extension API.
 *
 * Tools: wiki_ingest, wiki_query, wiki_write, wiki_edit, wiki_read,
 *        wiki_move, wiki_lint, wiki_summarize
 */
export function registerTools(
  pi: ExtensionAPI,
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  markDirty: () => void,
  getGraphBoost?: () => boolean,
  getLintConfig?: () => { autoFix: boolean; staleDays: number },
): void {
  const ingestExec = createIngestExecute(wikiDir, store, getScope);
  const queryExec = createQueryExecute(wikiDir, store, getScope, getGraphBoost);
  const writeExec = createWriteExecute(wikiDir, store, getScope, markDirty);
  const editExec = createEditExecute(wikiDir, store, markDirty);
  const readExec = createReadExecute(wikiDir);
  const moveExec = createMoveExecute(wikiDir, store, markDirty);
  const lintExec = createLintExecute(wikiDir, store, markDirty, getLintConfig);
  const migrateExec = createMigrateExecute(wikiDir);
  const summarizeExec = createSummarizeExecute(wikiDir, getScope);

  // -- wiki_ingest --
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_ingest,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_ingest,
    promptGuidelines: getWikiToolGuidelines("wiki_ingest"),
    parameters: WikiIngestParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: ingesting...");
      try { return await ingestExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      const srcType = args.sourceType ?? detectSourceType(args.source);
      const src =
        args.source.length > 60
          ? args.source.slice(0, 57) + "..."
          : args.source;
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_ingest ")) +
          theme.fg("muted", `[${srcType}] `) +
          theme.fg("dim", src),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiIngestDetails | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text.slice(0, 80) : "", 0, 0);
      }
      const parts = [
        theme.fg("success", "Fetched ") +
          theme.fg("muted", `${details.sourceType} (${formatBytes(details.sourceLength)})`),
      ];
      if (details.rawPath) {
        parts.push(theme.fg("dim", `Saved: ${details.rawPath}`));
      }
      return new Text(parts.join("\n"), 0, 0);
    },
  });

  // -- wiki_query --
  pi.registerTool({
    name: "wiki_query",
    label: "Wiki Query",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_query,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_query,
    promptGuidelines: getWikiToolGuidelines("wiki_query"),
    parameters: WikiQueryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: searching...");
      try { return await queryExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      const q =
        args.query.length > 50 ? args.query.slice(0, 47) + "..." : args.query;
      let text =
        theme.fg("toolTitle", theme.bold("wiki_query ")) +
        theme.fg("dim", `"${q}"`);
      if (args.global) text += theme.fg("muted", " (global)");
      if (args.category) text += theme.fg("muted", ` [${args.category}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiQueryDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "No results"), 0, 0);
      }
      return new Text(
        theme.fg("success", `${details.resultCount} result(s)`) +
          theme.fg("dim", ` scope: ${details.scopeUsed}`),
        0,
        0,
      );
    },
  });

  // -- wiki_edit --
  pi.registerTool({
    name: "wiki_edit",
    label: "Wiki Edit",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_edit,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_edit,
    promptGuidelines: getWikiToolGuidelines("wiki_edit"),
    parameters: WikiEditParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: editing...");
      try { return await editExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_edit ")) +
          theme.fg("muted", args.path ?? "") +
          theme.fg("dim", ` (${args.edits?.length ?? 0} edit(s))`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiWriteDetails | undefined;
      if (details?.pagesWritten?.length) {
        return new Text(theme.fg("success", `Edited ${details.pagesWritten.join(", ")}`), 0, 0);
      }
      const t = result.content[0];
      return new Text(theme.fg("warning", t?.type === "text" ? t.text : "No changes"), 0, 0);
    },
  });

  // -- wiki_write --
  pi.registerTool({
    name: "wiki_write",
    label: "Wiki Write",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_write,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_write,
    promptGuidelines: getWikiToolGuidelines("wiki_write"),
    parameters: WikiWriteParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: writing...");
      try { return await writeExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      const count = args.pages?.length ?? 0;
      const slugs = (args.pages ?? [])
        .slice(0, 3)
        .map((p: { slug: string }) => p.slug)
        .join(", ");
      let text =
        theme.fg("toolTitle", theme.bold("wiki_write ")) +
        theme.fg("muted", `${count} page(s)`);
      if (slugs) text += theme.fg("dim", ` [${slugs}]`);
      text += theme.fg("muted", " +index");  // always auto-rebuilds index
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiWriteDetails | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      const parts: string[] = [];
      if (details.pagesWritten.length > 0) {
        parts.push(
          theme.fg("success", `Wrote ${details.pagesWritten.length} page(s): `) +
            theme.fg("muted", details.pagesWritten.join(", ")),
        );
      }
      if (details.pagesSkipped?.length) {
        parts.push(theme.fg("warning", `Skipped ${details.pagesSkipped.length} page(s): `) + theme.fg("muted", details.pagesSkipped.join(", ")));
      }
      if (details.indexUpdated) parts.push(theme.fg("dim", "Updated index.md"));
      if (details.logAppended) parts.push(theme.fg("dim", "Logged operation"));
      return new Text(parts.join("\n") || theme.fg("dim", "No changes"), 0, 0);
    },
  });

  // -- wiki_read --
  pi.registerTool({
    name: "wiki_read",
    label: "Wiki Read",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_read,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_read,
    promptGuidelines: getWikiToolGuidelines("wiki_read"),
    parameters: WikiReadParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: reading...");
      try { return await readExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_read ")) +
          theme.fg("dim", args.path),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiReadDetails | undefined;
      if (!details || !details.found) {
        return new Text(theme.fg("error", "Page not found"), 0, 0);
      }
      return new Text(
        theme.fg("success", "Found ") + theme.fg("muted", details.path ?? ""),
        0,
        0,
      );
    },
  });

  // -- wiki_move --
  pi.registerTool({
    name: "wiki_move",
    label: "Wiki Move",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_move,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_move,
    promptGuidelines: getWikiToolGuidelines("wiki_move"),
    parameters: WikiMoveParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: moving...");
      try { return await moveExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_move ")) +
          theme.fg("dim", `${args.path} -> ${args.to}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiMoveDetails | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      return new Text(
        theme.fg("success", "Moved ") +
          theme.fg("muted", `${details.from} -> ${details.to}`),
        0,
        0,
      );
    },
  });

  // -- wiki_lint --
  pi.registerTool({
    name: "wiki_lint",
    label: "Wiki Lint",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_lint,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_lint,
    promptGuidelines: getWikiToolGuidelines("wiki_lint"),
    parameters: WikiLintParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: linting...");
      try { return await lintExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      const configuredAutoFix = getLintConfig?.().autoFix ?? true;
      const mode = (args.autoFix ?? configuredAutoFix) ? "auto-fix" : "report-only";
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_lint ")) +
          theme.fg("muted", `[${mode}]`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiLintDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "Lint complete"), 0, 0);
      }
      const parts = [
        theme.fg("muted", `${details.stats.totalPages} pages`),
      ];
      if (details.fixedCount > 0) {
        parts.push(theme.fg("success", `${details.fixedCount} fixed`));
      }
      if (details.issueCount > 0) {
        parts.push(theme.fg("warning", `${details.issueCount} remaining`));
      } else {
        parts.push(theme.fg("success", "healthy"));
      }
      return new Text(parts.join(" | "), 0, 0);
    },
  });

  // -- wiki_migrate --
  pi.registerTool({
    name: "wiki_migrate",
    label: "Wiki Migrate",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_migrate,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_migrate,
    promptGuidelines: getWikiToolGuidelines("wiki_migrate"),
    parameters: WikiMigrateParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: migrating...");
      try { return await migrateExec(); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("wiki_migrate ")) +
          theme.fg("muted", `→ v${CURRENT_SCHEMA_VERSION}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as { migratedCount: number; totalPages: number } | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "Migration complete"), 0, 0);
      }
      if (details.migratedCount === 0) {
        return new Text(
          theme.fg("success", `All ${details.totalPages} pages at v${CURRENT_SCHEMA_VERSION}`),
          0,
          0,
        );
      }
      return new Text(
        theme.fg("success", `Migrated ${details.migratedCount}/${details.totalPages} page(s)`),
        0,
        0,
      );
    },
  });

  // -- wiki_summarize --
  pi.registerTool({
    name: "wiki_summarize",
    label: "Wiki Summarize",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_summarize,
    promptSnippet: WIKI_TOOL_SNIPPETS.wiki_summarize,
    promptGuidelines: getWikiToolGuidelines("wiki_summarize"),
    parameters: WikiSummarizeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("pi-para", "wiki: summarizing...");
      try { return await summarizeExec(params); } finally { ctx.ui.setStatus("pi-para", undefined); }
    },
    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("wiki_summarize ")) +
        theme.fg("dim", args.target);
      if (args.depth) text += theme.fg("muted", ` [${args.depth}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WikiSummarizeDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "Summary generated"), 0, 0);
      }
      if (details.pageCount === 0) {
        return new Text(theme.fg("warning", "No pages found"), 0, 0);
      }
      return new Text(
        theme.fg("success", `Summarizing ${details.pageCount} page(s)`) +
          theme.fg("dim", ` target: ${details.target}`),
        0,
        0,
      );
    },
  });
}

// -- Public API: standalone tools for mini-agent -----------------------------

/**
 * Create standalone AgentTool instances for the mini-agent (capture/lint/summarize).
 * Returns only the tools needed for autonomous wiki operations:
 * wiki_write, wiki_edit, wiki_read, wiki_query, wiki_move.
 */
export function createStandaloneTools(
  wikiDir: string,
  store: QMDStore,
  getScope: () => ProjectScope,
  markDirty?: () => void,
): AgentTool[] {
  const noopDirty = markDirty ?? (() => {});
  const writeExec = createWriteExecute(wikiDir, store, getScope, noopDirty);
  const editExec = createEditExecute(wikiDir, store, noopDirty);
  const readExec = createReadExecute(wikiDir);
  const queryExec = createQueryExecute(wikiDir, store, getScope);
  const moveExec = createMoveExecute(wikiDir, store, noopDirty);

  const wikiWrite: AgentTool<typeof WikiWriteParams> = {
    name: "wiki_write",
    label: "Wiki Write",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_write,
    parameters: WikiWriteParams,
    execute: (_toolCallId, params) => writeExec(params),
  };

  const wikiEdit: AgentTool<typeof WikiEditParams> = {
    name: "wiki_edit",
    label: "Wiki Edit",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_edit,
    parameters: WikiEditParams,
    execute: (_toolCallId, params) => editExec(params),
  };

  const wikiRead: AgentTool<typeof WikiReadParams> = {
    name: "wiki_read",
    label: "Wiki Read",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_read,
    parameters: WikiReadParams,
    execute: (_toolCallId, params) => readExec(params),
  };

  const wikiQuery: AgentTool<typeof WikiQueryParams> = {
    name: "wiki_query",
    label: "Wiki Query",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_query,
    parameters: WikiQueryParams,
    execute: (_toolCallId, params) => queryExec(params),
  };

  const wikiMove: AgentTool<typeof WikiMoveParams> = {
    name: "wiki_move",
    label: "Wiki Move",
    description: WIKI_TOOL_DESCRIPTIONS.wiki_move,
    parameters: WikiMoveParams,
    execute: (_toolCallId, params) => moveExec(params),
  };

  return [wikiWrite, wikiEdit, wikiRead, wikiQuery, wikiMove];
}

// -- Utilities ---------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
