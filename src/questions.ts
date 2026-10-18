/**
 * Open questions: the "## Open Questions" section of a page, as tracked items.
 *
 * A question is one bullet line. Written by an agent it carries the date it was asked and, when the host has one, the
 * session that asked it:
 *
 *   - [ ] (2026-10-18, #993) Does the picker need a "key no longer works" state?
 *
 * When it is answered, the line moves to "## Resolved Questions", ticked, with the date and session that answered it,
 * and the answer after an arrow:
 *
 *   - [x] (2026-10-19, #1204) Does the picker need a "key no longer works" state? → yes: machine health (#72)
 *
 * Older pages hold plain bullets (`- question`); they count as open, asked when the page was last updated. A ticked or
 * struck-through line left in the open section counts as resolved.
 *
 * The rest of pi-para uses this to show a page's open questions when it is read or found, to list the wiki's open
 * questions for a session's prompt, to point out questions a page just written may answer, and to flag stale ones.
 */
import { matchesScope, type ProjectScope } from "./scope.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { listPages, type ParaCategory, readPage } from "./wiki.js";

export const OPEN_SECTION = "Open Questions";
export const RESOLVED_SECTION = "Resolved Questions";

/** One question line, as written. */
export interface QuestionLine {
  /** The line itself, as it is in the page. */
  line: string;
  /** The question's words, without its mark, date, and session. */
  text: string;
  /** When it was asked (YYYY-MM-DD), if written. */
  date?: string;
  /** The session that asked it ("#993"), if written. */
  session?: string;
  /** Ticked, or struck through. */
  done: boolean;
}

/** An open question on a page. */
export interface OpenQuestion extends QuestionLine {
  /** `category/slug`. */
  page: string;
  title: string;
  scope: string[];
  /** When it was asked: its own date, else the page's last update (YYYY-MM-DD). */
  asked: string;
}

const LINE = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(?:\((\d{4}-\d{2}-\d{2})(?:,\s*(#?[\w.:/-]+))?\)\s+)?(.+?)\s*$/;

/** The lines of a `## <name>` section of a page's body, up to the next heading of level 1 or 2. */
export function sectionLines(body: string, name: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);

  if (start === -1) {
    return [];
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));

  return end === -1 ? rest : rest.slice(0, end);
}

/** The question lines of a section: its bullets, each read as a question. Placeholder bullets ("none") are left out. */
export function parseQuestions(body: string, name = OPEN_SECTION): QuestionLine[] {
  return sectionLines(body, name).flatMap((line) => {
    const match = LINE.exec(line);

    if (match === null) {
      return [];
    }

    const [, mark, date, session, words] = match;
    const struck = /^~~.*~~$/.test(words!.trim());
    const text = words!.replace(/^~~|~~$/g, "").trim();

    if (/^(none|n\/a|-|—|\(none\)|nothing yet\.?)$/i.test(text) || /^\[.*gaps in knowledge.*\]$/i.test(text)) {
      return [];
    }

    return [
      {
        line,
        text,
        ...(date === undefined ? {} : { date }),
        ...(session === undefined ? {} : { session: session.startsWith("#") ? session : `#${session}` }),
        done: (mark !== undefined && mark !== " ") || struck,
      },
    ];
  });
}

/** A page's open questions: the section's lines that are not ticked. */
export function openQuestionsOf(body: string): QuestionLine[] {
  return parseQuestions(body).filter((question) => !question.done);
}

/** A question line as an agent writes it: `- [ ] (date, #session) text`. */
export function questionLine(text: string, { date, session }: { date: string; session?: string }): string {
  return `- [ ] (${date}${session === undefined ? "" : `, ${session.startsWith("#") ? session : `#${session}`}`}) ${text.trim()}`;
}

/** A resolved line: `- [x] (date, #session) text → answer`. */
export function resolvedLine(text: string, answer: string, { date, session }: { date: string; session?: string }): string {
  return `- [x] (${date}${session === undefined ? "" : `, ${session.startsWith("#") ? session : `#${session}`}`}) ${text.trim()} → ${answer.trim()}`;
}

/** Whole days from `date` (YYYY-MM-DD or ISO) to `now`. */
export function daysSince(date: string, now = Date.now()): number {
  const at = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);

  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 86_400_000));
}

/** Each page's open questions as last read, by file, with the file's mtime and size: a page reads again only when it changed. */
const pageCache = new Map<string, { mtimeMs: number; size: number; questions: Omit<OpenQuestion, "page">[] }>();

/** A page's open questions, from the cache while its file is unchanged. */
async function pageQuestions(wikiDir: string, category: ParaCategory, slug: string): Promise<Omit<OpenQuestion, "page">[]> {
  const file = join(wikiDir, category, `${slug}.md`);
  let info;

  try {
    info = await stat(file);
  } catch {
    pageCache.delete(file);

    return [];
  }

  const cached = pageCache.get(file);

  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.questions;
  }

  const page = await readPage(wikiDir, category, slug);
  const updated = page === null ? "" : (page.frontmatter.updated || page.frontmatter.created || "").slice(0, 10);
  const questions =
    page === null
      ? []
      : openQuestionsOf(page.body).map((question) => ({
          ...question,
          title: page.frontmatter.title,
          scope: page.frontmatter.scope,
          asked: question.date ?? updated,
        }));

  pageCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, questions });

  return questions;
}

