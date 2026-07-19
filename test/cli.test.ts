import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultUserConfig, saveParaConfig } from "../src/config.js";
import { SchedulerStateDB } from "../src/scheduler/state.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const repoDir = fileURLToPath(new URL("..", import.meta.url));

let home: string;
let oldHome: string | undefined;
let oldUserProfile: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-para-cli-"));
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  // Windows os.homedir() resolves USERPROFILE, not HOME.
  process.env.USERPROFILE = home;
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldUserProfile;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("CLI wiki directory", () => {
  it("lists scheduler tasks from the configured wiki.dir", async () => {
    const customWikiDir = join(home, "custom-wiki");
    const config = getDefaultUserConfig(home);
    config.wiki.dir = customWikiDir;
    await saveParaConfig(config, { homeDir: home });

    const db = new SchedulerStateDB(join(customWikiDir, ".pi-para.sqlite"));
    db.enqueue("custom-wiki-task", { source: "configured-wiki" });
    db.close();

    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "tasks"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("queued custom-wiki-task");
  });

  it("falls back to the default wiki directory when config loading fails", async () => {
    const defaultWikiDir = join(home, ".pi", "wiki");
    const db = new SchedulerStateDB(join(defaultWikiDir, ".pi-para.sqlite"));
    db.enqueue("default-wiki-task", {});
    db.close();

    const configPath = join(home, ".pi", "para", "config.jsonc");
    await mkdir(join(home, ".pi", "para"), { recursive: true });
    await writeFile(configPath, "{ invalid jsonc", "utf8");

    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "tasks"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("queued default-wiki-task");
  });
});
