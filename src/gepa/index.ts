/**
 * GEPA optimizer orchestrator — TypeScript side.
 *
 * 1. Extracts all prompt/tool/skill instruction texts from source
 * 2. Writes targets.json for the Python DSPy GEPA script
 * 3. Reads auth.json → passes API keys as env vars to uv subprocess
 * 4. Calls `uv run scripts/gepa/optimize.py`
 * 5. Reads results.json → saves optimized prompts to disk
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// -- Types -------------------------------------------------------------------

interface GEPATarget {
  name: string;
  type: "prompt" | "tool" | "skill";
  content: string;
  sourceFile: string;
}

interface GEPAResult {
  target: string;
  status: "success" | "error";
  baseline_score?: number;
  optimized_score?: number;
  improvement_pct?: number;
  optimized_instruction?: string;
  original_instruction?: string;
  model?: string;
  auto?: string;
  error?: string;
  timestamp?: string;
}

interface GEPAOutput {
  results: GEPAResult[];
  model: string;
  auto: string;
  wiki_dir: string;
  timestamp: string;
}

export interface GEPAOptions {
  target?: string;
  /** Student model — runs the proxy (fast, cheap). */
  studentModel?: string;
  /** Teacher/reflection model — proposes mutations (smart, creative). */
  teacherModel?: string;
  /** Judge model — scores outputs (fast, cheap). Default: same as student. */
  judgeModel?: string;
  /** Shorthand: sets studentModel (backward compat with --model flag) */
  model?: string;
  /** Shorthand: sets teacherModel (backward compat with --reflection-model flag) */
  reflectionModel?: string;
  auto?: "light" | "medium" | "heavy";
  maxMetricCalls?: number;
  threads?: number;
  seed?: number;
}

// -- Paths -------------------------------------------------------------------

const WIKI_DIR = join(homedir(), ".pi", "wiki");
const GEPA_DIR = join(WIKI_DIR, "gepa");
const INPUT_DIR = join(GEPA_DIR, "input");
const OUTPUT_DIR = join(GEPA_DIR, "output");
const OPTIMIZED_DIR = join(GEPA_DIR, "optimized");
const HISTORY_DIR = join(GEPA_DIR, "history");

// -- Package root ------------------------------------------------------------

function findPackageRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "@picassio/pi-para") return dir;
      } catch {}
    }
    dir = dirname(dir);
  }
  return resolve(dirname(new URL(import.meta.url).pathname), "../..");
}

// -- Helpers: extract strings from TS source ---------------------------------

function extractTSConst(source: string, name: string): string | null {
  const m = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\`([\\s\\S]*?)\`;`));
  return m ? m[1].trim() : null;
}

