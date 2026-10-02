// The document view (terminal-r4 "Document"): text to read (an email, an
// article, a script), shown in full a page at a time.
//
// - `versions` are tabs `1`–`9` (the emails in a sequence); each shows its own
//   sections.
// - The body pages by width × rows: it is wrapped at the pane's width (capped
//   at r4's 76-column reading measure), then cut into pages that fit the rows
//   the view is given (`ctx.rows`, less its own tab bar, meta and page line);
//   `space` moves on. The turn's layout shrinks `ctx.rows` until the whole turn
//   fits the live region (`renderLiveTurn`), so no page line is ever hidden.
// - Tabs stop at 9; the versions past them are named (`+ 2 more not shown`).
// - A section from outside (`untrusted`, or the whole view) is marked
//   `from outside ·`, so its words never read as ours.
// - `markdown` goes through `renderMarkdown`; `plain`, `html_stripped` and
//   `code` print line for line. Every string is scrubbed first.
import { renderMarkdown } from "../../formatting/markdown-render.js";
import { fitLine, isRecord, paint, viewText, wrapText } from "./primitives.js";
import {
  bodyOf,
  clampIndex,
  countOf,
  formatCount,
  labelColumnWidth,
  labelValueLines,
  recordsOf,
  type Fields
} from "./things.js";
import type { KindRenderer, ViewRenderCtx } from "./types.js";

/** Pages without a known height are this many lines. */
export const DEFAULT_DOCUMENT_PAGE_LINES = 20;
/** A page never gets shorter than this, however small the window. */
export const MIN_DOCUMENT_PAGE_LINES = 3;
/** r4's reading measure: document text wraps at this many columns at most. */
export const DOCUMENT_MEASURE = 76;
const MAX_TABS = 9;
const BAR = "│ ";

/** Lines a page may take when `rows` lines are free for it (the default when unknown). */
export function documentPageLines(rows: number | undefined): number {
  if (typeof rows !== "number" || !Number.isFinite(rows)) {
    return DEFAULT_DOCUMENT_PAGE_LINES;
  }
  return Math.max(MIN_DOCUMENT_PAGE_LINES, Math.floor(rows));
}

export const renderDocument: KindRenderer<"document"> = (view, ctx) => {
  const body = bodyOf(view);
  const width = Math.max(1, Math.floor(ctx.width));
  const sections = recordsOf(body.sections);
  const allVersions = recordsOf(body.versions);
  const versions = allVersions.slice(0, MAX_TABS);
  const tab = versions.length ? clampIndex(ctx.tab, versions.length) : 0;
  const shown = versions.length ? sectionsFor(versions[tab], sections) : sections;
  const viewUntrusted = view.untrusted === true;
  const lines: string[] = [];

  if (versions.length) {
    lines.push(tabBar(versions, tab, ctx));
    if (allVersions.length > versions.length) {
      lines.push(paint(fitLine(`+ ${formatCount(allVersions.length - versions.length)} more not shown`, width), "muted", ctx));
    }
    lines.push("");
  }

  const meta = recordsOf(body.meta)
    .map((item) => ({ label: viewText(item.label), value: viewText(item.value) }))
    .filter((item) => item.label !== "" || item.value !== "");
  if (meta.length) {
    const labelWidth = labelColumnWidth(meta.map((item) => item.label), width);
    // The first meta row is the subject: its value is bold (r4 `Subject  {b}…`); the rest stay default.
    meta.forEach((item, index) => lines.push(...labelValueLines(item.label, item.value, labelWidth, ctx, index === 0 ? "b" : "text")));
    lines.push("");
  }

  // What prints under the body: the truncation note and the live URL.
  const after: string[] = [];
  const truncated = isRecord(body.truncated) ? body.truncated : null;
  const shownChars = countOf(truncated?.shownChars);
  const totalChars = countOf(truncated?.totalChars);
  if (shownChars !== null && totalChars !== null && totalChars > shownChars) {
    after.push("", ...wrapText(`${formatCount(shownChars)} of ${formatCount(totalChars)} characters shown`, width).map((line) => paint(line, "muted", ctx)));
  }
  const liveUrl = viewText(body.liveUrl);
  if (liveUrl) {
    after.push(paint(fitLine(liveUrl, width), "muted", ctx));
  }

  // The body, wrapped to the pane (at most the reading measure), then paged
  // into what is left of the rows once the lines above and below are counted.
  const inner = { ...ctx, width: Math.max(1, Math.min(width, DOCUMENT_MEASURE) - BAR.length) };
  const bodyLines: string[] = [];
  shown.forEach((part, index) => {
    if (index > 0) {
      bodyLines.push("");
    }
    bodyLines.push(...sectionLines(part, viewUntrusted, inner));
  });
  const known = typeof ctx.rows === "number" && Number.isFinite(ctx.rows);
  let perPage = documentPageLines(known ? ctx.rows! - lines.length - after.length : undefined);
  if (bodyLines.length > perPage && known) {
    // Paging adds the `page N of M` line, so the page gives up a row for it.
    perPage = documentPageLines(perPage - 1);
  }
  const pages = Math.max(1, Math.ceil(bodyLines.length / perPage));
  const page = clampIndex(ctx.page, pages);
  // r4's document gutter: a `│` in the rule colour before every body line.
  const bar = paint(BAR.trimEnd(), "line", ctx);
  const pageLines = bodyLines.slice(page * perPage, (page + 1) * perPage).map((line) => (line ? `${bar} ${line}` : bar));
  lines.push(...pageLines);
  if (pages > 1) {
    // Every page is the same height, so the page line and the keys never jump
    // and the turn's fit (which sets the page size) is the same on every page.
    lines.push(...Array.from({ length: perPage - pageLines.length }, () => ""));
    lines.push(paint(`page ${page + 1} of ${pages}`, "muted", ctx));
  }
  lines.push(...after);

  return {
    detail: lines,
    footnotes: [],
    keys: [],
    okKey: null,
    rowCount: 0,
    ...(versions.length > 1 ? { tabs: versions.length } : {}),
    pages,
    ...(liveUrl ? { copyText: liveUrl } : {})
  };
};

