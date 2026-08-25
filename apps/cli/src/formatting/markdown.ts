import { displayWidth, padEndCells, truncateCells } from "../tui/lib/display-width.js";

const TABLE_DIVIDER_CELL_RE = /^:?-{3,}:?$/;

export interface MarkdownTableBlock {
  rawCount: number;
  rawLines: string[];
  tableLines: string[];
}

export function formatMarkdownForTerminal(message: string, width: number): string[] {
  const lines = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rendered: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const block = readMarkdownTableBlock(lines.slice(index), { final: true });
    if (block && block !== "hold") {
      rendered.push(...renderMarkdownTableBlock(block, width));
      index += block.rawCount;
      continue;
    }

    const line = lines[index] ?? "";
    if (!line.trim()) {
      rendered.push("");
      index += 1;
      continue;
    }

    rendered.push(...wrapLine(line, width));
    index += 1;
  }

  return rendered.length ? rendered : [""];
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
    const tableLines = rawLines.filter((line) => !isMarkdownTableDivider(line));
    if (tableLines.length > 0) {
      return { rawCount: end, rawLines, tableLines };
    }
  }

  if (lines.length === 1 && !options.final) {
    return "hold";
  }

  return null;
}

export function renderMarkdownTableBlock(block: MarkdownTableBlock, width: number): string[] {
  const rows = block.tableLines.map(splitMarkdownTableRow).filter((row) => row.length > 0);
  if (rows.length === 0) {
    return block.rawLines;
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_value, column) =>
    Math.max(...rows.map((row) => displayWidth(stripInlineMarkup(row[column] ?? ""))))
  );
  const rendered = rows.map((row) =>
    widths
      .map((cellWidth, column) => padEndCells(stripInlineMarkup(row[column] ?? ""), cellWidth))
      .join("  ")
      .trimEnd()
  );

  if (rendered.some((line) => displayWidth(line) > width)) {
    return block.rawLines;
  }

  return rendered;
}

function splitMarkdownTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableDivider(row: string): boolean {
  const cells = splitMarkdownTableRow(row);
  return cells.length > 1 && cells.every((cell) => TABLE_DIVIDER_CELL_RE.test(cell));
}

const SGR = {
  bold: "[1m",
  boldOff: "[22m",
  italic: "[3m",
  italicOff: "[23m",
  strike: "[9m",
  strikeOff: "[29m"
} as const;

/**
 * Apply inline markdown emphasis to a single rendered line.
 *
 * With color enabled, `**bold**`/`__bold__`, `*italic*`/`_italic_`,
 * `~~strike~~`, and `` `code` `` become the matching ANSI SGR spans (code
 * is rendered bold to avoid nesting a color reset inside a colored panel).
 * With color disabled, the markers are stripped to plain text so the
 * terminal never shows literal `**`. Width helpers are ANSI-aware, so the
 * emitted escape codes do not disturb panel alignment.
 */
export function styleInlineMarkdown(line: string, color: boolean): string {
  if (!color) {
    return stripInlineMarkup(line);
  }

  return line
    .replace(/\*\*(.+?)\*\*/g, `${SGR.bold}$1${SGR.boldOff}`)
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, `${SGR.bold}$1${SGR.boldOff}`)
    .replace(/~~(.+?)~~/g, `${SGR.strike}$1${SGR.strikeOff}`)
    .replace(/`([^`]+)`/g, `${SGR.bold}$1${SGR.boldOff}`)
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, `${SGR.italic}$1${SGR.italicOff}`)
    .replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, `${SGR.italic}$1${SGR.italicOff}`);
}

export function stripInlineMarkup(value: string): string {
  return value
    .replace(/!\[(.*?)\]\(((?:[^\s()]|\([^\s()]*\))+?)\)/g, "[image: $1] $2")
    .replace(/\[(.+?)\]\(((?:[^\s()]|\([^\s()]*\))+?)\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1")
    .replace(/==(.+?)==/g, "$1")
    .replace(/\[\^([^\]]+)\]/g, "[$1]");
}

function wrapLine(line: string, width: number): string[] {
  const words = line.trimEnd().split(/(\s+)/).filter((part) => part.length > 0);
  const wrapped: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current}${word}` : word.trimStart();

    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      wrapped.push(current.trimEnd());
      current = word.trimStart();
    }

    while (displayWidth(current) > width) {
      const chunk = truncateCells(current, width);
      wrapped.push(chunk);
      current = current.slice(Math.max(0, chunk.length - 1)).trimStart();
    }
  }

  if (current.trim() || wrapped.length === 0) {
    wrapped.push(current.trimEnd());
  }

  return wrapped;
}
