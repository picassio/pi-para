import { existsSync, statSync } from "node:fs";
import { initWiki } from "./wiki.js";
import { loadParaConfig, type ParaUserConfig } from "./config.js";
import { readSecretStore, resolveCredentialRef } from "./credentials.js";
import { getParaPaths } from "./paths.js";
import { openStore, closeStore } from "./store.js";
import type { ProviderCredentialRef } from "./config.js";
import { createPiModelRegistry, getCaptureSelection, resolveSelectedModel } from "./model-resolver.js";
import { SchedulerStateDB } from "./scheduler/state.js";
import { ensureGeneratedStateGitignore, fixSecretPermissions, missingGeneratedStateGitignorePatterns } from "./repair.js";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  fixable?: boolean;
}

export interface DoctorOptions {
  homeDir?: string;
  fix?: boolean;
  validateQmd?: boolean;
  testCaptureModel?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const loaded = await loadParaConfig({ homeDir: options.homeDir, migrate: options.fix ?? false });
  const paths = getParaPaths({ homeDir: options.homeDir, wikiDir: loaded.config.wiki.dir });

  checks.push(checkExists("config", paths.userConfigPath, "warn"));
  checks.push(checkExists("pi-settings", paths.piSettingsPath, "warn"));

  if (options.fix) await initWiki(paths.wikiDir);
  checks.push(checkExists("wiki-dir", paths.wikiDir, "warn", true));

  const schedulerCheck = checkScheduler(paths.schedulerDbPath);
  checks.push(schedulerCheck);

  if (options.fix) {
    fixSecretPermissions(paths.secretsPath);
    await ensureGeneratedStateGitignore(paths.wikiDir);
  }

  checks.push(await checkSecrets(paths.secretsPath));
  checks.push(await checkGeneratedStateGitignore(paths.wikiDir));
  checks.push(...await checkProviderDiagnostics(loaded.config, paths.secretsPath, options));

  if (options.validateQmd !== false) {
    checks.push(await checkQmd(paths.wikiDir, loaded.config, paths.secretsPath));
  }

  const backlogPath = `${paths.wikiDir}/.completed-sessions`;
  if (existsSync(backlogPath)) {
    checks.push({
      name: "capture-backlog",
      status: "warn",
      message: ".completed-sessions exists; startup catch-up will process queued entries once capture task is enabled",
    });
  } else {
    checks.push({ name: "capture-backlog", status: "ok", message: "no completed-session registry found" });
  }

  return { ok: checks.every((check) => check.status !== "error"), checks };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = ["pi-para doctor"];
  for (const check of result.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    lines.push(`  ${icon} ${check.name}: ${check.message}`);
  }
  return lines.join("\n");
}

function checkExists(name: string, path: string, missingStatus: DoctorStatus, fixable = false): DoctorCheck {
  return existsSync(path)
    ? { name, status: "ok", message: path }
    : { name, status: missingStatus, message: `${path} not found`, fixable };
}

