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

/**
 * Per-text memo of closer lookups, keyed by delimiter char + size. Entry `i`
 * holds the result of a closer scan that passed index `i` (-1 = none, -2 =
 * not yet scanned). The scan's state is its index alone, so any later scan that
 * reaches a memoized index ends the same way: every index is scanned at most
 * once per key, and a paragraph full of unmatched `**` stays linear instead of
 * rescanning to the end for each opener (wave-1 adversarial review).
 */
type CloserMemo = Map<string, Int32Array>;

/**
 * Inline nesting (link labels, emphasis) parsed as markup. Each level re-parses
 * a slice, so deeper text prints as written rather than recursing: 5,000 nested
 * `[` overflowed the stack (wave-1 adversarial review).
 */
const MAX_INLINE_DEPTH = 32;

function parseRange(text: string, style: Style, depth = 0): Span[] {
  if (depth > MAX_INLINE_DEPTH) {
    return text ? [{ ...style, text }] : [];
  }
  const memo: CloserMemo = new Map();
  const links = new LinkIndex(text);
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
      const link = readLink(text, index + 1, links);
      if (link) {
        // No pictures in the terminal and no picture URLs: an image is its alt
        // text only, with no link, so nothing offers to open or copy it.
        flush();
        out.push(...parseRange(link.label || "image", style, depth + 1));
        index = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = readLink(text, index, links);
      if (link) {
        flush();
        out.push(...parseRange(link.label, { ...style, link: link.url }, depth + 1));
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
      const emphasis = readEmphasis(text, index, char, memo);
      if (emphasis) {
        flush();
        out.push(...parseRange(text.slice(emphasis.innerStart, emphasis.innerEnd), { ...style, ...emphasis.style }, depth + 1));
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
  char: "*" | "_" | "~",
  memo: CloserMemo
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
    const close = findDelimiterClose(text, innerStart, char, size, memo);
    if (close < 0) {
      continue;
    }
    const style: Style = char === "~" ? { strike: true } : size === 2 ? { bold: true } : { italic: true };
    return { innerStart, innerEnd: close, end: close + size, style };
  }
  return null;
}

/** Find the closing delimiter of `size` for an opener ending at `from`. */
function findDelimiterClose(text: string, from: number, char: string, size: number, memo: CloserMemo): number {
  const key = `${char}${size}`;
  let table = memo.get(key);
  if (!table) {
    table = new Int32Array(text.length + 1).fill(-2);
    memo.set(key, table);
  }
  const visited: number[] = [];
  const settle = (result: number): number => {
    for (const at of visited) {
      table[at] = result;
    }
    return result;
  };
  let index = from + 1;
  while (index < text.length) {
    const known = table[index]!;
    if (known !== -2) {
      return settle(known);
    }
    visited.push(index);
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
        return settle(runEnd - size);
      }
      index = runEnd;
      continue;
    }
    index += 1;
  }
  return settle(-1);
}

/**
 * Bracket and paren matches for one text, computed once in linear time so that
 * a paragraph of unmatched `[` or `[x](` does not rescan to the end for every
 * opener (`[`×70k took 3.4 s). Same rules as the per-opener scans they replace:
 * `\\` skips the next character in a label; the URL's parens ignore escapes
 * and stop at a newline.
 */
class LinkIndex {
  private bracketClose: Int32Array | null = null;
  private bracketAligned: Uint8Array | null = null;
  private parenLevel: Int32Array | null = null;
  private parenClosers: Map<number, number[]> | null = null;
  private nextNewline: Int32Array | null = null;

  constructor(private readonly text: string) {}

  /** The `]` that closes the `[` at `start`, or -1 when the label never closes. */
  labelClose(start: number): number {
    if (!this.bracketClose) this.indexBrackets();
    if (this.bracketAligned![start]) return this.bracketClose![start]!;
    // `start` sits inside an escape pair of the whole-text pass (a code span
    // can end in `\\`): scan from here, as the per-opener code did.
    return scanLabelClose(this.text, start);
  }

  /** The `)` that ends a URL starting at `from`, or -1 (a newline or the end first). */
  urlClose(from: number): number {
    if (!this.parenLevel) this.indexParens();
    if (from >= this.text.length) return -1;
    const closers = this.parenClosers!.get(this.parenLevel![from]!);
    if (!closers) return -1;
    let lo = 0;
    let hi = closers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (closers[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    const close = lo < closers.length ? closers[lo]! : -1;
    const newline = this.nextNewline![from]!;
    return close >= 0 && (newline < 0 || close < newline) ? close : -1;
  }

  private indexBrackets(): void {
    const { text } = this;
    const close = new Int32Array(text.length + 1).fill(-1);
    const aligned = new Uint8Array(text.length + 1);
    const open: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      aligned[index] = 1;
      const char = text[index];
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "[") {
        open.push(index);
      } else if (char === "]") {
        const opener = open.pop();
        if (opener !== undefined) close[opener] = index;
      }
    }
    this.bracketClose = close;
    this.bracketAligned = aligned;
  }

