import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logCapture } from "../src/processor.js";

describe("capture diagnostics never leak into the live terminal", () => {
  it("background capture/scheduler sources contain no console output", () => {
    // The capture scheduler runs inside the live interactive Pi process.
    // Console output there bypasses the TUI renderer and leaks
    // session-derived text into the currently active session.
    const backgroundSources = [
      "src/processor.ts",
      "src/summarize.ts",
      "src/raw.ts",
      "src/capture.ts",
      "src/session-tools.ts",
      "src/scheduler/index.ts",
      "src/scheduler/session-capture.ts",
      "src/scheduler/state.ts",
      "src/scheduler/leases.ts",
      "src/scheduler/controls.ts",
    ];
    for (const file of backgroundSources) {
      const source = readFileSync(join(__dirname, "..", file), "utf-8");
      const offending = source
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /console\.(log|error|info|warn|debug)\(/.test(line));
      expect(offending, `${file} must not write to the live terminal: ${JSON.stringify(offending)}`).toEqual([]);
    }
  });

  it("logCapture writes to .capture.log inside the wiki, rotates, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "para-capture-log-"));
    logCapture(dir, "Agent finished (scope): 5 messages, 2 tool results");
    const logPath = join(dir, ".capture.log");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toMatch(/Agent finished \(scope\): 5 messages, 2 tool results\n$/);

    // Oversized log rotates to .old instead of growing without bound.
    writeFileSync(logPath, "x".repeat(1024 * 1024 + 1));
    logCapture(dir, "after rotation");
    expect(existsSync(`${logPath}.old`)).toBe(true);
    expect(statSync(logPath).size).toBeLessThan(1024);
    expect(readFileSync(logPath, "utf-8")).toContain("after rotation");

    // A bogus directory must be silently ignored.
    expect(() => logCapture(join(dir, "missing", "nested"), "ignored")).not.toThrow();
  });

  it("the capture log is ignored by the seeded wiki .gitignore and never staged", () => {
    const wikiSource = readFileSync(join(__dirname, "..", "src", "wiki.ts"), "utf-8");
    expect(wikiSource).toContain(".capture.log*");
    const stageBlock = wikiSource.slice(wikiSource.indexOf("stageCandidates"), wikiSource.indexOf("stagePaths"));
    expect(stageBlock).not.toContain(".capture.log");
  });
});
