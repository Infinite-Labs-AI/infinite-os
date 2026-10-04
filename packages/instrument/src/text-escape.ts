// Small escapers shared by the code that builds RegExps from identifiers and the code that writes
// Markdown tables. One copy each, so no caller escapes half the metacharacters.

/** Every RegExp metacharacter escaped (the backslash included), so `value` matches itself literally. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * One GitHub-flavoured Markdown table cell: backslashes are escaped FIRST, then pipes, so an input
 * `\|` cannot become `\\|` (an escaped backslash followed by a live pipe that opens a new column).
 * Newlines are flattened to spaces (a row is one line).
 */
export function escapeMarkdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/** `value` without its trailing `/` characters, in linear time (a `/\/+$/` replace is quadratic on many slashes). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

/** §3x.3 (§2.3) Text escaped for the inside of a template literal: `\` → `\\`, a backtick and `${` escaped. */
export function escapeForTemplateLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
}
