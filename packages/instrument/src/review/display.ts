import { sanitizeUntrustedBlock } from "../agents/sanitize.js"
import type { Scanner } from "./scan.js"

/** Presentation only. Never use this representation as source code or a filesystem path. */
export function neutralizeUntrustedMarkup(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›")
    .replace(/@(?=[A-Za-z0-9_])/g, "＠")
    .replace(/(!?)\[([^\]\n]*)\](?=\s*(?:\(|\[|:))/g, "$1［$2］")
    .replace(/\b(https?|mailto):/gi, "$1[:]")
}
export function safeDisplayText(scanner: Scanner, text: string): string {
  return neutralizeUntrustedMarkup(scanner.redact(sanitizeUntrustedBlock(text, 65_536)).text)
}
