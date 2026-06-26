import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { expandHome, getParaPaths, resolvePath } from "../src/paths.js";

describe("paths", () => {
  it("expands home-prefixed paths", () => {
    expect(expandHome("~/wiki", "/home/alice")).toBe(join("/home/alice", "wiki"));
    expect(expandHome("~", "/home/alice")).toBe("/home/alice");
    expect(expandHome("/tmp/wiki", "/home/alice")).toBe("/tmp/wiki");
  });

  it("resolves relative paths against base directory", () => {
    expect(resolvePath("docs", "/repo", "/home/alice")).toBe(resolve("/repo", "docs"));
    expect(resolvePath("~/docs", "/repo", "/home/alice")).toBe(join("/home/alice", "docs"));
  });

  it("returns all canonical pi-para paths", () => {
    const paths = getParaPaths({ homeDir: "/home/alice", wikiDir: "~/kb" });
    expect(paths.agentDir).toBe(join("/home/alice", ".pi", "agent"));
    expect(paths.paraDir).toBe(join("/home/alice", ".pi", "para"));
    expect(paths.wikiDir).toBe(join("/home/alice", "kb"));
    expect(paths.userConfigPath).toBe(join("/home/alice", ".pi", "para", "config.jsonc"));
    expect(paths.secretsPath).toBe(join("/home/alice", ".pi", "para", "secrets.json"));
    expect(paths.schedulerDbPath).toBe(join("/home/alice", "kb", ".pi-para.sqlite"));
    expect(paths.legacyConfigPath).toBe(join("/home/alice", "kb", "config.json"));
    expect(paths.legacyQmdConfigPath).toBe(join("/home/alice", ".config", "qmd", "index.yml"));
    expect(paths.piSettingsPath).toBe(join("/home/alice", ".pi", "agent", "settings.json"));
  });
});
