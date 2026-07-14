import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { loadParaConfig, type LoadedParaConfig } from "./config.js";
import { getParaPaths, resolvePath } from "./paths.js";
import { initWiki } from "./wiki.js";
import { openStore, closeStore } from "./store.js";

export interface SetupOptions {
  homeDir?: string;
  yes?: boolean;
  dryRun?: boolean;
  localPath?: string;
  validateQmd?: boolean;
  initWiki?: boolean;
}

export interface SetupResult {
  dryRun: boolean;
  extensionRef: string;
  configPath: string;
  wikiDir: string;
  changes: string[];
  warnings: string[];
  migratedFromLegacy: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const loaded = await loadParaConfig({ homeDir: options.homeDir, migrate: true });
  const paths = getParaPaths({ homeDir: options.homeDir, wikiDir: loaded.config.wiki.dir });
  const extensionRef = resolveExtensionRef(options.localPath);
  const changes: string[] = [];
  const warnings: string[] = [];

  if (loaded.migratedFromLegacy) {
    changes.push(`migrated legacy config to ${paths.userConfigPath}`);
  } else {
    changes.push(`config ready at ${paths.userConfigPath}`);
  }

  if (options.initWiki !== false) {
    if (!options.dryRun) await initWiki(paths.wikiDir);
    changes.push(`initialized wiki at ${paths.wikiDir}`);
  }

  const registration = await ensurePiExtensionRegistration(paths.piSettingsPath, extensionRef, {
    dryRun: options.dryRun ?? false,
  });
  changes.push(registration.changed ? `registered extension ${extensionRef}` : `extension already registered: ${extensionRef}`);

  if (options.validateQmd !== false) {
    try {
      if (!options.dryRun) {
        const store = await openStore(paths.wikiDir, {
          paraConfig: { ...loaded.config, qmd: { ...loaded.config.qmd, embedEnabled: false } },
          secretsPath: paths.secretsPath,
        });
        await closeStore(store);
      }
      changes.push("validated QMD SDK store");
    } catch (err) {
      warnings.push(`QMD SDK validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    dryRun: options.dryRun ?? false,
    extensionRef,
    configPath: paths.userConfigPath,
    wikiDir: paths.wikiDir,
    changes,
    warnings,
    migratedFromLegacy: loaded.migratedFromLegacy,
  };
}

export function formatSetupResult(result: SetupResult): string {
  const lines = [`pi-para setup ${result.dryRun ? "dry run " : ""}complete.`];
  for (const change of result.changes) lines.push(`  ✓ ${change}`);
  for (const warning of result.warnings) lines.push(`  ⚠ ${warning}`);
  lines.push("", "Next: restart open Pi sessions, then run /wiki or `npx -y pi-para@latest doctor`.");
  return lines.join("\n");
}

export function resolveExtensionRef(localPath?: string): string {
  if (!localPath) return "npm:pi-para";
  return resolvePath(localPath, process.cwd());
}

export async function ensurePiExtensionRegistration(
  settingsPath: string,
  extensionRef: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; packages: string[] }> {
  const settings = readPiSettings(settingsPath);
  const packages = Array.isArray(settings.packages) ? settings.packages.map(String) : [];
  if (packages.includes(extensionRef)) return { changed: false, packages };

  const nextPackages = [...packages, extensionRef];
  settings.packages = nextPackages;
  if (!opts.dryRun) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await atomicWriteFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  }
  return { changed: true, packages: nextPackages };
}

function readPiSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
}

export function summarizeSetupConfig(loaded: LoadedParaConfig): string {
  return `config=${loaded.sourcePath} wiki=${loaded.config.wiki.dir}`;
}
