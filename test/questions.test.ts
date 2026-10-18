import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../src/context.js";
import { lintWiki } from "../src/lint.js";
import {
  answeredNote,
  collectOpenQuestions,
  daysSince,
  formatOpenQuestions,
  openQuestionsOf,
  parseQuestions,
  questionLine,
  questionsMaybeAnswered,
  resolvedLine,
} from "../src/questions.js";
import { resetSchedulersForTests } from "../src/scheduler/index.js";
import { createEditExecute, createReadExecute } from "../src/tools/edit-read.js";
import { initWiki, writePage, type PageFrontmatter, type WikiPage } from "../src/wiki.js";

let wikiDir: string;

function page(category: WikiPage["category"], slug: string, body: string, overrides: Partial<PageFrontmatter> = {}): WikiPage {
  return {
    category,
    slug,
    frontmatter: {
      title: slug,
      para: category,
      scope: ["global"],
      tags: [],
      sources: [],
      created: "2026-10-01T00:00:00.000Z",
      updated: "2026-10-01T00:00:00.000Z",
      links: [],
      schemaVersion: 2,
      ...overrides,
    } as PageFrontmatter,
    body,
  };
}

const MACHINES = `## Topic
How the app reaches machines.

## Open Questions
- [ ] (2026-10-02, #993) Does the folder picker need a key no longer works state?
- Should machines show their uptime in the sheet?
- [x] (2026-10-03, #993) Is the agent socket private? → yes, mode 0600
- ~~Old question struck through~~
- none

## Resolved Questions
- [x] (2026-10-01, #12) Where are keys kept? → in the database

## Sources
- session 993`;

beforeEach(async () => {
  wikiDir = await mkdtemp(join(tmpdir(), "pi-para-questions-"));
  await initWiki(wikiDir);
});

