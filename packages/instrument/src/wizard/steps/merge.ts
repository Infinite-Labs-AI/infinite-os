// Step 10 `merge` (§3d.1, §3g.4 "Merge gate", lane O4). The USER merges; the wizard never runs `gh pr merge`,
// never `--admin`, never pushes to the base. It asks `merge-ready` (ENTER open on GitHub · ESC later), then polls
// `gh pr view --json state,mergedAt,mergeCommit` every 30 s while the terminal is open. Merged → the merge commit
// (`mergeCommit.oid`, never the head SHA: a squash merge does not contain it) is saved and PATCHed as the run's
// `mergeSha`. ESC / "later" → parked (exit 3); a re-run picks the PR back up.
import { createHash } from "node:crypto"
import { join } from "node:path"

import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import type { PrSummary } from "../contracts/git-host.js"
import { PR_LOOP_LIMITS } from "../contracts/git-host.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { wizardGitExtras } from "../../git/index.js"
import { isGitHubAdapter } from "../../hosts/github.js"
import { isUnsupported } from "../../hosts/other.js"
import { assertNoAgentAlive, requireRunId, status, sub } from "../../review/context.js"
import { mergeRequirementLine } from "../../github/rules.js"
import { parseLedger, REVIEW_LEDGER_PATH } from "../../review/ledger.js"

const meta = WIZARD_STEP_META.merge
/** "While the terminal is open": a day of polling, then the run parks (the desktop's watcher carries on). */
const MAX_POLL_MS = 24 * 60 * 60_000

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

function parked(reason: string, number: number | null): StepOutcome {
  return {
    kind: "parked",
    code: "INF_WIZ_MERGE_PARKED",
    reason,
    resumeHint: number
      ? `Merge pull request #${number} when you're happy, then run \`npx infinite-tag\` again: it picks up the merge and proves it live.`
      : "Merge the branch when you're happy, then run `npx infinite-tag` again: it picks up the merge and proves it live."
  }
}

