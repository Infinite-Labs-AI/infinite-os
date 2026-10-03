// Everything the wizard posts on the PR (lane O4, §3g.3–§3g.5), built here and scanned here:
// the PR body, the ONE review (`event: COMMENT`; a finding outside a diff hunk goes into the body), the replies,
// and the final comment. Statuses are plain text the wizard owns: a literal `- [ ]` (which anyone can tick) is
// never posted. On a public repo, a provider ID that is not already in the diff is shown as `<id>`.
import { sanitizeUntrustedBlock } from "../agents/sanitize.js"
import type { AgentKind, ReviewResult } from "../wizard/contracts/agents.js"
import { FORBIDDEN_CHECKBOX, PR_MARKERS } from "../wizard/contracts/git-host.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { lineInHunk, type DiffFile } from "./diff.js"
import { mostlyRedacted, type Scanner } from "./scan.js"
import type { TriageDecision } from "./triage.js"
import { escapeMarkdownCell } from "../text-escape.js"

export const AGENT_LABEL: Record<AgentKind, string> = { claude_code: "Claude Code", codex: "Codex" }

/** Task-list checkboxes become plain bullets (any collaborator could tick one and fake a "done"). */
export function neutralizeCheckboxes(text: string): string {
  return text.replace(/^(\s*[-*+]\s+)\[[ xX]\]\s?/gm, "$1").split(FORBIDDEN_CHECKBOX).join("- ")
}

function escapeCell(text: string): string {
  return escapeMarkdownCell(text).trim()
}

/** Strips C0 control characters (but newlines and tabs) from untrusted text before it is posted. */
export function stripControl(text: string): string {
  // The ONE sanitiser's multi-line shape (§3z.12 B9): newlines and tabs kept, everything else hostile stripped.
  return sanitizeUntrustedBlock(text, 65_536)
}

/** The scan + control-strip every posted string goes through. */
export function safeText(scanner: Scanner, text: string): string {
  return scanner.redact(stripControl(text)).text
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
  reportMarkdown: string
  howToReview: string
  runId: string
  isPrivate: boolean
  diffText: string
  connectionIds: readonly string[]
  scanner: Scanner
  notes?: readonly string[]
}): string {
  const parts = [input.reportMarkdown.trim(), ...(input.notes ?? []).map((note) => `> ${note}`), input.howToReview.trim()]
  let body = neutralizeCheckboxes(safeText(input.scanner, parts.filter(Boolean).join("\n\n")))
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
}): ReviewPost {
  const marker = PR_MARKERS.review({ runId: input.runId, round: input.round, head: input.head, reviewer: input.reviewer })
  const threads: ReviewPost["threads"] = []
  const bodyFindings: string[] = []
  const inBody: string[] = []
  for (const finding of input.review.findings) {
    const raw = `${finding.body}${finding.suggested_fix ? `\n\nSuggested fix: ${finding.suggested_fix}` : ""}`
    const scanned = safeText(input.scanner, raw)
    // The path is reviewer text too: it is scanned like the body before it appears anywhere.
    const path = safeText(input.scanner, finding.path)
    const location = finding.line === null ? path : `${path}:${finding.line}`
    const text = mostlyRedacted(raw, scanned)
      ? `A finding on ${location} was withheld because it quoted a secret or personal data.`
      : scanned
    const label = `**[${finding.item} ${finding.severity}]** ${finding.id}`
    if (finding.line !== null && path === finding.path && lineInHunk(input.diffFiles, finding.path, finding.line)) {
      threads.push({ path: finding.path, line: finding.line, body: `${neutralizeCheckboxes(`${label}\n\n${text}`)}\n\n${marker}` })
    } else {
      inBody.push(finding.id)
      bodyFindings.push(`- ${label} \`${location.replace(/`/g, "'")}\`: ${text.replace(/\n+/g, " ")}`)
    }
  }
  const checklist = input.review.checklist
    .map((row) => `| ${row.item} | ${STATUS_TEXT[row.status]} | ${escapeCell(safeText(input.scanner, row.note))} |`)
    .join("\n")
  const verdict = input.review.verdict === "looks_good" ? "looks good" : "changes suggested"
  const unchecked = input.unchecked ?? []
  const header =
    unchecked.length > 0
      ? `**Second review by ${AGENT_LABEL[input.reviewer]} (round ${input.round}): incomplete — it could not check ${unchecked.join(", ")}.** Posted by infinite-tag; a review is an opinion, not a receipt.`
      : `**Second review by ${AGENT_LABEL[input.reviewer]} (round ${input.round}): ${verdict}.** Posted by infinite-tag; a review is an opinion, not a receipt.`
  const content = [
    header,
    safeText(input.scanner, input.review.summary),
    checklist ? `| Item | Status | Note |\n|---|---|---|\n${checklist}` : "",
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
export type NotFixedOutcome = "timeout" | "toolless" | "error" | "no_change" | "checks_failed"

/** The one wording of a not-fixed reply (thread reply, run note and terminal line say the same words). */
export function notFixedReply(outcome: NotFixedOutcome, why?: string | null): string {
  switch (outcome) {
    case "timeout":
      return "Not fixed: the agent ran out of its 5 minutes before changing anything. It stays open."
    case "toolless":
      return "Not fixed: the agent could not use its tools. It stays open."
    case "error":
      return "Not fixed: the agent stopped with an error before changing anything. It stays open."
    case "no_change":
      return "Not fixed: the agent finished without changing anything. It stays open."
    case "checks_failed":
      return `Not fixed this round: the agent's change did not pass the wizard's checks${why ? ` (${stripControl(why).slice(0, 200)})` : ""}. It stays open.`
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
          : notFixedReply(fix?.kind === "not_fixed" ? (fix.outcome ?? "checks_failed") : "checks_failed", fix?.kind === "not_fixed" ? fix.why : null)
      : decision.action === "INFINITE"
        ? `This is ${decision.label ?? "Infinite's own code"} (${safeText(scanner, decision.item.path ?? "general")}), which the wizard never hands to your agent. The finding is recorded in this run's report for Infinite to fix.`
      : decision.action === "ASK"
        ? `Waiting on the repo owner: ${safeText(scanner, decision.reason)}`
        : safeText(scanner, decision.reason)
  return `${neutralizeCheckboxes(stripControl(text))}\n\n${PR_MARKERS.reply}`
}

export interface FinalCommentInput {
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
  const state = job.state.replace(/_/g, " ")
  if ((job.state === "failed" || job.state === "blocked") && job.note) return `${state}: ${job.note}`
  return `${state}${job.blockedReason ? ` (${job.blockedReason.replace(/_/g, " ")})` : ""}`
}

/** §3g.4 step 9: the before/after table, the checklist states, declined items with reasons, and what the user decides. */
export function buildFinalComment(input: FinalCommentInput): string {
  const jobs = input.jobs
    .map((job) => `| ${escapeCell(job.title)} | ${escapeCell(jobStateCell(job))} |`)
    .join("\n")
  const declined = input.decisions
    .filter((decision) => decision.action === "DECLINE")
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason}`)
  const open = input.decisions
    .filter((decision) => decision.action === "ASK")
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason} (${excerpt(decision.item.body)})`)
  const agentLabel = input.reviewer === "claude_code" || input.reviewer === "codex" ? AGENT_LABEL[input.reviewer] : null
  const review =
    agentLabel && input.completeness?.state === "blind"
      ? `No second review (${agentLabel} could not read the files).`
      : input.reviewer === null || input.reviewer === "brief" || !input.reviewed || !agentLabel
        ? "No second review ran on this pull request."
        : input.completeness?.state === "incomplete"
          ? `Reviewed by ${agentLabel} (incomplete: ${input.completeness.unchecked.join(", ")} not checked). A review is an opinion; only a receipt from this run means "proven".`
          : `Reviewed by ${agentLabel}. A review is an opinion; only a receipt from this run means "proven".`
  const text = [
    "**infinite-tag: what happened**",
    review,
    input.reportMarkdown.trim(),
    jobs ? `**Checklist (the wizard's own checks, never the agent's word)**\n\n| Job | State |\n|---|---|\n${jobs}` : "",
    declined.length > 0 ? `**Declined, with reasons**\n\n${declined.join("\n")}` : "",
    open.length > 0 ? `**You decide**\n\n${open.join("\n")}` : "",
    input.untrusted.length > 0
      ? `**Comments from people outside the repo (shown, not acted on)**\n\n${input.untrusted
          .map((comment) => `- @${comment.author}${comment.path ? ` on \`${comment.path}\`` : ""}: ${excerpt(comment.excerpt)}`)
          .join("\n")}`
      : "",
    ...input.notes.map((note) => `> ${note}`),
    FINAL_COMMENT_MERGE_LINE
  ]
    .filter(Boolean)
    .join("\n\n")
  return `${neutralizeCheckboxes(safeText(input.scanner, text))}\n\n${PR_MARKERS.final(input.runId)}\n`
}

