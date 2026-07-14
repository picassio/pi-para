import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  backupLegacyConfigIfNeeded,
  getDefaultUserConfig,
  loadParaConfig,
  migrateLegacyConfig,
  normalizeConfig,
  parseJsonc,
  saveParaConfig,
  stripJsonComments,
  toLegacyRuntimeConfig,
  writeMigrationBreadcrumb,
} from "../src/config.js";

describe("config", () => {
  async function tempHome() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-config-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("parses JSONC without stripping comment-like text inside strings", () => {
    const raw = `{
      // real comment
      "url": "https://example.com//path",
      "text": "not /* a comment */",
      /* block */
      "n": 1
    }`;
    expect(stripJsonComments(raw)).toContain("https://example.com//path");
    expect(parseJsonc(raw)).toEqual({ url: "https://example.com//path", text: "not /* a comment */", n: 1 });
  });

  it("normalizes partial config with defaults and expanded wiki path", () => {
    const config = normalizeConfig({ wiki: { dir: "~/custom" } as any, context: { maxTokens: 123 } as any }, "/home/alice");
    expect(config.version).toBe(1);
    expect(config.wiki.dir).toBe(join("/home/alice", "custom"));
    expect(config.context.maxTokens).toBe(123);
    expect(config.scheduler.enabled).toBe(true);
    expect(config.qmd.providerConfig).toBe("pi-para-profiles");
  });

  it("migrates legacy config into role-based config", () => {
    const migrated = migrateLegacyConfig({
      wikiDir: "~/wiki2",
      contextMaxTokens: 9000,
      contextIncludeSchema: false,
      contextIncludeIndex: false,
      searchLimit: 17,
      searchGraphBoost: false,
      lintAutoFix: false,
      lintStaleDays: 30,
      daemonModel: "anthropic/claude-sonnet-4-20250514",
      webWiki: { enabled: true, host: "0.0.0.0", port: 1234 },
    }, getDefaultUserConfig("/home/alice"), "/home/alice");

    expect(migrated.wiki.dir).toBe(join("/home/alice", "wiki2"));
    expect(migrated.context).toMatchObject({ maxTokens: 9000, includeSchema: false, includeIndex: false, searchLimit: 17, searchGraphBoost: false });
    expect(migrated.lint).toEqual({ autoFix: false, staleDays: 30 });
    expect(migrated.models.capture).toEqual({ provider: "anthropic", model: "claude-sonnet-4-20250514", credentialRef: "pi-auth:anthropic" });
    expect(migrated.webWiki).toMatchObject({ enabled: true, host: "0.0.0.0", port: 1234 });
  });

  it("saves, loads, and converts to legacy runtime config", async () => {
    const home = await tempHome();
    try {
      const config = getDefaultUserConfig(home.dir);
      config.context.maxTokens = 555;
      config.models.capture = { provider: "anthropic", model: "claude-sonnet", credentialRef: "pi-auth:anthropic" };
      await saveParaConfig(config, { homeDir: home.dir });
      const loaded = await loadParaConfig({ homeDir: home.dir });
      expect(loaded.config.context.maxTokens).toBe(555);
      expect(loaded.migratedFromLegacy).toBe(false);
      expect(toLegacyRuntimeConfig(loaded.config)).toMatchObject({
        wikiDir: join(home.dir, ".pi", "wiki"),
        contextMaxTokens: 555,
        daemonModel: "anthropic/claude-sonnet",
      });
    } finally {
      await home.cleanup();
    }
  });

  it("loads legacy config when canonical config is missing and writes breadcrumb helpers", async () => {
    const home = await tempHome();
    try {
      const wikiDir = join(home.dir, ".pi", "wiki");
      await mkdir(wikiDir, { recursive: true });
      const legacyPath = join(wikiDir, "config.json");
      await writeFile(legacyPath, JSON.stringify({ contextMaxTokens: 777 }), "utf-8");
      const loaded = await loadParaConfig({ homeDir: home.dir });
      expect(loaded.migratedFromLegacy).toBe(true);
      expect(loaded.config.context.maxTokens).toBe(777);
      expect(existsSync(join(home.dir, ".pi", "para", "config.jsonc"))).toBe(true);
      const backup = await backupLegacyConfigIfNeeded(loaded.paths, new Date("2026-01-02T03:04:05.000Z"));
      expect(backup).toContain("bak-20260102T030405Z");
      await writeMigrationBreadcrumb(loaded.paths);
      expect(await readFile(`${legacyPath}.migrated`, "utf-8")).toContain("config.jsonc");
    } finally {
      await home.cleanup();
    }
  });
});
