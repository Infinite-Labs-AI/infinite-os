// Helpers every job detector shares (lane O8). Detectors are pure functions of a RepoSnapshot: they
// read text, never the disk, and every finding names a repo-relative `file` and a 1-based `line`.
//
// Two rules keep them honest:
// - comments and string literals never count as code (`maskCommentsAndStrings`, the installer's own
//   masker), so `// call signOut() here` or an example in a string is not a handler;
// - test, story, mock, fixture and e2e files are never evidence (`isNonProductPath`), so a `signOut`
//   in a test file is ignored.
import { maskCommentsAndStrings } from "../../frameworks/shared.js"
import { lineNumberAt } from "../../harness/scan.js"
import type { RepoSnapshot } from "../repo-files.js"

export interface Finding {
  file: string
  line: number
  /** A short structural label of what matched (never surrounding code or a value). */
  detail: string
}

const NON_PRODUCT_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|__mocks__|__fixtures__|fixtures|e2e|cypress|playwright|specs?|stories|\.storybook|mocks?)\//i
const NON_PRODUCT_FILE = /(?:^|\/)(?:test[-_.][^/]*|[^/]*\.(?:test|spec|stories|story|cy|e2e)\.[cm]?[jt]sx?|[^/]*\.d\.ts|[^/]*\.min\.[cm]?js)$/i

/** Tests, stories, mocks, fixtures, e2e suites, type declarations and minified bundles: never evidence. */
export function isNonProductPath(path: string): boolean {
  return NON_PRODUCT_DIRECTORY.test(path) || NON_PRODUCT_FILE.test(path)
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/i
const HTML_FILE = /\.html?$/i

export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path)
}

export function isHtmlFile(path: string): boolean {
  return HTML_FILE.test(path)
}

/** The product source files of a snapshot (code + HTML), in path order. */
export function productSourceFiles(snapshot: RepoSnapshot): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path)) continue
    if (isCodeFile(path) || isHtmlFile(path)) out.push([path, text])
  }
  return out
}

/**
 * The code view of a file: comments blanked (offsets kept). With `blankStrings` string contents are
 * blanked too, so a pattern matched there is a real call, not text. HTML files keep only their
 * `<script>` bodies' code semantics approximately: the masker treats the markup as code, which is
 * fine for call-site patterns (`gtag(`, `fbq(`).
 */
export function codeView(text: string, blankStrings: boolean): string {
  return maskCommentsAndStrings(text, blankStrings)
}

/**
 * Matches `pattern` (global) against the comment-masked text, then confirms the call prefix is code in
 * the string-masked text, so an example inside a string never matches. Returns 1-based lines.
 */
export function codeMatches(text: string, pattern: RegExp): Array<{ line: number; index: number; match: RegExpMatchArray }> {
  if (!pattern.global) throw new Error("codeMatches needs a global pattern")
  const commentsMasked = codeView(text, false)
  const stringsMasked = codeView(text, true)
  const out: Array<{ line: number; index: number; match: RegExpMatchArray }> = []
  for (const match of commentsMasked.matchAll(pattern)) {
    const index = match.index ?? 0
    // The callable prefix (up to the first `(`) must read the same with strings blanked: an example
    // stored in a string literal is blanked there and never matches (the provider-evidence rule).
    const paren = match[0].indexOf("(")
    const prefix = paren > 0 ? match[0].slice(0, paren) : match[0]
    if (stringsMasked.slice(index, index + prefix.length) !== prefix) continue
    out.push({ line: lineNumberAt(text, index), index, match })
  }
  return out
}

/** Matches `pattern` (global) against the comment-masked text, strings kept (for quoted keys like `'_fbc='`). */
export function textMatches(text: string, pattern: RegExp): Array<{ line: number; index: number; match: RegExpMatchArray }> {
  if (!pattern.global) throw new Error("textMatches needs a global pattern")
  const commentsMasked = codeView(text, false)
  return [...commentsMasked.matchAll(pattern)].map((match) => ({ line: lineNumberAt(text, match.index ?? 0), index: match.index ?? 0, match }))
}

/** Sorted, de-duplicated findings (by file, line, detail). */
export function sortFindings<T extends { file: string; line: number; detail?: string }>(findings: T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const finding of findings) {
    const key = `${finding.file}\u0000${finding.line}\u0000${finding.detail ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(finding)
  }
  return unique.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || ((a.detail ?? "") < (b.detail ?? "") ? -1 : 1)))
}

/**
 * The route path a Next.js / file-routed file serves, when it is a page or route handler, else null.
 * `app/(marketing)/pricing/page.tsx` → `/pricing`; `pages/api/download.ts` → `/api/download`;
 * `app/api/signup/route.ts` → `/api/signup`. Dynamic segments stay as written (`/blog/[slug]`).
 */
export function routePathOf(path: string, appRoot: string): string | null {
  const relative = appRoot === "." || appRoot === "" ? path : path.startsWith(`${appRoot}/`) ? path.slice(appRoot.length + 1) : null
  if (relative === null) return null
  const withoutSrc = relative.startsWith("src/") ? relative.slice(4) : relative
  const appMatch = /^app\/(.*?)(?:^|\/)?(page|route)\.(?:[cm]?[jt]sx?|mdx?)$/.exec(withoutSrc)
  if (appMatch) {
    const segments = appMatch[1]!
      .split("/")
      .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
    return `/${segments.join("/")}`
  }
  const pagesMatch = /^pages\/(.*)\.(?:[cm]?[jt]sx?|mdx?)$/.exec(withoutSrc)
  if (pagesMatch) {
    const route = pagesMatch[1]!
    if (/^_(?:app|document|error)$/.test(route) || /(?:^|\/)_/.test(route)) return null
    const trimmed = route.replace(/(?:^|\/)index$/, "")
    return `/${trimmed}`
  }
  const htmlMatch = /^(?:public\/)?(.*)\.html?$/.exec(withoutSrc)
  if (htmlMatch) {
    const trimmed = htmlMatch[1]!.replace(/(?:^|\/)index$/, "")
    return `/${trimmed}`
  }
  return null
}
