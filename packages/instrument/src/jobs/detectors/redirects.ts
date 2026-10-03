// Job 13 (`redirect_utms`) owner detector (lane O8): who redirects, and whether a redirect sits in
// front of a COUNTED path.
//
// Two ways a redirect loses attribution:
// - it drops the query (UTMs, `fbclid`, `gclid`) on a hop: seen live by the T1 redirect walk (O9);
//   statically, a middleware redirect built as `new URL("/x", request.url)` with no `.search` copy is a
//   hint for the brief;
// - it runs BEFORE the server lane: `vercel.json` / `_redirects` redirects answer at the edge, so the
//   middleware lane never sees the document request. A host-level redirect whose source is a
//   conversion route or a middleware-matcher path hides that path from the lane (`coversCountedPath`).
import type { RepoSnapshot } from "../repo-files.js"
import { codeMatches, isCodeFile, isNonProductPath, sortFindings, type Finding } from "./shared.js"

export type RedirectOwner = "vercel_json" | "next_config" | "middleware" | "netlify"

export interface RedirectFinding extends Finding {
  owner: RedirectOwner
  source: string | null
  destination: string | null
  /** A host-level redirect whose source is a conversion route or a matcher path. */
  coversCountedPath: boolean
  /** Static hint only: a middleware redirect that never copies the query. */
  mayDropQuery: boolean
}

function lineOf(text: string, needle: string, from = 0): number {
  const index = text.indexOf(needle, from)
  if (index < 0) return 1
  return text.slice(0, index).split("\n").length
}

/** Converts a Vercel/Next path pattern (`/blog/:slug*`, `/(.*)`) to a RegExp over a pathname. */
export function pathPatternToRegExp(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index]!
    if (ch === ":") {
      const name = /^:[A-Za-z_][A-Za-z0-9_]*([*+?])?/.exec(pattern.slice(index))
      if (name) {
        source += name[1] === "*" || name[1] === "+" ? ".*" : "[^/]+"
        index += name[0].length - 1
        continue
      }
    }
    if (ch === "(") {
      const close = pattern.indexOf(")", index)
      if (close > index) {
        source += `(?:${pattern.slice(index + 1, close)})`
        index = close
        continue
      }
    }
    source += /[.+^${}|[\]\\]/.test(ch) ? `\\${ch}` : ch === "*" ? ".*" : ch
  }
  return new RegExp(`^${source}$`)
}

/** The middleware `config.matcher` literals (string or array of strings). */
export function middlewareMatchers(snapshot: RepoSnapshot): string[] {
  const out: string[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !/(?:^|\/)(?:middleware|proxy)\.[cm]?[jt]s$/.test(path)) continue
    const matcher = /matcher\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/.exec(text)
    if (!matcher) continue
    for (const literal of matcher[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)) out.push(literal[1]!)
  }
  return [...new Set(out)].sort()
}

function covers(source: string, countedPaths: readonly string[], matchers: readonly string[]): boolean {
  let sourcePattern: RegExp
  try {
    sourcePattern = pathPatternToRegExp(source)
  } catch {
    return false
  }
  if (countedPaths.some((path) => sourcePattern.test(path))) return true
  // A literal source a matcher also covers.
  const literalSource = /^\/[A-Za-z0-9/_-]*$/.test(source) ? source : null
  if (literalSource === null) return false
  return matchers.some((matcher) => {
    try {
      return pathPatternToRegExp(matcher).test(literalSource)
    } catch {
      return false
    }
  })
}

/**
 * Pure. `countedPaths` = the conversion route paths (from the outcome detector); matchers are read from
 * the repo's middleware.
 */
export function detectRedirects(snapshot: RepoSnapshot, countedPaths: readonly string[]): RedirectFinding[] {
  const findings: RedirectFinding[] = []
  const matchers = middlewareMatchers(snapshot)
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path)) continue
    if (/(?:^|\/)vercel\.json$/.test(path)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      const redirects = (parsed as { redirects?: unknown }).redirects
      if (!Array.isArray(redirects)) continue
      let cursor = 0
      for (const entry of redirects) {
        if (typeof entry !== "object" || entry === null) continue
        const source = typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : null
        const destination = typeof (entry as { destination?: unknown }).destination === "string" ? (entry as { destination: string }).destination : null
        const line = source ? lineOf(text, JSON.stringify(source), cursor) : 1
        if (source) cursor = Math.max(cursor, text.indexOf(JSON.stringify(source), cursor) + 1)
        findings.push({
          file: path,
          line,
          detail: "vercel.json redirect",
          owner: "vercel_json",
          source,
          destination,
          coversCountedPath: source !== null && covers(source, countedPaths, matchers),
          mayDropQuery: false
        })
      }
      continue
    }
    if (/(?:^|\/)_redirects$/.test(path)) {
      text.split("\n").forEach((raw, index) => {
        const line = raw.trim()
        if (line === "" || line.startsWith("#")) return
        const [source, destination] = line.split(/\s+/)
        if (!source || !destination) return
        findings.push({
          file: path,
          line: index + 1,
          detail: "Netlify redirect",
          owner: "netlify",
          source,
          destination,
          coversCountedPath: covers(source, countedPaths, matchers),
          mayDropQuery: false
        })
      })
      continue
    }
    if (!isCodeFile(path)) continue
    if (/(?:^|\/)next\.config\.[cm]?[jt]s$/.test(path)) {
      const fn = codeMatches(text, /\b(?:async\s+)?redirects\s*\(\s*\)/g)[0]
      if (fn) findings.push({ file: path, line: fn.line, detail: "next.config redirects()", owner: "next_config", source: null, destination: null, coversCountedPath: false, mayDropQuery: false })
      continue
    }
    if (/(?:^|\/)(?:middleware|proxy)\.[cm]?[jt]s$/.test(path)) {
      const redirect = codeMatches(text, /\bNextResponse\s*\.\s*redirect\s*\(|\bResponse\s*\.\s*redirect\s*\(/g)[0]
      if (redirect) {
        const copiesQuery = /\.search\b|searchParams/.test(text)
        findings.push({ file: path, line: redirect.line, detail: "middleware redirect", owner: "middleware", source: null, destination: null, coversCountedPath: false, mayDropQuery: !copiesQuery })
      }
    }
  }
  return sortFindings(findings)
}
