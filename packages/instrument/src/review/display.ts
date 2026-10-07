import { sanitizeUntrustedBlock } from "../agents/sanitize.js"
import type { Scanner } from "./scan.js"

/** Presentation-only task markers, including nested blockquotes and ordered lists. */
export function neutralizeTaskCheckboxes(text: string): string {
  return text.replace(/^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\][ \t]?/gm, "$1")
}

/** Presentation only. Never use this representation as source code or a filesystem path. */
export function neutralizeUntrustedMarkup(text: string): string {
  return neutralizeTaskCheckboxes(text).replace(/</g, "‹").replace(/>/g, "›")
    .replace(/@(?=[A-Za-z0-9_])/g, "＠")
    .replace(/(!?)\[([^\]\n]*)\](?=\s*(?:\(|\[|:))/g, "$1［$2］")
    .replace(/\b(https?|mailto):/gi, "$1[:]")
    .replace(/#(?=\d+\b)/g, "＃")
    .replace(/\bGH-(?=\d+\b)/gi, "GH－")
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?=\s+(?:(?:[\w.-]+\/)?[\w.-]+)?＃\d+\b)/gi, "$1 [quoted]")
}
/** Redact raw values and any value exposed by removing terminal controls before changing their syntax. */
function redactRawText(scanner: Scanner, text: string): string {
  const rawRedacted = scanner.redact(text).text
  const cleaned = sanitizeUntrustedBlock(rawRedacted, Math.max(1, rawRedacted.length))
  return scanner.redact(cleaned).text
}

/** Preserve executable code/Markdown syntax; only redact and strip terminal controls before the cap. */
export function redactDisplayText(scanner: Scanner, text: string): string {
  return sanitizeUntrustedBlock(redactRawText(scanner, text), 65_536)
}

export function safeDisplayText(scanner: Scanner, text: string): string {
  return sanitizeUntrustedBlock(neutralizeUntrustedMarkup(redactRawText(scanner, text)), 65_536)
}

/** Every line remains visibly quoted, including blank lines, headings, tables and nested quote syntax. */
export function quoteDisplayNote(scanner: Scanner, text: string): string {
  return safeDisplayText(scanner, text).split("\n").map(line => `> ${line}`).join("\n")
}
