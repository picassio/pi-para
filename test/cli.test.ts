import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModel } from "../src/cli.js";
import { getDefaultUserConfig, saveParaConfig } from "../src/config.js";
import { setSecret } from "../src/credentials.js";

let home: string;
let oldHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-para-cli-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});

describe("legacy CLI model selection", () => {
  it("uses an explicit Pi model with fake persisted auth before a configured secret", async () => {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "persisted-key" } }));
    const config = getDefaultUserConfig(home);
    config.models.capture = { provider: "anthropic", model: "claude-fable-5", credentialRef: "secret:capture" };
    await saveParaConfig(config, { homeDir: home });
    await setSecret("capture", "secret-key", join(home, ".pi", "para", "secrets.json"));

    const selected = await createModel("anthropic/claude-fable-5");
    expect(selected.model.provider).toBe("anthropic");
    expect(await selected.getApiKey("anthropic")).toBe("persisted-key");
  });

  it("uses the configured capture model and pi-para secret when persisted auth is absent", async () => {
    const config = getDefaultUserConfig(home);
    config.models.capture = { provider: "anthropic", model: "claude-fable-5", credentialRef: "secret:capture" };
    await saveParaConfig(config, { homeDir: home });
    await setSecret("capture", "secret-key", join(home, ".pi", "para", "secrets.json"));
    const selected = await createModel();
    expect(selected.model.id).toBe("claude-fable-5");
    expect(await selected.getApiKey("anthropic")).toBe("secret-key");
  });

  it("auto-selects a remote model from fake persisted auth without environment variables", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "persisted-key" } }));
    const selected = await createModel();
    expect(selected.model.provider).toBe("anthropic");
    expect(await selected.getApiKey("anthropic")).toBe("persisted-key");
  });
});
