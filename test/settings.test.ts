import { describe, expect, it } from "vitest";
import { getDefaultUserConfig } from "../src/config.js";
import {
  applyProviderPreset,
  disableRerank,
  ensureEmbeddingProfile,
  findProviderPreset,
  PROVIDER_PRESETS,
  ensureRerankProfile,
  modelSelectionLabel,
  providerProfileLabel,
  setCaptureModel,
  setCaptureModelAuto,
  setContextMaxTokens,
  setLintStaleDays,
  setProviderDims,
  setProviderProfileField,
  setSearchLimit,
  setWebWikiEnabled,
  setWebWikiHost,
  setWebWikiPort,
  toggleLintAutoFix,
  toggleSearchGraphBoost,
} from "../src/settings.js";

describe("settings", () => {
  it("formats model and provider labels", () => {
    expect(modelSelectionLabel("auto")).toBe("auto");
    expect(modelSelectionLabel({ provider: "anthropic", model: "claude", credentialRef: "pi-auth:anthropic" })).toBe("anthropic/claude via pi-auth:anthropic");
    expect(providerProfileLabel(null)).toBe("not configured");
    expect(providerProfileLabel({ provider: "openai", model: "embed", baseUrl: "https://api", credentialRef: "secret:embed" })).toBe("openai/embed at https://api via secret:embed");
  });

  it("updates numeric and toggle settings with safe fallbacks", () => {
    const config = getDefaultUserConfig("/tmp/home");
    expect(setContextMaxTokens(config, "6000")).toBe(6000);
    expect(setContextMaxTokens(config, "bad")).toBe(6000);
    expect(setSearchLimit(config, "25")).toBe(25);
    expect(setLintStaleDays(config, "30")).toBe(30);
    expect(toggleSearchGraphBoost(config)).toBe(false);
    expect(toggleLintAutoFix(config)).toBe(false);
  });

  it("updates capture and web wiki settings", () => {
    const config = getDefaultUserConfig("/tmp/home");
    const capture = setCaptureModel(config, "anthropic", "claude-sonnet");
    expect(capture).toEqual({ provider: "anthropic", model: "claude-sonnet", credentialRef: "pi-auth:anthropic" });
    expect(config.models.capture).toEqual(capture);
    setCaptureModelAuto(config);
    expect(config.models.capture).toBe("auto");

    setWebWikiEnabled(config, true);
    setWebWikiHost(config, "0.0.0.0");
    expect(setWebWikiPort(config, "1234")).toBe(1234);
    expect(config.webWiki).toMatchObject({ enabled: true, host: "0.0.0.0", port: 1234 });
  });

  it("updates embedding/rerank profiles and rejects env credential refs", () => {
    const config = getDefaultUserConfig("/tmp/home");
    const embedding = ensureEmbeddingProfile(config);
    setProviderProfileField(embedding, "provider", "openai");
    setProviderProfileField(embedding, "baseUrl", "https://api.openai.com/v1");
    setProviderProfileField(embedding, "model", "text-embedding-3-small");
    setProviderProfileField(embedding, "apiFormat", "openai");
    setProviderProfileField(embedding, "credentialRef", "secret:embedding");
    expect(setProviderDims(embedding, "1536")).toBe(1536);
    expect(config.qmd.embedding).toMatchObject({ provider: "openai", dims: 1536, credentialRef: "secret:embedding" });
    expect(() => setProviderProfileField(embedding, "credentialRef", "env:OPENAI_API_KEY")).toThrow(/credentialRef/);
    expect(() => setProviderProfileField(embedding, "apiFormat", "bad")).toThrow(/apiFormat/);

    const rerank = ensureRerankProfile(config);
    expect(rerank.provider).toBe("jina");
    disableRerank(config);
    expect(config.qmd.rerank).toBeNull();
  });

  it("exposes provider presets with baseUrl and api format", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("openrouter");
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(["openai", "anthropic"]).toContain(preset.apiFormat);
    }
    expect(findProviderPreset("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(findProviderPreset("nope")).toBeUndefined();
  });

  it("applies a provider preset without touching credentialRef or dims", () => {
    const config = getDefaultUserConfig("/tmp/home");
    const embedding = ensureEmbeddingProfile(config);
    setProviderDims(embedding, "768");
    setProviderProfileField(embedding, "credentialRef", "secret:embedding");

    applyProviderPreset(embedding, findProviderPreset("openrouter")!, "embedding");
    expect(embedding).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiFormat: "openai",
      model: "openai/text-embedding-3-small",
      dims: 768,
      credentialRef: "secret:embedding",
    });

    // Rerank preset without a default rerank model keeps the existing model
    const rerank = ensureRerankProfile(config);
    const before = rerank.model;
    applyProviderPreset(rerank, findProviderPreset("openai")!, "rerank");
    expect(rerank.provider).toBe("openai");
    expect(rerank.model).toBe(before);

    applyProviderPreset(rerank, findProviderPreset("voyage")!, "rerank");
    expect(rerank.model).toBe("rerank-2-lite");
  });
});
