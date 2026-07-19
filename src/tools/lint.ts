import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { QMDStore } from "qmd-engine";
import { lintWiki } from "../lint.js";
import { PARA_CATEGORIES } from "../wiki.js";
import { LINT_PROMPT } from "../templates/prompts.js";
import type { WikiLintDetails } from "./schemas.js";
import { scheduleWikiMaintenance } from "./shared.js";

// -- Factory: wiki_lint execute ----------------------------------------------

export function createLintExecute(
  wikiDir: string,
  store: QMDStore,
  markDirty: () => void,
  getLintConfig?: () => { autoFix: boolean; staleDays: number },
) {
  return async (
    params: { autoFix?: boolean },
  ): Promise<AgentToolResult<WikiLintDetails>> => {
    const configured = getLintConfig?.();
    const report = await lintWiki(wikiDir, {
      autoFix: params.autoFix ?? configured?.autoFix ?? true,
      staleDays: configured?.staleDays ?? 90,
    });
    if (report.fixed.length > 0) {
      scheduleWikiMaintenance(wikiDir, store, markDirty);
    }

    const { issues, fixed, stats } = report;

    // Format report for the LLM
    const parts: string[] = [];

    parts.push("## Wiki Lint Report\n");
    parts.push(`Total pages: ${stats.totalPages}`);
    parts.push(
      `By category: ${PARA_CATEGORIES.map((c) => `${c}: ${stats.byCategory[c]}`).join(", ")}`,
    );
    parts.push(`Total links: ${stats.totalLinks} (broken: ${stats.brokenLinks})`);
    parts.push(`Orphan pages: ${stats.orphanPages}`);
    if (stats.oldestPage) parts.push(`Oldest page: ${stats.oldestPage}`);
    if (stats.newestPage) parts.push(`Newest page: ${stats.newestPage}`);
    if (stats.lastIngest) parts.push(`Last ingest: ${stats.lastIngest}`);

    if (fixed.length > 0) {
      parts.push(`\n## Auto-fixed (${fixed.length})\n`);
      for (const f of fixed) {
        parts.push(`- [${f.severity}] ${f.page ?? ""}: ${f.message}`);
      }
    }

    if (issues.length > 0) {
      parts.push(`\n## Remaining Issues (${issues.length})\n`);
      for (const issue of issues) {
        parts.push(
          `- [${issue.severity}] ${issue.category}${issue.page ? ` (${issue.page})` : ""}: ${issue.message}`,
        );
      }
      parts.push("");
      parts.push(LINT_PROMPT);
    } else {
      parts.push("\nNo remaining issues. Wiki is healthy.");
    }

    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: {
        issueCount: issues.length,
        fixedCount: fixed.length,
        stats,
      },
    };
  };
}
