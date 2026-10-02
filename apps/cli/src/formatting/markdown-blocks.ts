import type { TableAlign } from "./table.js";

/**
 * The block lexer for the subset of markdown an assistant writes: ATX
 * headings, `-`/`*`/`+`/`1.` lists with nesting, fenced code, `>` quotes,
 * rules, GFM tables and paragraphs. No dependency: the streaming "hold"
 * contract (`readMarkdownTableBlock(lines, { final })`) needs a lexer we own.
 */
export type MarkdownBlock =
  | { type: "blank" }
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list_item"; depth: number; ordered: boolean; marker: string; text: string }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "rule" }
  | { type: "table"; header: string[]; aligns: Array<TableAlign | undefined>; rows: string[][] };

export interface MarkdownTableBlock {
  rawCount: number;
  rawLines: string[];
  tableLines: string[];
}

const TABLE_DIVIDER_CELL_RE = /^:?-+:?$/; // GFM: one or more dashes
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

export function lexMarkdown(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  const listStack: number[] = [];
  let index = 0;

  const pushBlank = () => {
    if (blocks.length && blocks.at(-1)?.type !== "blank") {
      blocks.push({ type: "blank" });
    }
  };

  while (index < lines.length) {
    const line = lines[index]!;

    if (!line.trim()) {
      pushBlank();
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]!;
        const trimmed = candidate.trim();
        if (trimmed[0] === marker[0] && /^(`+|~+)$/.test(trimmed) && trimmed.length >= marker.length) {
          index += 1;
          break;
        }
        body.push(stripIndent(candidate, indent));
        index += 1;
      }
      blocks.push({ type: "code", lang: fence[3] ?? "", lines: body });
      listStack.length = 0;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: (heading[2] ?? "").replace(/[ \t]+#+$/, "").trim() });
      listStack.length = 0;
      index += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: "rule" });
      listStack.length = 0;
      index += 1;
      continue;
    }

    const table = readMarkdownTableBlock(lines.slice(index), { final: true });
    if (table && table !== "hold") {
      blocks.push(tableBlock(table));
      listStack.length = 0;
      index += table.rawCount;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const inner: string[] = [];
      while (index < lines.length) {
        const match = QUOTE_RE.exec(lines[index]!);
        if (!match) {
          break;
        }
        inner.push(match[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", lines: inner });
      listStack.length = 0;
      continue;
    }

    const item = LIST_RE.exec(line);
    if (item) {
      const column = item[1]!.length;
      const marker = item[2]!;
      while (listStack.length && listStack.at(-1)! > column + 1) {
        listStack.pop();
      }
      const depth = listStack.length;
      listStack.push(column + marker.length + 1);
      const text = [item[3]!.trim()];
      index += 1;
      while (index < lines.length && isContinuation(lines, index)) {
        text.push(lines[index]!.trim());
        index += 1;
      }
      blocks.push({ type: "list_item", depth, ordered: /\d/.test(marker), marker, text: text.join("\n") });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && isContinuation(lines, index)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    listStack.length = 0;
  }

  while (blocks.at(-1)?.type === "blank") {
    blocks.pop();
  }
  return blocks;
}

export function readMarkdownTableBlock(
  lines: string[],
  options: { final: boolean }
): MarkdownTableBlock | "hold" | null {
  const first = lines[0];
  if (!first?.trim() || !first.includes("|")) {
    return null;
  }

  if (lines.length >= 2 && isMarkdownTableDivider(lines[1] ?? "") && splitMarkdownTableRow(first).length > 1) {
    let end = 2;
    while (end < lines.length && lines[end]!.trim() && lines[end]!.includes("|")) {
      end += 1;
    }
    if (end === lines.length && !options.final) {
      return "hold";
    }
    return {
      rawCount: end,
      rawLines: lines.slice(0, end),
      tableLines: [first, ...lines.slice(2, end)]
    };
  }

  if (first.trim().startsWith("|")) {
    let end = 0;
    while (end < lines.length && lines[end]!.trim().startsWith("|")) {
      end += 1;
    }
    if (end === lines.length && !options.final) {
      return "hold";
    }
    const rawLines = lines.slice(0, end);
    // Only a divider in the header position is chrome; a later all-dash row is
    // data (a dash for an unmeasured value) and must stay.
    const tableLines = rawLines.filter((line, index) => !(index === 1 && isMarkdownTableDivider(line)));
    if (tableLines.length > 0) {
      return { rawCount: end, rawLines, tableLines };
    }
  }

  if (lines.length === 1 && !options.final) {
    return "hold";
  }

  return null;
}

export function splitMarkdownTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function isMarkdownTableDivider(row: string): boolean {
  const cells = splitMarkdownTableRow(row);
  return cells.length > 1 && cells.every((cell) => TABLE_DIVIDER_CELL_RE.test(cell));
}

function tableBlock(block: MarkdownTableBlock): MarkdownBlock {
  const divider = block.rawLines[1] && isMarkdownTableDivider(block.rawLines[1]) ? block.rawLines[1] : undefined;
  const aligns = divider
    ? splitMarkdownTableRow(divider).map((cell): TableAlign | undefined =>
        cell.endsWith(":") && !cell.startsWith(":") ? "right" : cell.startsWith(":") && !cell.endsWith(":") ? "left" : undefined
      )
    : [];
  const [header = [], ...rows] = block.tableLines.map(splitMarkdownTableRow);
  return { type: "table", header, aligns, rows };
}

/** A line continues the open paragraph or list item unless it is blank or starts another block. */
function isContinuation(lines: readonly string[], index: number): boolean {
  const line = lines[index]!;
  if (!line.trim()) {
    return false;
  }
  if (FENCE_RE.test(line) || HEADING_RE.test(line) || RULE_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line)) {
    return false;
  }
  const table = readMarkdownTableBlock(lines.slice(index), { final: true });
  return !table || table === "hold";
}

function stripIndent(line: string, indent: number): string {
  let index = 0;
  while (index < indent && line[index] === " ") {
    index += 1;
  }
  return line.slice(index);
}
