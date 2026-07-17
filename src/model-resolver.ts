import type { Model } from "@earendil-works/pi-ai";
import type { ProviderCredentialRef, ParaUserConfig } from "./config.js";
import { resolveCredentialRef } from "./credentials.js";

export interface ModelRegistryLike {
  getAll(): Model<any>[];
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface PiCredentialReader {
  hasStoredCredential(provider: string): boolean;
  getApiKey(provider: string): Promise<string | undefined>;
}

export interface PiModelServices {
  modelRegistry: ModelRegistryLike;
  credentials: PiCredentialReader;
}

export type ModelSelection = ProviderCredentialRef | "auto";

export function parseProviderModelSpec(spec: string): { provider: string; modelId: string } | null {
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx === spec.length - 1) return null;
  return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

function isRemoteModel(model: Model<any>): boolean {
  return model.provider !== "node-llama-cpp" && model.provider !== "local" && !model.provider.includes("llama");
}

export function resolveSelectedModel(
  selection: ModelSelection,
  registry: ModelRegistryLike,
  opts: { legacyModelSpec?: string | null; preferredModelSpec?: string } = {},
): Model<any> | null {
  if (selection !== "auto") {
    if (selection.model) return registry.find(selection.provider, selection.model) ?? null;
    return registry.getAvailable().find((model) => model.provider === selection.provider && isRemoteModel(model)) ?? null;
  }

  const legacy = opts.legacyModelSpec ? parseProviderModelSpec(opts.legacyModelSpec) : null;
  if (legacy) {
    const model = registry.find(legacy.provider, legacy.modelId);
    if (model && isRemoteModel(model)) return model;
  }

  const preferred = opts.preferredModelSpec ? parseProviderModelSpec(opts.preferredModelSpec) : null;
  if (preferred) {
    const model = registry.find(preferred.provider, preferred.modelId);
    if (model && isRemoteModel(model)) return model;
  }

  return pickBestAvailableModel(registry.getAvailable().filter(isRemoteModel));
}

export function pickBestAvailableModel(models: Model<any>[]): Model<any> | null {
  const remote = models.filter(isRemoteModel);
  if (remote.length === 0) return null;
  const sonnet = remote.find((model) => model.provider === "anthropic" && /sonnet/i.test(model.id));
  if (sonnet) return sonnet;
  return [...remote].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0] ?? null;
}

export function createModelApiKeyResolver(
  selection: ModelSelection,
  registry: ModelRegistryLike,
  opts: { credentials?: PiCredentialReader; secretsPath?: string } = {},
): (provider: string) => Promise<string | undefined> {
  return async (provider: string) => {
    if (selection === "auto") {
      return opts.credentials ? opts.credentials.getApiKey(provider) : registry.getApiKeyForProvider(provider);
    }
    if (selection.provider !== provider) return undefined;

    if (selection.credentialRef.startsWith("pi-auth:")) {
      const configuredProvider = selection.credentialRef.slice("pi-auth:".length);
      if (configuredProvider !== provider) return undefined;
      return opts.credentials ? opts.credentials.getApiKey(provider) : registry.getApiKeyForProvider(provider);
    }

    if (selection.credentialRef.startsWith("secret:")) {
      const resolved = await resolveCredentialRef(selection.credentialRef, { secretsPath: opts.secretsPath });
      return resolved.ok ? resolved.value : undefined;
    }

    return undefined;
  };
}

export function getCaptureSelection(config: ParaUserConfig): ModelSelection {
  return config.models.capture;
}

export async function createPiModelServices(
  options: { authPath?: string } = {},
): Promise<PiModelServices | null> {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    const runtime = await mod.ModelRuntime.create({ authPath: options.authPath, allowModelNetwork: false });
    const modelRegistry = new mod.ModelRegistry(runtime);
    await modelRegistry.refresh();
    return {
      modelRegistry,
      credentials: {
        hasStoredCredential: (provider) => Boolean(mod.readStoredCredential(provider, options.authPath)),
        getApiKey: async (provider) => {
          if (!mod.readStoredCredential(provider, options.authPath)) return undefined;
          return (await runtime.getAuth(provider))?.auth.apiKey;
        },
      },
    };
  } catch {
    return null;
  }
}

/** @deprecated Use createPiModelServices. */
export const createPiModelRegistry = createPiModelServices;
