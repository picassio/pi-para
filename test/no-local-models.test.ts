import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("never a local model", () => {
  it("pi-para turns qmd's local models off: a store without a remote provider is refused, never opened on one", async () => {
    await import("../src/store.js");
    expect(process.env.QMD_NO_LOCAL_MODELS).toBe("1");

    const { createStore } = await import("qmd-engine");
    const dir = await mkdtemp(join(tmpdir(), "pi-para-no-local-"));

    try {
      await expect(createStore({ dbPath: join(dir, "index.sqlite"), config: { collections: {} } })).rejects.toThrow(
        /Local models are turned off/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
