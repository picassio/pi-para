import { existsSync, chmodSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const GENERATED_STATE_GITIGNORE_PATTERNS = [
  ".qmd.sqlite*",
  ".daemon.sqlite*",
  ".pi-para.sqlite*",
  "gepa/input/",
  "gepa/output/",
];

export interface GitignoreRepairResult {
  path: string;
  changed: boolean;
  added: string[];
}

export function missingGeneratedStateGitignorePatterns(wikiDir: string): string[] {
  const path = join(wikiDir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing.split(/\r?\n/);
  return GENERATED_STATE_GITIGNORE_PATTERNS.filter((pattern) => !lines.includes(pattern));
}

export async function ensureGeneratedStateGitignore(wikiDir: string): Promise<GitignoreRepairResult> {
  const path = join(wikiDir, ".gitignore");
  await mkdir(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const added = missingGeneratedStateGitignorePatterns(wikiDir);
  if (added.length === 0) return { path, changed: false, added: [] };

  const prefix = existing.trimEnd().length > 0 ? `${existing.trimEnd()}\n` : "";
  const block = `${prefix}${prefix ? "\n" : ""}# pi-para generated state (do not version)\n${added.join("\n")}\n`;
  await writeFile(path, block, "utf-8");
  return { path, changed: true, added };
}

export function fixSecretPermissions(secretsPath: string): boolean {
  if (!existsSync(secretsPath)) return false;
  const before = readMode(secretsPath);
  if ((before & 0o077) === 0) return false;
  chmodSync(secretsPath, 0o600);
  return true;
}

export function readMode(path: string): number {
  return existsSync(path) ? (statSync(path).mode & 0o777) : 0;
}
