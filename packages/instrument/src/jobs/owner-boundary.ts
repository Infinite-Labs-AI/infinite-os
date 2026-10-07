/** Customer-owned policy is outside every installer, worker, reviewer and check. */
export const OWNER_BOUNDARY = "Consent and your privacy policy are yours; this run changed neither."
export const CONSENT_LEFT_FOR_YOU = "Left for you: this file’s consent code is in the way."
export const OWNER_BOUNDARY_INSTRUCTION = "Consent, cookie banners, CMP code, privacy policies and terms pages belong to the site owner. Do not edit, move, wrap, reindent, evaluate, grade or comment on them. If a task cannot be completed without touching them, skip it with: left for you: this file’s consent code is in the way. No exceptions for preview guards or formatting."

/** Conservative path boundary, shared by planning, allowlists and the post-turn fence. */
export function isPolicyPath(path: string): boolean {
  return /(?:^|\/)(?:privacy(?:[-_]?(?:policy|notice))?|terms(?:[-_]?(?:of[-_]?(?:service|use)|conditions))?|cookie[-_]?(?:policy|notice))(?:\.[^/]+|\/|$)/i.test(path.replaceAll("\\", "/"))
}

/** Review prose about this owner-only domain is omitted, never turned into a fix or approval ask. */
export function isOwnerOnlyFinding(input: { item?: string | null; path?: string | null; body: string; suggestedFix?: string | null; suggested_fix?: string | null }): boolean {
  return input.item === "R6" || isPolicyPath(input.path ?? "") || /\bconsent\b|cookie[ -]banner|\bCMP\b|\b(?:OneTrust|Optanon|Cookiebot|CookieConsent|Didomi|UC_UI|usercentrics|klaro|__tcfapi|__uspapi|__gpp|__cmp)\b|privacy[ -](?:policy|notice|page|paragraph|text)|terms[ -](?:of[ -](?:service|use)|page|conditions)/i.test(`${input.body} ${input.suggestedFix ?? input.suggested_fix ?? ""}`)
}

/** Historical wizard work is not erased by retiring a job on a continuation. */
export const LEGACY_OWNER_BOUNDARY = "Consent and your privacy policy are yours. An earlier version of this run recorded policy edits; this continuation left them alone."

/** Read only job/receipt provenance, never policy bytes or the receipt's embedded text edits. */
export function hasRecordedPolicyEdits(jobs: readonly { jobId: string; edits?: readonly unknown[] }[], receipt?: unknown, runId?: string): boolean {
  const policyJob = (jobId: unknown) => typeof jobId === "string" && jobId.split(":")[0] === "privacy_paragraph"
  if (jobs.some(job => policyJob(job.jobId) && (job.edits?.length ?? 0) > 0)) return true
  const edits = receipt && typeof receipt === "object" ? (receipt as { edits?: unknown }).edits : null
  return !!runId && Array.isArray(edits) && edits.some(edit => edit && typeof edit === "object" && edit.runId === runId && policyJob(edit.jobId))
}

/** Every report/PR path uses the same sentence; legacy evidence wins over an old blanket assertion. */
export function withOwnerBoundary(text: string, priorPolicyEdits = false): string {
  const legacy = priorPolicyEdits || text.includes(LEGACY_OWNER_BOUNDARY)
  const statement = legacy ? LEGACY_OWNER_BOUNDARY : OWNER_BOUNDARY
  let result = legacy ? text.replaceAll(OWNER_BOUNDARY, LEGACY_OWNER_BOUNDARY) : text
  let seen = false
  result = result.replaceAll(statement, () => { if (seen) return ""; seen = true; return statement }).trim()
  return seen ? result : [result, statement].filter(Boolean).join("\n\n")
}
