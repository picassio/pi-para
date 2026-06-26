import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDefaultUserConfig, saveParaConfig } from "../src/config.js";
import { initWiki, writePage } from "../src/wiki.js";
import { SchedulerStateDB } from "../src/scheduler/state.js";
import { formatPiParaStatus, getPiParaStatus } from "../src/status.js";

describe("status", () => {
  async function tempHome() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-status-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("reports config, wiki, page, scheduler, and qmd status", async () => {
    const home = await tempHome();
    try {
      const config = getDefaultUserConfig(home.dir);
      await saveParaConfig(config, { homeDir: home.dir });
      await initWiki(config.wiki.dir);
      await writePage(config.wiki.dir, {
        category: "resources",
        slug: "test-page",
        frontmatter: {
          title: "Test Page",
          para: "resources",
          scope: ["pi-para"],
          tags: ["test"],
          sources: [],
          created: "2026-01-01",
          updated: "2026-01-01",
          links: [],
          schemaVersion: 1,
        },
        body: "## Topic\n\nTest.",
      });
      await writeFile(join(config.wiki.dir, ".qmd.sqlite"), "", "utf-8");

      const schedulerDb = new SchedulerStateDB(join(config.wiki.dir, ".pi-para.sqlite"));
      schedulerDb.enqueue("capture-session", { sessionFile: "a.jsonl" });
      schedulerDb.close();

      const status = await getPiParaStatus({ homeDir: home.dir });
      const formatted = formatPiParaStatus(status);

      expect(status.pages.total).toBe(1);
      expect(status.pages.byCategory.resources).toBe(1);
      expect(status.scheduler.queued).toBe(1);
      expect(status.qmdDbExists).toBe(true);
      expect(formatted).toContain("pi-para status");
      expect(formatted).toContain("Pages: 1 total");
      expect(formatted).toContain("Scheduler: 1 queued");
    } finally {
      await home.cleanup();
    }
  });

  it("reports warnings before first Pi startup initializes state", async () => {
    const home = await tempHome();
    try {
      const status = await getPiParaStatus({ homeDir: home.dir });

      expect(status.pages.total).toBe(0);
      expect(status.warnings.join("\n")).toContain("QMD DB not created yet");
      expect(formatPiParaStatus(status)).toContain("Warnings:");
    } finally {
      await home.cleanup();
    }
  });
});
