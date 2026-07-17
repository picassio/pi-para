import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import {
  createModelApiKeyResolver,
  createPiModelServices,
  getCaptureSelection,
  parseProviderModelSpec,
  pickBestAvailableModel,
  resolveSelectedModel,
  type ModelRegistryLike,
} from "../src/model-resolver.js";
import { getDefaultUserConfig } from "../src/config.js";

function model(provider: string, id: string, contextWindow = 1000): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "anthropic-messages" as any,
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 1000,
  };
}

function registry(models: Model<any>[]): ModelRegistryLike {
  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    getApiKeyForProvider: async (provider) => `${provider}-key`,
  };
}

describe("model resolver", () => {
  it("parses provider/model specs", () => {
    expect(parseProviderModelSpec("anthropic/claude-sonnet")).toEqual({ provider: "anthropic", modelId: "claude-sonnet" });
    expect(parseProviderModelSpec("bad")).toBeNull();
    expect(parseProviderModelSpec("/bad")).toBeNull();
    expect(parseProviderModelSpec("bad/")).toBeNull();
  });

  it("prefers available Sonnet, then largest context", () => {
    const haiku = model("anthropic", "claude-haiku", 2000);
    const sonnet = model("anthropic", "claude-sonnet", 1000);
    const other = model("openai", "gpt", 9000);
    expect(pickBestAvailableModel([haiku, sonnet, other])).toBe(sonnet);
    expect(pickBestAvailableModel([haiku, other])).toBe(other);
    expect(pickBestAvailableModel([])).toBeNull();
  });

  it("resolves explicit, legacy, preferred, and auto selections", () => {
    const models = [model("anthropic", "claude-sonnet", 1000), model("openai", "gpt", 2000)];
    const reg = registry(models);
    expect(resolveSelectedModel({ provider: "openai", model: "gpt", credentialRef: "pi-auth:openai" }, reg)).toBe(models[1]);
    expect(resolveSelectedModel({ provider: "openai", credentialRef: "pi-auth:openai" }, reg)).toBe(models[1]);
    expect(resolveSelectedModel("auto", reg, { legacyModelSpec: "openai/gpt" })).toBe(models[1]);
    expect(resolveSelectedModel("auto", reg, { preferredModelSpec: "anthropic/claude-sonnet" })).toBe(models[0]);
    expect(resolveSelectedModel({ provider: "missing", model: "nope", credentialRef: "pi-auth:missing" }, reg)).toBeNull();
  });

  it("creates API key resolvers without env refs", async () => {
    const reg = registry([model("anthropic", "claude-sonnet")]);
    expect(await createModelApiKeyResolver("auto", reg)("anthropic")).toBe("anthropic-key");
    expect(await createModelApiKeyResolver({ provider: "anthropic", model: "claude-sonnet", credentialRef: "pi-auth:anthropic" }, reg, {
      credentials: { hasStoredCredential: () => true, getApiKey: async () => "auth-key" },
    })("anthropic")).toBe("auth-key");
    expect(await createModelApiKeyResolver({ provider: "anthropic", model: "claude-sonnet", credentialRef: "pi-auth:other" }, reg)("openai")).toBeUndefined();
  });

  it("creates the Pi 0.80.10 runtime with synchronous registry reads and async credential resolution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-runtime-"));
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "fake-test-key" } }));
      const services = await createPiModelServices({ authPath });
      expect(services).not.toBeNull();
      expect(services!.modelRegistry.getAll().length).toBeGreaterThan(0);
      expect(services!.credentials.hasStoredCredential("anthropic")).toBe(true);
      expect(await services!.credentials.getApiKey("anthropic")).toBe("fake-test-key");
      expect(services!.credentials.hasStoredCredential("missing")).toBe(false);
      expect(await services!.credentials.getApiKey("missing")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never auto-selects local models", () => {
    expect(resolveSelectedModel("auto", registry([model("node-llama-cpp", "local", 100_000)]))).toBeNull();
  });

  it("reads capture selection from config", () => {
    const config = getDefaultUserConfig("/tmp/home");
    expect(getCaptureSelection(config)).toBe("auto");
    config.models.capture = { provider: "anthropic", model: "claude", credentialRef: "pi-auth:anthropic" };
    expect(getCaptureSelection(config)).toEqual({ provider: "anthropic", model: "claude", credentialRef: "pi-auth:anthropic" });
  });
});
