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
import { commitChecks, withDeploymentStates, readinessChecks, retryCheckRead } from "../../github/checks.js"
import { mergeRequirementLine } from "../../github/rules.js"
import { parseLedger, REVIEW_LEDGER_PATH } from "../../review/ledger.js"
import { verdictFactsFor } from "../verdict-facts.js"
import { incompleteParts } from "../verdict.js"
import { repoLabelFromRemote } from "./done.js"

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

/**
 * §3x.6 The tag's `in_pr` report reaches Infinite BEFORE the merge (at the merge-ready card, or when a merge is seen
 * first): its verdict is `not_checked_live` and already names any approved fix not in the code and any open review
 * blocker. Returns what the PR lacks (the merge card's words), or null.
 */
async function postInPrReport(ctx: WizardContext, deps: WizardDeps, runId: string): Promise<string | null> {
  const state = ctx.state.get()
  if (!state.report.in_pr) return null
  const keys = deps.bridge.has("tag.keys.v1") ? await deps.bridge.keys().catch(() => null) : null
  const report = deps.report.build({
    runId,
    tagVersion: deps.tagVersion,
    site: { repoLabel: repoLabelFromRemote(await deps.git.remoteUrl().catch(() => null), ctx.root), productionHost: keys?.infinite.productionHosts[0] ?? state.site?.productionHost ?? null },
    columns: { live_today: state.report.live_today, in_pr: state.report.in_pr, proven_live: null },
    provenLivePending: "deploy",
    runStartedAt: state.runStartedAt ?? null,
    day7: null,
    notes: [],
    verdictFacts: await verdictFactsFor(ctx, deps)
  })
  assertNoAgentAlive(deps, "report post")
  await deps.bridge.postReport(runId, "in_pr", deps.report.payload(report))
  return report.verdict ? incompleteParts(report.verdict, state.jobs) : null
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
  const ledger = parseLedger(await deps.fs.readText(join(ctx.root, REVIEW_LEDGER_PATH)), runId)
  // Live run 5 (P2): a review posted from the printed brief and read back is a review (its round is in the ledger).
  if (!label) return reviewer === "brief" && ledger.rounds.some((round) => round.reviewer === "brief") ? `Reviewed from the printed review brief${ledger.completeness?.state === "incomplete" ? " (review incomplete)" : ""}` : "No second review"
  const completeness = ledger.completeness
  if (completeness?.state === "blind") return `Review incomplete (${label} could not read the files)`
  if (completeness?.state === "incomplete") {
    const count = completeness.unchecked.length
    return `Review incomplete (${label} could not check ${count} item${count === 1 ? "" : "s"})`
  }
  return ledger.rounds.length > 0 && completeness?.state === "complete" ? `Reviewed by ${label}` : "No second review ran"
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
  payload: { prUrl: string; number: number; summary: string; incomplete?: string }
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
    const lacking = await postInPrReport(ctx, deps, runId)
    if (git && head && baseSha && (await git.isAncestor(head, baseSha))) return saveMerge(ctx, deps, runId, baseSha, null)
    const answer = await ctx.ask("merge-ready", {
      prUrl: state.pr.url ?? state.git.branch,
      number: 0,
      summary: `Merge ${state.git.branch} into ${state.git.base} on your git host.`,
      ...(lacking ? { incomplete: lacking } : {})
    })
    return parked(answer === "open" ? "Waiting for you to merge on your git host." : "You chose to merge later.", null)
  }

  const number = state.pr.number!
  let pr = await github.readPr(number)
  // §3x.6: the in-PR report (and its verdict) reaches Infinite before the merge is recorded.
  const lacking = pr.state === "CLOSED" ? null : await postInPrReport(ctx, deps, runId)
  if (pr.state === "MERGED" && pr.mergeCommitOid) return saveMerge(ctx, deps, runId, pr.mergeCommitOid, pr.mergedAt)
  if (pr.state === "CLOSED") return parked("The pull request was closed without merging. Run `npx infinite-tag` to start a fresh run.", null)

  // The review step's snapshot may be stale on resume. Read this head again before inviting a merge.
  let checkLine: string
  try {
    const head = pr.headRefOid
    const base = await commitChecks(github.gh, state.git.baseSha).catch(() => [])
    for (;;) {
      const found = await retryCheckRead(async () => {
        const checks = await withDeploymentStates(github.gh, head, await commitChecks(github.gh, head))
        if (checks.some(check => !["pass", "fail", "cancel", "pending", "skipping"].includes(check.bucket))) throw new Error("PR check states could not be read")
        return checks
      }, ms => deps.clock.sleep(ms, ctx.signal))
      const measured = readinessChecks(found, base)
      measured.notes.forEach(note => sub(ctx, "merge", note, "warn"))
      const held = measured.checks.filter(check => !["pass", "skipping"].includes(check.bucket))
      const pushedAt = state.lastPush?.sha === head ? Date.parse(state.lastPush.at) : NaN
      const remaining = 10 * 60_000 - (deps.clock.now().getTime() - pushedAt)
      if (held.length && held.every(check => check.bucket === "pending") && remaining > 0 && !ctx.signal.aborted) {
        status(ctx, "merge", `Waiting on PR checks: ${held.map(check => check.name).join(", ")}`)
        await deps.clock.sleep(Math.min(30_000, remaining), ctx.signal)
        continue
      }
      if (held.length) return { kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason: `PR checks are not ready: ${held.map(check => `${check.name} (${check.state})`).join(", ")}.`, resumeHint: "Resolve the named checks, then run `npx infinite-tag` again." }
      checkLine = [...measured.notes, ...(measured.checks.length ? measured.checks.map(check => `${check.name}: ${check.bucket === "skipping" ? "not measured" : check.state}`) : measured.notes.length ? [] : ["no checks reported: not measured"])].join("; ")
      break
    }
  } catch {
    return { kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason: "PR checks could not be read after three attempts.", resumeHint: "Run `npx infinite-tag` again when GitHub checks can be read." }
  }

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
    checks: checkLine
  })
  sub(ctx, "merge", `Waiting for you to merge #${number}…`, "pending")
  // §3y.9 (P2-6): GitHub is polled every 30 s WHILE the card is up; a merge seen closes the card (the ask's signal).
  const seen = await askWhilePolling(ctx, deps, github, number, { prUrl: pr.url, number, summary, ...(lacking ? { incomplete: lacking } : {}) })
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
