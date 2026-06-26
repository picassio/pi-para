import { existsSync } from "node:fs";
import { loadParaConfig } from "./config.js";
import { getParaPaths } from "./paths.js";
import { listPages, type ParaCategory } from "./wiki.js";
import { SchedulerStateDB, type QueueStatus } from "./scheduler/state.js";

export interface PiParaStatusOptions {
  homeDir?: string;
}

export interface PiParaStatusResult {
  configPath: string;
  wikiDir: string;
  configSource: "canonical" | "migrated";
  schedulerDbPath: string;
  qmdDbPath: string;
  pages: {
    total: number;
    byCategory: Record<ParaCategory, number>;
  };
  scheduler: Record<QueueStatus, number>;
  qmdDbExists: boolean;
  warnings: string[];
}

const QUEUE_STATUSES: QueueStatus[] = ["queued", "running", "done", "failed"];

export async function getPiParaStatus(options: PiParaStatusOptions = {}): Promise<PiParaStatusResult> {
  const loaded = await loadParaConfig({ homeDir: options.homeDir, migrate: true });
  const paths = getParaPaths({ homeDir: options.homeDir, wikiDir: loaded.config.wiki.dir });
  const warnings: string[] = [];

  const pages = await getPageCounts(paths.wikiDir, warnings);
  const scheduler = getSchedulerCounts(paths.schedulerDbPath, warnings);

  if (!existsSync(paths.wikiDir)) warnings.push(`wiki directory not found: ${paths.wikiDir}`);
  if (!existsSync(paths.schedulerDbPath)) warnings.push("scheduler DB not created yet; it will be initialized when Pi starts");
  if (!existsSync(paths.qmdDbPath)) warnings.push("QMD DB not created yet; search index is initialized on first store open");

  return {
    configPath: paths.userConfigPath,
    wikiDir: paths.wikiDir,
    configSource: loaded.migratedFromLegacy ? "migrated" : "canonical",
    schedulerDbPath: paths.schedulerDbPath,
    qmdDbPath: paths.qmdDbPath,
    pages,
    scheduler,
    qmdDbExists: existsSync(paths.qmdDbPath),
    warnings,
  };
}

export function formatPiParaStatus(status: PiParaStatusResult): string {
  const lines = [
    "pi-para status",
    `  Config: ${status.configPath} (${status.configSource})`,
    `  Wiki: ${status.wikiDir}`,
    `  Pages: ${status.pages.total} total (${formatCategoryCounts(status.pages.byCategory)})`,
    `  Scheduler: ${status.scheduler.queued} queued, ${status.scheduler.running} running, ${status.scheduler.failed} failed`,
    `  QMD SDK DB: ${status.qmdDbExists ? status.qmdDbPath : "not initialized"}`,
  ];

  if (status.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) lines.push(`  ⚠ ${warning}`);
  }

  lines.push("", "Next: use 'pi-para doctor' for diagnostics or '/wiki-scheduler status' inside Pi.");
  return lines.join("\n");
}

async function getPageCounts(wikiDir: string, warnings: string[]): Promise<PiParaStatusResult["pages"]> {
  const byCategory: Record<ParaCategory, number> = {
    projects: 0,
    areas: 0,
    resources: 0,
    archives: 0,
  };

  try {
    if (!existsSync(wikiDir)) return { total: 0, byCategory };
    const pages = await listPages(wikiDir);
    for (const page of pages) byCategory[page.category]++;
    return { total: pages.length, byCategory };
  } catch (err) {
    warnings.push(`could not count wiki pages: ${err instanceof Error ? err.message : String(err)}`);
    return { total: 0, byCategory };
  }
}

function getSchedulerCounts(dbPath: string, warnings: string[]): Record<QueueStatus, number> {
  const counts: Record<QueueStatus, number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
  };

  try {
    const db = new SchedulerStateDB(dbPath);
    try {
      for (const status of QUEUE_STATUSES) counts[status] = db.list(status).length;
    } finally {
      db.close();
    }
  } catch (err) {
    warnings.push(`could not read scheduler DB: ${err instanceof Error ? err.message : String(err)}`);
  }

  return counts;
}

function formatCategoryCounts(counts: Record<ParaCategory, number>): string {
  return `projects ${counts.projects}, areas ${counts.areas}, resources ${counts.resources}, archives ${counts.archives}`;
}
