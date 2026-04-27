import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
} from "../src/frontmatter.js";
import type { PageFrontmatter } from "../src/wiki.js";

describe("frontmatter", () => {
  describe("parseFrontmatter", () => {
    it("parses valid frontmatter and body", () => {
      const content = `---
title: SSL Certs
para: resources
scope:
  - pi-mono
tags:
  - ssl
  - security
sources:
  - https://example.com/ssl
created: "2026-04-27T00:00:00.000Z"
updated: "2026-04-27T00:00:00.000Z"
links:
  - "[[tls-basics]]"
---
# SSL Certs

Some content here.
`;
      const { frontmatter, body } = parseFrontmatter(content);
      expect(frontmatter.title).toBe("SSL Certs");
      expect(frontmatter.para).toBe("resources");
      expect(frontmatter.scope).toEqual(["pi-mono"]);
      expect(frontmatter.tags).toEqual(["ssl", "security"]);
      expect(frontmatter.sources).toEqual(["https://example.com/ssl"]);
      expect(frontmatter.links).toEqual(["[[tls-basics]]"]);
      expect(body).toBe("# SSL Certs\n\nSome content here.\n");
    });

    it("handles missing frontmatter", () => {
      const content = "# Just a heading\n\nNo frontmatter here.";
      const { frontmatter, body } = parseFrontmatter(content);
      expect(frontmatter.title).toBe("Untitled");
      expect(frontmatter.para).toBe("resources");
      expect(frontmatter.scope).toEqual([]);
      expect(body).toBe(content);
    });

    it("handles malformed YAML", () => {
      const content = `---
title: Bad
para: [unclosed
---
Body text.
`;
      expect(() => parseFrontmatter(content)).toThrow(
        /Malformed YAML frontmatter/,
      );
    });

    it("preserves unknown fields", () => {
      const content = `---
title: Page
para: areas
custom_field: hello
nested:
  key: value
---
Body`;
      const { frontmatter } = parseFrontmatter(content);
      expect(frontmatter.title).toBe("Page");
      expect((frontmatter as Record<string, unknown>).custom_field).toBe(
        "hello",
      );
      expect((frontmatter as Record<string, unknown>).nested).toEqual({
        key: "value",
      });
    });

    it("handles empty YAML block", () => {
      const content = `---
---
Body after empty frontmatter.`;
      const { frontmatter, body } = parseFrontmatter(content);
      expect(frontmatter.title).toBe("Untitled");
      expect(frontmatter.para).toBe("resources");
      expect(body).toBe("Body after empty frontmatter.");
    });

    it("handles empty body", () => {
      const content = `---
title: No Body
para: projects
---
`;
      const { frontmatter, body } = parseFrontmatter(content);
      expect(frontmatter.title).toBe("No Body");
      expect(body).toBe("");
    });

    it("handles special characters in title and body", () => {
      const content = `---
title: "Colon: & Ampersand & Quotes \\"escaped\\""
para: resources
tags:
  - "c++"
  - "c#"
---
Content with special chars: <html> & "quotes" & 'apostrophes'
`;
      const { frontmatter, body } = parseFrontmatter(content);
      expect(frontmatter.title).toContain("Colon");
      expect(frontmatter.tags).toContain("c++");
      expect(frontmatter.tags).toContain("c#");
      expect(body).toContain("<html>");
    });

    it("handles frontmatter with trailing newline before closing", () => {
      const content = `---
title: Test

---
Body`;
      const { frontmatter, body } = parseFrontmatter(content);
      expect(frontmatter.title).toBe("Test");
      expect(body).toBe("Body");
    });
  });

  describe("serializeFrontmatter", () => {
    it("serializes frontmatter and body to markdown string", () => {
      const fm: PageFrontmatter = {
        title: "Test Page",
        para: "projects",
        scope: ["my-project"],
        tags: ["test"],
        sources: [],
        created: "2026-04-27T00:00:00.000Z",
        updated: "2026-04-27T00:00:00.000Z",
        links: [],
      };
      const result = serializeFrontmatter(fm, "# Content\n\nHello.\n");
      expect(result).toMatch(/^---\n/);
      expect(result).toMatch(/\n---\n/);
      expect(result).toContain("title: Test Page");
      expect(result).toContain("para: projects");
      expect(result).toContain("# Content\n\nHello.\n");
    });

    it("roundtrips with parseFrontmatter", () => {
      const fm: PageFrontmatter = {
        title: "Roundtrip Test",
        para: "areas",
        scope: ["global"],
        tags: ["meta", "test"],
        sources: ["https://example.com"],
        created: "2026-01-15T10:30:00.000Z",
        updated: "2026-04-27T12:00:00.000Z",
        links: ["[[other-page]]", "[[another]]"],
      };
      const body = "# Roundtrip\n\nThis should survive a roundtrip.\n";
      const serialized = serializeFrontmatter(fm, body);
      const parsed = parseFrontmatter(serialized);
      expect(parsed.frontmatter.title).toBe(fm.title);
      expect(parsed.frontmatter.para).toBe(fm.para);
      expect(parsed.frontmatter.scope).toEqual(fm.scope);
      expect(parsed.frontmatter.tags).toEqual(fm.tags);
      expect(parsed.frontmatter.sources).toEqual(fm.sources);
      expect(parsed.frontmatter.created).toBe(fm.created);
      expect(parsed.frontmatter.updated).toBe(fm.updated);
      expect(parsed.frontmatter.links).toEqual(fm.links);
      expect(parsed.body).toBe(body);
    });

    it("roundtrips with unknown fields preserved", () => {
      const fm = {
        title: "Extended",
        para: "resources" as const,
        scope: [],
        tags: [],
        sources: [],
        created: "2026-04-27T00:00:00.000Z",
        updated: "2026-04-27T00:00:00.000Z",
        links: [],
        custom: "preserved",
      };
      const body = "Body\n";
      const serialized = serializeFrontmatter(
        fm as PageFrontmatter,
        body,
      );
      const parsed = parseFrontmatter(serialized);
      expect(
        (parsed.frontmatter as Record<string, unknown>).custom,
      ).toBe("preserved");
      expect(parsed.body).toBe(body);
    });

    it("handles empty body", () => {
      const fm: PageFrontmatter = {
        title: "Empty",
        para: "archives",
        scope: [],
        tags: [],
        sources: [],
        created: "2026-04-27T00:00:00.000Z",
        updated: "2026-04-27T00:00:00.000Z",
        links: [],
      };
      const result = serializeFrontmatter(fm, "");
      expect(result).toMatch(/---\n$/);
      const parsed = parseFrontmatter(result);
      expect(parsed.frontmatter.title).toBe("Empty");
      expect(parsed.body).toBe("");
    });
  });

  describe("validateFrontmatter", () => {
    it("validates required fields", () => {
      const fm = validateFrontmatter({
        title: "My Page",
        para: "projects",
      });
      expect(fm.title).toBe("My Page");
      expect(fm.para).toBe("projects");
      expect(fm.scope).toEqual([]);
      expect(fm.tags).toEqual([]);
      expect(fm.sources).toEqual([]);
      expect(fm.links).toEqual([]);
      // created and updated should be set to current time
      expect(fm.created).toBeTruthy();
      expect(fm.updated).toBeTruthy();
    });

    it("provides defaults for missing optional fields", () => {
      const fm = validateFrontmatter({});
      expect(fm.title).toBe("Untitled");
      expect(fm.para).toBe("resources");
      expect(fm.scope).toEqual([]);
      expect(fm.tags).toEqual([]);
      expect(fm.sources).toEqual([]);
      expect(fm.links).toEqual([]);
      expect(fm.created).toBeTruthy();
      expect(fm.updated).toBeTruthy();
    });

    it("rejects invalid para category", () => {
      const fm = validateFrontmatter({
        title: "Bad Category",
        para: "invalid-category",
      });
      // Falls back to "resources"
      expect(fm.para).toBe("resources");
    });

    it("coerces a single string scope to array", () => {
      const fm = validateFrontmatter({
        title: "Single Scope",
        scope: "my-project",
      });
      expect(fm.scope).toEqual(["my-project"]);
    });

    it("filters non-string values from arrays", () => {
      const fm = validateFrontmatter({
        title: "Mixed Array",
        tags: ["valid", 42, null, "also-valid"],
      });
      expect(fm.tags).toEqual(["valid", "also-valid"]);
    });

    it("preserves unknown fields", () => {
      const fm = validateFrontmatter({
        title: "With Extras",
        para: "areas",
        priority: "high",
        metadata: { nested: true },
      });
      expect(fm.title).toBe("With Extras");
      expect((fm as Record<string, unknown>).priority).toBe("high");
      expect((fm as Record<string, unknown>).metadata).toEqual({
        nested: true,
      });
    });

    it("preserves existing created/updated dates", () => {
      const fm = validateFrontmatter({
        title: "Dated",
        created: "2025-01-01T00:00:00.000Z",
        updated: "2025-06-15T12:00:00.000Z",
      });
      expect(fm.created).toBe("2025-01-01T00:00:00.000Z");
      expect(fm.updated).toBe("2025-06-15T12:00:00.000Z");
    });

    it("handles empty title string", () => {
      const fm = validateFrontmatter({ title: "" });
      expect(fm.title).toBe("Untitled");
    });
  });
});
