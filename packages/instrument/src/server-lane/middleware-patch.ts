// Patching an EXISTING Next.js middleware/proxy file with the server lane — pure text, no I/O.
//
// The patch is deliberately narrow: it un-exports the customer's handler (one small recorded edit),
// inserts a fenced import at the top, and appends a fenced `export default withInfiniteServerLane(<their handler>)`.
// Their code runs unchanged; ours records the document request first, fire-and-forget.
//
// It REFUSES (returns "unpatchable" with a reason) whenever the file is unusual — an export shape it
// doesn't recognize, two middleware exports, a matcher it can't read, or a NARROW matcher. A narrow
// matcher is the important one: Next.js has one middleware and one matcher, so a middleware scoped to
// /dashboard would make the lane see only /dashboard. Widening it would change the customer's own
// middleware behavior, which we never do — the agent brief explains what to change instead.
import type { ManagedTextEdit } from "../types.js"

import {
  SERVER_LANE_FENCE_START,
  SERVER_LANE_MODULE_BASENAME,
  buildFencedExportBlock,
  buildFencedImportBlock
} from "./runtime-source.js"
import { applyTextEdits } from "./text-edits.js"

export const INNER_MIDDLEWARE_IDENTIFIER = "infiniteInnerMiddleware"

export type MiddlewarePatchResult =
  | { kind: "patched"; contents: string; edits: ManagedTextEdit[]; innerIdentifier: string }
  | { kind: "already-patched" }
  | { kind: "unpatchable"; reason: string }

export const UNPATCHABLE_REASONS = {
  noExport:
    "No middleware export was found (looked for `export function middleware`, `export default function`, `export const middleware`, `export default <expression>`).",
  multipleExports:
    "More than one middleware export was found (for example both a named `middleware` and a default export); infinite-tag only wraps exactly one.",
  reExport:
    "The middleware is re-exported from another module (`export { default } from …` / `export { middleware }`), which infinite-tag cannot wrap safely.",
  unrecognizedDefault:
    "The default export is a shape infinite-tag does not recognize (class, object literal, or similar).",
  matcherUnreadable:
    "`export const config` has a `matcher` that is not a plain string or array of string literals, so infinite-tag cannot tell which pages the lane would see.",
  matcherNarrow:
    "`export const config.matcher` limits this middleware to specific routes; the lane would only see those pages. Widen the matcher to the document catch-all and scope your existing logic by path instead — see the brief.",
  partialInstall:
    "The file already references infinite-server-lane without the infinite-tag fence; finish or remove that wiring by hand first."
} as const

/** Ordered shape probes. Each is anchored to a line start so commented-out lines never match. */
const NAMED_FUNCTION = /^(export\s+)(?:async\s+)?function\s+(middleware|proxy)\s*\(/m
const NAMED_CONST = /^(export\s+)(?:const|let)\s+(middleware|proxy)\b/m
const DEFAULT_NAMED_FUNCTION = /^(export\s+default\s+)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/m
const DEFAULT_ANON_FUNCTION = /^(export\s+default\s+)(?:async\s+)?function\s*\(/m
const DEFAULT_ARROW = /^(export\s+default\s+)(?:async\s+)?\(/m
const DEFAULT_EXPRESSION = /^(export\s+default\s+)([A-Za-z_$][\w$.]*)\s*(\(|;|$)/m
const ANY_DEFAULT = /^export\s+default\b/m
const RE_EXPORT_DEFAULT = /^export\s*\{[^}]*\bdefault\b[^}]*\}/m
const RE_EXPORT_NAMED = /^export\s*\{[^}]*\b(middleware|proxy)\b[^}]*\}/m
const CONFIG_EXPORT = /^export\s+const\s+config\b/m

