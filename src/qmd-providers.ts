import type { CollectionConfig } from "qmd-engine";
import type { ParaUserConfig, ProviderCredentialRef } from "./config.js";
import { resolveCredentialRef, type CredentialRef } from "./credentials.js";

export type QmdProvidersConfig = NonNullable<CollectionConfig["providers"]>;

export interface BuildQmdProvidersOptions {
  secretsPath?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}

export async function buildQmdProvidersFromParaConfig(
  config: ParaUserConfig,
  opts: BuildQmdProvidersOptions = {},
): Promise<QmdProvidersConfig | undefined> {
  if (config.qmd.providerConfig !== "pi-para-profiles") return undefined;

  const providers: QmdProvidersConfig = {};

  if (config.qmd.embedEnabled && config.qmd.embedding) {
    providers.embed = await toQmdEndpoint(config.qmd.embedding, "embed", opts);
  }

  if (config.qmd.rerank) {
    providers.rerank = await toQmdEndpoint(config.qmd.rerank, "rerank", opts);
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

async function toQmdEndpoint(
  profile: ProviderCredentialRef,
  role: "embed" | "rerank",
  opts: BuildQmdProvidersOptions,
): Promise<NonNullable<QmdProvidersConfig[typeof role]>> {
  const resolved = await resolveCredentialRef(profile.credentialRef as CredentialRef, opts);
  const endpoint: NonNullable<QmdProvidersConfig[typeof role]> = {
    url: profile.baseUrl || defaultBaseUrl(profile.provider, role),
    model: profile.model,
  };

  if (profile.apiFormat === "openai" || profile.apiFormat === "anthropic") {
    endpoint.api = profile.apiFormat;
  }
  if (resolved.ok && resolved.value) {
    endpoint.key = resolved.value;
  }
  if (role === "embed" && profile.dims) {
    (endpoint as NonNullable<QmdProvidersConfig["embed"]>).dims = profile.dims;
  }

  return endpoint;
}

export function defaultBaseUrl(provider: string, role: "embed" | "rerank"): string | undefined {
  const normalized = provider.toLowerCase();
  if (normalized === "openai") return "https://api.openai.com/v1";
  if (normalized === "openrouter") return "https://openrouter.ai/api/v1";
  if (normalized === "jina" && role === "rerank") return "https://api.jina.ai/v1";
  if (normalized === "voyage") return "https://api.voyageai.com/v1";
  if (normalized === "cohere") return "https://api.cohere.com/v2";
  return undefined;
}
