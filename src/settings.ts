import type { ParaUserConfig, ProviderCredentialRef } from "./config.js";

export function modelSelectionLabel(selection: ParaUserConfig["models"]["capture"]): string {
  if (selection === "auto") return "auto";
  return `${selection.provider}/${selection.model ?? "auto"} via ${selection.credentialRef}`;
}

export function providerProfileLabel(profile: ProviderCredentialRef | null | undefined): string {
  if (!profile) return "not configured";
  const model = profile.model ?? "model not set";
  const location = profile.baseUrl ? ` at ${profile.baseUrl}` : "";
  return `${profile.provider}/${model}${location} via ${profile.credentialRef}`;
}

export function setContextMaxTokens(config: ParaUserConfig, value: string): number {
  const parsed = parsePositiveInteger(value, config.context.maxTokens);
  config.context.maxTokens = parsed;
  return parsed;
}

export function setSearchLimit(config: ParaUserConfig, value: string): number {
  const parsed = parsePositiveInteger(value, config.context.searchLimit);
  config.context.searchLimit = parsed;
  return parsed;
}

export function setLintStaleDays(config: ParaUserConfig, value: string): number {
  const parsed = parsePositiveInteger(value, config.lint.staleDays);
  config.lint.staleDays = parsed;
  return parsed;
}

export function toggleSearchGraphBoost(config: ParaUserConfig): boolean {
  config.context.searchGraphBoost = !config.context.searchGraphBoost;
  return config.context.searchGraphBoost;
}

export function toggleLintAutoFix(config: ParaUserConfig): boolean {
  config.lint.autoFix = !config.lint.autoFix;
  return config.lint.autoFix;
}

export function setCaptureModelAuto(config: ParaUserConfig): void {
  config.models.capture = "auto";
}

export function setCaptureModel(config: ParaUserConfig, provider: string, model: string): ProviderCredentialRef {
  const profile: ProviderCredentialRef = {
    provider,
    model,
    credentialRef: `pi-auth:${provider}`,
  };
  config.models.capture = profile;
  return profile;
}

export function setWebWikiEnabled(config: ParaUserConfig, enabled: boolean): void {
  config.webWiki.enabled = enabled;
}

export function setWebWikiHost(config: ParaUserConfig, host: string): void {
  config.webWiki.host = host.trim() || config.webWiki.host;
}

export function setWebWikiPort(config: ParaUserConfig, value: string): number {
  const parsed = parsePositiveInteger(value, config.webWiki.port);
  config.webWiki.port = parsed;
  return parsed;
}

export function setProviderProfileField(
  profile: ProviderCredentialRef,
  field: "provider" | "baseUrl" | "model" | "apiFormat" | "credentialRef",
  value: string,
): void {
  if (field === "apiFormat") {
    if (value !== "openai" && value !== "anthropic" && value !== "custom") {
      throw new Error("apiFormat must be openai, anthropic, or custom");
    }
    profile.apiFormat = value;
    return;
  }
  if (field === "credentialRef") {
    if (value !== "none" && !value.startsWith("pi-auth:") && !value.startsWith("secret:")) {
      throw new Error("credentialRef must be pi-auth:<provider>, secret:<name>, or none");
    }
    profile.credentialRef = value as ProviderCredentialRef["credentialRef"];
    return;
  }
  profile[field] = value;
}

export function setProviderDims(profile: ProviderCredentialRef, value: string): number {
  const parsed = parsePositiveInteger(value, profile.dims ?? 0);
  profile.dims = parsed;
  return parsed;
}

export function ensureEmbeddingProfile(config: ParaUserConfig): ProviderCredentialRef {
  config.qmd.embedding ??= {
    provider: "openai",
    model: "text-embedding-3-small",
    apiFormat: "openai",
    credentialRef: "secret:embedding",
  };
  return config.qmd.embedding;
}

export function ensureRerankProfile(config: ParaUserConfig): ProviderCredentialRef {
  config.qmd.rerank ??= {
    provider: "jina",
    model: "jina-reranker-v2-base-multilingual",
    apiFormat: "openai",
    credentialRef: "secret:rerank",
  };
  return config.qmd.rerank;
}

export function disableRerank(config: ParaUserConfig): void {
  config.qmd.rerank = null;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
