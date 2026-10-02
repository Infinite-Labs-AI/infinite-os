// Port-plan row 7 detector (lane O8): ADOPTED host-only `_fbc` writers.
//
// infinite.fast `meta-click-id.mjs` rule 3 (ported in `providers/meta-browser/click-id.ts`): fbevents
// reads the FIRST-listed `_fbc` and re-saves it into its own Domain cookie, so an older copy on a
// narrower scope (host-only, or `www` beside the apex) shadows every new click and a newest-first
// reader cannot rescue the visitor. A hand-written capture that writes `_fbc` WITHOUT a `Domain`
// attribute is such a writer; the plan offers "retire it" (`retire_fbc_writer`, never under `--yes`).
//
// The wizard's own managed capture (a "Managed by Infinite" file or the managed HTML block) is never a
// finding. Tag-manager templates live outside the repo: retiring one is a user line, not an agent job.
import { MANAGED_HTML_END, MANAGED_HTML_START } from "../../frameworks/managed-html.js"
import { isManagedInfiniteFile } from "../../frameworks/managed-files.js"
import type { RepoSnapshot } from "../repo-files.js"
import { isCodeFile, isHtmlFile, isNonProductPath, sortFindings, textMatches, type Finding } from "./shared.js"

export interface FbcWriterFinding extends Finding {
  via: "document_cookie" | "cookie_library" | "server_set_cookie"
  /** No `Domain` attribute on the write: a host-only cookie (the shadowing kind). */
  hostOnly: boolean
}

const WRITERS: Array<{ via: FbcWriterFinding["via"]; pattern: RegExp }> = [
  { via: "document_cookie", pattern: /document\s*\.\s*cookie\s*=\s*[^;\n]*_fbc=[^\n]*/g },
  { via: "cookie_library", pattern: /\b(?:Cookies|cookie|jsCookie|cookieStore)\s*\.\s*set\s*\(\s*["'`]_fbc["'`][^\n]*/g },
  { via: "server_set_cookie", pattern: /(?:\bcookies\s*\(\s*\)\s*\.\s*set|\bres\s*\.\s*cookie|\bsetCookie|\bserialize)\s*\(\s*["'`]_fbc["'`][^\n]*/g }
]

function managedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let from = 0
  for (;;) {
    const start = text.indexOf(MANAGED_HTML_START, from)
    if (start < 0) break
    const end = text.indexOf(MANAGED_HTML_END, start)
    if (end < 0) break
    ranges.push([start, end + MANAGED_HTML_END.length])
    from = end + 1
  }
  return ranges
}

/** Pure. Only `hostOnly` findings are retire candidates; the rest are listed for the brief. */
export function detectFbcWriters(snapshot: RepoSnapshot): FbcWriterFinding[] {
  const findings: FbcWriterFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !(isCodeFile(path) || isHtmlFile(path))) continue
    if (isManagedInfiniteFile(text) || !text.includes("_fbc")) continue
    const managed = managedRanges(text)
    for (const { via, pattern } of WRITERS) {
      for (const match of textMatches(text, new RegExp(pattern.source, "g"))) {
        if (managed.some(([start, end]) => match.index >= start && match.index < end)) continue
        const statement = match.match[0]
        const hostOnly = !/domain\s*[=:]/i.test(statement)
        findings.push({ file: path, line: match.line, detail: `_fbc write via ${via}`, via, hostOnly })
      }
    }
  }
  return sortFindings(findings)
}
