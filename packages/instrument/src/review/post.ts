// Everything the wizard posts on the PR (lane O4, §3g.3–§3g.5), built here and scanned here:
// the PR body, the ONE review (`event: COMMENT`; a finding outside a diff hunk goes into the body), the replies,
// and the final comment. Statuses are plain text the wizard owns: a literal `- [ ]` (which anyone can tick) is
// never posted. On a public repo, a provider ID that is not already in the diff is shown as `<id>`.
import type { AgentKind, ReviewResult } from "../wizard/contracts/agents.js"
import { FORBIDDEN_CHECKBOX, PR_MARKERS } from "../wizard/contracts/git-host.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { lineInHunk, type DiffFile } from "./diff.js"
import { mostlyRedacted, type Scanner } from "./scan.js"
import type { TriageDecision } from "./triage.js"

export const AGENT_LABEL: Record<AgentKind, string> = { claude_code: "Claude Code", codex: "Codex" }

/** Task-list checkboxes become plain bullets (any collaborator could tick one and fake a "done"). */
export function neutralizeCheckboxes(text: string): string {
  return text.replace(/^(\s*[-*+]\s+)\[[ xX]\]\s?/gm, "$1").split(FORBIDDEN_CHECKBOX).join("- ")
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

/** Strips C0 control characters (but newlines and tabs) from untrusted text before it is posted. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
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
}): ReviewPost {
  const marker = PR_MARKERS.review({ runId: input.runId, round: input.round, head: input.head, reviewer: input.reviewer })
  const threads: ReviewPost["threads"] = []
  const bodyFindings: string[] = []
  const inBody: string[] = []
  for (const finding of input.review.findings) {
    const raw = `${finding.body}${finding.suggested_fix ? `\n\nSuggested fix: ${finding.suggested_fix}` : ""}`
    const scanned = safeText(input.scanner, raw)
    const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`
    const text = mostlyRedacted(raw, scanned)
      ? `A finding on ${location} was withheld because it quoted a secret or personal data.`
      : scanned
    const label = `**[${finding.item} ${finding.severity}]** ${finding.id}`
    const path = safeText(input.scanner, finding.path)
    if (finding.line !== null && path === finding.path && lineInHunk(input.diffFiles, finding.path, finding.line)) {
      threads.push({ path: finding.path, line: finding.line, body: `${label}\n\n${text}\n\n${marker}` })
    } else {
      inBody.push(finding.id)
      bodyFindings.push(`- ${label} \`${location}\`: ${text.replace(/\n+/g, " ")}`)
    }
  }
  const checklist = input.review.checklist
    .map((row) => `| ${row.item} | ${STATUS_TEXT[row.status]} | ${escapeCell(safeText(input.scanner, row.note))} |`)
    .join("\n")
  const verdict = input.review.verdict === "looks_good" ? "looks good" : "changes suggested"
  const body = neutralizeCheckboxes(
    [
      `**Second review by ${AGENT_LABEL[input.reviewer]} (round ${input.round}): ${verdict}.** Posted by infinite-tag; a review is an opinion, not a receipt.`,
      safeText(input.scanner, input.review.summary),
      checklist ? `| Item | Status | Note |\n|---|---|---|\n${checklist}` : "",
      bodyFindings.length > 0 ? `**Notes outside the changed lines**\n\n${bodyFindings.join("\n")}` : "",
      marker
    ]
      .filter(Boolean)
      .join("\n\n")
  )
  return { body, threads, inBody }
}

/** The reply on a thread (never re-read as feedback). */
export function buildReply(scanner: Scanner, decision: TriageDecision, fixSha: string | null): string {
  const text =
    decision.action === "FIX"
      ? fixSha
        ? `Fixed in ${fixSha.slice(0, 7)}; the wizard re-ran its checks and the rehearsal on that commit.`
        : "Not fixed this round: the agent's change did not pass the wizard's checks. It stays open."
      : decision.action === "ASK"
        ? `Waiting on the repo owner: ${decision.reason}`
        : decision.reason
  return `${safeText(scanner, text)}\n\n${PR_MARKERS.reply}`
}

export interface FinalCommentInput {
  runId: string
  reportMarkdown: string
  reviewer: AgentKind | "brief" | null
  reviewed: boolean
  jobs: readonly ChecklistItem[]
  decisions: readonly TriageDecision[]
  /** Comments from people outside the repo: listed, never acted on. */
  untrusted: ReadonlyArray<{ author: string; path: string | null; excerpt: string }>
  notes: readonly string[]
  scanner: Scanner
}

/** §3g.4 step 9: the before/after table, the checklist states, declined items with reasons, and what the user decides. */
export function buildFinalComment(input: FinalCommentInput): string {
  const jobs = input.jobs
    .map((job) => `| ${escapeCell(job.title)} | ${job.state.replace(/_/g, " ")}${job.blockedReason ? ` (${job.blockedReason.replace(/_/g, " ")})` : ""} |`)
    .join("\n")
  const declined = input.decisions
    .filter((decision) => decision.action === "DECLINE")
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason}`)
  const open = input.decisions
    .filter((decision) => decision.action === "ASK")
    .map((decision) => `- ${decision.item.path ? `\`${decision.item.path}\`` : "general"}: ${decision.reason} (${excerpt(decision.item.body)})`)
  const review =
    input.reviewer === null || input.reviewer === "brief" || !input.reviewed
      ? "No second review ran on this pull request."
      : `Reviewed by ${AGENT_LABEL[input.reviewer]}. A review is an opinion; only a receipt from this run means "proven".`
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
    "Merge when you're happy. After it deploys, Infinite proves it live."
  ]
    .filter(Boolean)
    .join("\n\n")
  return `${neutralizeCheckboxes(safeText(input.scanner, text))}\n\n${PR_MARKERS.final(input.runId)}\n`
}

export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