export function patchExistingMiddleware(
  source: string,
  options: { moduleImportPath: string }
): MiddlewarePatchResult {
  if (source.includes(SERVER_LANE_FENCE_START)) {
    return { kind: "already-patched" }
  }
  if (source.includes(SERVER_LANE_MODULE_BASENAME)) {
    return { kind: "unpatchable", reason: UNPATCHABLE_REASONS.partialInstall }
  }
  if (RE_EXPORT_DEFAULT.test(source) || RE_EXPORT_NAMED.test(source)) {
    return { kind: "unpatchable", reason: UNPATCHABLE_REASONS.reExport }
  }

  const matcherVerdict = inspectConfigMatcher(source)
  if (matcherVerdict !== "ok") {
    return {
      kind: "unpatchable",
      reason:
        matcherVerdict === "narrow"
          ? UNPATCHABLE_REASONS.matcherNarrow
          : UNPATCHABLE_REASONS.matcherUnreadable
    }
  }

  const candidates = findExportCandidates(source)
  if (candidates.length === 0) {
    return {
      kind: "unpatchable",
      reason: ANY_DEFAULT.test(source)
        ? UNPATCHABLE_REASONS.unrecognizedDefault
        : UNPATCHABLE_REASONS.noExport
    }
  }
  if (candidates.length > 1 || countMatches(source, /^export\s+default\b/gm) > 1) {
    return { kind: "unpatchable", reason: UNPATCHABLE_REASONS.multipleExports }
  }
  const candidate = candidates[0]!

  const importBlock = buildFencedImportBlock({ moduleImportPath: options.moduleImportPath })
  const exportBlock = buildFencedExportBlock({ innerIdentifier: candidate.innerIdentifier })
  const edits: ManagedTextEdit[] = [
    { offset: importInsertionOffset(source), removed: "", inserted: importBlock },
    { offset: candidate.offset, removed: candidate.removed, inserted: candidate.inserted },
    {
      offset: source.length,
      removed: "",
      inserted: (source.endsWith("\n") || source.length === 0 ? "" : "\n") + exportBlock
    }
  ]
  return {
    kind: "patched",
    contents: applyTextEdits(source, edits),
    edits,
    innerIdentifier: candidate.innerIdentifier
  }
}

interface ExportCandidate {
  offset: number
  removed: string
  inserted: string
  innerIdentifier: string
}

function findExportCandidates(source: string): ExportCandidate[] {
  const candidates: ExportCandidate[] = []
  const seenOffsets = new Set<number>()
  const push = (candidate: ExportCandidate): void => {
    if (!seenOffsets.has(candidate.offset)) {
      seenOffsets.add(candidate.offset)
      candidates.push(candidate)
    }
  }

  const namedFunction = NAMED_FUNCTION.exec(source)
  if (namedFunction) {
    push({
      offset: namedFunction.index,
      removed: namedFunction[1]!,
      inserted: "",
      innerIdentifier: namedFunction[2]!
    })
  }
  const namedConst = NAMED_CONST.exec(source)
  if (namedConst) {
    push({
      offset: namedConst.index,
      removed: namedConst[1]!,
      inserted: "",
      innerIdentifier: namedConst[2]!
    })
  }
  const defaultNamed = DEFAULT_NAMED_FUNCTION.exec(source)
  if (defaultNamed) {
    push({
      offset: defaultNamed.index,
      removed: defaultNamed[1]!,
      inserted: "",
      innerIdentifier: defaultNamed[2]!
    })
  }
  const defaultAnon = DEFAULT_ANON_FUNCTION.exec(source)
  if (defaultAnon) {
    push({
      offset: defaultAnon.index,
      removed: defaultAnon[1]!,
      inserted: `const ${INNER_MIDDLEWARE_IDENTIFIER} = `,
      innerIdentifier: INNER_MIDDLEWARE_IDENTIFIER
    })
  }
  const defaultArrow = DEFAULT_ARROW.exec(source)
  if (defaultArrow) {
    push({
      offset: defaultArrow.index,
      removed: defaultArrow[1]!,
      inserted: `const ${INNER_MIDDLEWARE_IDENTIFIER} = `,
      innerIdentifier: INNER_MIDDLEWARE_IDENTIFIER
    })
  }
  const defaultExpression = DEFAULT_EXPRESSION.exec(source)
  if (defaultExpression && !/^(function|async|class)$/.test(defaultExpression[2]!)) {
    push({
      offset: defaultExpression.index,
      removed: defaultExpression[1]!,
      inserted: `const ${INNER_MIDDLEWARE_IDENTIFIER} = `,
      innerIdentifier: INNER_MIDDLEWARE_IDENTIFIER
    })
  }
  return candidates
}

