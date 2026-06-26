import { existsSync, chmodSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { getParaPaths } from "./paths.js";

export type CredentialRef = `pi-auth:${string}` | `secret:${string}` | "none";

export interface SecretStoreData {
  version: 1;
  secrets: Record<string, string>;
}

export interface CredentialResolution {
  ok: boolean;
  source: "pi-auth" | "secret" | "none" | "missing";
  value?: string;
  error?: string;
}

export function parseCredentialRef(ref: string): { kind: "pi-auth" | "secret" | "none"; name: string | null } {
  if (ref === "none") return { kind: "none", name: null };
  if (ref.startsWith("pi-auth:") && ref.length > "pi-auth:".length) {
    return { kind: "pi-auth", name: ref.slice("pi-auth:".length) };
  }
  if (ref.startsWith("secret:") && ref.length > "secret:".length) {
    return { kind: "secret", name: ref.slice("secret:".length) };
  }
  throw new Error(`Unsupported credentialRef: ${ref}. Use pi-auth:<provider>, secret:<name>, or none.`);
}

export async function readSecretStore(path = getParaPaths().secretsPath): Promise<SecretStoreData> {
  if (!existsSync(path)) return { version: 1, secrets: {} };
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<SecretStoreData>;
  return { version: 1, secrets: parsed.secrets ?? {} };
}

export async function writeSecretStore(data: SecretStoreData, path = getParaPaths().secretsPath): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify({ version: 1, secrets: data.secrets }, null, 2)}\n`, 0o600);
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod can fail on non-POSIX filesystems; doctor reports permission issues.
  }
}

export async function setSecret(name: string, value: string, path = getParaPaths().secretsPath): Promise<void> {
  if (!name.trim()) throw new Error("Secret name is required.");
  if (!value) throw new Error("Secret value is required.");
  const data = await readSecretStore(path);
  data.secrets[name] = value;
  await writeSecretStore(data, path);
}

export async function removeSecret(name: string, path = getParaPaths().secretsPath): Promise<void> {
  const data = await readSecretStore(path);
  delete data.secrets[name];
  await writeSecretStore(data, path);
}

export async function resolveCredentialRef(
  ref: CredentialRef,
  opts: { secretsPath?: string; authStorage?: { getApiKey(provider: string): Promise<string | undefined> } } = {},
): Promise<CredentialResolution> {
  const parsed = parseCredentialRef(ref);
  if (parsed.kind === "none") return { ok: true, source: "none" };

  if (parsed.kind === "secret") {
    const data = await readSecretStore(opts.secretsPath);
    const value = data.secrets[parsed.name ?? ""];
    if (!value) return { ok: false, source: "missing", error: `Secret not found: ${parsed.name}` };
    return { ok: true, source: "secret", value };
  }

  const authStorage = opts.authStorage ?? await createPiAuthStorage();
  if (!authStorage) {
    return { ok: false, source: "missing", error: "Pi AuthStorage is unavailable." };
  }
  const value = await authStorage.getApiKey(parsed.name ?? "");
  if (!value) return { ok: false, source: "missing", error: `Pi auth not configured for provider: ${parsed.name}` };
  return { ok: true, source: "pi-auth", value };
}

async function createPiAuthStorage(): Promise<{ getApiKey(provider: string): Promise<string | undefined> } | null> {
  try {
    const mod = await import("@mariozechner/pi-coding-agent");
    const AuthStorage = (mod as unknown as { AuthStorage?: { create(): { getApiKey(provider: string): Promise<string | undefined> } } }).AuthStorage;
    return AuthStorage?.create() ?? null;
  } catch {
    return null;
  }
}

export function redactCredential(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
