// Step 10 `merge` (§3d.1, §3g.4 "Merge gate", lane O4). The USER merges; the wizard never runs `gh pr merge`,
// never `--admin`, never pushes to the base. It asks `merge-ready` (ENTER open on GitHub · ESC later), then polls
// `gh pr view --json state,mergedAt,mergeCommit` every 30 s while the terminal is open. Merged → the merge commit
// (`mergeCommit.oid`, never the head SHA: a squash merge does not contain it) is saved and PATCHed as the run's
// `mergeSha`. ESC / "later" → parked (exit 3); a re-run picks the PR back up.
import { createHash } from "node:crypto"

import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { PR_LOOP_LIMITS } from "../contracts/git-host.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { wizardGitExtras } from "../../git/index.js"
import { isGitHubAdapter } from "../../hosts/github.js"
import { isUnsupported } from "../../hosts/other.js"
import { assertNoAgentAlive, requireRunId, status, sub } from "../../review/context.js"
import { mergeRequirementLine } from "../../github/rules.js"

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
  const reviewed = state.agent?.reviewer === "codex" ? "Reviewed by Codex" : state.agent?.reviewer === "claude_code" ? "Reviewed by Claude Code" : "No second review"
  const rehearsal = once === "pass" ? "rehearsal passed" : once === "problem" ? "rehearsal found a problem" : "rehearsal undetermined"
  const summary = [`Pull request #${number} is ready. ${reviewed} · ${rehearsal}. Merge it to ship.`, requirement].filter(Boolean).join(" ")
  sub(ctx, "merge", `Waiting for you to merge #${number}…`, "pending")
  const answer = await ctx.ask("merge-ready", { prUrl: pr.url, number, summary })
  if (answer !== "open") return parked(answer === "later" ? "You chose to merge later." : "The merge question was closed.", number)

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
