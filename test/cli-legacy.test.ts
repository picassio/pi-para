import { describe, expect, it } from "vitest";
import { formatLegacyDaemonWarning, isLegacyDaemonCommand } from "../src/cli-legacy.js";

describe("legacy daemon CLI warnings", () => {
  it("identifies legacy daemon commands", () => {
    expect(isLegacyDaemonCommand("start")).toBe(true);
    expect(isLegacyDaemonCommand("process-recent")).toBe(true);
    expect(isLegacyDaemonCommand("legacy-status")).toBe(true);
    expect(isLegacyDaemonCommand("status")).toBe(false);
    expect(isLegacyDaemonCommand("gepa")).toBe(false);
    expect(isLegacyDaemonCommand("tasks")).toBe(false);
    expect(isLegacyDaemonCommand(undefined)).toBe(false);
  });

  it("formats migration warnings with current workflow guidance", () => {
    const expected = new Map([
      ["start", "pi-para setup"],
      ["stop", "/wiki-scheduler status"],
      ["legacy-status", "pi-para tasks"],
      ["process", "pi-para capture-recent"],
      ["process-recent", "pi-para capture-recent"],
      ["retry-failed", "pi-para tasks retry"],
      ["history", "pi-para tasks history"],
      ["unknown", "pi-para tasks"],
    ]);

    for (const [command, replacement] of expected) {
      const warning = formatLegacyDaemonWarning(command);
      expect(warning).toContain("deprecated legacy daemon command");
      expect(warning).toContain("in-process scheduler");
      expect(warning).toContain(replacement);
    }
  });
});
