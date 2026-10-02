// Job 12 (`csp`) owner detector (lane O8): WHO sets the Content-Security-Policy, and in which style.
// The job is seeded only when a CSP actually blocks the needed hosts (the T1 `csp` check or the dry
// load's `csp.violations`); this detector names the one file the agent may edit.
//
// Style decides whether an agent may do it at all: a host-list policy can gain exactly the needed
// hosts per directive; a nonce or `strict-dynamic` policy cannot be fixed by adding hosts, so that
// item is `blocked:needs_you`.
import type { RepoSnapshot } from "../repo-files.js"
import { isCodeFile, isHtmlFile, isNonProductPath, sortFindings, textMatches, type Finding } from "./shared.js"

export type CspOwnerKind = "next_config" | "vercel_json" | "middleware" | "html_meta" | "helmet" | "headers_file" | "netlify_toml" | "server_code"
export type CspStyle = "hosts" | "nonce" | "strict_dynamic"

export interface CspOwnerFinding extends Finding {
  owner: CspOwnerKind
  style: CspStyle
}

function ownerOf(path: string, text: string, appRoot: string): CspOwnerKind {
  const relative = appRoot === "." ? path : path.startsWith(`${appRoot}/`) ? path.slice(appRoot.length + 1) : path
  if (/(?:^|\/)next\.config\.[cm]?[jt]s$/.test(relative)) return "next_config"
  if (/(?:^|\/)vercel\.json$/.test(relative)) return "vercel_json"
  if (/(?:^|\/)netlify\.toml$/.test(relative)) return "netlify_toml"
  if (/(?:^|\/)_headers$/.test(relative)) return "headers_file"
  if (/^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/.test(relative)) return "middleware"
  if (isHtmlFile(path)) return "html_meta"
  if (/\bhelmet\s*\(/.test(text)) return "helmet"
  return "server_code"
}

function styleOf(text: string): CspStyle {
  if (/strict-dynamic/.test(text)) return "strict_dynamic"
  if (/['"`]nonce-|\bnonce-\$\{|\bnonce\b\s*[:=]/.test(text)) return "nonce"
  return "hosts"
}

const CSP_HEADER = /Content-Security-Policy(?!-Report-Only)|contentSecurityPolicy\s*:/gi

/** Pure: every file that sets a CSP (report-only policies block nothing and are ignored). */
export function detectCspOwners(snapshot: RepoSnapshot): CspOwnerFinding[] {
  const findings: CspOwnerFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path)) continue
    const isConfig = /(?:^|\/)(?:vercel\.json|netlify\.toml|_headers)$/.test(path)
    if (!isConfig && !isCodeFile(path) && !isHtmlFile(path)) continue
    const match = textMatches(text, new RegExp(CSP_HEADER.source, "gi"))[0]
    if (!match) continue
    findings.push({ file: path, line: match.line, detail: "sets Content-Security-Policy", owner: ownerOf(path, text, snapshot.appRoot), style: styleOf(text) })
  }
  return sortFindings(findings)
}
