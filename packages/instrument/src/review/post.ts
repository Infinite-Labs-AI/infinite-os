import { ownerInformationOnly, protectedFinding, OWNER_INFORMATION_HEADING } from "./integrity.js"
import { safeDisplayText, neutralizeTaskCheckboxes, quoteDisplayNote, redactDisplayText } from "./display.js"
// Everything the wizard posts on the PR (lane O4, §3g.3–§3g.5), built here and scanned here:
// the PR body, the ONE review (`event: COMMENT`; a finding outside a diff hunk goes into the body), the replies,
// and the final comment. Statuses are plain text the wizard owns: a literal `- [ ]` (which anyone can tick) is
// never posted. On a public repo, a provider ID that is not already in the diff is shown as `<id>`.
import type { OwnerBoundaryMeasurement } from "../jobs/owner-diff.js"
import { hasRecordedPolicyEdits, withOwnerBoundary } from "../jobs/owner-boundary.js"
import { omitOwnerPolicyReview } from "./brief.js"
import { sanitizeUntrustedBlock } from "../agents/sanitize.js"
import { AGENT_LIMITS, type AgentKind, type ReviewResult } from "../wizard/contracts/agents.js"
import { PR_MARKERS } from "../wizard/contracts/git-host.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { lineInHunk, type DiffFile } from "./diff.js"
import { createScanner, mostlyRedacted, type Scanner } from "./scan.js"
import type { TriageDecision } from "./triage.js"
import { escapeMarkdownCell } from "../text-escape.js"

export const AGENT_LABEL: Record<AgentKind, string> = { claude_code: "Claude Code", codex: "Codex" }

/** Task-list checkboxes become plain bullets (any collaborator could tick one and fake a "done"). */
export function neutralizeCheckboxes(text: string): string {
  return neutralizeTaskCheckboxes(text)
}

function escapeCell(text: string, scanner: Scanner = createScanner({ literals: [], allowedIds: [] })): string {
  return escapeMarkdownCell(safeDisplayText(scanner, text)).trim()
}

/** Strips C0 control characters (but newlines and tabs) from untrusted text before it is posted. */
export function stripControl(text: string): string {
  // The ONE sanitiser's multi-line shape (§3z.12 B9): newlines and tabs kept, everything else hostile stripped.
  return sanitizeUntrustedBlock(text, 65_536)
}

/** The scan + control-strip every posted string goes through. */
export function safeText(scanner: Scanner, text: string): string {
  return redactDisplayText(scanner, text)
}

const ID_SHAPES = [/\bG-[A-Z0-9]{6,12}\b/g, /\bphc_[A-Za-z0-9]{20,}\b/g, /(?<![0-9A-Za-z])\d{15,16}(?![0-9A-Za-z])/g]

/**
 * §3g.3 (wf4 PR-08): on a PUBLIC repo the PR body is a third-party surface. A provider ID that does not already
 * appear in the committed diff is shown as `<id>`; one the diff already publishes stays.
 */
export function redactIdsNotInDiff(text: string, diffText: string, knownIds: readonly string[]): string {
  let out = text
  for (const id of [...knownIds].sort((a, b) => b.length - a.length)) {
    if (id.length >= 6 && out.includes(id) && !diffText.includes(id)) out = out.split(id).join("<id>")
  }
  for (const shape of ID_SHAPES) {
    out = out.replace(new RegExp(shape.source, shape.flags), (match) => (diffText.includes(match) ? match : "<id>"))
  }
  return out
}

export function buildPrBody(input: {
  ownerBoundary?: OwnerBoundaryMeasurement
  reportMarkdown: string
  howToReview: string
  runId: string
  isPrivate: boolean
  diffText: string
  connectionIds: readonly string[]
  scanner: Scanner
  notes?: readonly string[]
}): string {
  const parts = [input.reportMarkdown.trim(), ...(input.notes ?? []).map((note) => quoteDisplayNote(input.scanner, note)), input.howToReview.trim()]
  let body = neutralizeCheckboxes(safeText(input.scanner, withOwnerBoundary(parts.filter(Boolean).join("\n\n"), false, input.ownerBoundary)))
  if (!input.isPrivate) body = redactIdsNotInDiff(body, input.diffText, input.connectionIds)
  return `${body}\n\n${PR_MARKERS.pr(input.runId)}\n`
}

