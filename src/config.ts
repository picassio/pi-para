import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getParaPaths, resolvePath, type ParaPaths } from "./paths.js";
import { atomicWriteFile } from "./atomic-write.js";

export interface ProviderCredentialRef {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiFormat?: "openai" | "anthropic" | "custom";
  dims?: number;
  credentialRef: `pi-auth:${string}` | `secret:${string}` | "none";
}

export interface ParaUserConfig {
  $schema?: string;
  version: 1;
  wiki: {
    dir: string;
    defaultScope: string | null;
    autoCapture: boolean;
    captureOnCompact: boolean;
    captureOnStartup: boolean;
  };
  context: {
    maxTokens: number;
    includeSchema: boolean;
    includeIndex: boolean;
    searchLimit: number;
    searchGraphBoost: boolean;
  };
  scheduler: {
    enabled: boolean;
    startupCatchup: boolean;
    intervalMinutes: number;
    maxConcurrentTasks: number;
  };
  models: {
    capture: ProviderCredentialRef | "auto";
    summarize: ProviderCredentialRef | "auto";
    judge: ProviderCredentialRef | "auto";
  };
  qmd: {
    mode: "sdk";
    embedEnabled: boolean;
    providerConfig: "pi-para-profiles" | "legacy-qmd-compatible";
    embedding?: ProviderCredentialRef;
    rerank?: ProviderCredentialRef | null;
  };
  lint: {
    autoFix: boolean;
    staleDays: number;
  };
  /** Deprecated compatibility input. Preserved when loading but ignored by the runtime. */
  webWiki: {
    enabled: boolean;
    host: string;
    port: number;
    launch: "manual" | "disabled";
  };
}

export interface LegacyParaRuntimeConfig {
  wikiDir: string;
  contextMaxTokens: number;
  contextIncludeSchema: boolean;
  contextIncludeIndex: boolean;
  lintAutoFix: boolean;
  lintStaleDays: number;
  searchLimit: number;
  searchIncludeArchives: boolean;
  searchGraphBoost: boolean;
  daemonModel: string | null;
}

export interface LoadedParaConfig {
  config: ParaUserConfig;
  paths: ParaPaths;
  sourcePath: string;
  migratedFromLegacy: boolean;
}