afterEach(async () => {
  // wiki_edit starts the maintenance scheduler, whose SQLite must close before the folder goes (Windows EBUSY).
  resetSchedulersForTests();
  await rm(wikiDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("open questions", () => {
  it("reads tracked lines, plain bullets, and ticked or struck ones as resolved", () => {
    const lines = parseQuestions(MACHINES);

    expect(lines.map((each) => [each.text, each.date, each.session, each.done])).toEqual([
      ["Does the folder picker need a key no longer works state?", "2026-10-02", "#993", false],
      ["Should machines show their uptime in the sheet?", undefined, undefined, false],
      ["Is the agent socket private? → yes, mode 0600", "2026-10-03", "#993", true],
      ["Old question struck through", undefined, undefined, true],
    ]);
    expect(openQuestionsOf(MACHINES).map((each) => each.text)).toEqual([
      "Does the folder picker need a key no longer works state?",
      "Should machines show their uptime in the sheet?",
    ]);
    expect(parseQuestions(MACHINES, "Resolved Questions").map((each) => each.done)).toEqual([true]);
    expect(questionLine("Why?", { date: "2026-10-18", session: "993" })).toBe("- [ ] (2026-10-18, #993) Why?");
    expect(resolvedLine("Why?", "because", { date: "2026-10-19" })).toBe("- [x] (2026-10-19) Why? → because");
    expect(daysSince("2026-10-11", Date.parse("2026-10-18T12:00:00Z"))).toBe(7);
  });

  it("collects them across the wiki, this scope's first, oldest first; archives are history", async () => {
    await writePage(wikiDir, page("resources", "machines", MACHINES, { scope: ["pi-phone"], updated: "2026-10-05T00:00:00.000Z" }));
    await writePage(wikiDir, page("resources", "other", "## Open Questions\n- [ ] (2026-09-01) An old question elsewhere?\n", { scope: ["other"] }));
    await writePage(wikiDir, page("archives", "done", "## Open Questions\n- [ ] (2026-08-01) Archived question?\n"));

    const scope = { name: "pi-phone", include: ["pi-phone"], exclude: [], source: "config" as const };
    const all = await collectOpenQuestions(wikiDir, { scope });

    expect(all.map((each) => [each.page, each.asked, each.inScope])).toEqual([
      ["resources/machines", "2026-10-02", true],
      ["resources/machines", "2026-10-05", true],
      ["resources/other", "2026-09-01", false],
    ]);
    expect(formatOpenQuestions(all, { max: 2 })).toMatch(/on \[\[machines\]\] \(resources\/machines\), asked 2026-10-02, #993\n.*\n- …and 1 more/);
  });

  it("points out the open questions a page just written may answer, on any page, and not its own new questions", async () => {
    await writePage(wikiDir, page("resources", "machines", MACHINES));
    const answers = await questionsMaybeAnswered(wikiDir, [
      {
        page: "resources/health",
        text: "## Key Facts\n- The folder picker marks a machine whose key no longer works with a warning (machine health).\n\n## Open Questions\n- [ ] (2026-10-18) Should machines show their uptime in the sheet?",
      },
    ]);

    expect(answers.map((each) => each.text)).toEqual(["Does the folder picker need a key no longer works state?"]);
    expect(answeredNote(answers)).toMatch(/This may answer an open question in the wiki:\n- «Does the folder picker[^»]*» on resources\/machines, asked 2026-10-02 \(#993\)[^\n]*\nIf it does, resolve it\. To resolve one, wiki_edit its page/);
    expect(await questionsMaybeAnswered(wikiDir, [{ page: "resources/x", text: "Unrelated words about bread and butter." }])).toEqual([]);
  });

  it("wiki_read shows a page's open questions first; wiki_edit says what an edit may answer", async () => {
    await writePage(wikiDir, page("resources", "machines", MACHINES));
    await writePage(wikiDir, page("resources", "health", "## Key Facts\n- Machines answer.\n"));

    const read = await createReadExecute(wikiDir)({ path: "resources/machines" });
    const text = (read.content[0] as { text: string }).text;

    expect(text).toMatch(/Open questions on this page \(2\): resolve any you can answer\.[^\n]*\n- Does the folder picker need a key no longer works state\? \(asked 2026-10-02, #993\)\n- Should machines show their uptime in the sheet\?\n\n## Topic/);

    const store = { update: async () => ({}) } as never;
    const edited = await createEditExecute(wikiDir, store, () => {})({
      path: "resources/health",
      edits: [{ oldText: "- Machines answer.", newText: "- Machines answer. The folder picker marks a machine whose key no longer works." }],
    });

    expect((edited.content[0] as { text: string }).text).toMatch(/Edited resources\/health\.[^\n]*\nThis may answer an open question in the wiki:\n- «Does the folder picker/);
  });

  it("lint warns about questions open longer than the limit; the context lists them", async () => {
    await writePage(wikiDir, page("resources", "machines", MACHINES, { updated: new Date().toISOString() }));
    await writePage(wikiDir, page("resources", "fresh", `## Open Questions\n- [ ] (${new Date().toISOString().slice(0, 10)}) A question asked today?\n`));

    const report = await lintWiki(wikiDir, { autoFix: false, questionDays: 7 });
    const open = report.issues.filter((issue) => issue.category === "open-question");

    expect(open.map((issue) => issue.page)).toEqual(["resources/machines"]);
    expect(open[0]!.severity).toBe("warning");
    expect(open[0]!.message).toMatch(/^Open for \d+ days \(asked 2026-10-02, #993\): «Does the folder picker/);

    const scope = { name: "global", include: ["global"], exclude: [], source: "config" as const };
    const context = await buildContext(wikiDir, {} as never, scope, { includeSchema: false, includeIndex: false, includeSummaries: false });

    expect(context).toMatch(/## Open Questions in the Wiki \(3\)\n\nStill unknown\. When your work answers one, resolve it\./);
    expect(context).toMatch(/- Does the folder picker need a key no longer works state\? — on \[\[machines\]\]/);
  });
});
