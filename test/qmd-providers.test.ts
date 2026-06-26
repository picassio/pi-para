import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDefaultUserConfig } from "../src/config.js";
import { setSecret } from "../src/credentials.js";
import { buildQmdProvidersFromParaConfig, defaultBaseUrl } from "../src/qmd-providers.js";

describe("qmd provider profiles", () => {
  it("translates pi-para embedding and rerank profiles to QMD SDK providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-qmd-providers-"));
    try {
      const secretsPath = join(dir, "secrets.json");
      await setSecret("embedding", "embed-key", secretsPath);
      await setSecret("rerank", "rerank-key", secretsPath);

      const config = getDefaultUserConfig(dir);
      config.qmd.embedding = {
        provider: "openai",
        model: "text-embedding-3-small",
        dims: 1536,
        apiFormat: "openai",
        credentialRef: "secret:embedding",
      };
      config.qmd.rerank = {
        provider: "jina",
        model: "jina-reranker-v2-base-multilingual",
        credentialRef: "secret:rerank",
      };

      const providers = await buildQmdProvidersFromParaConfig(config, { secretsPath });

      expect(providers?.embed).toEqual({
        url: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        api: "openai",
        key: "embed-key",
        dims: 1536,
      });
      expect(providers?.rerank).toEqual({
        url: "https://api.jina.ai/v1",
        model: "jina-reranker-v2-base-multilingual",
        key: "rerank-key",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not translate legacy-compatible configs", async () => {
    const config = getDefaultUserConfig();
    config.qmd.providerConfig = "legacy-qmd-compatible";
    config.qmd.embedding = {
      provider: "openai",
      model: "text-embedding-3-small",
      credentialRef: "none",
    };

    await expect(buildQmdProvidersFromParaConfig(config)).resolves.toBeUndefined();
  });

  it("keeps explicit local/no-auth profiles without a key", async () => {
    const config = getDefaultUserConfig();
    config.qmd.embedding = {
      provider: "local-openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      credentialRef: "none",
    };

    const providers = await buildQmdProvidersFromParaConfig(config);

    expect(providers?.embed).toEqual({
      url: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
    });
  });

  it("preserves endpoint selection when a secret is missing", async () => {
    const config = getDefaultUserConfig();
    config.qmd.embedding = {
      provider: "openai",
      model: "text-embedding-3-small",
      credentialRef: "secret:missing",
    };

    const providers = await buildQmdProvidersFromParaConfig(config, { secretsPath: "/tmp/no-such-pi-para-secrets.json" });

    expect(providers?.embed).toEqual({
      url: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
    });
  });

  it("knows common provider base URLs", () => {
    expect(defaultBaseUrl("openai", "embed")).toBe("https://api.openai.com/v1");
    expect(defaultBaseUrl("jina", "rerank")).toBe("https://api.jina.ai/v1");
    expect(defaultBaseUrl("unknown", "embed")).toBeUndefined();
  });
});
