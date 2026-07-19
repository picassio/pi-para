import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatLegacyDaemonRemoval,
  isLegacyDaemonBinary,
  isLegacyDaemonCommand,
} from "../src/cli-legacy.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(command: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, command], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
}

describe("removed legacy daemon CLI", () => {
  it("identifies removed commands and compatibility binary names", () => {
    expect(isLegacyDaemonCommand("daemon")).toBe(true);
    expect(isLegacyDaemonCommand("watch")).toBe(true);
    expect(isLegacyDaemonCommand("start")).toBe(true);
    expect(isLegacyDaemonCommand("tasks")).toBe(false);
    expect(isLegacyDaemonCommand(undefined)).toBe(false);
    expect(isLegacyDaemonBinary("/usr/local/bin/pi-para-daemon")).toBe(true);
    expect(isLegacyDaemonBinary("C:\\bin\\pi-para-daemon.cmd")).toBe(true);
    expect(isLegacyDaemonBinary("/usr/local/bin/pi-para")).toBe(false);
  });

  it.each(["daemon", "watch"])("prints the removal message and exits nonzero for %s", (command) => {
    const result = runCli(command);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(`${formatLegacyDaemonRemoval(command)}\n`);
    expect(result.stderr).toContain("removed in 0.7");
    expect(result.stderr).toContain("embedded scheduler");
    expect(result.stderr).toContain("pi-para tasks");
    expect(result.stderr).toContain("pi-para doctor");
  });
});
