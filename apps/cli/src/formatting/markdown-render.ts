import { scrubTerminalControls } from "../desktop/confirm-in-session.js";
import { displayWidth, truncateCells } from "../tui/lib/display-width.js";
import { ansiFg, ansiSpan, type AnsiRole, type Theme, type ThemeStyle } from "../tui/theme.js";
import { lexMarkdown, type MarkdownBlock } from "./markdown-blocks.js";
import { NO_BREAK_SPACE, parseInline, wrapSpans, type Span } from "./markdown-inline.js";
import { renderTable } from "./table.js";

/**
 * Markdown to terminal lines. Layout happens on visible text (spans), and SGR
 * codes are emitted only after the lines are decided, so a style never counts
 * toward the width and an emphasis span that crosses a wrap never prints its
 * markers. Every line has `displayWidth <= width`.
 *
 * `role` is the color the caller paints the line in (default `text`). A span
 * that switches color switches back to it. The r4 look (terminal-r4 §5):
 * headings `b`, code `cyan`, links `cyan u` + ` ↗`, bullets `dim`, quote bars
 * and rules `line`, a table's Total row set apart (rule above, bold).
 *
 * `plain` skips the markdown parse (see the option).
 */
export interface MarkdownRenderOptions {
  width: number;
  color: boolean;
  theme: Theme;
  role?: AnsiRole;
  /**
   * Plain text, no markdown: each line is scrubbed and wrapped, nothing else.
   * For tool output, which must read exactly as the tool returned it.
   */
  plain?: boolean;
  /**
   * The widest this text is ever redrawn at when the window widens: unbounded
   * (the default) for the live answer in one column; the pane's cap when the
   * answer sits beside its details; `0` for text printed once (scrollback, a
   * one-shot print), which a wider window never redraws. A table whose dropped
   * columns need more than this names them `hidden`, never `widen by`.
   */
  widenLimit?: number;
}

const BULLETS = ["•", "◦", "▪"] as const;
const CONTINUATION_MARK = "↩";
const LINK_MARK = "↗";
const SGR = {
  bold: ["\u001b[1m", "\u001b[22m"],
  italic: ["\u001b[3m", "\u001b[23m"],
  strike: ["\u001b[9m", "\u001b[29m"]
} as const;
/** A last body row whose first cell says this is the table's Total (N9). */
const TOTAL_LABEL = /^totals?:?$/i;

/**
 * Quote nesting the renderer draws as bars. Deeper `>` print as text under the
 * last bar: each level re-renders its inner text, so unbounded nesting was a
 * stack overflow on model text (3,000 `>` threw; wave-1 adversarial review).
 */
const MAX_QUOTE_DEPTH = 8;

export function renderMarkdown(text: string, opts: MarkdownRenderOptions): string[] {
  return renderDocument(text, opts, 0);
}

