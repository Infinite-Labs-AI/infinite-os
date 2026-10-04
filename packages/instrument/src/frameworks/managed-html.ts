// The managed <script> block injected into an HTML page's <head>. Shared by the static-html adapter
// and the Vite adapter (which injects into index.html instead of touching the React entrypoint), so
// both use identical markers, assembly, insertion and removal — and uninstall reverses either.
import { indentBlock } from "./shared.js"

export const MANAGED_HTML_START = "<!-- infinite:start -->"
export const MANAGED_HTML_END = "<!-- infinite:end -->"

function escapeForRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const managedBlockPattern = new RegExp(
  `${escapeForRegExp(MANAGED_HTML_START)}[\\s\\S]*?${escapeForRegExp(MANAGED_HTML_END)}`,
  "m"
)

const managedBlockPatternWithTrailingNewline = new RegExp(
  `${escapeForRegExp(MANAGED_HTML_START)}[\\s\\S]*?${escapeForRegExp(MANAGED_HTML_END)}\\n?`,
  "m"
)

/** The fenced managed block for the given provider `<script>…</script>` snippets (already HTML). */
export function buildManagedHtmlBlock(providerSnippets: string[]): string {
  return [
    MANAGED_HTML_START,
    ...providerSnippets.flatMap((snippet) => ["", indentBlock(snippet, 2)]),
    "",
    MANAGED_HTML_END
  ].join("\n")
}

export function hasManagedHtmlBlock(html: string): boolean {
  return html.includes(MANAGED_HTML_START)
}

/**
 * Insert the managed block (replacing an existing one if present, else before `</head>`). Function
 * replacers so any `$` sequence in the block is inserted verbatim — never a `$&`/`$1` backreference.
 */
export function upsertManagedHtmlBlock(html: string, block: string): string {
  return hasManagedHtmlBlock(html)
    ? html.replace(managedBlockPattern, () => block)
    : html.replace("</head>", () => `${block}\n</head>`)
}

/** Remove the managed block (and one trailing newline). Returns the input unchanged when absent. */
export function stripManagedHtmlBlock(html: string): string {
  return html.replace(managedBlockPatternWithTrailingNewline, "")
}
