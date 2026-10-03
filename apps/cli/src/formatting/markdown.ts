import { DEFAULT_THEME } from "../tui/theme.js";
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

export function stripInlineMarkup(value: string): string {
  return value
    .replace(/!\[(.*?)\]\(((?:[^\s()]|\([^\s()]*\))+?)\)/g, "$1")
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