async function saveMerge(ctx: WizardContext, deps: WizardDeps, runId: string, mergeSha: string, mergedAt: string | null): Promise<StepOutcome> {
  if (!/^[0-9a-f]{40}$/.test(mergeSha)) return { kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE", message: "The merge commit SHA could not be read.", next: "halt" }
  ctx.state.update((state) => {
    if (state.pr) state.pr.mergeSha = mergeSha
  })
  await ctx.state.save()
  assertNoAgentAlive(deps, "runs PATCH")
  await deps.bridge.patchRun(runId, { mergeSha, ...(mergedAt ? { mergedAt } : {}), phase: "merged" })
  sub(ctx, "merge", "✓ Merged", "ok")
  const line = "Merged · Vercel is deploying"
  status(ctx, "merge", line)
  return { kind: "ok", status: line }
}

/**
 * The `merge-ready` summary (§3d.3 `summary`, one string): its FIRST line is the sentence that goes between
 * "Pull request #N is ready." and "Merge it to ship." (the overlay adds both, so they are never said here);
 * every further line is a detail row shown under it (the design's "branch → base" and "N files changed").
 */
/**
 * §3y.7: the merge card's review words, from the review ledger's completeness: a blind review is "No second review
 * (<agent> could not read the files)", an incomplete one names how many items were not checked.
 */
export async function reviewSentence(ctx: Pick<WizardContext, "root">, deps: Pick<WizardDeps, "fs">, runId: string, reviewer: string | null): Promise<string> {
  const label = reviewer === "codex" ? "Codex" : reviewer === "claude_code" ? "Claude Code" : null
  if (!label) return "No second review"
  const completeness = parseLedger(await deps.fs.readText(join(ctx.root, REVIEW_LEDGER_PATH)), runId).completeness
  if (completeness?.state === "blind") return `No second review (${label} could not read the files)`
  if (completeness?.state === "incomplete") {
    const count = completeness.unchecked.length
    return `Review incomplete (${label} could not check ${count} item${count === 1 ? "" : "s"})`
  }
  return `Reviewed by ${label}`
}

export function mergeSummary(input: { sentence: string; branch: string; base: string; filesChanged: number | null; checks: string }): string {
  const files = input.filesChanged === null ? null : `${input.filesChanged} file${input.filesChanged === 1 ? "" : "s"} changed`
  return [input.sentence, `${input.branch} → ${input.base}`, [files, input.checks].filter(Boolean).join(" · ")].filter(Boolean).join("\n")
}

/** How many files the pull request changes (base...head), or null when the diff cannot be read. */
async function filesChanged(deps: WizardDeps, baseSha: string | null | undefined, headSha: string | null | undefined): Promise<number | null> {
  if (!baseSha || !headSha) return null
  try {
    return ((await deps.git.diff(baseSha, headSha)).match(/^diff --git /gm) ?? []).length
  } catch {
    // A detail row only: the merge question is still asked without it.
    return null
  }
}

/**
 * §3y.9: opens `merge-ready` and polls `gh pr view` every 30 s until the card closes. A merge (or a close) seen while
 * the card is up aborts the ask through its signal (§3z.12 §3d.8), so the card closes by itself, with no keypress.
 */
export async function askWhilePolling(
  ctx: WizardContext,
  deps: WizardDeps,
  github: { readPr(number: number): Promise<PrSummary> },
  number: number,
  payload: { prUrl: string; number: number; summary: string }
): Promise<{ answer: "open" | "later" | string; pr: PrSummary | null }> {
  const close = new AbortController()
  const stop = new AbortController()
  let seen: PrSummary | null = null
  const poller = (async () => {
    while (!stop.signal.aborted && !ctx.signal.aborted) {
      await deps.clock.sleep(PR_LOOP_LIMITS.mergePollMs, stop.signal).catch(() => undefined)
      if (stop.signal.aborted || ctx.signal.aborted) return
      let pr: PrSummary
      try {
        pr = await github.readPr(number)
      } catch {
        // A failed read is retried on the next poll.
        continue
      }
      if ((pr.state === "MERGED" && pr.mergeCommitOid) || pr.state === "CLOSED") {
        seen = pr
        close.abort()
        return
      }
    }
  })()
  try {
    const answer = await ctx.ask("merge-ready", payload, { signal: close.signal })
    return { answer: String(answer), pr: seen }
  } finally {
    stop.abort()
    await poller
  }
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const runId = requireRunId(ctx)
  if (!runId) return { kind: "failed", code: "INF_WIZ_PR_CREATE_FAILED", message: "There is no run id yet.", next: "halt" }
  const state = ctx.state.get()
  if (!state.pr || !state.git) return { kind: "skipped", reason: "No pull request to merge: nothing was committed this run." }
  if (state.pr.mergeSha) return { kind: "ok", status: "Merged · Vercel is deploying" }

  const github = isGitHubAdapter(deps.host) && state.pr.number !== null && (await deps.host.auth()).ok ? deps.host : null
  if (!github) {
    // No merge API the wizard can read: the branch's head reaching the base IS the merge (a merge commit or a
    // fast-forward; a squash on such a host needs a re-run after the user says so).
    const git = wizardGitExtras(deps.git)
    const head = state.git.headSha
    const baseSha = git ? await git.remoteBranchSha(state.git.base) : null
    if (git && head && baseSha && (await git.isAncestor(head, baseSha))) return saveMerge(ctx, deps, runId, baseSha, null)
    const answer = await ctx.ask("merge-ready", {
      prUrl: state.pr.url ?? state.git.branch,
      number: 0,
      summary: `Merge ${state.git.branch} into ${state.git.base} on your git host.`
    })
    return parked(answer === "open" ? "Waiting for you to merge on your git host." : "You chose to merge later.", null)
  }

  const number = state.pr.number!
  let pr = await github.readPr(number)
  if (pr.state === "MERGED" && pr.mergeCommitOid) return saveMerge(ctx, deps, runId, pr.mergeCommitOid, pr.mergedAt)
  if (pr.state === "CLOSED") return parked("The pull request was closed without merging. Run `npx infinite-tag` to start a fresh run.", null)

  const rules = await github.rules(state.git.base)
  const requirement = isUnsupported(rules) ? null : mergeRequirementLine({ reviewDecision: pr.reviewDecision, ...rules })
  const once = state.report.in_pr?.finishLine.each_tool_once?.state
  const reviewed = await reviewSentence(ctx, deps, runId, state.agent?.reviewer ?? null)
  const rehearsal = once === "pass" ? "rehearsal passed" : once === "problem" ? "rehearsal found a problem" : "rehearsal undetermined"
  const summary = mergeSummary({
    sentence: [`${reviewed} · ${rehearsal}.`, requirement].filter(Boolean).join(" "),
    branch: state.git.branch,
    base: state.git.base,
    filesChanged: await filesChanged(deps, state.git.baseSha, state.git.headSha),
    checks: once === "pass" ? "rehearsal passed on the latest commit" : once === "problem" ? "the rehearsal found a problem" : "the rehearsal could not tell"
  })
  sub(ctx, "merge", `Waiting for you to merge #${number}…`, "pending")
  // §3y.9 (P2-6): GitHub is polled every 30 s WHILE the card is up; a merge seen closes the card (the ask's signal).
  const seen = await askWhilePolling(ctx, deps, github, number, { prUrl: pr.url, number, summary })
  if (seen.pr?.state === "MERGED" && seen.pr.mergeCommitOid) {
    sub(ctx, "merge", "✓ Merged on GitHub", "ok")
    return saveMerge(ctx, deps, runId, seen.pr.mergeCommitOid, seen.pr.mergedAt)
  }
  if (seen.pr?.state === "CLOSED") return parked("The pull request was closed without merging. Run `npx infinite-tag` to start a fresh run.", null)
  const answer = seen.answer
  if (answer !== "open") {
    // ESC / later: one final read, so a merge made just now is never missed.
    const last = await github.readPr(number).catch(() => null)
    if (last?.state === "MERGED" && last.mergeCommitOid) {
      sub(ctx, "merge", "✓ Merged on GitHub", "ok")
      return saveMerge(ctx, deps, runId, last.mergeCommitOid, last.mergedAt)
    }
    return parked(answer === "later" ? "You chose to merge later." : "The merge question was closed.", number)
  }
  // B29: "open" opens the pull request in the browser (darwin TTY runs; the wiring sets `openUrl` only there).
  if (!ctx.options.json && deps.openUrl && /^https:\/\//.test(pr.url)) await deps.openUrl(pr.url).catch(() => undefined)
  sub(ctx, "merge", "Checking GitHub every 30 s — merge whenever you're ready (ESC later)", "pending")

  const started = deps.clock.now().getTime()
  for (;;) {
    if (ctx.signal.aborted) return parked("Stopped while waiting for the merge.", number)
    if (deps.clock.now().getTime() - started > MAX_POLL_MS) return parked("Still not merged after a day of waiting.", number)
    try {
      pr = await github.readPr(number)
    } catch {
      // A failed read is retried on the next poll.
      await deps.clock.sleep(PR_LOOP_LIMITS.mergePollMs, ctx.signal)
      continue
    }
    if (pr.state === "MERGED" && pr.mergeCommitOid) return saveMerge(ctx, deps, runId, pr.mergeCommitOid, pr.mergedAt)
    if (pr.state === "CLOSED") return parked("The pull request was closed without merging. Run `npx infinite-tag` to start a fresh run.", null)
    await deps.clock.sleep(PR_LOOP_LIMITS.mergePollMs, ctx.signal)
  }
}

export const step: WizardStep<"merge"> = {
  id: "merge",
  title: meta.title,
  who: [...meta.who],
  learn: meta.learn,
  requiredCapabilities: [...meta.requiredCapabilities],
  inputHash: (ctx) => {
    const state = ctx.state?.get?.()
    return sha256(`merge:${state?.pr?.number ?? ""}:${state?.git?.headSha ?? ""}`)
  },
  run
}
