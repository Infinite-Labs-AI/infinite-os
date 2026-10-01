import { scrubTerminalControls } from "../desktop/confirm-in-session.js";
import { displayWidth } from "../tui/lib/display-width.js";

/**
 * Inline markdown as styled spans. Spans carry visible text only, so layout
 * (`wrapSpans`) measures what the terminal will show and SGR codes are added
 * after the lines are decided. That is what keeps `**` out of a wrapped line.
 */
export type Span = { text: string; bold?: true; italic?: true; strike?: true; code?: true; link?: string };

type Style = Omit<Span, "text">;

/** A word joiner that never breaks: the renderer swaps it back to a space after layout. */
export const NO_BREAK_SPACE = "\u00a0";

const ESCAPABLE = new Set(Array.from("\\`*_{}[]()#+-.!|~<>\""));
const AUTOLINK_RE = /^<((?:https?:\/\/|mailto:)[^>\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/;

/** Parse one paragraph of inline markdown. `\n` stays in the text as a hard break. */
export function parseInline(text: string): Span[] {
  const scrubbed = text.split("\n").map(scrubTerminalControls).join("\n");
  return mergeSpans(parseRange(scrubbed, {}));
}

/**
 * Lay spans out into lines no wider than `width` visible cells. Runs of spaces
 * collapse to one, `\n` forces a break, and a word wider than the line breaks
 * by character. `indent.first` / `indent.rest` prefix the lines as plain spans.
 */
export function wrapSpans(spans: Span[], width: number, indent?: { first: string; rest: string }): Span[][] {
  const first = indent?.first ?? "";
  const rest = indent?.rest ?? "";
  const items = tokenize(spans);
  const lines: Span[][] = [];
  let current: Span[] = [];
  let used = 0;
  let hasContent = false;

  const prefix = () => (lines.length === 0 ? first : rest);
  const avail = () => Math.max(1, width - displayWidth(prefix()));
  const start = () => {
    const lead = prefix();
    current = lead ? [{ text: lead }] : [];
    used = 0;
    hasContent = false;
  };
  const finish = () => {
    lines.push(mergeSpans(current));
  };

  const placeHard = (pieces: Span[]) => {
    for (const piece of pieces) {
      for (const char of Array.from(piece.text)) {
        const charWidth = displayWidth(char);
        if (hasContent && used + charWidth > avail()) {
          finish();
          start();
        }
        current.push({ ...styleOf(piece), text: char });
        used += charWidth;
        hasContent = true;
      }
    }
  };

  start();
  for (const item of items) {
    if (item.kind === "break") {
      finish();
      start();
      continue;
    }
    const wordWidth = item.pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);
    if (hasContent) {
      if (used + 1 + wordWidth <= avail()) {
        current.push({ ...item.spaceStyle, text: " " }, ...item.pieces);
        used += 1 + wordWidth;
        continue;
      }
      finish();
      start();
    }
    if (wordWidth <= avail()) {
      current.push(...item.pieces);
      used += wordWidth;
      hasContent = true;
      continue;
    }
    placeHard(item.pieces);
  }
  finish();

  return lines;
}

/** A word, and the style of the space before it (so a link or strike stays continuous across its spaces). */
type Token = { kind: "break" } | { kind: "word"; pieces: Span[]; spaceStyle: Style };

function tokenize(spans: readonly Span[]): Token[] {
  const tokens: Token[] = [];
  let word: Span[] = [];
  let spaceStyle: Style = {};
  let nextSpaceStyle: Style = {};
  const flushWord = () => {
    if (word.length) {
      tokens.push({ kind: "word", pieces: word, spaceStyle });
      word = [];
    }
  };
  for (const span of spans) {
    for (const part of span.text.split(/(\n| +)/)) {
      if (!part) {
        continue;
      }
      if (part === "\n") {
        flushWord();
        tokens.push({ kind: "break" });
        continue;
      }
      if (/^ +$/.test(part)) {
        flushWord();
        nextSpaceStyle = styleOf(span);
        continue;
      }
      if (!word.length) {
        spaceStyle = sharedStyle(nextSpaceStyle, styleOf(span));
      }
      word.push({ ...styleOf(span), text: part });
    }
  }
  flushWord();
  return tokens;
}

function parseRange(text: string, style: Style): Span[] {
  const out: Span[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push({ ...style, text: buffer });
      buffer = "";
    }
  };
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === "\\" && index + 1 < text.length && ESCAPABLE.has(text[index + 1]!)) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      const run = runLength(text, index, "`");
      const close = findCodeClose(text, index + run, run);
      if (close >= 0) {
        flush();
        let code = text.slice(index + run, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
          code = code.slice(1, -1);
        }
        out.push({ ...style, code: true, text: code.replace(/\n/g, " ") });
        index = close + run;
        continue;
      }
      buffer += "`".repeat(run);
      index += run;
      continue;
    }

    if (char === "!" && text[index + 1] === "[") {
      const link = readLink(text, index + 1);
      if (link) {
        // No pictures in the terminal and no picture URLs: an image is its alt
        // text only, with no link, so nothing offers to open or copy it.
        flush();
        out.push(...parseRange(link.label || "image", style));
        index = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = readLink(text, index);
      if (link) {
        flush();
        out.push(...parseRange(link.label, { ...style, link: link.url }));
        index = link.end;
        continue;
      }
    }

    if (char === "<") {
      const auto = AUTOLINK_RE.exec(text.slice(index));
      if (auto) {
        flush();
        out.push({ ...style, text: auto[1]!, link: auto[1]! });
        index += auto[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const emphasis = readEmphasis(text, index, char);
      if (emphasis) {
        flush();
        out.push(...parseRange(text.slice(emphasis.innerStart, emphasis.innerEnd), { ...style, ...emphasis.style }));
        index = emphasis.end;
        continue;
      }
      const run = runLength(text, index, char);
      buffer += char.repeat(run);
      index += run;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return out;
}

function readEmphasis(
  text: string,
  start: number,
  char: "*" | "_" | "~"
): { innerStart: number; innerEnd: number; end: number; style: Style } | null {
  const run = runLength(text, start, char);
  const sizes = char === "~" ? (run >= 2 ? [2] : []) : run >= 2 ? [2, 1] : [1];
  if (char === "_" && isWordChar(text[start - 1])) {
    return null;
  }

  for (const size of sizes) {
    const innerStart = start + size;
    const next = text[innerStart];
    if (next === undefined || /\s/.test(next)) {
      continue;
    }
    const close = findDelimiterClose(text, innerStart, char, size);
    if (close < 0) {
      continue;
    }
    const style: Style = char === "~" ? { strike: true } : size === 2 ? { bold: true } : { italic: true };
    return { innerStart, innerEnd: close, end: close + size, style };
  }
  return null;
}

/** Find the closing delimiter of `size` for an opener ending at `from`. */
function findDelimiterClose(text: string, from: number, char: string, size: number): number {
  let index = from + 1;
  while (index < text.length) {
    const current = text[index]!;
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === "`") {
      const run = runLength(text, index, "`");
      const close = findCodeClose(text, index + run, run);
      index = close >= 0 ? close + run : index + run;
      continue;
    }
    if (current === char) {
      const run = runLength(text, index, char);
      const runEnd = index + run;
      const before = text[index - 1];
      const fits = run === size || (run === 3 && size <= 2) || (char === "~" && run >= size);
      const flanking = before !== undefined && !/\s/.test(before);
      const after = text[runEnd];
      const wordSafe = char !== "_" || !isWordChar(after);
      if (fits && flanking && wordSafe) {
        return runEnd - size;
      }
      index = runEnd;
      continue;
    }
    index += 1;
  }
  return -1;
}

function readLink(text: string, start: number): { label: string; url: string; end: number } | null {
  let depth = 0;
  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  if (depth !== 0 || text[index + 1] !== "(") {
    return null;
  }
  const label = text.slice(start + 1, index);
  let parens = 0;
  let cursor = index + 2;
  for (; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\n") {
      return null;
    }
    if (char === "(") {
      parens += 1;
    } else if (char === ")") {
      if (parens === 0) {
        break;
      }
      parens -= 1;
    }
  }
  if (cursor >= text.length) {
    return null;
  }
  const target = text.slice(index + 2, cursor).trim();
  const url = (/^<([^>]*)>/.exec(target)?.[1] ?? target.split(/\s+/)[0] ?? "").trim();
  if (!url) {
    return null;
  }
  return { label, url, end: cursor + 1 };
}

function findCodeClose(text: string, from: number, run: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "`") {
      const length = runLength(text, index, "`");
      if (length === run) {
        return index;
      }
      index += length;
      continue;
    }
    index += 1;
  }
  return -1;
}

function runLength(text: string, start: number, char: string): number {
  let end = start;
  while (text[end] === char) {
    end += 1;
  }
  return end - start;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function styleOf(span: Span): Style {
  const { text: _text, ...style } = span;
  return style;
}

/** The style a space between two runs keeps: only what both sides share. */
function sharedStyle(a: Style, b: Style): Style {
  const shared: Style = {};
  if (a.bold && b.bold) {
    shared.bold = true;
  }
  if (a.italic && b.italic) {
    shared.italic = true;
  }
  if (a.strike && b.strike) {
    shared.strike = true;
  }
  if (a.link && a.link === b.link) {
    shared.link = a.link;
  }
  return shared;
}

function sameStyle(a: Span, b: Span): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link;
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (!span.text) {
      continue;
    }
    const last = out.at(-1);
    if (last && sameStyle(last, span)) {
      last.text += span.text;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}