  private indexParens(): void {
    const { text } = this;
    // level[i] = `(` minus `)` before i. A scan from `from` stops at the first
    // `)` whose level equals level[from] (its parens counter is then 0).
    const level = new Int32Array(text.length + 1);
    const closers = new Map<number, number[]>();
    const nextNewline = new Int32Array(text.length + 1).fill(-1);
    let running = 0;
    for (let index = 0; index < text.length; index += 1) {
      level[index] = running;
      const char = text[index];
      if (char === "(") {
        running += 1;
      } else if (char === ")") {
        const list = closers.get(running);
        if (list) list.push(index);
        else closers.set(running, [index]);
        running -= 1;
      }
    }
    level[text.length] = running;
    let newline = -1;
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (text[index] === "\n") newline = index;
      nextNewline[index] = newline;
    }
    this.parenLevel = level;
    this.parenClosers = closers;
    this.nextNewline = nextNewline;
  }
}

function scanLabelClose(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
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
        return index;
      }
    }
  }
  return -1;
}

function readLink(text: string, start: number, links: LinkIndex): { label: string; url: string; end: number } | null {
  const index = links.labelClose(start);
  if (index < 0 || text[index + 1] !== "(") {
    return null;
  }
  const label = text.slice(start + 1, index);
  const cursor = links.urlClose(index + 2);
  if (cursor < 0) {
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

/**
 * A partial answer (still streaming, or stopped mid-stream) with every marker
 * that opened a span which has not closed yet taken out, so `**Cold brew car`
 * draws as `Cold brew car` until its `**` arrives, and a stopped answer never
 * keeps a literal `**` (eval M4). Only an OPENING marker is held: one after a
 * space, punctuation or the start of a line, followed by text or nothing yet.
 * Markers inside words (`snake_case`, `5*3`) and between spaces (`5 * 3`) are
 * text and stay, and so does everything in a fenced code block still open.
 * Only the last paragraph can hold an open marker; earlier ones are final.
 */
/** Characters after which a marker is part of a path, a key or a handle, not an opener. */
const TEXT_BEFORE_MARKER = new Set(["/", ":", ".", "=", "@", "#"]);

export function holdOpenMarkers(text: string): string {
  const fences = text.split("\n").filter((line) => /^ {0,3}(```|~~~)/.test(line)).length;
  if (fences % 2 === 1) {
    return text;
  }
  const breakAt = text.lastIndexOf("\n\n");
  const head = breakAt >= 0 ? text.slice(0, breakAt + 2) : "";
  let tail = breakAt >= 0 ? text.slice(breakAt + 2) : text;

  // A link or image still arriving: its label only (`[label](https://exa` → `label`).
  tail = tail
    .replace(/!?\[([^[\]\n]*)\]\([^()\s]*$/u, "$1")
    .replace(/!?\[([^[\]\n]*)\]$/u, "$1")
    .replace(/(^|[^\w\]\\])!?\[([^[\]\n]*)$/u, "$1$2");

  const removals: [number, number][] = [];
  const memo: CloserMemo = new Map();
  // A URL is text to its end: `https://x.com/_foo` has no opener in it.
  const urls = Array.from(tail.matchAll(/\S+:\/\/\S*/gu), (match) => [match.index!, match.index! + match[0].length] as const);
  let index = 0;
  while (index < tail.length) {
    const char = tail[index]!;
    const url = urls.find(([from, to]) => index >= from && index < to);
    if (url) {
      index = url[1];
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char !== "`" && char !== "*" && char !== "_" && char !== "~") {
      index += 1;
      continue;
    }
    const run = runLength(tail, index, char);
    const before = tail[index - 1];
    const after = tail[index + run];
    // After a path or key character (`a/_b`, `key=_v`, `user@_x`) a marker is text, as it is mid-word.
    const opens = !isWordChar(before) && !TEXT_BEFORE_MARKER.has(before ?? "") && (after === undefined || !/\s/.test(after)) && (char !== "~" || run >= 2);
    if (char === "`") {
      const close = findCodeClose(tail, index + run, run);
      if (close >= 0) {
        index = close + run;
        continue;
      }
    } else if (opens && after !== undefined) {
      // The closer must be the opener's own size: `**a*` is still waiting for its `**`.
      const size = char === "~" ? 2 : Math.min(run, 2);
      const close = findDelimiterClose(tail, index + size, char, size, memo);
      if (close >= 0) {
        index = close + size;
        continue;
      }
    }
    if (opens) {
      removals.push([index, index + run]);
    }
    index += run;
  }
  for (const [from, to] of removals.reverse()) {
    tail = `${tail.slice(0, from)}${tail.slice(to)}`;
  }
  return `${head}${tail}`;
}
