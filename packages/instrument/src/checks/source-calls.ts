// Reading calls out of source text, for the static checks: which calls are code (never a comment or a string),
// their balanced argument lists, the first object literal's top-level properties, and plain string literals.
// Moved out of `job-static.ts` unchanged so the commerce checks (`commerce-static.ts`) read code the same way.
import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { lineNumberAt } from "../harness/scan.js"
import { escapeRegExp } from "../text-escape.js"

/** One call: where it starts, its argument text (original and masked) and its 1-based line. */
export interface Call {
  name: string
  index: number
  line: number
  args: string
  maskedArgs: string
  end: number
}

/** Every call of `names` that is code (not a comment or a string), with its balanced argument list. */
export function callsOf(text: string, names: readonly string[]): Call[] {
  const masked = maskCommentsAndStrings(text, true)
  const commentsOnly = maskCommentsAndStrings(text, false)
  const pattern = new RegExp(`(?<![\\w$])(?:window\\s*\\.\\s*)?(${names.map(escapeRegExp).join("|")})\\s*\\(`, "g")
  const out: Call[] = []
  for (const match of masked.matchAll(pattern)) {
    const index = match.index ?? 0
    if (commentsOnly.slice(index, index + match[0].length) !== text.slice(index, index + match[0].length)) continue
    const open = index + match[0].length - 1
    const end = closingOf(masked, open)
    if (end < 0) continue
    out.push({ name: match[1]!, index, line: lineNumberAt(text, index), args: text.slice(open + 1, end), maskedArgs: masked.slice(open + 1, end), end })
  }
  return out
}

/** The index of the bracket that closes the one at `open` (any of `(`, `{`, `[`), in masked text; -1 when unbalanced. */
export function closingOf(masked: string, open: number): number {
  let depth = 0
  for (let cursor = open; cursor < masked.length; cursor += 1) {
    const ch = masked[cursor]
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

/** The first object literal's top-level properties in an argument list: key → value text (original). */
export function topLevelProps(call: Pick<Call, "args" | "maskedArgs">): Map<string, string> | null {
  const start = call.maskedArgs.indexOf("{")
  if (start < 0 || call.maskedArgs.slice(0, start).trim() !== "") return null
  return objectProps(call.args, call.maskedArgs, start)
}

/** The top-level properties of the object literal that opens at `start` (original text, masked text). */
export function objectProps(original: string, masked: string, start: number): Map<string, string> {
  const props = new Map<string, string>()
  let depth = 0
  let segmentStart = start + 1
  const flush = (end: number) => {
    const maskedSegment = masked.slice(segmentStart, end)
    const segment = original.slice(segmentStart, end)
    const offset = segmentStart
    segmentStart = end + 1
    if (maskedSegment.trim() === "") return
    if (/^\s*\.\.\./.test(maskedSegment)) {
      props.set(`...${props.size}`, segment.trim())
      return
    }
    const quoted = /^\s*(["'])([A-Za-z_$][\w$]*)\1\s*:/.exec(segment)
    const named = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(maskedSegment)
    const key = quoted?.[2] ?? named?.[1] ?? null
    if (key !== null) {
      const colon = masked.indexOf(":", offset + (quoted ? quoted[0].length - 1 : named![0].length - 1))
      props.set(key, original.slice(colon + 1, end).trim())
      return
    }
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(maskedSegment)
    if (shorthand) props.set(shorthand[1]!, shorthand[1]!)
  }
  for (let cursor = start; cursor < masked.length; cursor += 1) {
    const ch = masked[cursor]
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1
      if (depth === 0) {
        flush(cursor)
        break
      }
    } else if (ch === "," && depth === 1) flush(cursor)
  }
  return props
}

/** A plain string literal's value (`"x"`, `'x'`, or a template with no `${…}`), else null. */
export function literalString(value: string): string | null {
  const trimmed = value.trim()
  const match = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(trimmed)
  if (!match) return null
  if (match[1] === "`" && match[2]!.includes("${")) return null
  return match[2]!
}

/** An argument list split at its top-level commas (strings and brackets respected). */
export function splitTopLevelArgs(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let index = 0; index < args.length; index += 1) {
    const ch = args[index]!
    if (quote) {
      if (ch === "\\") index += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1
    else if (ch === "," && depth === 0) {
      out.push(args.slice(start, index))
      start = index + 1
    }
  }
  if (args.slice(start).trim() !== "") out.push(args.slice(start))
  return out
}
