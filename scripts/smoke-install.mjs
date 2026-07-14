#!/usr/bin/env node
/* v8 ignore start */
import { mkdtemp, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

async function main() {
  await access(cli, constants.R_OK).catch(() => {
    throw new Error("dist/cli.js not found. Run npm run build before smoke-install.");
  });

  const home = await mkdtemp(join(tmpdir(), "pi-para-smoke-"));
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows — set both.
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  try {
    await run([cli, "setup", "--yes", "--local", root], env);

    const status = JSON.parse((await run([cli, "status", "--json"], env)).stdout);
    assert(status.configPath?.startsWith(home), "status configPath should use smoke HOME");
    assert(status.wikiDir?.startsWith(home), "status wikiDir should use smoke HOME");
    assert(typeof status.pages?.total === "number", "status pages.total should be numeric");
    assert(typeof status.scheduler?.queued === "number", "status scheduler.queued should be numeric");

    const doctor = JSON.parse((await run([cli, "doctor", "--json"], env)).stdout);
    assert(doctor.ok === true, "doctor should pass in smoke HOME");

    console.log("pi-para smoke install passed");
    console.log(`  HOME: ${home}`);
    console.log(`  Config: ${status.configPath}`);
    console.log(`  Wiki: ${status.wikiDir}`);
  } finally {
    if (!process.env.PI_PARA_KEEP_SMOKE_HOME) {
      await rm(home, { recursive: true, force: true });
    }
  }
}

async function run(args, env) {
  const [file, ...rest] = args;
  return execFileAsync(process.execPath, [file, ...rest], {
    cwd: root,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
