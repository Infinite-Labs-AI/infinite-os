// Shared reading helpers for the wizard-era setup checks (provider census, PostHog config, host guard,
// sensitive pages, Meta event id). Same privacy line as `markup.ts`: tags, call shapes and public ids
// only — never a form value or visible copy.
//
// `codeView` blanks comments (JS and HTML) while keeping every offset, so a commented-out
// `fbq('init', …)` is never counted and line numbers stay true.
import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { htmlScripts } from "../html-scripts.js"
import { lineNumberAt } from "../harness/scan.js"

import { metaSourceUnits, type MetaSourceUnit } from "./meta-pixel-config.js"

export type SourceUnit = MetaSourceUnit

export function isHtmlFile(file: string): boolean {
  return /\.html?$/i.test(file)
}

/** The unit's text with comments blanked (same length, same offsets). */
export function codeView(file: string, text: string): string {
  const blankHtmlComments = text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
  if (!isHtmlFile(file) && !/^\s*</.test(blankHtmlComments)) return maskCommentsAndStrings(blankHtmlComments, false)
  // HTML: only the script bodies are code; JS comments are blanked inside them.
  const chars = blankHtmlComments.split("")
  for (const script of htmlScripts(blankHtmlComments, true)) {
    const body = maskCommentsAndStrings(blankHtmlComments.slice(script.bodyStart, script.bodyEnd), false)
    for (let index = 0; index < body.length; index += 1) chars[script.bodyStart + index] = body[index] as string
  }
  return chars.join("")
}

/** Every file split into managed / adopted units (managed HTML blocks, the decoded Next bootstrap). */
export function sourceUnits(files: ReadonlyMap<string, string>): SourceUnit[] {
  const units: SourceUnit[] = []
  for (const [file, contents] of files) units.push(...metaSourceUnits(file, contents))
  return units
}

/** 1-based file line of an offset inside a unit. A decoded (non-verbatim) unit points at its start. */
export function unitLine(unit: SourceUnit, offset: number): number {
  return unit.verbatim ? unit.line + lineNumberAt(unit.text, offset) - 1 : unit.line
}

/** Next.js / Vite route handlers and other server-only code (not page code). */
export function isServerFile(file: string): boolean {
  return (
    /(^|\/)(app|src\/app)\/(.*\/)?route\.[jt]sx?$/.test(file) ||
    /(^|\/)pages\/api\//.test(file) ||
    /(^|\/)(api|server)\//.test(file) ||
    /\.server\.[jt]sx?$/.test(file) ||
    /(^|\/)middleware\.[jt]s$/.test(file)
  )
}

/** The index of the bracket that closes the one at `open` (`(`, `{` or `[`), or -1. Strings are skipped. */
export function matchingBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" }
  const stack: string[] = []
  let quote: string | null = null
  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote) {
      if (char === "\\") {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (pairs[char]) stack.push(pairs[char] as string)
    else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return index
    }
  }
  return -1
}
