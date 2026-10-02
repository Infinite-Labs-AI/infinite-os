// The answer column (terminal-r4 `frame()`, spec §5 "Answer pane"): the
// question and the answer, with no box around them, at whatever width the
// column has (the whole window in one column, the answer pane when split).
//
//   ❯ the question, in b, wrapped under its own words
//
//   ∞ the answer, markdown, wrapped under its own words
//
// Every line wraps at width − 1 with its two-column prefix, as r4 does. A
// question is wrapped, never cut (eval N11).
import { renderMarkdown } from "../../formatting/markdown-render.js";
import { holdOpenMarkers } from "../../formatting/markdown-inline.js";
import { fitLine, paint, viewText, wrapText } from "../views/primitives.js";
import { ansiSpan, type AnsiRole, type Theme } from "../theme.js";

export interface ColumnStyle {
  color: boolean;
  theme: Theme;
}

/** The room the words get: the column less r4's one spare column and the two-column prefix. */
function textWidth(width: number): number {
  return Math.max(1, Math.floor(width) - 3);
}

/** `❯ question`: the mark in cyan, the words in b, hung under the first word. */
export function questionLines(text: string, width: number, style: ColumnStyle): string[] {
  return wrapText(viewText(text), textWidth(width)).map((line, index) =>
    fitLine(`${index === 0 ? `${paint("❯", "primary", style)} ` : "  "}${paint(line, "b", style)}`, width)
  );
}

/**
 * `∞ answer`: the mark in cyan, the answer as markdown, hung under its first
 * word. `partial` is an answer still arriving or stopped mid-way: a span whose
 * closing marker has not come yet prints as plain words (eval M4). `label` is
 * the answering project (`Infinite — Acme`), printed dim after the mark on a
 * row of its own when there is one.
 */
export function answerLines(
  text: string,
  width: number,
  style: ColumnStyle,
  options: { partial?: boolean; label?: string; mark?: boolean } = {}
): string[] {
  const body = renderMarkdown(options.partial ? holdOpenMarkers(text) : text, {
    width: textWidth(width),
    color: style.color,
    theme: style.theme
  });
  const mark = options.mark === false ? "  " : `${paint("∞", "primary", style)} `;
  const label = options.label ? viewText(options.label) : "";
  const lines = label ? [`${mark}${paint(label, "muted", style)}`, ...body.map((line) => `  ${line}`)] : body.map((line, index) => `${index === 0 ? mark : "  "}${line}`);
  return lines.map((line) => fitLine(line, width));
}

/**
 * A note in the turn (a receipt, a stop line, an error, a tool's output): its
 * words hung under the answer, in its tone. Plain by default (tool output reads
 * as the tool returned it); `markdown` for words the model wrote.
 */
export function noteLines(
  text: string,
  width: number,
  style: ColumnStyle,
  tone: AnsiRole = "muted",
  options: { markdown?: boolean } = {}
): string[] {
  if (options.markdown) {
    // The renderer switches back to `tone` after each span it styles, so the whole line can sit in it.
    const span = ansiSpan(style.theme, tone);
    return renderMarkdown(text, { width: textWidth(width), color: style.color, theme: style.theme, role: tone }).map((line) =>
      fitLine(`  ${style.color && line ? `${span.open}${line}${span.close}` : line}`, width)
    );
  }
  return renderMarkdown(text, { width: textWidth(width), color: false, theme: style.theme, plain: true }).map((line) =>
    fitLine(`  ${paint(line, tone, style)}`, width)
  );
}
