import { createScanner } from "./scan.js"
import { isPolicyPath } from "../jobs/owner-boundary.js"

const scopeScanner = createScanner({ literals: [], allowedIds: [] })

/** The category is reviewer input, never authority to discard a security finding. */
export interface FindingScope {
  category?: string
  item?: string | null
  severity?: string
  path?: string | null
  body?: string
  suggestedFix?: string | null
  suggested_fix?: string | null
}

/** Text can only KEEP a finding open here; it can never authorise closing one. */
export function protectedFinding(finding: FindingScope): boolean {
  if (finding.severity === "blocker" || finding.category === "security" || finding.item === "R7" || finding.item === "R8") return true
  const text = `${finding.body ?? ""}\n${finding.suggestedFix ?? finding.suggested_fix ?? ""}`
  return scopeScanner.redact(text).hits.length > 0 || /\b(?:security|secrets?|credentials?|PII|unhashed|emails?|phones?|passwords?|vulnerabilit\w*|XSS|CSRF)\b|\b(?:personal|sensitive|private)\s+(?:data|information)\b|\b(?:private|API|server|access)\s*[-_ ]?(?:keys?|tokens?)\b|\b(?:SQL|code)\s+injection\b|\[redacted:/i.test(text)
}

function ownerFileNamed(text: string): boolean {
  const paths = text.match(/(?:[\w@().-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|html?|mdx?|astro|vue|svelte|liquid|njk|hbs)\b/g) ?? []
  return paths.some(path => isPolicyPath(path) || /(?:^|\/)[^/]*(?:consent|cookie[-_]?banner|cmp)[^/]*\.[^/]+$/i.test(path))
}

/** A missing location is in scope unless the prose names an owner consent/policy file. */
export function ownerInformationOnly(finding: FindingScope): boolean {
  if (finding.category !== "owner_consent_privacy" || protectedFinding(finding)) return false
  const path = finding.path
  if (path?.trim() && !/^(?:[~/]|[A-Za-z]:)|[\\\u0000-\u001f]|(?:^|\/)\.\.?(?:\/|$)/.test(path)) return true
  return ownerFileNamed(`${finding.body ?? ""}\n${finding.suggestedFix ?? finding.suggested_fix ?? ""}`)
}

/** More than one quarter outside the requested review scope invalidates an approving review. */
export function reviewReliabilityWarning(findings: readonly FindingScope[]): string | null {
  const count = findings.filter(finding => finding.category === "owner_consent_privacy").length
  return count > findings.length / 4
    ? `review unreliable: ${count} of ${findings.length} findings were labelled owner consent/privacy (more than 25%); an independent review is needed`
    : null
}