function extractToolInstructions(source: string): Record<string, string> {
  const tools: Record<string, string> = {};
  const blocks = [...source.matchAll(
    /registerTool\(\{[\s\S]*?name:\s*"(wiki_\w+)"[\s\S]*?(?=registerTool\(\{|$)/g,
  )];
  for (const block of blocks) {
    const name = block[1].replace("wiki_", "wiki-");
    const text = block[0];
    const descStrs = [...(text.match(/description:\s*\n?\s*([\s\S]*?)(?:promptSnippet:|promptGuidelines:|parameters:)/)?.[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)];
    const desc = descStrs.map(s => s[1]).join(" ");
    const snippet = text.match(/promptSnippet:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
    const guideMatch = text.match(/promptGuidelines:\s*\[([\s\S]*?)\]/);
    const guides = guideMatch ? [...guideMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map(s => s[1]).join("\n") : "";
    const combined = [`Tool: ${name}`, desc && `Description: ${desc.trim()}`, snippet && `Snippet: ${snippet}`, guides && `Guidelines:\n${guides}`].filter(Boolean).join("\n");
    if (combined.length > 50) tools[name] = combined;
  }
  return tools;
}

function toKebab(name: string): string {
  return name.replace(/_/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

// -- Target extraction -------------------------------------------------------

export function extractTargets(packageRoot?: string): GEPATarget[] {
  const root = packageRoot ?? findPackageRoot();
  const targets: GEPATarget[] = [];

  // Prompt templates
  const promptsFile = join(root, "src", "templates", "prompts.ts");
  if (existsSync(promptsFile)) {
    const src = readFileSync(promptsFile, "utf-8");
    for (const n of ["WIKI_SYSTEM_PROMPT","INGEST_PROMPT","QUERY_PROMPT","CAPTURE_SYSTEM_PROMPT","CAPTURE_PROMPT","EXPLICIT_CAPTURE_PROMPT","SUMMARIZE_SYSTEM_PROMPT","ITERATIVE_UPDATE_PROMPT","OVERVIEW_PROMPT","LINT_PROMPT"]) {
      const c = extractTSConst(src, n);
      if (c) targets.push({ name: toKebab(n), type: "prompt", content: c, sourceFile: promptsFile });
    }
  }

  // Maintainer + processor prompts
  for (const [file, constName, targetName] of [
    ["src/maintainer.ts", "MAINTENANCE_SYSTEM_PROMPT", "maintenance-system-prompt"],
    ["src/processor.ts", "CAPTURE_SYSTEM_PROMPT", "processor-capture-prompt"],
  ] as const) {
    const p = join(root, file);
    if (existsSync(p)) {
      const c = extractTSConst(readFileSync(p, "utf-8"), constName);
      if (c) targets.push({ name: targetName, type: "prompt", content: c, sourceFile: p });
    }
  }

  // Tool instructions
  const toolsFile = join(root, "src", "tools.ts");
  if (existsSync(toolsFile)) {
    for (const [n, c] of Object.entries(extractToolInstructions(readFileSync(toolsFile, "utf-8")))) {
      targets.push({ name: `tool-${n}`, type: "tool", content: c, sourceFile: toolsFile });
    }
  }

  // Skills
  for (const s of ["para", "setup"]) {
    const p = join(root, "skills", s, "SKILL.md");
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const body = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)?.[1]?.trim() ?? raw;
      targets.push({ name: `skill-${s}`, type: "skill", content: body, sourceFile: p });
    }
  }

  return targets;
}

// -- Auth env vars -----------------------------------------------------------

function getAuthEnvVars(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf-8"));
    if (auth.anthropic?.access) { env.ANTHROPIC_OAUTH_TOKEN = auth.anthropic.access; env.ANTHROPIC_API_KEY = auth.anthropic.access; }
    else if (auth.anthropic?.key) env.ANTHROPIC_API_KEY = auth.anthropic.key;
    if (auth.minimax?.key) env.MINIMAX_API_KEY = auth.minimax.key;
    if (auth.openrouter?.key) env.OPENROUTER_API_KEY = auth.openrouter.key;
    else if (auth.openrouter?.openrouter_key) env.OPENROUTER_API_KEY = auth.openrouter.openrouter_key;
  } catch {
    try {
      const raw = readFileSync(join(homedir(), ".config", "qmd", "index.yml"), "utf-8");
      const m = raw.match(/chat:[\s\S]*?key:\s*(.+)/);
      if (m) { const k = m[1].trim(); if (raw.includes("minimaxi.com")) env.MINIMAX_CN_API_KEY = k; else env.MINIMAX_API_KEY = k; }
    } catch {}
  }
  return env;
}

// -- Main orchestrator -------------------------------------------------------

export async function runGEPA(options: GEPAOptions = {}): Promise<GEPAOutput> {
  const root = findPackageRoot();
  const scriptsDir = join(root, "scripts", "gepa");
  for (const d of [INPUT_DIR, OUTPUT_DIR, OPTIMIZED_DIR, HISTORY_DIR]) mkdirSync(d, { recursive: true });

  // Load GEPA config from config.json (user-configurable defaults)
  let gepaConfig: Record<string, unknown> = {};
  try {
    const cfg = JSON.parse(readFileSync(join(WIKI_DIR, "config.json"), "utf-8"));
    gepaConfig = cfg.gepa ?? {};
  } catch {}

  // Resolution: CLI flag → options → config.json → default
  const studentModel = options.studentModel ?? options.model
    ?? (gepaConfig.studentModel as string) ?? "anthropic/claude-sonnet-4-20250514";
  const teacherModel = options.teacherModel ?? options.reflectionModel
    ?? (gepaConfig.teacherModel as string) ?? "anthropic/claude-opus-4-6";
  const judgeModel = options.judgeModel
    ?? (gepaConfig.judgeModel as string) ?? studentModel;
  const auto = options.auto ?? (gepaConfig.auto as "light" | "medium" | "heavy") ?? "light";
  const threads = options.threads ?? (gepaConfig.threads as number) ?? 2;
  const seed = options.seed ?? (gepaConfig.seed as number) ?? 42;

  const allTargets = extractTargets(root);
  let targets = options.target ? allTargets.filter(t => t.name === options.target) : allTargets;
  if (options.target && targets.length === 0) throw new Error(`Target '${options.target}' not found. Available: ${allTargets.map(t => t.name).join(", ")}`);

  console.log(`[gepa] Found ${targets.length} target(s) to optimize`);
  console.log(`[gepa] Student: ${studentModel}, Teacher: ${teacherModel}, Judge: ${judgeModel}, Budget: ${auto}`);

  const targetsFile = join(INPUT_DIR, "targets.json");
  writeFileSync(targetsFile, JSON.stringify({ targets: targets.map(t => ({ name: t.name, type: t.type, content: t.content })) }, null, 2));

  const outputFile = join(OUTPUT_DIR, "results.json");
  const uvArgs = [
    "run", "--project", scriptsDir, join(scriptsDir, "optimize.py"),
    "--targets-file", targetsFile, "--wiki-dir", WIKI_DIR, "--output", outputFile,
    "--model", studentModel,
    "--reflection-model", teacherModel,
    "--judge-model", judgeModel,
    "--auto", auto,
    "--threads", String(threads),
    "--seed", String(seed),
    ...(options.maxMetricCalls ? ["--max-metric-calls", String(options.maxMetricCalls)] : []),
    ...(options.target ? ["--target", options.target] : []),
  ];

  console.log(`[gepa] Running: uv ${uvArgs.slice(0, 6).join(" ")} ...`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("uv", uvArgs, { cwd: scriptsDir, env: { ...process.env, ...getAuthEnvVars() }, stdio: ["pipe", "inherit", "inherit"] });
    proc.on("close", c => c === 0 ? resolve() : reject(new Error(`uv exited with code ${c}`)));
    proc.on("error", e => reject(new Error(`Failed to spawn uv: ${e.message}`)));
  });

  if (!existsSync(outputFile)) throw new Error("Output file not created");
  const output: GEPAOutput = JSON.parse(readFileSync(outputFile, "utf-8"));

  for (const r of output.results) {
    if (r.status === "success" && r.optimized_instruction) {
      mkdirSync(OPTIMIZED_DIR, { recursive: true });
      writeFileSync(join(OPTIMIZED_DIR, `${r.target}.txt`), r.optimized_instruction, "utf-8");
      const hDir = join(HISTORY_DIR, r.target); mkdirSync(hDir, { recursive: true });
      writeFileSync(join(hDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(r, null, 2));
      console.log(`[gepa] Saved optimized: ${r.target}`);
    }
  }
  return output;
}

// -- Query functions ---------------------------------------------------------

export function listOptimized(): { name: string; score: number; timestamp: string; model: string }[] {
  if (!existsSync(OPTIMIZED_DIR)) return [];
  const results: { name: string; score: number; timestamp: string; model: string }[] = [];
  for (const f of readdirSync(OPTIMIZED_DIR).filter(f => f.endsWith(".txt"))) {
    const name = f.replace(".txt", "");
    let score = 0, timestamp = "", model = "";
    try {
      const entries = readdirSync(join(HISTORY_DIR, name)).filter(f => f.endsWith(".json")).sort().reverse();
      if (entries[0]) { const d = JSON.parse(readFileSync(join(HISTORY_DIR, name, entries[0]), "utf-8")); score = d.optimized_score ?? 0; timestamp = d.timestamp ?? ""; model = d.model ?? ""; }
    } catch {}
    results.push({ name, score, timestamp, model });
  }
  return results;
}

export function compareTarget(targetName: string): { original: string; optimized: string } | null {
  const target = extractTargets().find(t => t.name === targetName);
  if (!target) return null;
  try {
    const opt = readFileSync(join(OPTIMIZED_DIR, `${targetName}.txt`), "utf-8");
    return { original: target.content, optimized: opt };
  } catch { return null; }
}
