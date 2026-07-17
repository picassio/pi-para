import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCredentialRef,
  readSecretStore,
  redactCredential,
  removeSecret,
  resolveCredentialRef,
  setSecret,
} from "../src/credentials.js";

describe("credentials", () => {
  async function tempFile() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-cred-"));
    return { dir, path: join(dir, "secrets.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("parses supported credential references and rejects env-style refs", () => {
    expect(parseCredentialRef("none")).toEqual({ kind: "none", name: null });
    expect(parseCredentialRef("pi-auth:anthropic")).toEqual({ kind: "pi-auth", name: "anthropic" });
    expect(parseCredentialRef("secret:embed")).toEqual({ kind: "secret", name: "embed" });
    expect(() => parseCredentialRef("env:OPENAI_API_KEY")).toThrow(/Unsupported credentialRef/);
  });

  it("stores, resolves, redacts, and removes local secrets", async () => {
    const file = await tempFile();
    try {
      expect(await readSecretStore(file.path)).toEqual({ version: 1, secrets: {} });
      await setSecret("openai-embedding", "sk-test-secret", file.path);
      expect(existsSync(file.path)).toBe(true);
      if (process.platform !== "win32") {
        // POSIX mode bits are meaningless on Windows/NTFS (always 666)
        expect((statSync(file.path).mode & 0o777).toString(8)).toBe("600");
      }
      expect(await resolveCredentialRef("secret:openai-embedding", { secretsPath: file.path })).toMatchObject({
        ok: true,
        source: "secret",
        value: "sk-test-secret",
      });
      expect(redactCredential("sk-test-secret")).toBe("sk-t…cret");
      await removeSecret("openai-embedding", file.path);
      expect(await resolveCredentialRef("secret:openai-embedding", { secretsPath: file.path })).toMatchObject({
        ok: false,
        source: "missing",
      });
    } finally {
      await file.cleanup();
    }
  });

  it("resolves pi auth through an injected credential reader", async () => {
    const result = await resolveCredentialRef("pi-auth:anthropic", {
      credentials: { getApiKey: async (provider) => provider === "anthropic" ? "token" : undefined },
    });
    expect(result).toEqual({ ok: true, source: "pi-auth", value: "token" });
  });

  it("reports missing pi auth and none credentials", async () => {
    await expect(setSecret("", "value")).rejects.toThrow(/Secret name/);
    await expect(setSecret("name", "")).rejects.toThrow(/Secret value/);
    expect(await resolveCredentialRef("none")).toEqual({ ok: true, source: "none" });
    expect(await resolveCredentialRef("pi-auth:missing", { credentials: { getApiKey: async () => undefined } })).toMatchObject({
      ok: false,
      source: "missing",
    });
    expect(await resolveCredentialRef("pi-auth:missing", { credentials: null })).toEqual({
      ok: false,
      source: "missing",
      error: "Pi credential runtime is unavailable.",
    });
    expect(redactCredential(undefined)).toBe("not set");
    expect(redactCredential("short")).toBe("********");
  });
});