const STATUS_TEXT = { pass: "pass", fail: "fail", cant_tell: "can't tell" } as const

export interface ReviewPost {
  body: string
  threads: Array<{ path: string; line: number; body: string }>
  /** Finding ids that went into the body (outside a hunk, unlocated, or withheld). */
  inBody: string[]
}

/** §3g.4 step 2: ONE review; inline where GitHub accepts it, in the body otherwise; everything scanned. */
export function buildReviewPost(input: {
  review: ReviewResult
  diffFiles: readonly DiffFile[]
  scanner: Scanner
  runId: string
  round: number
  head: string
  reviewer: AgentKind
  /** §3y.7: the items the reviewer could not check (an incomplete review says so in its header). */
  unchecked?: readonly string[]
  completeness?: "complete" | "incomplete" | "blind"
}): ReviewPost {
  input = { ...input, review: omitOwnerPolicyReview(input.review) }
  const marker = PR_MARKERS.review({ runId: input.runId, round: input.round, head: input.head, reviewer: input.reviewer })
  const threads: ReviewPost["threads"] = []
  const bodyFindings: string[] = []
  const ownerFindings: string[] = []
  const inBody: string[] = []
  for (const finding of input.review.findings) {
    const raw = `${finding.body}${finding.suggested_fix ? `\n\nSuggested fix: ${finding.suggested_fix}` : ""}`
    const scanned = safeDisplayText(input.scanner, raw)
    // The path is reviewer text too: it is scanned like the body before it appears anywhere.
    const path = safeDisplayText(input.scanner, finding.path)
    const location = finding.line === null ? path : `${path}:${finding.line}`
    const text = mostlyRedacted(raw, scanned)
      ? `A finding on ${location} was withheld because it quoted a secret or personal data.`
      : scanned
    const ownerInfo = ownerInformationOnly(finding)
    const label = `**[${finding.item} ${finding.severity}]** ${finding.id}`
    if (ownerInfo) {
      inBody.push(finding.id)
      ownerFindings.push(`- ${label} ${location}: ${text.replace(/\n+/g, " ")}`)
      continue
    }
    if (finding.line !== null && path === finding.path && lineInHunk(input.diffFiles, finding.path, finding.line)) {
      threads.push({ path: finding.path, line: finding.line, body: `${neutralizeCheckboxes(`${label}\n\n${text}`)}\n\n${marker}` })
    } else {
      inBody.push(finding.id)
      bodyFindings.push(`- ${label} \`${location.replace(/`/g, "'")}\`: ${text.replace(/\n+/g, " ")}`)
    }
  }
  const checklist = input.review.checklist
    .map((row) => `| ${row.item} | ${STATUS_TEXT[row.status]} | ${escapeCell(row.note, input.scanner)} |`)
    .join("\n")
  const onlyInfo = input.review.findings.length > 0 && input.review.findings.every(ownerInformationOnly)
  const protectedOpen = input.review.findings.some(protectedFinding)
  const verdict = protectedOpen ? "changes suggested" : onlyInfo && input.review.checklist.every(row => row.status !== "fail") ? "owner information only" : input.review.verdict === "looks_good" ? "looks good" : "changes suggested"
  const unchecked = input.unchecked?.length ? input.unchecked : input.review.checklist.length === 0 ? ["no checklist rows"] : input.completeness !== "complete" ? ["read-check not verified"] : []
  const header =
    unchecked.length > 0
      ? `**Second review by ${AGENT_LABEL[input.reviewer]} (round ${input.round}): incomplete — unchecked: ${unchecked.join(", ")}.** Posted by infinite-tag; a review is an opinion, not a receipt.`
      : `**Second review by ${AGENT_LABEL[input.reviewer]} (round ${input.round}): ${verdict}.** Posted by infinite-tag; a review is an opinion, not a receipt.`
  const content = [
    header,
    "Owner actions and copyable handoffs are in the pull request body.",
    `**Reviewer summary (quoted):**\n\n${safeDisplayText(input.scanner, input.review.summary).split("\n").map(line => `> ${line}`).join("\n")}`,
    checklist ? `| Item | Status | Note |\n|---|---|---|\n${checklist}` : "",
    ownerFindings.length > 0 ? `**${OWNER_INFORMATION_HEADING}**\n\n${ownerFindings.join("\n")}` : "",
    bodyFindings.length > 0 ? `**Notes outside the changed lines**\n\n${bodyFindings.join("\n")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n")
  // Belt and braces: the whole assembled body passes the scan once more (every GitHub post does, §3g.5).
  const body = `${neutralizeCheckboxes(safeText(input.scanner, content))}\n\n${marker}`
  return { body, threads, inBody }
}

/**
 * What happened to a FIX on its thread: `fixed` (committed, and the wizard's checks passed), `unverified`
 * (committed and pushed, but the required checks had not finished), or `not_fixed`.
 */
export type FixReplyState =
  | { kind: "fixed"; sha: string }
  | { kind: "unverified"; sha: string }
  | { kind: "not_fixed"; outcome?: NotFixedOutcome; why?: string | null }

/**
 * §3x.3 / DECISIONS §1.5 Why a FIX stayed open, as it really happened: the round ran out of time, the agent could not use
 * its tools, it stopped with an error, it finished without a change, or its change failed the wizard's checks.
 */
export type NotFixedOutcome = "timeout" | "toolless" | "error" | "no_change" | "checks_failed" | "undone" | "gate_refused" | "blocked"

/**
 * The one wording of a not-fixed reply (thread reply, run note and terminal line say the same words). Review P1-4: a
 * round whose change the wizard UNDID is never "before changing anything" / "without changing anything":
 *   - `undone`: the agent stopped (out of time, an error, no tools) mid-change; `why` = what stopped it and the files;
 *   - `gate_refused`: the post-turn safety check refused every change; `why` = the gate's own note;
 *   - `blocked`: the fence undid every change (outside the job's files, consent); `why` = the block's note.
 */
/** The fix round's time budget in whole minutes, as every reply says it. */
export const FIX_ROUND_MINUTES = Math.round(AGENT_LIMITS.reviewFix.wallMsPerRound / 60_000)

export function notFixedReply(outcome: NotFixedOutcome, why?: string | null, scanner: Scanner = createScanner({ literals: [], allowedIds: [] })): string {
  const said = why ? safeDisplayText(scanner, why).slice(0, 200) : null
  switch (outcome) {
    case "undone":
      return `Not fixed: ${said ?? "the agent stopped before it finished"}. It stays open.`
    case "gate_refused":
      return `Not fixed: ${said ?? "the wizard's safety check refused the agent's change"}, so the change was undone. It stays open.`
    case "blocked":
      return `Not fixed: ${said ?? "the wizard undid the agent's change"}. It stays open.`
    case "timeout":
      return `Not fixed: the agent ran out of its ${FIX_ROUND_MINUTES} minutes before changing anything. It stays open.`
    case "toolless":
      return "Not fixed: the agent could not use its tools. It stays open."
    case "error":
      return "Not fixed: the agent stopped with an error before changing anything. It stays open."
    case "no_change":
      return "Not fixed: the agent finished without changing anything. It stays open."
    case "checks_failed":
      return `Not fixed this round: the agent's change did not pass the wizard's checks${said ? ` (${said})` : ""}. It stays open.`
  }
}

/** §3x.3 The label of a finding on Infinite's own files (triage `INFINITE`). */
export type InfiniteOwnLabel = "Infinite's own code" | "the wizard's own change"

/** The reply on a thread (never re-read as feedback). */
export function buildReply(scanner: Scanner, decision: TriageDecision, fix: FixReplyState | null): string {
  // Only the untrusted part (the triage reason, which quotes review text) is scanned: the commit SHA is the
  // wizard's own and a short SHA can be all digits (it must never read as a redacted phone number).
  const text =
    decision.action === "FIX"
      ? fix?.kind === "fixed"
        ? `Fixed in ${fix.sha.slice(0, 7)}; the wizard re-ran its checks and the rehearsal on that commit.`
        : fix?.kind === "unverified"
          ? `Changed in ${fix.sha.slice(0, 7)}. The required checks had not finished, so the wizard has not marked it done; it stays open.`
          : notFixedReply(fix?.kind === "not_fixed" ? (fix.outcome ?? "checks_failed") : "checks_failed", fix?.kind === "not_fixed" ? fix.why : null, scanner)
      : decision.action === "INFINITE"
        ? `This is ${decision.label ?? "Infinite's own code"} (${safeDisplayText(scanner, decision.item.path ?? "general")}), which the wizard never hands to your agent. The finding is recorded in this run's report for Infinite to fix.`
      : decision.action === "ASK" && decision.leftByOwner && !ownerInformationOnly(decision.item)
        ? safeDisplayText(scanner, decision.reason)
      : decision.action === "ASK"
        ? `Waiting on the repo owner: ${safeDisplayText(scanner, decision.reason)}`
        : safeDisplayText(scanner, decision.reason)
  return `${neutralizeCheckboxes(stripControl(text))}\n\n${PR_MARKERS.reply}`
}