function checkScheduler(dbPath: string): DoctorCheck {
  try {
    const db = new SchedulerStateDB(dbPath);
    const queued = db.list("queued").length;
    db.close();
    return { name: "scheduler", status: "ok", message: `${dbPath} (${queued} queued)` };
  } catch (err) {
    return { name: "scheduler", status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSecrets(secretsPath: string): Promise<DoctorCheck> {
  try {
    const store = await readSecretStore(secretsPath);
    if (!existsSync(secretsPath)) return { name: "secrets", status: "ok", message: "no local pi-para secrets configured" };
    // POSIX mode bits are meaningless on Windows/NTFS — stat reports 666 and
    // chmod is a no-op, so a permissions warning there is a false positive.
    if (process.platform === "win32") {
      return { name: "secrets", status: "ok", message: `${Object.keys(store.secrets).length} local secret(s) (POSIX permission check skipped on Windows)` };
    }
    const mode = statSync(secretsPath).mode & 0o777;
    if (mode & 0o077) {
      return { name: "secrets", status: "warn", message: `${secretsPath} permissions are too open (${mode.toString(8)})`, fixable: true };
    }
    return { name: "secrets", status: "ok", message: `${Object.keys(store.secrets).length} local secret(s), permissions ${mode.toString(8)}` };
  } catch (err) {
    return { name: "secrets", status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkGeneratedStateGitignore(wikiDir: string): Promise<DoctorCheck> {
  try {
    const missing = missingGeneratedStateGitignorePatterns(wikiDir);
    if (missing.length > 0) {
      return { name: "gitignore", status: "warn", message: `missing generated-state ignores: ${missing.join(", ")}`, fixable: true };
    }
    return { name: "gitignore", status: "ok", message: "generated SQLite/state files are ignored" };
  } catch (err) {
    return { name: "gitignore", status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkProviderDiagnostics(
  config: ParaUserConfig,
  secretsPath: string,
  options: DoctorOptions,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  if (config.qmd.providerConfig === "legacy-qmd-compatible") {
    checks.push({ name: "qmd-providers", status: "warn", message: "using legacy QMD provider config compatibility mode" });
  } else {
    checks.push({ name: "qmd-providers", status: "ok", message: "using pi-para provider profiles" });
  }

  if (!config.qmd.embedEnabled) {
    checks.push({ name: "qmd-embedding", status: "ok", message: "embedding disabled" });
  } else if (config.qmd.embedding) {
    checks.push(await checkCredentialProfile("qmd-embedding", config.qmd.embedding, secretsPath));
  } else {
    checks.push({ name: "qmd-embedding", status: "warn", message: "embedding enabled but no pi-para embedding profile is configured" });
  }

  if (config.qmd.rerank) {
    checks.push(await checkCredentialProfile("qmd-rerank", config.qmd.rerank, secretsPath));
  } else {
    checks.push({ name: "qmd-rerank", status: "ok", message: "rerank disabled" });
  }

  checks.push(await checkCaptureModel(config, secretsPath, options.testCaptureModel === true));
  return checks;
}

async function checkCredentialProfile(name: string, profile: ProviderCredentialRef, secretsPath: string): Promise<DoctorCheck> {
  const label = `${profile.provider}/${profile.model ?? "model not set"}`;
  if (profile.credentialRef === "none") {
    return { name, status: "ok", message: `${label} uses no credential` };
  }
  const resolved = await resolveCredentialRef(profile.credentialRef, { secretsPath });
  if (!resolved.ok) {
    return { name, status: "warn", message: `${label} credential missing: ${resolved.error}` };
  }
  return { name, status: "ok", message: `${label} credential available via ${resolved.source}` };
}

async function checkCaptureModel(config: ParaUserConfig, secretsPath: string, testModel: boolean): Promise<DoctorCheck> {
  const selection = getCaptureSelection(config);
  if (!testModel) {
    if (selection === "auto") return { name: "capture-model", status: "ok", message: "auto selection; run doctor --test-capture-model to resolve" };
    return checkCredentialProfile("capture-model", selection, secretsPath);
  }

  try {
    const registry = await createPiModelRegistry();
    if (!registry) return { name: "capture-model", status: "warn", message: "Pi model registry unavailable" };
    const model = resolveSelectedModel(selection, registry.modelRegistry, { preferredModelSpec: "anthropic/claude-sonnet-4-20250514" });
    if (!model) return { name: "capture-model", status: "warn", message: "no capture model resolved" };
    const getKey = selection === "auto"
      ? () => registry.modelRegistry.getApiKeyForProvider(model.provider)
      : () => resolveCredentialRef(selection.credentialRef, { secretsPath, authStorage: registry.authStorage }).then((r) => r.value);
    const key = await getKey();
    return key
      ? { name: "capture-model", status: "ok", message: `${model.provider}/${model.id} credential available` }
      : { name: "capture-model", status: "warn", message: `${model.provider}/${model.id} resolved but credential is missing` };
  } catch (err) {
    return { name: "capture-model", status: "warn", message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkQmd(wikiDir: string, config: ParaUserConfig, secretsPath: string): Promise<DoctorCheck> {
  try {
    const store = await openStore(wikiDir, {
      paraConfig: { ...config, qmd: { ...config.qmd, embedEnabled: false } },
      secretsPath,
    });
    let embedInfo = "";
    let pending = 0;
    let hasVectorIndex = false;
    try {
      const status = await store.getStatus();
      hasVectorIndex = Boolean(status.hasVectorIndex);
      pending = status.needsEmbedding ?? 0;
      const profile = config.qmd.embedding;
      const endpointHost = profile?.baseUrl ? new URL(profile.baseUrl).host : "default";
      const adapter = profile ? `${profile.provider}/${profile.model ?? "model not set"} at ${endpointHost}` : "no embedding profile";
      embedInfo = ` — vector index: ${hasVectorIndex ? "yes" : "no"}, pending embeddings: ${pending}, embed: ${adapter}`;
    } catch {
      // status probe is best-effort
    }
    await closeStore(store);
    // Pending embeddings are expected transient state — the background
    // qmd-embed scheduler task drains them while a Pi session is open — so
    // report the numbers without failing the check.
    const note = config.qmd.embedEnabled !== false && !hasVectorIndex && pending > 0
      ? " (background qmd-embed task will process these while a Pi session is open)"
      : "";
    return { name: "qmd-sdk", status: "ok", message: `store opened and updated with pi-para provider profiles${embedInfo}${note}` };
  } catch (err) {
    return { name: "qmd-sdk", status: "error", message: err instanceof Error ? err.message : String(err), fixable: false };
  }
}