function renderDocument(text: string, opts: MarkdownRenderOptions, quoteDepth: number): string[] {
  const width = Math.max(1, Math.floor(opts.width));
  const source = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n")
    .map(scrubTerminalControls)
    .join("\n");
  const lines: string[] = [];

  if (opts.plain) {
    for (const line of source.split("\n")) {
      lines.push(...renderPlainLine(line.trimEnd(), { ...opts, width }));
    }
  } else {
    for (const block of lexMarkdown(source)) {
      lines.push(...renderBlock(block, { ...opts, width }, quoteDepth));
    }
  }

  while (lines.length && lines[0] === "") {
    lines.shift();
  }
  while (lines.length && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length ? lines : [""];
}

/** A line that fits prints as written (spacing kept); a longer one wraps under its own indent. */
function renderPlainLine(line: string, opts: MarkdownRenderOptions): string[] {
  if (!line) {
    return [""];
  }
  if (displayWidth(line) <= opts.width) {
    return [line];
  }
  const lead = /^\s*/.exec(line)![0];
  const indent = displayWidth(lead) <= opts.width / 2 ? lead : "";
  return wrapSpans([{ text: line.slice(lead.length) }], opts.width, { first: indent, rest: indent }).map((spans) =>
    styleLine(spans, opts)
  );
}

function renderBlock(block: MarkdownBlock, opts: MarkdownRenderOptions, quoteDepth: number): string[] {
  switch (block.type) {
    case "blank":
      return [""];
    case "heading":
      return layout(parseInline(block.text), opts).map((line) => styleLine(line, opts, { heading: true }));
    case "paragraph":
      return layout(parseInline(block.text), opts).map((line) => styleLine(line, opts));
    case "list_item":
      return renderListItem(block, opts);
    case "code":
      return renderCode(block.lines, opts);
    case "quote": {
      const depth = quoteDepth + 1;
      // At the cap the inner text prints as written (plain: scrubbed and
      // wrapped), so any further `>` show as text.
      const innerOpts = depth >= MAX_QUOTE_DEPTH ? { ...opts, plain: true } : opts;
      if (opts.width < 4) {
        return renderDocument(block.lines.join("\n"), innerOpts, depth);
      }
      const inner = renderDocument(block.lines.join("\n"), { ...innerOpts, width: opts.width - 2 }, depth);
      const bar = paint("│", "line", opts);
      return inner.map((line) => (line ? `${bar} ${line}` : bar));
    }
    case "rule":
      return [paint("─".repeat(opts.width), "line", opts)];
    case "table":
      return renderMarkdownTable(block, opts);
  }
}

function renderListItem(block: Extract<MarkdownBlock, { type: "list_item" }>, opts: MarkdownRenderOptions): string[] {
  const marker = block.ordered ? block.marker : BULLETS[block.depth % BULLETS.length]!;
  let indent = "  ".repeat(block.depth);
  if (opts.width - displayWidth(`${indent}${marker} `) < 8) {
    indent = "";
  }
  let first = `${indent}${marker} `;
  let rest = " ".repeat(displayWidth(first));
  if (displayWidth(first) >= opts.width) {
    first = rest = "";
  }
  const mark = displayWidth(first) ? `${indent}${paint(marker, block.ordered ? opts.role ?? "text" : "muted", opts)} ` : "";
  return layout(parseInline(block.text), opts, { first, rest }).map((line, index) => {
    const head = line[0];
    // The bullet is drawn dim; the indent span may have merged with plain text after it.
    if (index === 0 && mark && head && head.text.startsWith(first) && !head.bold && !head.italic && !head.strike && !head.code && !head.link) {
      const after = head.text.slice(first.length);
      return `${mark}${styleLine(after ? [{ ...head, text: after }, ...line.slice(1)] : line.slice(1), opts)}`;
    }
    return styleLine(line, opts);
  });
}

function renderCode(source: readonly string[], opts: MarkdownRenderOptions): string[] {
  const indent = opts.width > 4 ? "  " : "";
  const avail = opts.width - indent.length;
  const out: string[] = [];
  for (const raw of source) {
    const line = raw.trimEnd();
    if (displayWidth(line) <= avail) {
      out.push(`${indent}${paint(line, "primary", opts)}`);
      continue;
    }
    if (avail < 2) {
      // No room for a character plus the ↩ mark.
      out.push(paint(truncateCells(line, opts.width), "primary", opts));
      continue;
    }
    let chunk = "";
    for (const char of Array.from(line)) {
      if (displayWidth(chunk + char) > avail - 1) {
        out.push(`${indent}${paint(chunk, "primary", opts)}${paint(CONTINUATION_MARK, "muted", opts)}`);
        chunk = "";
      }
      chunk += char;
    }
    out.push(`${indent}${paint(chunk, "primary", opts)}`);
  }
  return out;
}

function renderMarkdownTable(block: Extract<MarkdownBlock, { type: "table" }>, opts: MarkdownRenderOptions): string[] {
  const rows = block.rows.map((row) => row.map(plainInline));
  // A last row labelled Total is the table's total: a rule above it, in bold (N9).
  const last = rows.at(-1);
  const total = rows.length > 1 && last && TOTAL_LABEL.test((last[0] ?? "").trim()) ? last : undefined;
  const table = renderTable(
    {
      columns: block.header.map((label, index) => ({ label: plainInline(label), align: block.aligns[index] })),
      rows: total ? rows.slice(0, -1) : rows,
      ...(total ? { total } : {})
    },
    { width: opts.width, color: opts.color, theme: opts.theme, role: opts.role }
  );
  const lines = [...table.lines];
  if (table.hidden.length) {
    // An answer's table has no `→` key: say how much wider the window must be,
    // but only when a wider window redraws this text that wide (`widenLimit`).
    const more = Math.max(1, table.fullWidth - opts.width);
    const widenable = table.fullWidth <= (opts.widenLimit ?? Number.POSITIVE_INFINITY);
    const hint = widenable
      ? `+ ${table.hidden.join(", ")} · widen by ${more} ${more === 1 ? "col" : "cols"} to see`
      : `+ ${table.hidden.join(", ")} hidden`;
    lines.push(...wrapSpans([{ text: hint }], opts.width).map((spans) => paint(spans.map((span) => span.text).join(""), "muted", opts)));
  }
  return lines;
}

/** Inline markdown flattened to its visible text (for table cells). */
function plainInline(text: string): string {
  return parseInline(text)
    .map((span) => (span.link ? `${span.text} ${LINK_MARK}` : span.text))
    .join("");
}

/** Wrap spans to the width; a link keeps its ↗ on the same line as its last word. */
function layout(spans: Span[], opts: MarkdownRenderOptions, indent?: { first: string; rest: string }): Span[][] {
  const marked = spans.map((span) => (span.link ? { ...span, text: `${span.text}${NO_BREAK_SPACE}${LINK_MARK}` } : span));
  return wrapSpans(marked, opts.width, indent);
}

function styleLine(line: readonly Span[], opts: MarkdownRenderOptions, extra: { heading?: boolean } = {}): string {
  return line
    .map((span) => {
      const text = span.text.split(NO_BREAK_SPACE).join(" ");
      if (!opts.color) {
        return text;
      }
      const open: string[] = [];
      const close: string[] = [];
      // Bold stays an attribute on the body colour; a heading is r4's `b` (bold white).
      if (span.bold && !extra.heading) {
        open.push(SGR.bold[0]);
        close.push(SGR.bold[1]);
      }
      if (span.italic) {
        open.push(SGR.italic[0]);
        close.push(SGR.italic[1]);
      }
      if (span.strike) {
        open.push(SGR.strike[0]);
        close.push(SGR.strike[1]);
      }
      const tokens: ThemeStyle | undefined = span.code ? "cyan" : span.link ? ["cyan", "u"] : extra.heading ? "b" : undefined;
      if (tokens) {
        const span = ansiSpan(opts.theme, tokens);
        open.push(span.open);
        close.unshift(span.close, roleForeground(opts));
      }
      return `${open.join("")}${text}${close.join("")}`;
    })
    .join("");
}

/** The caller's colour again after a span closed its own (nothing for body text: the close already says 39). */
function roleForeground(opts: MarkdownRenderOptions): string {
  return opts.role && opts.role !== "text" ? ansiFg(opts.theme, opts.role) : "";
}

function paint(text: string, tone: ThemeStyle, opts: MarkdownRenderOptions): string {
  if (!opts.color || !text) {
    return text;
  }
  const span = ansiSpan(opts.theme, tone);
  return `${span.open}${text}${span.close}${roleForeground(opts)}`;
}
