export { isPolicyPath } from "./policy-pages.js"
import { safeDisplayText } from "../review/display.js"
import { createScanner, type Scanner } from "../review/scan.js"
import type { OwnerBoundaryMeasurement } from "./owner-diff.js"
/** Customer-owned policy is outside every installer, worker, reviewer and check. */
const OLD_FINAL_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against the final diff)."
const OLD_RECORDED_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against this run’s recorded commits)."
export const OWNER_BOUNDARY = "This run did not edit your privacy or terms pages, or any code where it recognised a consent call (checked against the commits it made). Consent and privacy are yours: please review the files this run changed."
const OLD_UNMEASURED = "Your consent code and privacy policy are yours; the final diff has not been checked."
export const OWNER_BOUNDARY_UNMEASURED = "This run could not check its own commits against your consent code and policy pages (no wizard commits were measured); please review the changed files."
const FOUND_OWNER_EDIT = "This run checked its own commits and found an edit to your consent code or policy pages"
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
  const savedReason = /This run could not check its own commits against your consent code and policy pages \(([^\n]*?)\); please review the changed files\./.exec(text)?.[1]
  const savedFoundReason = /This run checked its own commits and found an edit to your consent code or policy pages \(([^\n]*?)\); please review the changed files\./.exec(text)?.[1]
  const foundEdit = measurement?.state === "changed" || (!measurement && savedFoundReason !== undefined)
  const savedFiles = text.split(/\n\s*\n/).find(block => /^Changed files(?: \(branch history; ownership unverified\))?:/.test(block.trim()))
  const reason = foundEdit ? (measurement?.issues?.map(issue => issue.reason).join("; ") || savedFoundReason || "the measured diff contains an owner-code edit") : legacy ? "an earlier version of this run recorded policy edits" : measurement?.unverifiedReason ??
    (measurement?.issues?.length ? measurement.issues.map(issue => issue.reason).join("; ") : !measurement && savedReason ? savedReason : "no wizard commits were measured")
  const statement = measured ? OWNER_BOUNDARY : `${foundEdit ? FOUND_OWNER_EDIT : "This run could not check its own commits against your consent code and policy pages"} (${safeDisplayText(scanner, reason).replace(/[\r\n]/g, " ").slice(0, 140)}); please review the changed files.`
  const files = [...new Set(measurement?.files ?? [])]
  const listed = files.slice(0, 20).map(file => `- ${safeDisplayText(scanner, file).replace(/[\r\n\t]/g, " ").replace(/`/g, "'").slice(0, 240)}`)
  const changed = !measurement && savedFiles ? safeDisplayText(scanner, savedFiles).split("\n").slice(0, 22).map(line => line.slice(0, 245)).join("\n") : files.length ? [`Changed files${measurement?.fileScope === "branch_history" ? " (branch history; ownership unverified)" : ""}:`, ...listed,
    ...(files.length > listed.length ? [`- … ${files.length - listed.length} more changed files; review the complete Git diff.`] : [])].join("\n")
    : measurement?.filesAvailable ? "Changed files: none found in the available diff." : "Changed files: unavailable from the saved run."
  // Re-render saved reports by replacing our exact old/new status paragraphs, including their list.
  let result = text
  for (const old of previousStatements) result = result.replaceAll(old, "")
  result = result.split(/\n\s*\n/).filter(block => !isOwnerBoundaryStatement(block) && !/^Changed files(?: \(branch history; ownership unverified\))?:/.test(block.trim())).join("\n\n").trim()
  return [result, statement, changed].filter(Boolean).join("\n\n")
}

/** Compact cloud notes keep the complete claim/reason and an explicitly bounded path summary. */
export function ownerBoundaryNotes(text: string, priorPolicyEdits: boolean, measurement?: Partial<OwnerBoundaryMeasurement>): string[] {
  const blocks = withOwnerBoundary(text, priorPolicyEdits, measurement).split(/\n\s*\n/)
  const statement = blocks.find(block => block.startsWith(OWNER_BOUNDARY) || block.startsWith(FOUND_OWNER_EDIT) || block.startsWith("This run could not check"))!
  const files = blocks.find(block => block.startsWith("Changed files"))!
  if (!files.includes("\n")) return [statement, files]
  const rows = files.split("\n").slice(1).filter(row => !row.startsWith("- …"))
  const shown = rows.slice(0, 3).map(row => row.replace(/^- /, "").slice(0, 48))
  const extra = Math.max(0, (measurement?.files?.length ?? rows.length) - shown.length)
  return [statement, `${files.split("\n")[0]} ${shown.join("; ")}${extra ? `; … ${extra} more changed files (full Git diff).` : ""}`]
}

export function frozenJobNote(item: { id: string; jobId: string; title: string }, place: { file: string; line: number }): string {
  const tool = item.jobId === "preview_guard" ? ({ ga4: "GA4", meta: "Meta pixel", posthog: "PostHog" }[item.id.split(":")[1]!] ?? item.title) : item.title
  const location = `${place.file}:${place.line}`
  return item.jobId === "preview_guard"
    ? `For you: add the preview guard to ${tool}'s start-up at ${location}; until then preview and local visits count in ${tool}.`
    : `For you: make the "${tool}" change at ${location}, inside your consent code.`
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
  let guard = `if (${expression})`
  if (init && lines) {
    const rawLines = source!.split("\n")
    const count = rawLines.at(-1) === "" ? rawLines.length - 1 : rawLines.length
    const start = Math.max(0, at - 3), end = Math.min(count, at + 4)
    const context = rawLines.slice(start, end).flatMap((line, offset) => {
      const absentNewline = start + offset === count - 1 && !source!.endsWith("\n") ? ["\\ No newline at end of file"] : []
      return start + offset === at ? [`-${line}`, ...absentNewline, `+${init[1]}if (${expression}) ${line.slice(init[1]!.length)}`, ...absentNewline] : [` ${line}`, ...absentNewline]
    })
    guard = `--- a/${location.file}\n+++ b/${location.file}\n@@ -${start + 1},${end - start} +${start + 1},${end - start} @@\n${context.join("\n")}`
  }
  return { guard, text: `${note}\n\n${init ? "Owner-only diff for the named initialization statement; adjacent consent statements stay outside the condition." : "The exact initialization statement and its safe boundary could not be proven. The owner must choose placement for this condition; this is not an apply-ready edit."}\n\n\`\`\`${init ? "diff" : "js"}\n${guard}\n\`\`\`` }
}

/** Recognize only our standalone status sentences, not words inside reviewer findings. */
export function isOwnerBoundaryStatement(note: string): boolean {
  const text = note.trim()
  return previousStatements.includes(text) || text.startsWith(OWNER_BOUNDARY) || text.startsWith(FOUND_OWNER_EDIT) || text.startsWith("This run could not check its own commits against your consent code and policy pages (") || /^Changed files(?: \(branch history; ownership unverified\))?:/.test(text) || text.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;")
}
export function hasLegacyOwnerHistory(notes: readonly string[]): boolean {
  return notes.some(note => note === OLD_LEGACY_OWNER_BOUNDARY || note === LEGACY_OWNER_BOUNDARY || note.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;") || note.includes("(an earlier version of this run recorded policy edits)"))
}