/**
 * Every open question in the wiki, oldest first. Archives are left out unless asked for: a finished project's
 * questions are history. With `scope`, the ones on pages in that scope come first (`inScope`). Pages are read again
 * only when their file changed.
 */
export async function collectOpenQuestions(
  wikiDir: string,
  { scope, includeArchives = false }: { scope?: ProjectScope; includeArchives?: boolean } = {},
): Promise<(OpenQuestion & { inScope: boolean })[]> {
  const refs = await listPages(wikiDir);
  const found: (OpenQuestion & { inScope: boolean })[] = [];

  for (const ref of refs) {
    if (ref.category === "archives" && !includeArchives) {
      continue;
    }

    for (const question of await pageQuestions(wikiDir, ref.category, ref.slug)) {
      found.push({
        ...question,
        page: `${ref.category}/${ref.slug}`,
        inScope: scope === undefined ? true : matchesScope(question.scope, scope),
      });
    }
  }

  return found.sort((a, b) => Number(b.inScope) - Number(a.inScope) || a.asked.localeCompare(b.asked));
}

/** Open questions as short Markdown lines: `- «text» on [[slug]] (asked date, #session)`. */
export function formatOpenQuestions(questions: readonly OpenQuestion[], { max = 10, chars = 180 } = {}): string {
  const shown = questions.slice(0, max).map((question) => {
    const text = question.text.length > chars ? `${question.text.slice(0, chars - 1)}…` : question.text;
    const slug = question.page.split("/").pop();

    return `- ${text} — on [[${slug}]] (${question.page}), asked ${question.asked}${question.session ? `, ${question.session}` : ""}`;
  });
  const more = questions.length - shown.length;

  return [...shown, ...(more > 0 ? [`- …and ${more} more (wiki_lint lists them all)`] : [])].join("\n");
}

/** How to resolve one, in the words the tools and prompts use. */
export const RESOLVE_HOW =
  'To resolve one, wiki_edit its page: remove its line from "## Open Questions" and add under "## Resolved Questions" `- [x] (YYYY-MM-DD, #session) <question> → <answer>` (today, and your session if you know it).';

// -- Questions a page just written may answer ---------------------------------

const STOP = new Set(
  "a an and are as at be been but by can could did do does for from had has have how if in into is it its of on or should so than that the their then there these this those to was were what when where whether which who why will with would yet not no any all our we you your".split(
    " ",
  ),
);

/** The meaningful words of a text: lower case, without stop words or very short ones. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`*_[\]()<>"'“”‘’.,;:!?/\\|{}=+]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

/** Of a question's meaningful words, how many the text has, and the share. */
function overlap(question: string, text: Set<string>): { shared: number; share: number } {
  const own = [...words(question)];
  const shared = own.filter((word) => text.has(word)).length;

  return { shared, share: own.length === 0 ? 0 : shared / own.length };
}

/** A page's body without its open questions section: what it says, not what it asks. */
function withoutOpenSection(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${OPEN_SECTION.toLowerCase()}`);

  if (start === -1) {
    return body;
  }

  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));

  return [...lines.slice(0, start), ...(end === -1 ? [] : lines.slice(end))].join("\n");
}

/**
 * Open questions anywhere in the wiki that `written` (pages just written, by `category/slug`, with their new body) may
 * answer, best first: the new text, without its own open questions, has at least half of a question's meaningful
 * words, and two or more of them. Questions on the written pages count too: a page that answers its own question should
 * resolve it. Fast and local, for every write; lint finds more by meaning once the search index has the new text.
 */
export async function questionsMaybeAnswered(
  wikiDir: string,
  written: readonly { page: string; text: string }[],
  { max = 5 }: { max?: number } = {},
): Promise<(OpenQuestion & { why: string })[]> {
  if (written.length === 0) {
    return [];
  }

  const open = await collectOpenQuestions(wikiDir);
  const text = words(written.map((each) => withoutOpenSection(each.text)).join("\n"));

  return open
    .map((question) => ({ question, ...overlap(question.text, text) }))
    .filter(({ shared, share }) => shared >= 2 && share >= 0.5)
    .sort((a, b) => b.share - a.share || b.shared - a.shared)
    .slice(0, max)
    .map(({ question, shared }) => ({ ...question, why: `the new text has ${shared} of its key words` }));
}

/** The note a write's tool result ends with, when it may answer open questions; empty otherwise. */
export function answeredNote(candidates: readonly (OpenQuestion & { why: string })[]): string {
  if (candidates.length === 0) {
    return "";
  }

  return [
    "",
    `This may answer ${candidates.length === 1 ? "an open question" : `${candidates.length} open questions`} in the wiki:`,
    ...candidates.map(
      (question) =>
        `- «${question.text}» on ${question.page}, asked ${question.asked}${question.session ? ` (${question.session})` : ""}: ${question.why}`,
    ),
    `If it does, resolve it. ${RESOLVE_HOW}`,
  ].join("\n");
}
