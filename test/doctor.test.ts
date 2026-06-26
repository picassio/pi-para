import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatDoctorResult, runDoctor } from "../src/doctor.js";
import { setSecret } from "../src/credentials.js";
import { getDefaultUserConfig, saveParaConfig } from "../src/config.js";

describe("doctor", () => {
  async function tempHome() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-doctor-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("reports config, scheduler, secrets, qmd-skipped, and backlog state", async () => {
    const home = await tempHome();
    try {
      const result = await runDoctor({ homeDir: home.dir, fix: true, validateQmd: false });
      expect(result.ok).toBe(true);
      expect(result.checks.map((check) => check.name)).toEqual([
        "config",
        "pi-settings",
        "wiki-dir",
        "scheduler",
        "secrets",
        "gitignore",
        "qmd-providers",
        "qmd-embedding",
        "qmd-rerank",
        "capture-model",
        "capture-backlog",
      ]);
      expect(result.checks.find((check) => check.name === "wiki-dir")?.status).toBe("ok");
      expect(formatDoctorResult(result)).toContain("pi-para doctor");
    } finally {
      await home.cleanup();
    }
  });

  it("warns when local secrets permissions are too open", async () => {
    const home = await tempHome();
    try {
      const secretsPath = join(home.dir, ".pi", "para", "secrets.json");
      await setSecret("embed", "secret-value", secretsPath);
      await chmod(secretsPath, 0o644);
      let result = await runDoctor({ homeDir: home.dir, validateQmd: false });
      let secrets = result.checks.find((check) => check.name === "secrets");
      expect(secrets).toMatchObject({ status: "warn", fixable: true });
      expect(secrets?.message).toContain("too open");

      result = await runDoctor({ homeDir: home.dir, fix: true, validateQmd: false });
      secrets = result.checks.find((check) => check.name === "secrets");
      expect(secrets?.status).toBe("ok");
    } finally {
      await home.cleanup();
    }
  });

  it("reports provider credential diagnostics", async () => {
    const home = await tempHome();
    try {
      const config = getDefaultUserConfig(home.dir);
      config.qmd.embedding = {
        provider: "openai",
        model: "text-embedding-3-small",
        credentialRef: "secret:embedding",
      };
      config.models.capture = {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        credentialRef: "secret:capture",
      };
      await saveParaConfig(config, { homeDir: home.dir });
      await setSecret("embedding", "embed-key", join(home.dir, ".pi", "para", "secrets.json"));

      const result = await runDoctor({ homeDir: home.dir, validateQmd: false });

      expect(result.checks.find((check) => check.name === "qmd-embedding")).toMatchObject({ status: "ok" });
      expect(result.checks.find((check) => check.name === "capture-model")).toMatchObject({ status: "warn" });
      expect(result.checks.find((check) => check.name === "capture-model")?.message).toContain("Secret not found: capture");
    } finally {
      await home.cleanup();
    }
  });

  it("validates QMD SDK when requested", async () => {
    const home = await tempHome();
    try {
      const result = await runDoctor({ homeDir: home.dir, fix: true, validateQmd: true });
      expect(result.checks.find((check) => check.name === "qmd-sdk")?.status).toBe("ok");
      expect(result.ok).toBe(true);
    } finally {
      await home.cleanup();
    }
  });
});
