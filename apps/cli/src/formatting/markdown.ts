import { displayWidth, padEndCells } from "../tui/lib/display-width.js";
import { DEFAULT_THEME } from "../tui/theme.js";
import { splitMarkdownTableRow, type MarkdownTableBlock } from "./markdown-blocks.js";
import { renderMarkdown } from "./markdown-render.js";

export { readMarkdownTableBlock, type MarkdownTableBlock } from "./markdown-blocks.js";

/**
 * Plain (uncolored) markdown lines at `width`: headings, lists, code, quotes,
 * rules and bordered tables, with inline markers removed. Callers that paint
 * should call `renderMarkdown` with `color: true` instead of styling these
 * lines afterwards (styling after wrapping is what leaked `**`).
 */
export function formatMarkdownForTerminal(message: string, width: number): string[] {
  return renderMarkdown(message, { width, color: false, theme: DEFAULT_THEME });
}

/**
 * The streaming table row renderer used by the live activity panel while a
 * table is still arriving (see `readMarkdownTableBlock(lines, { final })`).
 */
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