/** The last line of the merge-time comment, and its replacement once the live check has run (R2-5). */
export const FINAL_COMMENT_MERGE_LINE = "Merge when you're happy. After it deploys, Infinite proves it live."
export const FINAL_COMMENT_UPDATED_LINE = "Updated after the live check: the table above is the run's final report, the same one as in the terminal and in Infinite."

/** The sections that follow the report in `buildFinalComment` (the report ends where the first of them starts). */
const AFTER_REPORT = ["\n\n**Checklist (the wizard's own checks", "\n\n**Declined, with reasons**", "\n\n**You decide**", "\n\n**Comments from people outside the repo", "\n\n> ", `\n\n${FINAL_COMMENT_MERGE_LINE}`, `\n\n${FINAL_COMMENT_UPDATED_LINE}`, "\n\n<!-- infinite-tag:"]

/**
 * R2-5 (live run 2): the "what happened" comment with its report replaced by the final one (after Prove), so the PR,
 * the terminal and the app show ONE report. Everything else in the comment (the review sentence, the checklist, the
 * decisions, the marker) is kept as posted. `reportMarkdown` must already be scanned by the caller. Returns null when
 * the body holds no report table (nothing is guessed).
 */
export function withFinalReport(body: string, reportMarkdown: string): string | null {
  const start = body.indexOf("### Before and after")
  if (start < 0) return null
  const ends = AFTER_REPORT.map((marker) => body.indexOf(marker, start)).filter((index) => index > start)
  if (ends.length === 0) return null
  const end = Math.min(...ends)
  const spliced = `${body.slice(0, start)}${neutralizeCheckboxes(reportMarkdown.trim())}${body.slice(end)}`
  return spliced.replace(`\n\n${FINAL_COMMENT_MERGE_LINE}`, `\n\n${FINAL_COMMENT_UPDATED_LINE}`)
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
