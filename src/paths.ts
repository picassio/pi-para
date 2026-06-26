import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ParaPaths {
  homeDir: string;
  agentDir: string;
  paraDir: string;
  wikiDir: string;
  userConfigPath: string;
  secretsPath: string;
  schedulerDbPath: string;
  qmdDbPath: string;
  legacyConfigPath: string;
  legacyQmdConfigPath: string;
  piSettingsPath: string;
}

export function expandHome(path: string, homeDir = homedir()): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homeDir, path.slice(2));
  return path;
}

export function resolvePath(path: string, baseDir = process.cwd(), homeDir = homedir()): string {
  const expanded = expandHome(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function getParaPaths(opts: { homeDir?: string; wikiDir?: string } = {}): ParaPaths {
  const homeDir = opts.homeDir ?? homedir();
  const agentDir = join(homeDir, ".pi", "agent");
  const paraDir = join(homeDir, ".pi", "para");
  const wikiDir = opts.wikiDir ? resolvePath(opts.wikiDir, process.cwd(), homeDir) : join(homeDir, ".pi", "wiki");

  return {
    homeDir,
    agentDir,
    paraDir,
    wikiDir,
    userConfigPath: join(paraDir, "config.jsonc"),
    secretsPath: join(paraDir, "secrets.json"),
    schedulerDbPath: join(wikiDir, ".pi-para.sqlite"),
    qmdDbPath: join(wikiDir, ".qmd.sqlite"),
    legacyConfigPath: join(wikiDir, "config.json"),
    legacyQmdConfigPath: join(homeDir, ".config", "qmd", "index.yml"),
    piSettingsPath: join(agentDir, "settings.json"),
  };
}