export interface FinalCommentInput {
  /** The structured report already rendered the non-blocker owner findings. */
  ownerInformationInReport?: boolean
  ownerBoundary?: OwnerBoundaryMeasurement
  runId: string
  reportMarkdown: string
  reviewer: AgentKind | "brief" | null
  reviewed: boolean
  /** §3y.7: the latest review's completeness (blind = the reviewer could not read the files). */
  completeness?: { state: "complete" | "incomplete" | "blind"; unchecked: readonly string[] } | null
  jobs: readonly ChecklistItem[]
  decisions: readonly TriageDecision[]
  /** Comments from people outside the repo: listed, never acted on. */
  untrusted: ReadonlyArray<{ author: string; path: string | null; excerpt: string }>
  notes: readonly string[]
  scanner: Scanner
}

/**
 * §3x.2 A job's cell in the PR checklist: a job that did not get done says WHY in the wizard's own words
 * (`failed: <note>` / `blocked: <note>`), never only a state code ("blocked (outside allowlist)").
 */
export function jobStateCell(job: ChecklistItem): string {
  if (job.consentActivation === "waiting_banner_signal" && job.state === "done_in_code") return job.note ?? "Installed, waiting on your banner signal. Offline check: works when consent is granted."
  if (job.ownerBoundary?.kind === "restored_unit" || job.blockedReason === "consent_touched") return "Put back: an edit reached code that handles consent."
  if (job.ownerBoundary?.kind === "legacy_policy" || job.jobId === "privacy_paragraph") return job.note ?? "Privacy policy work is retired; earlier recorded edits are reported separately."
  if (job.state === "left_for_you") return job.note ?? "Not done: left for the site owner."
  const state = job.state.replace(/_/g, " ")
  if ((job.state === "failed" || job.state === "blocked" || ((job.state === "done_in_code" || job.state === "claimed") && job.note && /^(?:Not checked after the deploy:|Checked, but not tied to this deploy:|Waiting for the Infinite app's results:)/.test(job.note))) && job.note) return `${state}: ${job.note}`
  return `${state}${job.blockedReason ? ` (${job.blockedReason.replace(/_/g, " ")})` : ""}`
}

/** Fence length is chosen from the source so a comment/string cannot escape into live Markdown. */
function ownerSnippet(text: string, language: string, scanner: Scanner): string {
  if (safeText(scanner, text) !== text) return "The copyable snippet was withheld because it contains private data, terminal controls, or exceeds the display limit. Review the named file locally."
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)))
  return `${fence}${language}\n${text}\n${fence}`
}

/** Shared merge-time and final checklist; scan the returned Markdown before posting. */
export function buildChecklist(jobs: readonly ChecklistItem[], scanner: Scanner = createScanner({ literals: [], allowedIds: [] }), alreadyShownOwnerText = ""): string {
  if (jobs.length === 0) return ""
  const rows = jobs.map((job) => {
    const ownerShown = job.state === "left_for_you" && job.ownerBoundary && job.note && alreadyShownOwnerText.includes(safeDisplayText(scanner, job.note))
    return `| ${escapeCell(job.title, scanner)} | ${escapeCell(ownerShown ? "Left for you; see the owner action above." : jobStateCell(job), scanner)} |`
  }).join("\n")
  const guards = jobs.filter(job => job.state === "left_for_you" && job.ownerBoundary?.kind === "frozen_unit" && job.ownerBoundary.guard && !alreadyShownOwnerText.includes(job.ownerBoundary.guard)).map(job => {
    const scope = job.ownerBoundary!
    const where = escapeCell(`${scope.file ?? job.allow.files[0] ?? "the noted file"}:${scope.line ?? 1}`, scanner)
    return `**For the site owner: ${escapeCell(job.title, scanner)}**\n\nApply this condition to the analytics start-up at ${where}. Keep your consent, grant and revoke code outside the guard. This snippet is for you to copy; the wizard did not edit that unit.\n\n${ownerSnippet(scope.guard!, scope.guard!.startsWith("--- a/") ? "diff" : "js", scanner)}`
  })
  const wiring = jobs.filter(job => job.state === "left_for_you" && job.ownerBoundary?.wiring && !alreadyShownOwnerText.includes(job.ownerBoundary.wiring)).map(job => {
    const scope = job.ownerBoundary!
    const where = escapeCell(scope.file ?? job.allow.files[0] ?? "the noted entrypoint", scanner)
    return `**For the site owner: wiring at ${where}**\n\nThe wizard left this entrypoint untouched. The import, mount or script below is for you to place; it has not been applied.\n\n${ownerSnippet(scope.wiring!, "text", scanner)}`
  })
  return [`**Checklist (the wizard's own checks, never the agent's word)**\n\n| Job | State |\n|---|---|\n${rows}`, ...guards, ...wiring].join("\n\n")
}

/** §3g.4 step 9: the before/after table, the checklist states, declined items with reasons, and what the user decides. */
export function buildFinalComment(input: FinalCommentInput): string {
  input = { ...input, decisions: input.decisions.map(decision => ({ ...decision, reason: safeDisplayText(input.scanner, decision.reason), item: { ...decision.item, body: safeDisplayText(input.scanner, decision.item.body), path: decision.item.path === null ? null : safeDisplayText(input.scanner, decision.item.path) } })), notes: input.notes.map(note => quoteDisplayNote(input.scanner, note)), untrusted: input.untrusted.map(entry => ({ ...entry, author: safeDisplayText(input.scanner, entry.author), excerpt: safeDisplayText(input.scanner, entry.excerpt), path: entry.path === null ? null : safeDisplayText(input.scanner, entry.path) })) }

  const ownerInfo = input.decisions.filter(decision => ownerInformationOnly(decision.item)).map(decision => `- ${decision.item.path ?? "general"}: ${excerpt(decision.item.body)}`)
  const declined = input.decisions
    .filter((decision) => decision.action === "DECLINE" && !ownerInformationOnly(decision.item) && !protectedFinding(decision.item))
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason}`)
  const open = input.decisions
    .filter((decision) => !ownerInformationOnly(decision.item) && ((decision.action === "ASK" && !decision.leftByOwner) || (decision.action === "OWNER_INFO" && !ownerInformationOnly(decision.item)) || ((decision.action === "DECLINE" || decision.action === "ANSWER") && protectedFinding(decision.item))))
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason} (${excerpt(decision.item.body)})`)
  const left = input.decisions
    .filter((decision) => decision.action === "ASK" && decision.leftByOwner && !ownerInformationOnly(decision.item))
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason} (${excerpt(decision.item.body)})`)
  const answered = input.decisions
    .filter((decision) => decision.action === "ANSWER" && !ownerInformationOnly(decision.item) && !protectedFinding(decision.item))
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}${decision.item.line ? `:${decision.item.line}` : ""}\`` : "general"}: ${excerpt(decision.item.body)} → ${decision.reason}`)
  const agentLabel = input.reviewer === "claude_code" || input.reviewer === "codex" ? AGENT_LABEL[input.reviewer] : null
  const review =
    agentLabel && input.completeness?.state === "blind"
      ? `No second review (${agentLabel} could not read the files).`
      : input.reviewer === "brief" && input.reviewed
        ? // Live run 5 (P2): a review posted from the printed brief and read back IS a second review. The wizard does not
          // know which agent wrote it, so it names where it came from, never an agent it cannot vouch for.
          `Reviewed from the printed review brief${input.completeness?.state === "incomplete" ? " (review incomplete: " + input.completeness.unchecked.join(", ") + ")" : ""} (an agent you chose posted it here). A review is an opinion; only a receipt from this run means "proven".`
      : input.reviewer === null || input.reviewer === "brief" || !input.reviewed || !agentLabel
        ? "No second review ran on this pull request."
        : input.completeness?.state === "incomplete"
          ? `Reviewed by ${agentLabel} (incomplete: ${input.completeness.unchecked.join(", ")} not checked). A review is an opinion; only a receipt from this run means "proven".`
          : `Reviewed by ${agentLabel}. A review is an opinion; only a receipt from this run means "proven".`
  const text = withOwnerBoundary([
    FINAL_COMMENT_TITLE,
    review,
    input.reportMarkdown.trim(),
    buildChecklist(input.jobs, input.scanner, input.reportMarkdown),
    ownerInfo.length > 0 && !input.ownerInformationInReport ? `**${OWNER_INFORMATION_HEADING}**\n\n${ownerInfo.join("\n")}` : "",
    declined.length > 0 ? `**Declined, with reasons**\n\n${declined.join("\n")}` : "",
    // Live run 5 (P3): a reviewer's question the wizard answered from this run's measurements. On a brief review there is
    // no inline thread to reply on, so the answer appears here, never nowhere.
    answered.length > 0 ? `**Questions answered from this run's checks**\n\n${answered.join("\n")}` : "",
    open.length > 0 ? `**You decide**\n\n${open.join("\n")}` : "",
    left.length > 0 ? `**Left by the repo owner**\n\n${left.join("\n")}` : "",
    input.untrusted.length > 0
      ? `**Comments from people outside the repo (shown, not acted on)**\n\n${input.untrusted
          .map((comment) => `- ＠${comment.author}${comment.path ? ` on \`${comment.path}\`` : ""}: ${excerpt(comment.excerpt)}`)
          .join("\n")}`
      : "",
    ...input.notes,
    FINAL_COMMENT_MERGE_LINE
  ]
    .filter(Boolean)
    .join("\n\n"), hasRecordedPolicyEdits(input.jobs), input.ownerBoundary)
  return `${neutralizeCheckboxes(safeText(input.scanner, text))}\n\n${PR_MARKERS.final(input.runId)}\n`
}