function countMatches(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length
}

/**
 * Where the fenced import goes: after any leading comment/blank lines (so `// @ts-nocheck` and
 * license banners stay first), before the first line of code. Imports hoist, so position is
 * otherwise irrelevant.
 */
export function importInsertionOffset(source: string): number {
  let offset = 0
  let inBlockComment = false
  for (const line of source.split(/(?<=\n)/)) {
    const trimmed = line.trim()
    if (inBlockComment) {
      offset += line.length
      if (trimmed.includes("*/")) inBlockComment = false
      continue
    }
    if (trimmed.length === 0 || trimmed.startsWith("//")) {
      offset += line.length
      continue
    }
    if (trimmed.startsWith("/*")) {
      offset += line.length
      if (!trimmed.includes("*/", 2)) inBlockComment = true
      continue
    }
    break
  }
  return offset
}

export type MatcherVerdict = "ok" | "narrow" | "unreadable"

/**
 * Reads `export const config = { matcher: … }` when present. Only string literals are understood;
 * anything else is "unreadable". A matcher is broad enough when at least one entry is a document
 * catch-all: a negative-lookahead group (`/((?!…).*)`), `/(.*)`, or `/:path*`.
 */
export function inspectConfigMatcher(source: string): MatcherVerdict {
  if (!CONFIG_EXPORT.test(source)) return "ok"
  const matcherIndex = source.search(/\bmatcher\s*:/)
  if (matcherIndex === -1) return "ok"
  const afterColon = source.indexOf(":", matcherIndex) + 1
  const rest = source.slice(afterColon).replace(/^\s+/, "")
  const entries = readStringLiterals(rest)
  if (entries === null) return "unreadable"
  return entries.some(isBroadMatcherEntry) ? "ok" : "narrow"
}

export function isBroadMatcherEntry(entry: string): boolean {
  return (
    entry.startsWith("/((?!") ||
    entry === "/(.*)" ||
    entry === "/:path*" ||
    entry === "/:path+" ||
    entry === "/(.*)*"
  )
}

/** A single string literal, or an array of string literals (whitespace, comments, trailing commas OK). */
function readStringLiterals(text: string): string[] | null {
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
    const single = readStringLiteral(text, 0)
    return single ? [single.value] : null
  }
  if (!text.startsWith("[")) return null
  const values: string[] = []
  let index = 1
  for (;;) {
    index = skipWhitespaceAndComments(text, index)
    if (text[index] === "]") return values
    if (index >= text.length) return null
    const literal = readStringLiteral(text, index)
    if (!literal) return null
    values.push(literal.value)
    index = skipWhitespaceAndComments(text, literal.end)
    if (text[index] === ",") {
      index += 1
      continue
    }
    if (text[index] === "]") return values
    return null
  }
}

function skipWhitespaceAndComments(text: string, start: number): number {
  let index = start
  for (;;) {
    while (index < text.length && /\s/.test(text[index]!)) index += 1
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index)
      if (newline === -1) return text.length
      index = newline + 1
      continue
    }
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2)
      if (close === -1) return text.length
      index = close + 2
      continue
    }
    return index
  }
}

function readStringLiteral(text: string, start: number): { value: string; end: number } | null {
  const quote = text[start]
  if (quote !== '"' && quote !== "'" && quote !== "`") return null
  let value = ""
  let index = start + 1
  while (index < text.length) {
    const char = text[index]!
    if (char === "\\") {
      const next = text[index + 1]
      if (next === undefined) return null
      value += next
      index += 2
      continue
    }
    if (char === quote) return { value, end: index + 1 }
    if (quote === "`" && char === "$" && text[index + 1] === "{") return null
    value += char
    index += 1
  }
  return null
}
