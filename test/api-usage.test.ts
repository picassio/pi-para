// pi-para/store passes qmd-engine's onApiUsage through, so a host can count what the wiki's embeddings cost.
import { describe, expect, test } from "vitest";
import { onApiUsage } from "../src/store.js";

describe("onApiUsage", () => {
  test("is qmd-engine's, from pi-para/store: a listener added returns how to stop", () => {
    const stop = onApiUsage(() => {});
    expect(typeof stop).toBe("function");
    stop();
  });
});
