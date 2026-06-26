import { describe, expect, it } from "vitest";
import {
  buildWikiToolGuidanceSection,
  getWikiToolGuidelines,
  WIKI_TOOL_DESCRIPTIONS,
  WIKI_TOOL_SNIPPETS,
} from "../src/wiki-tool-guidance.js";

describe("wiki tool guidance", () => {
  it("keeps descriptions concise and tool-specific", () => {
    expect(WIKI_TOOL_DESCRIPTIONS.wiki_query).toContain("Search");
    expect(WIKI_TOOL_DESCRIPTIONS.wiki_write).toContain("Create");
    expect(WIKI_TOOL_SNIPPETS.wiki_edit).toContain("oldText");
  });

  it("returns defensive copies of per-tool guidelines", () => {
    const first = getWikiToolGuidelines("wiki_write");
    first.push("mutated");

    expect(getWikiToolGuidelines("wiki_write")).not.toContain("mutated");
  });

  it("centralizes global wiki behavior guidance", () => {
    const section = buildWikiToolGuidanceSection();

    expect(section).toContain("## pi-para Wiki Tool Guidance");
    expect(section).toContain("wiki_query");
    expect(section).toContain("wiki_edit");
    expect(section).toContain("wiki_write");
    expect(section).toContain("no secrets");
  });
});
