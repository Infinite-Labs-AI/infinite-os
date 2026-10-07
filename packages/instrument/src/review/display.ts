import { sanitizeUntrustedBlock } from "../agents/sanitize.js"
import type { Scanner } from "./scan.js"

/** Presentation only. Never use this representation as source code or a filesystem path. */
export function neutralizeUntrustedMarkup(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›")
    .replace(/@(?=[A-Za-z0-9_])/g, "＠")
    .replace(/(!?)\[([^\]\n]*)\](?=\s*(?:\(|\[|:))/g, "$1［$2］")
    .replace(/\b(https?|mailto):/gi, "$1[:]")
    .replace(/#(?=\d+\b)/g, "＃")
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?=\s+(?:(?:[\w.-]+\/)?[\w.-]+)?＃\d+\b)/gi, "$1 [quoted]")
}
/** Preserve code/Markdown syntax, but redact both before and after control stripping, before any cap. */
export function redactDisplayText(scanner: Scanner, text: string): string {
  const rawRedacted = scanner.redact(text).text
  const cleaned = sanitizeUntrustedBlock(rawRedacted, Math.max(1, rawRedacted.length))
  return sanitizeUntrustedBlock(scanner.redact(cleaned).text, 65_536)
}

export function safeDisplayText(scanner: Scanner, text: string): string {
  return neutralizeUntrustedMarkup(redactDisplayText(scanner, text))
}
