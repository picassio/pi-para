import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureGeneratedStateGitignore,
  fixSecretPermissions,
  GENERATED_STATE_GITIGNORE_PATTERNS,
  missingGeneratedStateGitignorePatterns,
  readMode,
} from "../src/repair.js";

describe("repair", () => {
  async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), "pi-para-repair-"));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it("detects and repairs missing generated-state gitignore patterns", async () => {
    const tmp = await tempDir();
    try {
      await writeFile(join(tmp.dir, ".gitignore"), "custom\n.qmd.sqlite*\n", "utf-8");
      expect(missingGeneratedStateGitignorePatterns(tmp.dir)).toContain(".pi-para.sqlite*");
      const result = await ensureGeneratedStateGitignore(tmp.dir);
      expect(result.changed).toBe(true);
      expect(result.added).toEqual(GENERATED_STATE_GITIGNORE_PATTERNS.filter((p) => p !== ".qmd.sqlite*"));
      const content = await readFile(join(tmp.dir, ".gitignore"), "utf-8");
      expect(content).toContain("custom");
      expect(missingGeneratedStateGitignorePatterns(tmp.dir)).toEqual([]);
      expect((await ensureGeneratedStateGitignore(tmp.dir)).changed).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });

  it("fixes secret permissions only when needed", async () => {
    const tmp = await tempDir();
    try {
      const path = join(tmp.dir, "secrets.json");
      await writeFile(path, "{}", "utf-8");
      chmodSync(path, 0o644);
      expect(readMode(path).toString(8)).toBe("644");
      expect(fixSecretPermissions(path)).toBe(true);
      expect(readMode(path).toString(8)).toBe("600");
      expect(fixSecretPermissions(path)).toBe(false);
      expect(fixSecretPermissions(join(tmp.dir, "missing.json"))).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });
});
