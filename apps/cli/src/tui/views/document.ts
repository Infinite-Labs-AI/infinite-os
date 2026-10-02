// The document view (terminal-r4 "Document"): text to read (an email, an
// article, a script), shown in full a page at a time.
//
// - `versions` are tabs `1`–`9` (the emails in a sequence); each shows its own
//   sections.
// - The body pages by width × rows: it is wrapped at the pane's width, then
//   cut into pages of `documentPageLines(rows)` lines; `space` moves on.
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

/** Pages without a known terminal height are this many lines. */
export const DEFAULT_DOCUMENT_PAGE_LINES = 20;
/** Rows the live region keeps for the rest of the turn (head, tabs, meta, steps, key bar, composer). */
const DOCUMENT_CHROME_ROWS = 12;
const MIN_DOCUMENT_PAGE_LINES = 6;
const MAX_TABS = 9;
const BAR = "│ ";

/** Body lines per page at this terminal height. */
export function documentPageLines(rows: number | undefined): number {
  if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) {
    return DEFAULT_DOCUMENT_PAGE_LINES;
  }
  return Math.max(MIN_DOCUMENT_PAGE_LINES, Math.floor(rows) - DOCUMENT_CHROME_ROWS);
}

export const renderDocument: KindRenderer<"document"> = (view, ctx) => {
  const body = bodyOf(view);
  const width = Math.max(1, Math.floor(ctx.width));
  const sections = recordsOf(body.sections);
  const versions = recordsOf(body.versions).slice(0, MAX_TABS);
  const tab = versions.length ? clampIndex(ctx.tab, versions.length) : 0;
  const shown = versions.length ? sectionsFor(versions[tab], sections) : sections;
  const viewUntrusted = view.untrusted === true;
  const lines: string[] = [];

  if (versions.length) {
    lines.push(tabBar(versions, tab, ctx), "");
  }

  const meta = recordsOf(body.meta)
    .map((item) => ({ label: viewText(item.label), value: viewText(item.value) }))
    .filter((item) => item.label !== "" || item.value !== "");
  if (meta.length) {
    const labelWidth = labelColumnWidth(meta.map((item) => item.label), width);
    for (const item of meta) {
      lines.push(...labelValueLines(item.label, item.value, labelWidth, ctx));
    }
    lines.push("");
  }

  // The body, wrapped to the pane, then paged.
  const inner = { ...ctx, width: Math.max(1, width - BAR.length) };
  const bodyLines: string[] = [];
  shown.forEach((part, index) => {
    if (index > 0) {
      bodyLines.push("");
    }
    bodyLines.push(...sectionLines(part, viewUntrusted, inner));
  });
  const perPage = documentPageLines(ctx.rows);
  const pages = Math.max(1, Math.ceil(bodyLines.length / perPage));
  const page = clampIndex(ctx.page, pages);
  const bar = paint(BAR.trimEnd(), "muted", ctx);
  lines.push(...bodyLines.slice(page * perPage, (page + 1) * perPage).map((line) => (line ? `${bar} ${line}` : bar)));
  if (pages > 1) {
    lines.push(paint(`page ${page + 1} of ${pages}`, "muted", ctx));
  }

  const truncated = isRecord(body.truncated) ? body.truncated : null;
  const shownChars = countOf(truncated?.shownChars);
  const totalChars = countOf(truncated?.totalChars);
  if (shownChars !== null && totalChars !== null && totalChars > shownChars) {
    lines.push("", ...wrapText(`${formatCount(shownChars)} of ${formatCount(totalChars)} characters shown`, width).map((line) => paint(line, "muted", ctx)));
  }
  const liveUrl = viewText(body.liveUrl);
  if (liveUrl) {
    lines.push(paint(fitLine(liveUrl, width), "muted", ctx));
  }

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

/** `[1 Email 1]  2 Email 2`: the open tab inverse (bracketed without colour). */
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
    .map((label, index) => (index === tab ? paint(` ${label} `, "text", ctx, { bold: true, inverse: true }) : paint(` ${label} `, "muted", ctx)))
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
        ? [mark ? paint(mark, "warning", ctx) : "", heading ? paint(heading, "text", ctx, { bold: true }) : ""].filter(Boolean).join(" ")
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
