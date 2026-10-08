export { isPolicyPath } from "./policy-pages.js"
import { safeDisplayText } from "../review/display.js"
import { createScanner, type Scanner } from "../review/scan.js"
import type { OwnerBoundaryMeasurement } from "./owner-diff.js"
/** Customer-owned policy is outside every installer, worker, reviewer and check. */
const OLD_FINAL_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against the final diff)."
const OLD_RECORDED_BOUNDARY = "Your consent code and privacy policy are yours; this run changed neither (checked against this run’s recorded commits)."
const OLD_COMMIT_BOUNDARY = "This run did not edit your privacy or terms pages, or any code where it recognised a consent call (checked against the commits it made). Consent and privacy are yours: please review the files this run changed."
/** One plain line, said only when the run's own commits were measured against the site's consent code and policy pages. */
export const OWNER_BOUNDARY = "This run left your cookie banner, consent code and privacy pages as they were."
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

const previousStatements = [OLD_COMMIT_BOUNDARY, OLD_FINAL_BOUNDARY, OLD_RECORDED_BOUNDARY, OLD_OWNER_BOUNDARY, OLD_UNMEASURED, OLD_LEGACY_OWNER_BOUNDARY, LEGACY_OWNER_BOUNDARY,
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

/**
 * P2-4: what an owner-only change IS, in plain words, per job target (three identical "make the change" lines told the
 * owner nothing). Each names the setting or the lines, never an internal code.
 */
const OWNER_CHANGE: Readonly<Record<string, string>> = {
  "posthog_improve:history_change": "turn on PostHog's page-change counting (`capture_pageview: 'history_change'` in its init)",
  "posthog_improve:defaults": "move PostHog to its current recommended settings (the `defaults` option in its init)",
  "posthog_improve:sensitive_pages": "turn PostHog's session replay and autocapture off on your sensitive pages (in its init)",
  "posthog_improve:proxy": "send PostHog through your own site (`api_host: '/ingest'` in its init, plus the rewrite)",
  "ga4_improve:id": "use your connected GA4 measurement id in its config",
  "ga4_improve:spa_page_view": "make GA4 send one page_view per page change (a few lines after its config)",
  "meta_improve:autoconfig_off_adopted": "turn off Meta's automatic events (one line before the pixel's init)",
  "meta_improve:spa_page_view": "make the Meta pixel send one PageView per page change (a few lines after its first PageView)",
  "meta_improve:capture": "add Infinite's ad-click capture beside the Meta pixel",
  "meta_improve:retire_fbc_writer": "remove the hand-written `_fbc` cookie writer",
  "meta_improve:mirror": "move the browser Meta conversions onto the server's event id"
}

/**
 * Why the "For you" changes are the owner's, said ONCE per report (never repeated on every line): they sit in the code
 * that starts the site's trackers after its cookie banner, which the wizard never edits.
 */
export const OWNER_CODE_REASON = "The \"For you\" changes below are in the code that starts your trackers after your cookie banner. The wizard never edits that code, so they are yours to make."

/**
 * A setup check the wizard could not fix itself, as the concrete action left for the owner. Never the check id or an
 * internal code: the action, and where.
 */
function setupCheckAction(checkId: string, finding: string, place: { file: string; line: number }, location: string): string {
  if (checkId === "click_id_capture" && /does not follow imports/.test(finding)) {
    // The finding names the shared entries to check ("already loads through pages/_app.tsx or …").
    const entry = /already loads through ([^\s,]+)/.exec(finding)?.[1] ?? null
    return `check that ${place.file}, where your Meta pixel starts, is loaded from ${entry ?? "the file every page loads"}, so it runs on every page a visitor can land on and saves the ad click before they move on. The wizard could not confirm it, because it does not follow imports; if it is, nothing is left to do`
  }
  const words = finding.replace(/^Setup check [a-z0-9_]+:\s*/i, "").replace(/\bINF_[A-Z0-9_]+:\s*/g, "").replace(/\s+/g, " ").trim()
  return `${words.length > 0 ? `${words.charAt(0).toLowerCase()}${words.slice(1).replace(/\.$/, "")}` : "fix the setup check"} (at ${location})`
}

export function frozenJobNote(item: { id: string; jobId: string; title: string; trigger?: { finding: string } }, place: { file: string; line: number }): string {
  const tool = item.jobId === "preview_guard" ? ({ ga4: "GA4", meta: "Meta pixel", posthog: "PostHog" }[item.id.split(":")[1]!] ?? item.title) : item.title
  const location = `${place.file}:${place.line}`
  if (item.jobId === "preview_guard") return `For you: add the preview guard to ${tool}'s start-up at ${location}; until then preview and local visits count in ${tool}.`
  if (item.jobId === "setup_check_fixes") return `For you: ${setupCheckAction(item.id.split(":").slice(1).join(":"), item.trigger?.finding ?? "", place, location)}.`
  const change = OWNER_CHANGE[item.id]
  return change ? `For you: ${change} at ${location}.` : `For you: ${tool.charAt(0).toLowerCase()}${tool.slice(1)} at ${location}.`
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
  return { guard, text: `${note}\n\n${init ? "The change, line by line (only that start-up line; the consent lines around it stay as they are):" : "Where exactly this goes could not be worked out safely, so place this condition yourself:"}\n\n\`\`\`${init ? "diff" : "js"}\n${guard}\n\`\`\`` }
}

/** Recognize only our standalone status sentences, not words inside reviewer findings. */
export function isOwnerBoundaryStatement(note: string): boolean {
  const text = note.trim()
  return previousStatements.includes(text) || text.startsWith(OWNER_BOUNDARY) || text.startsWith(FOUND_OWNER_EDIT) || text.startsWith("This run could not check its own commits against your consent code and policy pages (") || /^Changed files(?: \(branch history; ownership unverified\))?:/.test(text) || text.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;")
}
export function hasLegacyOwnerHistory(notes: readonly string[]): boolean {
  return notes.some(note => note === OLD_LEGACY_OWNER_BOUNDARY || note === LEGACY_OWNER_BOUNDARY || note.startsWith("Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits;") || note.includes("(an earlier version of this run recorded policy edits)"))
}