/** The last line of the merge-time comment, and its replacement once the live check has run (R2-5). */
export const FINAL_COMMENT_MERGE_LINE = "Merge when you're happy. After it deploys, Infinite proves it live."
export const FINAL_COMMENT_UPDATED_LINE = "Updated after the live check: the table above is the run's final report, the same one as in the terminal and in Infinite."

/** The sections that follow the report in `buildFinalComment` (the report ends where the first of them starts). */
const AFTER_REPORT = ["\n\n**Checklist (the wizard's own checks", "\n\n**Declined, with reasons**", "\n\n**You decide**", "\n\n**Left by the repo owner**", "\n\n**Questions answered from this run's checks**", "\n\n**Comments from people outside the repo", "\n\n> ", `\n\n${FINAL_COMMENT_MERGE_LINE}`, `\n\n${FINAL_COMMENT_UPDATED_LINE}`, "\n\n<!-- infinite-tag:"]

/**
 * R2-5 (live run 2): the "what happened" comment with its report replaced by the final one (after Prove), so the PR,
 * the terminal and the app show ONE report. When supplied, the final checklist replaces the merge-time checklist.
 * Review decisions and markers stay as posted. Both Markdown inputs must already be scanned by the caller. Returns null when
 * the body holds no report table (nothing is guessed).
 */