export function getDefaultUserConfig(homeDir?: string): ParaUserConfig {
  const paths = getParaPaths({ homeDir });
  return {
    $schema: "https://picassio.github.io/pi-para/config.schema.json",
    version: 1,
    wiki: {
      dir: paths.wikiDir,
      defaultScope: null,
      autoCapture: true,
      captureOnCompact: true,
      captureOnStartup: true,
    },
    context: {
      maxTokens: 4000,
      includeSchema: true,
      includeIndex: true,
      searchLimit: 10,
      searchGraphBoost: true,
    },
    scheduler: {
      enabled: true,
      startupCatchup: true,
      intervalMinutes: 15,
      maxConcurrentTasks: 1,
    },
    models: {
      capture: "auto",
      summarize: "auto",
      judge: "auto",
    },
    qmd: {
      mode: "sdk",
      embedEnabled: true,
      providerConfig: "pi-para-profiles",
      rerank: null,
    },
    lint: {
      autoFix: true,
      staleDays: 90,
    },
    webWiki: {
      enabled: false,
      host: "127.0.0.1",
      port: 10973,
      launch: "manual",
    },
  };
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

export function normalizeConfig(input: Partial<ParaUserConfig>, homeDir?: string): ParaUserConfig {
  const defaults = getDefaultUserConfig(homeDir);
  const wikiDir = input.wiki?.dir ? resolvePath(input.wiki.dir, process.cwd(), homeDir) : defaults.wiki.dir;
  return {
    ...defaults,
    ...input,
    version: 1,
    wiki: { ...defaults.wiki, ...input.wiki, dir: wikiDir },
    context: { ...defaults.context, ...input.context },
    scheduler: { ...defaults.scheduler, ...input.scheduler },
    models: { ...defaults.models, ...input.models },
    qmd: { ...defaults.qmd, ...input.qmd },
    lint: { ...defaults.lint, ...input.lint },
    webWiki: { ...defaults.webWiki, ...input.webWiki },
  };
}

export async function loadParaConfig(opts: { homeDir?: string; migrate?: boolean } = {}): Promise<LoadedParaConfig> {
  const defaults = getDefaultUserConfig(opts.homeDir);
  const initialPaths = getParaPaths({ homeDir: opts.homeDir });

  if (existsSync(initialPaths.userConfigPath)) {
    const raw = await readFile(initialPaths.userConfigPath, "utf-8");
    const parsed = parseJsonc(raw) as Partial<ParaUserConfig>;
    const config = normalizeConfig(parsed, opts.homeDir);
    return {
      config,
      paths: getParaPaths({ homeDir: opts.homeDir, wikiDir: config.wiki.dir }),
      sourcePath: initialPaths.userConfigPath,
      migratedFromLegacy: false,
    };
  }

  if (opts.migrate !== false && existsSync(initialPaths.legacyConfigPath)) {
    const legacyRaw = await readFile(initialPaths.legacyConfigPath, "utf-8");
    const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;
    const config = migrateLegacyConfig(legacy, defaults, opts.homeDir);
    await saveParaConfig(config, { homeDir: opts.homeDir });
    return {
      config,
      paths: getParaPaths({ homeDir: opts.homeDir, wikiDir: config.wiki.dir }),
      sourcePath: initialPaths.userConfigPath,
      migratedFromLegacy: true,
    };
  }

  await saveParaConfig(defaults, { homeDir: opts.homeDir });
  return {
    config: defaults,
    paths: initialPaths,
    sourcePath: initialPaths.userConfigPath,
    migratedFromLegacy: false,
  };
}

export async function saveParaConfig(config: ParaUserConfig, opts: { homeDir?: string } = {}): Promise<void> {
  const paths = getParaPaths({ homeDir: opts.homeDir, wikiDir: config.wiki.dir });
  await atomicWriteFile(paths.userConfigPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function migrateLegacyConfig(
  legacy: Record<string, unknown>,
  defaults = getDefaultUserConfig(),
  homeDir?: string,
): ParaUserConfig {
  const config = normalizeConfig({}, homeDir);
  const wikiDir = typeof legacy.wikiDir === "string" ? resolvePath(legacy.wikiDir, process.cwd(), homeDir) : defaults.wiki.dir;

  config.wiki.dir = wikiDir;
  config.context.maxTokens = numberOr(legacy.contextMaxTokens, defaults.context.maxTokens);
  config.context.includeSchema = boolOr(legacy.contextIncludeSchema, defaults.context.includeSchema);
  config.context.includeIndex = boolOr(legacy.contextIncludeIndex, defaults.context.includeIndex);
  config.context.searchLimit = numberOr(legacy.searchLimit, defaults.context.searchLimit);
  config.context.searchGraphBoost = boolOr(legacy.searchGraphBoost, defaults.context.searchGraphBoost);
  config.lint.autoFix = boolOr(legacy.lintAutoFix, defaults.lint.autoFix);
  config.lint.staleDays = numberOr(legacy.lintStaleDays, defaults.lint.staleDays);
  config.qmd.providerConfig = "legacy-qmd-compatible";

  if (typeof legacy.daemonModel === "string" && legacy.daemonModel.includes("/")) {
    const [provider, ...rest] = legacy.daemonModel.split("/");
    config.models.capture = {
      provider: provider ?? "unknown",
      model: rest.join("/"),
      credentialRef: `pi-auth:${provider}`,
    };
  }

  if (isRecord(legacy.webWiki)) {
    config.webWiki.enabled = boolOr(legacy.webWiki.enabled, defaults.webWiki.enabled);
    config.webWiki.host = typeof legacy.webWiki.host === "string" ? legacy.webWiki.host : defaults.webWiki.host;
    config.webWiki.port = numberOr(legacy.webWiki.port, defaults.webWiki.port);
  }

  return config;
}

export function toLegacyRuntimeConfig(config: ParaUserConfig): LegacyParaRuntimeConfig {
  const capture = config.models.capture;
  const daemonModel = capture === "auto" ? null : `${capture.provider}/${capture.model ?? ""}`;
  return {
    wikiDir: config.wiki.dir,
    contextMaxTokens: config.context.maxTokens,
    contextIncludeSchema: config.context.includeSchema,
    contextIncludeIndex: config.context.includeIndex,
    lintAutoFix: config.lint.autoFix,
    lintStaleDays: config.lint.staleDays,
    searchLimit: config.context.searchLimit,
    searchIncludeArchives: false,
    searchGraphBoost: config.context.searchGraphBoost,
    daemonModel,
  };
}

export async function backupLegacyConfigIfNeeded(paths: ParaPaths, now = new Date()): Promise<string | null> {
  if (!existsSync(paths.legacyConfigPath)) return null;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backupPath = `${paths.legacyConfigPath}.bak-${stamp}`;
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(paths.legacyConfigPath, backupPath);
  return backupPath;
}

export async function writeMigrationBreadcrumb(paths: ParaPaths): Promise<void> {
  const breadcrumb = {
    migratedTo: paths.userConfigPath,
    note: "pi-para now reads ~/.pi/para/config.jsonc first. This legacy file is kept for compatibility.",
  };
  await writeFile(`${paths.legacyConfigPath}.migrated`, `${JSON.stringify(breadcrumb, null, 2)}\n`, "utf-8");
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
