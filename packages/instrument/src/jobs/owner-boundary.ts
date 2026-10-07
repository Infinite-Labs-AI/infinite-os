import { routePathOf } from "./detectors/shared.js"
/** Customer-owned policy is outside every installer, worker, reviewer and check. */
const OLD_FINAL_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against the final diff)."
export const OWNER_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against this run’s recorded commits)."
export const OWNER_BOUNDARY_UNMEASURED = "Your consent code and privacy policy are yours; the final diff has not been checked."
const OLD_OWNER_BOUNDARY = "Consent and your privacy policy are yours; this run changed neither."
export const CONSENT_LEFT_FOR_YOU = "Left for you: this file’s consent code is in the way."
export const OWNER_BOUNDARY_INSTRUCTION = "Consent, cookie banners, CMP code, privacy policies and terms pages belong to the site owner. Do not edit, move, wrap, reindent, evaluate, grade or comment on them. If a task cannot be completed without touching them, skip it with: left for you: this file’s consent code is in the way. No exceptions for preview guards or formatting."

/** Policy routes and source/content names are protected; only explicit non-policy code is exempt. */
export function isPolicyPath(path: string, appRoot = "."): boolean {
  const normalized = path.replaceAll("\\", "/")
  if (/(?:^|\/)api(?:\/|$)|(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:^|\/)search\/terms\.[^/]+$|\.(?:test|spec)\.[^/]+$/i.test(normalized)) return false
  const words = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const vocabulary = new Set(["privacy", "terms", "tos", "cookie", "cookies", "legal", "gdpr", "ccpa", "dpa", "imprint", "impressum"])
  if (words(normalized).some(word => vocabulary.has(word))) return true
  const roots = [appRoot]
  const workspace = /^(?:apps|packages)\/[^/]+/.exec(normalized)?.[0]
  if (workspace && appRoot === ".") roots.push(workspace)
  const route = roots.map(root => routePathOf(normalized, root)).find(value => value !== null)
  return route !== undefined && route !== null && words(route).some(word => vocabulary.has(word))
}

/** Only the reviewer’s structured category labels owner choices; prose and paths never establish scope. */
export function isOwnerOnlyFinding(input: { category?: string; item?: string | null; path?: string | null; body?: string; suggestedFix?: string | null; suggested_fix?: string | null }): boolean {
  return input.category === "owner_consent_privacy"
}

/** Historical wizard work is not erased by retiring a job on a continuation. */
export const LEGACY_OWNER_BOUNDARY = "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits."
const OLD_LEGACY_OWNER_BOUNDARY = "Consent and your privacy policy are yours. An earlier version of this run recorded policy edits; this continuation left them alone."

/** Read only job/receipt provenance, never policy bytes or the receipt's embedded text edits. */
export function hasRecordedPolicyEdits(jobs: readonly { jobId: string; edits?: readonly unknown[] }[], receipt?: unknown, runId?: string): boolean {
  const policyJob = (jobId: unknown) => typeof jobId === "string" && jobId.split(":")[0] === "privacy_paragraph"
  if (jobs.some(job => policyJob(job.jobId) && (job.edits?.length ?? 0) > 0)) return true
  const edits = receipt && typeof receipt === "object" ? (receipt as { edits?: unknown }).edits : null
  return !!runId && Array.isArray(edits) && edits.some(edit => edit && typeof edit === "object" && edit.runId === runId && policyJob(edit.jobId))
}

/** Every report/PR path uses the same sentence; legacy evidence wins over an old blanket assertion. */
export function withOwnerBoundary(text: string, priorPolicyEdits = false, measurement?: { state: "checked" | "changed" | "not_checked" }): string {
  const legacy = priorPolicyEdits || text.split(/\r?\n/).some(line => hasLegacyOwnerHistory([line]))
  const measured = measurement?.state === "checked"
  const legacyStatement = "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; " + (measured ? "the wizard’s recorded commits leave the owner’s code unchanged." : "their final diff has not been checked.")
  const statement = legacy ? legacyStatement : measured ? OWNER_BOUNDARY : OWNER_BOUNDARY_UNMEASURED
  let result = text
  for (const old of [OLD_FINAL_BOUNDARY, OLD_OWNER_BOUNDARY, OWNER_BOUNDARY, OWNER_BOUNDARY_UNMEASURED, OLD_LEGACY_OWNER_BOUNDARY, LEGACY_OWNER_BOUNDARY,
    "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; the owner's code is unchanged in the checked final diff.",
    "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; their final diff has not been checked.",
    "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; the wizard’s recorded commits leave the owner’s code unchanged."]) result = result.replaceAll(old, statement)
  let seen = false
  result = result.replaceAll(statement, () => { if (seen) return ""; seen = true; return statement }).trim()
  return seen ? result : [result, statement].filter(Boolean).join("\n\n")
}

export function frozenJobNote(item: { id: string; jobId: string; title: string }, place: { file: string; line: number }): string {
  const tool = item.jobId === "preview_guard" ? ({ ga4: "GA4", meta: "Meta pixel", posthog: "PostHog" }[item.id.split(":")[1]!] ?? item.title) : item.title
  const location = `${place.file}:${place.line}`
  return item.jobId === "preview_guard"
    ? `Not changed by us: ${tool}'s start-up code at ${location} also handles consent, which is yours. Until you add the guard there, preview and local visits keep counting in ${tool}.`
    : `Not changed by us: ${tool} at ${location} reaches code that handles consent, which is yours.`
}

export function ownerGuardHandoff(note: string, location: { file?: string; line?: number }, expression: string, source?: string): { text: string; guard: string } {
  const lines = source?.split(/\r?\n/)
  const at = (location.line ?? 1) - 1
  const original = lines?.[at]
  const init = original && /^(\s*)((?:(?:window|globalThis)\.)?(?:gtag\(\s*['"]config['"]|fbq\(\s*['"]init['"]|posthog\.init\())/.exec(original)
  // A single-statement if guards exactly this existing call, including its multiline arguments.
  // It never wraps the enclosing function or adjacent consent statements.
  const guard = init ? `--- a/${location.file}\n+++ b/${location.file}\n@@ -${at + 1},1 +${at + 1},1 @@\n-${original}\n+${init[1]}if (${expression}) ${original!.slice(init[1]!.length)}` : `if (${expression})`
  return { guard, text: `${note}\n\n${init ? "Owner-only diff for the named initialization statement; adjacent consent statements stay outside the condition." : "The exact initialization statement could not be located. The owner must choose placement for this condition; this is not an apply-ready edit."}\n\n\`\`\`${init ? "diff" : "js"}\n${guard}\n\`\`\`` }
}

/** Recognize only our standalone status sentences, not words inside reviewer findings. */
export function isOwnerBoundaryStatement(note: string): boolean {
  return [OLD_FINAL_BOUNDARY, OLD_OWNER_BOUNDARY, OWNER_BOUNDARY, OWNER_BOUNDARY_UNMEASURED, OLD_LEGACY_OWNER_BOUNDARY, LEGACY_OWNER_BOUNDARY].includes(note.trim()) || note.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;")
}
export function hasLegacyOwnerHistory(notes: readonly string[]): boolean {
  return notes.some(note => note === OLD_LEGACY_OWNER_BOUNDARY || note === LEGACY_OWNER_BOUNDARY || note.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;"))
}