/** The sections one version shows, by index (an index out of range is skipped). */
function sectionsFor(version: Fields | undefined, sections: readonly Fields[]): Fields[] {
  const indexes = Array.isArray(version?.sectionIndexes) ? version.sectionIndexes : [];
  return indexes
    .filter((index): index is number => Number.isInteger(index) && index >= 0 && index < sections.length)
    .map((index) => sections[index]!);
}

/** ` 1 Email 1   2 Email 2 `: the open tab in the brand chip, the others dim (the open one bracketed without colour). */
function tabBar(versions: readonly Fields[], tab: number, ctx: ViewRenderCtx): string {
  const plain = versions.map((version, index) => {
    const label = [viewText(version.label), viewText(version.locale)].filter(Boolean).join(" · ");
    return `${index + 1} ${label}`.trim();
  });
  if (!ctx.color) {
    return fitLine(plain.map((label, index) => (index === tab ? `[${label}]` : label)).join("  "), ctx.width);
  }
  const fitted = fitLine(plain.map((label) => ` ${label} `).join(" "), ctx.width);
  if (fitted !== plain.map((label) => ` ${label} `).join(" ")) {
    return paint(fitted, "muted", ctx);
  }
  return plain
    .map((label, index) => paint(` ${label} `, index === tab ? "inv" : "muted", ctx))
    .join(" ");
}

function sectionLines(part: Fields, viewUntrusted: boolean, ctx: ViewRenderCtx): string[] {
  const lines: string[] = [];
  const heading = viewText(part.heading);
  const outside = viewUntrusted || part.untrusted === true;
  if (outside || heading) {
    const mark = outside ? "from outside ·" : "";
    const plain = [mark, heading].filter(Boolean).join(" ");
    const fitted = fitLine(plain, ctx.width);
    lines.push(
      fitted === plain && ctx.color
        ? [mark ? paint(mark, "warning", ctx) : "", heading ? paint(heading, "b", ctx) : ""].filter(Boolean).join(" ")
        : paint(fitted, outside ? "warning" : "text", ctx)
    );
  }
  const text = typeof part.text === "string" ? part.text : "";
  if (text) {
    const markdown = part.format === "markdown";
    lines.push(...renderMarkdown(text, {
      width: ctx.width,
      color: ctx.color,
      theme: ctx.theme,
      plain: !markdown,
      ...(part.format === "code" ? { role: "muted" as const } : {})
    }));
  }
  return lines;
}