export function withFinalReport(body: string, reportMarkdown: string, checklistMarkdown?: string, ownerBoundary?: OwnerBoundaryMeasurement): string | null {
  // R4-4 (live run 4): the report starts at its HEADLINE (the paragraph after the review sentence), not at its table.
  // Splicing from "### Before and after" kept the merge-time headline and reasons ("set up in the pull request · not
  // checked live yet") above the final verdict: two contradicting headlines in one comment.
  const table = body.indexOf("### Before and after")
  if (table < 0) return null
  const start = reportStartIn(body)
  if (start === null || start > table) return null
  const ends = AFTER_REPORT.map((marker) => body.indexOf(marker, table)).filter((index) => index > table)
  if (ends.length === 0) return null
  const end = Math.min(...ends)
  let tail = body.slice(end)
  if (checklistMarkdown !== undefined) {
    const checklistStart = tail.indexOf(AFTER_REPORT[0]!)
    if (checklistStart >= 0) {
      const following = AFTER_REPORT.slice(1).map((marker) => tail.indexOf(marker, checklistStart + 2)).filter((index) => index >= 0)
      const checklistEnd = following.length > 0 ? Math.min(...following) : tail.length
      tail = tail.slice(0, checklistStart) + tail.slice(checklistEnd)
    }
    if (checklistMarkdown.trim()) tail = `\n\n${neutralizeCheckboxes(checklistMarkdown.trim())}${tail}`
  }
  const spliced = `${body.slice(0, start)}${neutralizeCheckboxes(reportMarkdown.trim())}${tail}`
  return withOwnerBoundary(spliced, false, ownerBoundary).replace(`\n\n${FINAL_COMMENT_MERGE_LINE}`, `\n\n${FINAL_COMMENT_UPDATED_LINE}`)
}

