import { describe, it, expect } from "vitest";
import {
  generateSummary,
  generateOverviewPrompt,
  serializeSessionForWiki,
} from "../src/summarize.js";
import type { SummarizeOptions } from "../src/summarize.js";
import type { WikiPage } from "../src/wiki.js";
import type { ProjectScope } from "../src/scope.js";

// Helper to create a minimal scope
function makeScope(name = "test-project"): ProjectScope {
  return {
    name,
    include: [name, "global"],
    exclude: [],
    source: "dirname",
  };
}

// Helper to create a minimal wiki page
function makePage(overrides: Partial<WikiPage> & { slug: string; body: string }): WikiPage {
  return {
    category: overrides.category ?? "resources",
    slug: overrides.slug,
    frontmatter: overrides.frontmatter ?? {
      title: overrides.slug.replace(/-/g, " "),
      para: overrides.category ?? "resources",
      scope: ["global"],
      tags: [],
      sources: [],
      created: "2026-01-01",
      updated: "2026-01-01",
      links: [],
    },
    body: overrides.body,
  };
}

describe("summarize", () => {
  describe("serializeSessionForWiki", () => {
    it("serializes messages to [User]: / [Assistant]: format", () => {
      const messages = [
        {
          role: "user",
          content: "How do I fix the SSL error?",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "You need to clear the cert cache." }],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-4",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      ];

      const result = serializeSessionForWiki(messages);
      expect(result).toContain("[User]: How do I fix the SSL error?");
      expect(result).toContain("[Assistant]: You need to clear the cert cache.");
    });

    it("truncates long tool results", () => {
      const longContent = "x".repeat(3000);
      const messages = [
        {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [{ type: "text", text: longContent }],
          isError: false,
          timestamp: Date.now(),
        },
      ];

      const result = serializeSessionForWiki(messages);
      expect(result).toContain("[Tool result]:");
      // Should be truncated at 2000 chars (the content part)
      expect(result).toContain("[... 1000 more characters truncated]");
      expect(result.length).toBeLessThan(longContent.length);
    });

    it("includes thinking content", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me analyze this..." },
            { type: "text", text: "The answer is 42." },
          ],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-4",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      ];

      const result = serializeSessionForWiki(messages);
      expect(result).toContain("[Assistant thinking]: Let me analyze this...");
      expect(result).toContain("[Assistant]: The answer is 42.");
    });

    it("serializes tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc_1",
              name: "read",
              arguments: { path: "/tmp/foo.ts" },
            },
          ],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-4",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          stopReason: "tool_use",
          timestamp: Date.now(),
        },
      ];

      const result = serializeSessionForWiki(messages);
      expect(result).toContain("[Assistant tool calls]: read(path=");
      expect(result).toContain("/tmp/foo.ts");
    });

    it("handles empty messages array", () => {
      expect(serializeSessionForWiki([])).toBe("");
    });

    it("handles user content as array of text blocks", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Part one. " },
            { type: "text", text: "Part two." },
          ],
          timestamp: Date.now(),
        },
      ];

      const result = serializeSessionForWiki(messages);
      expect(result).toContain("[User]: Part one. Part two.");
    });

    it("skips messages with unknown roles", () => {
      const messages = [
        { role: "unknown", content: "should be skipped" },
        { role: "user", content: "visible", timestamp: Date.now() },
      ];

      const result = serializeSessionForWiki(messages);
      expect(result).not.toContain("should be skipped");
      expect(result).toContain("[User]: visible");
    });
  });

  describe("generateSummary", () => {
    const scope = makeScope();

    it("generates ingest summary prompt", () => {
      const content = "SSL certificates expire after 90 days by default.";
      const options: SummarizeOptions = {
        mode: "ingest",
        scope,
        category: "resources",
      };

      const result = generateSummary(content, options);
      expect(result).toContain("source-content");
      expect(result).toContain(content);
      expect(result).toContain("test-project");
      expect(result).toContain("resources");
      // Should include the summarize system prompt
      expect(result).toContain("knowledge synthesis assistant");
    });

    it("generates session summary prompt", () => {
      const content = "[User]: How do I fix SSL?\n\n[Assistant]: Clear the cache.";
      const options: SummarizeOptions = {
        mode: "session",
        scope,
      };

      const result = generateSummary(content, options);
      expect(result).toContain("session-conversation");
      expect(result).toContain(content);
      expect(result).toContain("</session-conversation>");
      // Should include the capture prompt
      expect(result).toContain("Analyze the session conversation");
    });

    it("generates page summary prompt", () => {
      const content = "## Topic\nSSL certificates\n\n## Key Facts\n- Expire after 90 days";
      const options: SummarizeOptions = {
        mode: "page",
        scope,
      };

      const result = generateSummary(content, options);
      expect(result).toContain("page-content");
      expect(result).toContain(content);
      expect(result).toContain("Summarize the following wiki page");
    });

    it("generates iterative update prompt with existing content", () => {
      const existingContent = "## Topic\nSSL certs\n\n## Key Facts\n- Expire after 90 days";
      const newContent = "SSL certs can be renewed with certbot.";
      const options: SummarizeOptions = {
        mode: "iterative",
        scope,
        existingContent,
      };

      const result = generateSummary(newContent, options);
      expect(result).toContain("<existing-page>");
      expect(result).toContain(existingContent);
      expect(result).toContain("</existing-page>");
      expect(result).toContain("<new-content>");
      expect(result).toContain(newContent);
      expect(result).toContain("</new-content>");
      expect(result).toContain("PRESERVE all existing knowledge");
    });

    it("falls back to ingest mode when iterative has no existing content", () => {
      const content = "New topic about DNS records.";
      const options: SummarizeOptions = {
        mode: "iterative",
        scope,
      };

      const result = generateSummary(content, options);
      // Should fall back to ingest mode (no existing-page tags)
      expect(result).not.toContain("<existing-page>");
      expect(result).toContain("<source-content>");
      expect(result).toContain(content);
    });

    it("includes scope info in all modes", () => {
      const options: SummarizeOptions = {
        mode: "ingest",
        scope: makeScope("my-project"),
      };

      const result = generateSummary("content", options);
      expect(result).toContain("my-project");
      expect(result).toContain("Current scope:");
    });
  });

  describe("generateOverviewPrompt", () => {
    it("generates overview from multiple pages", () => {
      const pages: WikiPage[] = [
        makePage({
          slug: "ssl-certs",
          category: "resources",
          body: "## Topic\nSSL certificates\n\n## Key Facts\n- Used for HTTPS",
        }),
        makePage({
          slug: "auth-refactor",
          category: "projects",
          body: "## Topic\nAuth system refactor\n\n## Key Facts\n- Moving to OAuth2",
          frontmatter: {
            title: "Auth Refactor",
            para: "projects",
            scope: ["test-project"],
            tags: ["auth"],
            sources: [],
            created: "2026-01-01",
            updated: "2026-01-15",
            links: ["ssl-certs"],
          },
        }),
      ];

      const scope = makeScope();
      const result = generateOverviewPrompt(pages, scope);

      expect(result).toContain("Summarize the following wiki pages");
      expect(result).toContain("ssl-certs");
      expect(result).toContain("auth-refactor");
      expect(result).toContain("Total pages: 2");
      expect(result).toContain("SSL certificates");
      expect(result).toContain("Auth system refactor");
      expect(result).toContain("test-project");
    });

    it("handles empty pages array", () => {
      const scope = makeScope();
      const result = generateOverviewPrompt([], scope);

      expect(result).toContain("Total pages: 0");
      expect(result).toContain("Summarize the following wiki pages");
    });

    it("includes frontmatter metadata for each page", () => {
      const page = makePage({
        slug: "docker-patterns",
        body: "Docker best practices",
        frontmatter: {
          title: "Docker Patterns",
          para: "resources",
          scope: ["global"],
          tags: ["docker", "devops"],
          sources: ["https://docs.docker.com"],
          created: "2026-01-01",
          updated: "2026-01-01",
          links: [],
        },
      });

      const result = generateOverviewPrompt([page], makeScope());
      expect(result).toContain("Docker Patterns");
      expect(result).toContain("resources/docker-patterns");
      expect(result).toContain("docker, devops");
    });
  });
});
