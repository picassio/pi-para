import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linuxmusl-arm64",
  "linuxmusl-x64",
  "win32-arm64",
  "win32-x64",
];

describe("native package bundle", () => {
  it("packs every better-sqlite3 N-API prebuild without running install scripts", () => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const output = execFileSync(
      npm,
      ["pack", "--ignore-scripts", "--dry-run", "--json"],
      { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    const [{ files }] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const paths = new Set(files.map((file) => file.path.replaceAll("\\", "/")));

    for (const platform of platforms) {
      expect(paths.has(`node_modules/better-sqlite3/prebuilds/${platform}.node`), platform).toBe(true);
    }
  }, 30_000);
});