/** The comment's title line (`buildFinalComment`'s first paragraph). */
export const FINAL_COMMENT_TITLE = "**infinite-tag: what happened**"

/**
 * Where the report begins in a posted "what happened" comment: `buildFinalComment` writes the title, ONE review
 * sentence, then the report (its headline first). Null when the body is not in that shape (nothing is guessed).
 */
function reportStartIn(body: string): number | null {
  const title = body.indexOf(FINAL_COMMENT_TITLE)
  if (title < 0) return null
  const reviewStart = body.indexOf("\n\n", title + FINAL_COMMENT_TITLE.length)
  if (reviewStart < 0) return null
  const reviewEnd = body.indexOf("\n\n", reviewStart + 2)
  return reviewEnd < 0 ? null : reviewEnd + 2
}

export function excerpt(text: string, max = 160): string {
  const flat = neutralizeHtmlComments(text).replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Untrusted text with no live HTML comment left in it: whole `<!-- … -->` comments are dropped, then every
 * remaining opener (`<!`) and closer (`-->`) loses its angle bracket to an entity. A comment rebuilt by the
 * removal (`<!<!---->--`) or an unclosed `<!--` (which would hide the rest of the PR comment, the run marker
 * included) cannot survive: the bracket is replaced one character at a time, which cannot leave one behind.
 */
export function neutralizeHtmlComments(text: string): string {
  return dropHtmlComments(text).replace(/<(?=!)/g, "&lt;").replace(/(?<=--)>/g, "&gt;")
}

/** Whole `<!-- … -->` comments removed, scanning once (a lazy `<!--[\s\S]*?-->` regex is quadratic on many unclosed openers). */
function dropHtmlComments(text: string): string {
  let out = ""
  let at = 0
  for (;;) {
    const open = text.indexOf("<!--", at)
    if (open === -1) break
    const close = text.indexOf("-->", open + 4)
    if (close === -1) break
    out += text.slice(at, open)
    at = close + 3
  }
  return out + text.slice(at)
}
