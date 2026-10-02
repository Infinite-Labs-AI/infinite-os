// The ONE sanitiser for untrusted strings (§2.0: O3 owns it; O2 imports it for every untrusted string
// it renders). Untrusted = anything an agent, a repo file, a PR comment or a page wrote: narration,
// claim notes, `report_progress` text, review excerpts, console lines.
//
// It strips what could drive or fool a terminal: ANSI/VT escape sequences (CSI, OSC, DCS, single-char
// ESC sequences), every C0 and C1 control character, the bidi overrides/isolates that reorder text
// (Trojan Source), zero-width joiners used to hide text, and Unicode tag characters / the soft hyphen. Whitespace runs collapse to one space, and
// the result is capped at `max` characters (code points, never splitting a surrogate pair), ending in "…"
// when cut. Pure; no I/O.

// ESC [ … final byte  |  ESC ] … (BEL | ESC \)  |  ESC P/X/^/_ … ESC \  |  ESC + one char.
// The 8-bit C1 forms (CSI = \x9b, OSC = \x9d, DCS = \x90) are covered by the C1 strip below once their
// payload is removed with them.
const ANSI_PATTERN = new RegExp(
  [
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    "\\u009b[0-?]*[ -/]*[@-~]",
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?",
    "\\u009d[^\\u0007\\u001b\\u009c]*(?:\\u0007|\\u009c|\\u001b\\\\)?",
    "\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?",
    "[\\u0090\\u0098\\u009e\\u009f][^\\u009c\\u001b]*(?:\\u009c|\\u001b\\\\)?",
    "\\u001b[@-Z\\\\-_]",
    "\\u001b[ -/][0-~]?"
  ].join("|"),
  "g"
)

// C0 (incl. ESC leftovers, DEL) and C1 controls. Tab/newline/CR are turned into spaces first.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g

// Bidi embeddings/overrides/isolates and marks, plus zero-width characters and the BOM.
const INVISIBLE_PATTERN = /[؜​-‏‪-‮⁠-⁩﻿]/g

// Unicode TAG characters (U+E0000–U+E007F: invisible "ASCII smuggling" text a model still reads) and the
// soft hyphen (review O3 F22).
const SMUGGLING_PATTERN = /[\u{E0000}-\u{E007F}\u00AD]/gu

export const SANITIZE_ELLIPSIS = "…"

export function sanitizeUntrusted(text: unknown, max: number): string {
  if (!Number.isInteger(max) || max < 1) throw new Error("sanitizeUntrusted: max must be a positive integer")
  const raw = typeof text === "string" ? text : text === null || text === undefined ? "" : String(text)
  const cleaned = raw
    .replace(ANSI_PATTERN, "")
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(CONTROL_PATTERN, "")
    .replace(INVISIBLE_PATTERN, "")
    .replace(SMUGGLING_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
  const points = Array.from(cleaned)
  if (points.length <= max) return cleaned
  return `${points.slice(0, max - 1).join("").trimEnd()}${SANITIZE_ELLIPSIS}`
}
