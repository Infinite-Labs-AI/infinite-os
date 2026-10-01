import { scrubTerminalControls } from "../desktop/confirm-in-session.js";
import { displayWidth, truncateCells } from "../tui/lib/display-width.js";
import { ansiFg, type AnsiRole, type Theme } from "../tui/theme.js";
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
 * that switches color (code, links, a level-1 heading) switches back to it.
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
}

const BULLETS = ["•", "◦", "▪"] as const;
const CONTINUATION_MARK = "↩";
const LINK_MARK = "↗";
const SGR = {
  bold: ["\u001b[1m", "\u001b[22m"],
  italic: ["\u001b[3m", "\u001b[23m"],
  strike: ["\u001b[9m", "\u001b[29m"],
  underline: ["\u001b[4m", "\u001b[24m"]
} as const;

export function renderMarkdown(text: string, opts: MarkdownRenderOptions): string[] {
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
      lines.push(...renderBlock(block, { ...opts, width }));
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

function renderBlock(block: MarkdownBlock, opts: MarkdownRenderOptions): string[] {
  switch (block.type) {
    case "blank":
      return [""];
    case "heading": {
      const tone: AnsiRole | undefined = block.level === 1 ? "primary" : undefined;
      return layout(parseInline(block.text), opts).map((line) => styleLine(line, opts, { bold: true, tone }));
    }
    case "paragraph":
      return layout(parseInline(block.text), opts).map((line) => styleLine(line, opts));
    case "list_item":
      return renderListItem(block, opts);
    case "code":
      return renderCode(block.lines, opts);
    case "quote": {
      if (opts.width < 4) {
        return renderMarkdown(block.lines.join("\n"), opts);
      }
      const inner = renderMarkdown(block.lines.join("\n"), { ...opts, width: opts.width - 2 });
      const bar = paint("│", "muted", opts);
      return inner.map((line) => (line ? `${bar} ${line}` : bar));
    }
    case "rule":
      return [paint("─".repeat(opts.width), "muted", opts)];
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
  return layout(parseInline(block.text), opts, { first, rest }).map((line) => styleLine(line, opts));
}

function renderCode(source: readonly string[], opts: MarkdownRenderOptions): string[] {
  const indent = opts.width > 4 ? "  " : "";
  const avail = opts.width - indent.length;
  const out: string[] = [];
  for (const raw of source) {
    const line = raw.trimEnd();
    if (displayWidth(line) <= avail) {
      out.push(`${indent}${paint(line, "primaryBright", opts)}`);
      continue;
    }
    if (avail < 2) {
      // No room for a character plus the ↩ mark.
      out.push(paint(truncateCells(line, opts.width), "primaryBright", opts));
      continue;
    }
    let chunk = "";
    for (const char of Array.from(line)) {
      if (displayWidth(chunk + char) > avail - 1) {
        out.push(`${indent}${paint(chunk, "primaryBright", opts)}${paint(CONTINUATION_MARK, "muted", opts)}`);
        chunk = "";
      }
      chunk += char;
    }
    out.push(`${indent}${paint(chunk, "primaryBright", opts)}`);
  }
  return out;
}

function renderMarkdownTable(block: Extract<MarkdownBlock, { type: "table" }>, opts: MarkdownRenderOptions): string[] {
  const table = renderTable(
    {
      columns: block.header.map((label, index) => ({ label: plainInline(label), align: block.aligns[index] })),
      rows: block.rows.map((row) => row.map(plainInline))
    },
    { width: opts.width, color: opts.color, theme: opts.theme, role: opts.role }
  );
  const lines = [...table.lines];
  if (table.hidden.length) {
    lines.push(paint(truncateCells(`+ ${table.hidden.join(", ")} hidden · widen the window to see`, opts.width), "muted", opts));
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

function styleLine(
  line: readonly Span[],
  opts: MarkdownRenderOptions,
  extra: { bold?: boolean; tone?: AnsiRole } = {}
): string {
  return line
    .map((span) => {
      const text = span.text.split(NO_BREAK_SPACE).join(" ");
      if (!opts.color) {
        return text;
      }
      const open: string[] = [];
      const close: string[] = [];
      if (span.bold || extra.bold) {
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
      if (span.link) {
        open.push(SGR.underline[0]);
        close.push(SGR.underline[1]);
      }
      const tone: AnsiRole | undefined = span.code ? "primaryBright" : span.link ? "primary" : extra.tone;
      if (tone) {
        open.push(ansiFg(opts.theme, tone));
        close.push(ansiFg(opts.theme, opts.role ?? "text"));
      }
      return `${open.join("")}${text}${close.join("")}`;
    })
    .join("");
}

function paint(text: string, tone: AnsiRole, opts: MarkdownRenderOptions): string {
  if (!opts.color || !text) {
    return text;
  }
  return `${ansiFg(opts.theme, tone)}${text}${ansiFg(opts.theme, opts.role ?? "text")}`;
}
