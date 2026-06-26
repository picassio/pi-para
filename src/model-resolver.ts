import type { Model } from "@earendil-works/pi-ai";
import type { ProviderCredentialRef, ParaUserConfig } from "./config.js";
import { resolveCredentialRef } from "./credentials.js";

export interface ModelRegistryLike {
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface AuthStorageLike {
  getApiKey(provider: string): Promise<string | undefined>;
}

export type ModelSelection = ProviderCredentialRef | "auto";

export function parseProviderModelSpec(spec: string): { provider: string; modelId: string } | null {
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx === spec.length - 1) return null;
  return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

export function resolveSelectedModel(
  selection: ModelSelection,
  registry: ModelRegistryLike,
  opts: { legacyModelSpec?: string | null; preferredModelSpec?: string } = {},
): Model<any> | null {
  if (selection !== "auto") {
    if (selection.model) return registry.find(selection.provider, selection.model) ?? null;
    return registry.getAvailable().find((model) => model.provider === selection.provider) ?? null;
  }

  const legacy = opts.legacyModelSpec ? parseProviderModelSpec(opts.legacyModelSpec) : null;
  if (legacy) {
    const model = registry.find(legacy.provider, legacy.modelId);
    if (model) return model;
  }

  const preferred = opts.preferredModelSpec ? parseProviderModelSpec(opts.preferredModelSpec) : null;
  if (preferred) {
    const model = registry.find(preferred.provider, preferred.modelId);
    if (model) return model;
  }

  return pickBestAvailableModel(registry.getAvailable());
}

export function pickBestAvailableModel(models: Model<any>[]): Model<any> | null {
  if (models.length === 0) return null;
  const sonnet = models.find((model) => model.provider === "anthropic" && /sonnet/i.test(model.id));
  if (sonnet) return sonnet;
  return [...models].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0] ?? null;
}

export function createModelApiKeyResolver(
  selection: ModelSelection,
  registry: ModelRegistryLike,
  opts: { authStorage?: AuthStorageLike; secretsPath?: string } = {},
): (provider: string) => Promise<string | undefined> {
  return async (provider: string) => {
    if (selection === "auto") return registry.getApiKeyForProvider(provider);

    if (selection.credentialRef.startsWith("pi-auth:")) {
      const configuredProvider = selection.credentialRef.slice("pi-auth:".length);
      if (configuredProvider !== provider && selection.provider !== provider) return undefined;
      return (await opts.authStorage?.getApiKey(provider)) ?? await registry.getApiKeyForProvider(provider);
    }

    if (selection.credentialRef.startsWith("secret:")) {
      if (selection.provider !== provider) return undefined;
      const resolved = await resolveCredentialRef(selection.credentialRef, { secretsPath: opts.secretsPath });
      return resolved.ok ? resolved.value : undefined;
    }

    return undefined;
  };
}

export function getCaptureSelection(config: ParaUserConfig): ModelSelection {
  return config.models.capture;
}

export async function createPiModelRegistry(): Promise<{ authStorage: AuthStorageLike; modelRegistry: ModelRegistryLike } | null> {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    const typed = mod as unknown as {
      AuthStorage?: { create(): AuthStorageLike };
      ModelRegistry?: { create(authStorage: AuthStorageLike): ModelRegistryLike };
    };
    if (!typed.AuthStorage || !typed.ModelRegistry) return null;
    const authStorage = typed.AuthStorage.create();
    return { authStorage, modelRegistry: typed.ModelRegistry.create(authStorage) };
  } catch {
    return null;
  }
}
