import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ensurePiExtensionRegistration,
  formatSetupResult,
  resolveExtensionRef,
  runSetup,
  summarizeSetupConfig,
} from "../src/setup.js";
import { loadParaConfig } from "../src/config.js";

describe("setup", () => {
  async function tempHome() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-setup-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("resolves npm and local extension references", () => {
    expect(resolveExtensionRef()).toBe("npm:pi-para");
    expect(resolveExtensionRef(".")).toBe(resolve("."));
  });

  it("registers extension idempotently in Pi settings", async () => {
    const home = await tempHome();
    try {
      const settingsPath = join(home.dir, ".pi", "agent", "settings.json");
      let result = await ensurePiExtensionRegistration(settingsPath, "npm:pi-para");
      expect(result.changed).toBe(true);
      expect(JSON.parse(await readFile(settingsPath, "utf-8")).packages).toEqual(["npm:pi-para"]);
      result = await ensurePiExtensionRegistration(settingsPath, "npm:pi-para");
      expect(result.changed).toBe(false);
      expect(result.packages).toEqual(["npm:pi-para"]);
    } finally {
      await home.cleanup();
    }
  });

  it("supports dry-run registration without writing settings", async () => {
    const home = await tempHome();
    try {
      const settingsPath = join(home.dir, ".pi", "agent", "settings.json");
      const result = await ensurePiExtensionRegistration(settingsPath, "npm:pi-para", { dryRun: true });
      expect(result).toMatchObject({ changed: true, packages: ["npm:pi-para"] });
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      await home.cleanup();
    }
  });

  it("runs setup with config, wiki init, registration, and formatted summary", async () => {
    const home = await tempHome();
    try {
      const result = await runSetup({ homeDir: home.dir, validateQmd: false });
      expect(result.extensionRef).toBe("npm:pi-para");
      expect(result.configPath).toBe(join(home.dir, ".pi", "para", "config.jsonc"));
      expect(result.wikiDir).toBe(join(home.dir, ".pi", "wiki"));
      expect(result.changes.join("\n")).toContain("initialized wiki");
      expect(result.changes.join("\n")).toContain("registered extension npm:pi-para");
      expect(existsSync(join(home.dir, ".pi", "wiki", "index.md"))).toBe(true);
      expect(formatSetupResult(result)).toContain("restart open Pi sessions");
    } finally {
      await home.cleanup();
    }
  });

  it("migrates legacy config during setup and summarizes loaded config", async () => {
    const home = await tempHome();
    try {
      const wikiDir = join(home.dir, ".pi", "wiki");
      await mkdir(wikiDir, { recursive: true });
      await writeFile(join(wikiDir, "config.json"), JSON.stringify({ contextMaxTokens: 1234 }), "utf-8");
      const result = await runSetup({ homeDir: home.dir, validateQmd: false, initWiki: false });
      expect(result.migratedFromLegacy).toBe(true);
      const loaded = await loadParaConfig({ homeDir: home.dir });
      expect(summarizeSetupConfig(loaded)).toContain("config=");
      expect(loaded.config.context.maxTokens).toBe(1234);
    } finally {
      await home.cleanup();
    }
  });
});
