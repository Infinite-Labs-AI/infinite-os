export { isPolicyPath, policyContentPaths, isPolicySourceFile } from "./policy-pages.js"
import { safeDisplayText } from "../review/display.js"
import { createScanner, type Scanner } from "../review/scan.js"
import type { OwnerBoundaryMeasurement } from "./owner-diff.js"
/** Customer-owned policy is outside every installer, worker, reviewer and check. */
const OLD_FINAL_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against the final diff)."
const OLD_RECORDED_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against this run’s recorded commits)."
export const OWNER_BOUNDARY = "This run did not edit your privacy or terms pages, or any code where it recognised a consent call (checked against the commits it made). Consent and privacy are yours: please review the files this run changed."
const OLD_UNMEASURED = "Your consent code and privacy policy are yours; the final diff has not been checked."
export const OWNER_BOUNDARY_UNMEASURED = "This run could not check its own commits against your consent code and policy pages (no wizard commits were measured); please review the changed files."
const OLD_OWNER_BOUNDARY = "Consent and your privacy policy are yours; this run changed neither."
export const CONSENT_LEFT_FOR_YOU = "Left for you: this file’s consent code is in the way."
export const OWNER_BOUNDARY_INSTRUCTION = "Consent, cookie banners, CMP code, privacy policies and terms pages belong to the site owner. Do not edit, move, wrap, reindent, evaluate, grade or comment on them. If a task cannot be completed without touching them, skip it with: left for you: this file’s consent code is in the way. No exceptions for preview guards or formatting."

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

/** The claim requires a positive, complete measurement of the run's recorded commits. */
export function hasMeasuredOwnerBoundary(measurement?: Partial<OwnerBoundaryMeasurement>): boolean {
  return measurement?.state === "checked" && measurement.scope === "commit" && !measurement.unverifiedReason &&
    (measurement.measuredCommitCount ?? 0) > 0 && measurement.measuredCommitCount === measurement.wizardCommits?.length &&
    measurement.issues?.length === 0
}

const previousStatements = [OLD_FINAL_BOUNDARY, OLD_RECORDED_BOUNDARY, OLD_OWNER_BOUNDARY, OLD_UNMEASURED, OLD_LEGACY_OWNER_BOUNDARY, LEGACY_OWNER_BOUNDARY,
  "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; the owner's code is unchanged in the checked final diff.",
  "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; their final diff has not been checked.",
  "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; the wizard’s recorded commits leave the owner’s code unchanged."]

/** Every surface keeps an explicit reason when history is unverified and shows bounded display paths. */
export function withOwnerBoundary(text: string, priorPolicyEdits = false, measurement?: Partial<OwnerBoundaryMeasurement>, scanner: Scanner = createScanner({ literals: [], allowedIds: [] })): string {
  const legacy = priorPolicyEdits || text.split(/\r?\n/).some(line => hasLegacyOwnerHistory([line]))
  const measured = !legacy && hasMeasuredOwnerBoundary(measurement)
  const reason = legacy ? "an earlier version of this run recorded policy edits" : measurement?.unverifiedReason ??
    (measurement?.issues?.length ? measurement.issues.map(issue => issue.reason).join("; ") : "no wizard commits were measured")
  const statement = measured ? OWNER_BOUNDARY : `This run could not check its own commits against your consent code and policy pages (${safeDisplayText(scanner, reason).replace(/[\r\n]/g, " ").slice(0, 500)}); please review the changed files.`
  const files = [...new Set(measurement?.files ?? [])]
  const listed = files.slice(0, 20).map(file => `- ${safeDisplayText(scanner, file).replace(/[\r\n\t]/g, " ").replace(/`/g, "'").slice(0, 240)}`)
  const changed = files.length ? [`Changed files${measurement?.fileScope === "branch_history" ? " (branch history; ownership unverified)" : ""}:`, ...listed,
    ...(files.length > listed.length ? [`- … ${files.length - listed.length} more changed files; review the complete Git diff.`] : [])].join("\n")
    : measurement ? "Changed files: none found in the available diff." : "Changed files: unavailable from the saved run."
  // Re-render saved reports by replacing our exact old/new status paragraphs, including their list.
  let result = text
  for (const old of previousStatements) result = result.replaceAll(old, "")
  result = result.split(/\n\s*\n/).filter(block => !isOwnerBoundaryStatement(block) && !/^Changed files(?: \(branch history; ownership unverified\))?:/.test(block.trim())).join("\n\n").trim()
  return [result, statement, changed].filter(Boolean).join("\n\n")
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
  const previous = lines?.slice(0, at).filter(line => line.trim()).at(-1)?.trim()
  // Only emit a diff for an isolated call with literal/simple
  // arguments. An unbraced branch or a compound expression needs owner placement.
  const boundary = previous === undefined || (!/^(?:\/\/|\/\*|\*)/.test(previous) && /[;{}]$/.test(previous))
  const statement = lines?.slice(at).join("\n") ?? ""
  const candidate = boundary && location.file && /^([ \t]*)((?:[A-Za-z_$][\w$]*\.)?(?:gtag\(\s*['"]config['"]|fbq\(\s*['"]init['"]|posthog\.init\())(?:[^'"();`/]|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')*\)[ \t]*(;)?[ \t]*(?:\n|$)/.exec(statement)
  const tail = candidate ? statement.slice(candidate[0].length).trimStart() : ""
  const continuation = /^(?:[([`.,+\-*/%&|^?:<>=!]|(?:in|instanceof)\b)/.test(tail)
  const init = candidate && (candidate[3] || !continuation) ? candidate : null
  // The recognized call may have multiline literal arguments, but no other statements.
  // It never wraps the enclosing function or adjacent consent statements.
  const guard = init ? `--- a/${location.file}\n+++ b/${location.file}\n@@ -${at + 1},1 +${at + 1},1 @@\n-${original}\n+${init[1]}if (${expression}) ${original!.slice(init[1]!.length)}` : `if (${expression})`
  return { guard, text: `${note}\n\n${init ? "Owner-only diff for the named initialization statement; adjacent consent statements stay outside the condition." : "The exact initialization statement and its safe boundary could not be proven. The owner must choose placement for this condition; this is not an apply-ready edit."}\n\n\`\`\`${init ? "diff" : "js"}\n${guard}\n\`\`\`` }
}

/** Recognize only our standalone status sentences, not words inside reviewer findings. */
export function isOwnerBoundaryStatement(note: string): boolean {
  const text = note.trim()
  return previousStatements.includes(text) || text.startsWith(OWNER_BOUNDARY) || text.startsWith("This run could not check its own commits against your consent code and policy pages (") || text.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;")
}
export function hasLegacyOwnerHistory(notes: readonly string[]): boolean {
  return notes.some(note => note === OLD_LEGACY_OWNER_BOUNDARY || note === LEGACY_OWNER_BOUNDARY || note.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;") || note.includes("(an earlier version of this run recorded policy edits)"))
}
