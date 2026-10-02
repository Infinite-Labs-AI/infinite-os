// Step 8 `rehearsal` (§3d.1, lane O4): commit → push → draft PR → wait for the Vercel preview → rehearse it
// under the production hostname (nothing sent) + load the preview's own URL → grade (O6's grader) → PATCH the
// run (PR fields, phase `in_pr`, `clickTestedConversions`) → mark GA4 key events for the rehearsal-click-tested
// names only. A protected preview, a non-Vercel host or no preview is `undetermined`, never pass.
import type { ChecklistItem } from "../contracts/jobs.js"
import { homedir } from "node:os"
import { finalSealPath } from "../../agents/paths.js"
import { verifyFinalSeal } from "../../agents/fence.js"
import { createHash } from "node:crypto"
import { join } from "node:path"

import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { PR_LOOP_LIMITS } from "../contracts/git-host.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import type { TestTool } from "../contracts/test-engine.js"
import { wizardGitExtras, type WizardGitOps } from "../../git/index.js"
import { canPush } from "../../github/repo.js"
import { isUnsupported } from "../../hosts/other.js"
import { howToReviewSection } from "../../review/brief.js"
import {
  allowlistUnion,
  assertNoAgentAlive,
  bestEffortBridge,
  bridgeStop,
  buildScanner,
  loadRunFacts,
  manifestFiles,
  repoLabelFrom,
  requireRunId,
  status,
  sub,
  type RunFacts
} from "../../review/context.js"
import { hookFixItem, runFixRound } from "../../review/fix.js"
import { buildPrBody } from "../../review/post.js"
import { parseLedger, REVIEW_LEDGER_PATH } from "../../review/ledger.js"
import { applyRehearsalToJobs, recordRehearsalCells, rehearsalLines, rehearse, type RehearsalOutcome } from "../../review/rehearse.js"
import type { Scanner } from "../../review/scan.js"
import { ensurePr, failed, pushBranch, stageAndCommit, type CommitResult } from "../../review/ship.js"

const meta = WIZARD_STEP_META.rehearsal

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

/** URLs the jobs' evidence names on the live site (the pages that hold the conversions). */
export function evidenceUrls(ctx: WizardContext): string[] {
  return ctx.state
    .get()
    .jobs.flatMap((job) => job.trigger.evidence)
    .flatMap((evidence) => ("url" in evidence ? [evidence.url] : []))
}

/** Emits the per-tool `check.result` events and the design's sub-status lines for one rehearsal. */
export function announceRehearsal(ctx: WizardContext, step: "rehearsal" | "review", outcome: RehearsalOutcome, runId: string): void {
  for (const tool of Object.keys(outcome.grades) as TestTool[]) {
    const result = outcome.grades[tool]
    if (!result) continue
    ctx.emit.emit("check.result", { checkId: result.checkId, tier: "RH", state: result.state, ...(result.reason ? { reason: result.reason } : {}), runId })
  }
  for (const line of rehearsalLines(outcome)) sub(ctx, step, line.text, line.tone)
}

/** The rehearsal-click-tested bookkeeping (§3d.1): PATCH first (append-only), then GA4 key events for exactly those names ∩ approved. */
export async function recordClickTests(
  ctx: WizardContext,
  deps: WizardDeps,
  input: { step: "rehearsal" | "review"; runId: string; outcome: RehearsalOutcome; approved: readonly string[] }
): Promise<void> {
  const approved = new Set(input.approved)
  const names = input.outcome.ga4ClickTested.filter((name) => approved.has(name))
  if (names.length === 0 || !deps.bridge.has("tag.ga4-key-events.v1")) return
  assertNoAgentAlive(deps, "ga4-key-events")
  let response: Awaited<ReturnType<WizardDeps["bridge"]["markGa4KeyEvents"]>> | null = null
  await bestEffortBridge(ctx, input.step, "mark the GA4 key events", async () => {
    response = await deps.bridge.markGa4KeyEvents({ runId: input.runId, names })
  })
  if (response === null) return
  const done: Awaited<ReturnType<WizardDeps["bridge"]["markGa4KeyEvents"]>> = response
  const marked = [...done.created, ...done.alreadyExisted]
  if (marked.length > 0) sub(ctx, input.step, `GA4 key events: marked for ${marked.length} conversion(s) (click test passed)`, "ok")
  for (const refusal of done.refused) sub(ctx, input.step, `GA4 key event not marked for ${refusal.name}: ${refusal.reason.replace(/_/g, " ")}`, "warn")
}

/** The click-tested names already PATCHed this run (the review step PATCHes only new ones), in the review ledger. */
export async function rememberClickTested(ctx: WizardContext, deps: WizardDeps, runId: string, names: readonly string[]): Promise<void> {
  const path = join(ctx.root, REVIEW_LEDGER_PATH)
  const ledger = parseLedger(await deps.fs.readText(path), runId)
  ledger.clickTested = [...new Set([...(ledger.clickTested ?? []), ...names])].sort()
  await deps.fs.mkdirp(join(ctx.root, WIZARD_PATHS.dir), 0o700)
  await deps.fs.writeTextAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`, 0o600)
}

export interface ShipContext {
  runId: string
  git: WizardGitOps
  facts: RunFacts
  scanner: Scanner
  remoteUrl: string | null
  repoLabel: string
  ghReady: boolean
  isPrivate: boolean
}

/** The facts every O4 step needs, or a failed outcome. */
export async function prepareShip(ctx: WizardContext, deps: WizardDeps): Promise<ShipContext | StepOutcome> {
  const runId = requireRunId(ctx)
  if (!runId) return failed("INF_WIZ_PR_CREATE_FAILED", "There is no run id yet (the `agent` step creates it).")
  const git = wizardGitExtras(deps.git)
  if (!git) return failed("INF_WIZ_PR_CREATE_FAILED", "The wizard's git operations are not wired (WizardGitOps).")
  const state = ctx.state.get()
  if (!state.git) return failed("INF_WIZ_BRANCH_FAILED", "The pull request branch was not created before the scan.")
  git.setBase(state.git.base)
  const current = await git.currentBranch()
  if (current !== state.git.branch) {
    try {
      await git.switchTo(state.git.branch)
    } catch {
      return failed("INF_WIZ_BRANCH_FAILED", `Could not switch back to ${state.git.branch}.`)
    }
  }
  const facts = await loadRunFacts(deps)
  const scanner = buildScanner(ctx, deps, facts.connectionIds)
  const remoteUrl = await git.remoteUrl()
  let ghReady = false
  let isPrivate = false
  if (deps.host.kind === "github") {
    const auth = await deps.host.auth()
    ghReady = auth.ok
    if (ghReady) {
      const repo = await deps.host.repoFacts()
      if (!isUnsupported(repo)) {
        isPrivate = repo.isPrivate
        if (!canPush(repo.viewerPermission)) {
          return failed(
            "INF_WIZ_PUSH_REFUSED",
            `Your GitHub access to this repo is ${repo.viewerPermission ?? "unknown"}, so the wizard cannot push a branch. Ask for write access; the wizard never forks.`
          )
        }
      }
    }
  }
  return { runId, git, facts, scanner, remoteUrl, repoLabel: repoLabelFrom(remoteUrl, ctx.root), ghReady, isPrivate }
}

export function isShipContext(value: ShipContext | StepOutcome): value is ShipContext {
  return "git" in value && "scanner" in value
}

/** Turns a commit result that stops the step into its outcome (null = go on). */
export function commitStop(result: CommitResult): StepOutcome | null {
  switch (result.kind) {
    case "refused":
      return failed("INF_WIZ_DIRTY_TREE", result.message)
    case "failed":
      return failed("INF_WIZ_PR_CREATE_FAILED", result.message)
    case "hook_failed":
      return failed(
        "INF_WIZ_PR_CREATE_FAILED",
        result.ourFiles.length > 0
          ? `A commit hook failed on the wizard's files (${result.ourFiles.join(", ")}). Your changes are staged; fix the hook's complaint, run \`${result.command}\`, then \`npx infinite-tag --resume\`.\n${result.output}`
          : `A commit hook failed on files the wizard did not change. Your changes are staged. Once the hook passes, run \`${result.command}\`, then \`npx infinite-tag --resume\`.\n${result.output}`
      )
    default:
      return null
  }
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  try {
    return await rehearsalRun(ctx, deps)
  } catch (error) {
    const stop = bridgeStop(error)
    if (stop) {
      await ctx.state.save()
      return stop
    }
    throw error
  }
}

async function rehearsalRun(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const prepared = await prepareShip(ctx, deps)
  if (!isShipContext(prepared)) return prepared
  const { runId, git, facts, scanner } = prepared
  const state = ctx.state.get()
  const gitState = state.git!
  const { managed, npmFiles } = await manifestFiles(deps, ctx.root)
  const allowlist = allowlistUnion(state.jobs)

  // B5/B29: the tree the agent jobs left is re-read right before anything is staged; a write after the last
  // turn (a process an agent left running) stops the run instead of being committed.
  const seal = await verifyFinalSeal(ctx.root, finalSealPath(deps.env.HOME ?? homedir(), runId))
  if (seal && !seal.ok) {
    return {
      kind: "blocked",
      code: "INF_WIZ_FENCE_TAMPER",
      reason: `Files changed after the agent's last turn (${seal.changed.slice(0, 3).join(", ")}${seal.changed.length > 3 ? ", …" : ""}); a process it started may still be running. Nothing was committed.`
    }
  }

  sub(ctx, "rehearsal", "Committing the changes…", "pending")
  const commitOnce = () =>
    stageAndCommit({
      ctx,
      deps,
      git,
      step: "rehearsal",
      scanner,
      runId,
      message: `infinite-tag: set up analytics (run ${state.displayId})`,
      round: null,
      allowlist,
      managed,
      npmFiles,
      connectionIds: facts.connectionIds
    })
  let commit = await commitOnce()
  // §3g.1: a commit hook that fails on the wizard's OWN files gets a fix round through the worker (≤ 2).
  const worker = state.agent?.worker ?? null
  for (let round = 1; commit.kind === "hook_failed" && commit.ourFiles.length > 0 && worker !== null && round <= PR_LOOP_LIMITS.maxFixRounds; round += 1) {
    const fixable = commit.ourFiles.filter((file) => allowlist.includes(file) || managed.includes(file))
    if (fixable.length === 0) break
    sub(ctx, "rehearsal", `A commit hook flagged ${fixable.length} file(s); ${worker === "codex" ? "Codex" : "Claude Code"} is fixing them…`, "pending")
    const item = hookFixItem(fixable, commit.output)
    ctx.emit.emit("job.seeded", { item })
    const fix = await runFixRound(ctx, deps, { step: "rehearsal", worker, items: [item], scanner })
    if (fix.run.outcome === "out_of_usage") {
      await ctx.state.save()
      return { kind: "parked", code: "INF_WIZ_AGENT_OUT_OF_USAGE", reason: "The worker agent is out of usage while fixing a commit hook.", resumeHint: "Run `npx infinite-tag` again when your plan resets." }
    }
    // The hook itself re-checks the fix on the next commit; the receipt (a managed file) goes into that commit.
    if (fix.run.edits.length > 0) await deps.installer.recordEdits(fix.run.edits)
    commit = await commitOnce()
  }
  const stop = commitStop(commit)
  if (stop) return stop
  const head = await git.head()
  if (commit.kind === "nothing" && head === gitState.baseSha) {
    return { kind: "skipped", reason: "Nothing to commit: the wizard and the agent changed no file this run." }
  }
  if (commit.kind === "committed") sub(ctx, "rehearsal", `Committed ${commit.sha.slice(0, 7)} · ${commit.staged.length} file(s)`, "ok")
  const leftOut = commit.kind === "committed" || commit.kind === "nothing" ? commit.leftOut.filter((entry) => entry.why === "not_in_allowlist") : []
  if (leftOut.length > 0) sub(ctx, "rehearsal", `Left out ${leftOut.length} changed file(s) the plan does not cover (not committed)`, "warn")
  ctx.state.update((draft) => {
    if (draft.git) draft.git.headSha = head
  })

  const title = `Infinite: set up analytics so the site collects properly (${state.displayId})`
  sub(ctx, "rehearsal", "Pushing the branch…", "pending")
  const pushed = await pushBranch({ ctx, deps, git, scanner, hostKind: deps.host.kind, base: gitState.base, branch: gitState.branch, title })
  if (pushed.kind === "failed") return failed("INF_WIZ_PUSH_REFUSED", pushed.message)

  const report = deps.report.build({
    runId,
    tagVersion: deps.tagVersion,
    site: { repoLabel: prepared.repoLabel, productionHost: facts.productionHost },
    columns: ctx.state.get().report,
    provenLivePending: "deploy",
    day7: null,
    notes: []
  })
  const diffText = await git.diff(gitState.baseSha, head)
  const body = buildPrBody({
    reportMarkdown: deps.report.renderMarkdown(report),
    howToReview: howToReviewSection(),
    runId,
    isPrivate: prepared.isPrivate,
    diffText,
    connectionIds: facts.connectionIds,
    scanner,
    notes: [
      ...(state.agent?.reviewer === "codex" || state.agent?.reviewer === "claude_code" ? [] : ["No second review yet: the wizard printed a review brief."]),
      ...notCheckedNotes(state.jobs)
    ]
  })
  sub(ctx, "rehearsal", "Opening draft pull request…", "pending")
  const pr = await ensurePr({ deps, remoteUrl: prepared.remoteUrl, base: gitState.base, branch: gitState.branch, title, body, root: ctx.root, ghReady: prepared.ghReady })
  if (pr.kind === "failed") return failed("INF_WIZ_PR_CREATE_FAILED", pr.message)
  if (pr.kind === "pr") {
    ctx.state.update((draft) => {
      draft.pr = {
        host: "github",
        number: pr.pr.number,
        url: pr.pr.url,
        nodeId: pr.pr.nodeId,
        isDraft: pr.pr.isDraft,
        round: draft.pr?.round ?? 0,
        reviewedSha: draft.pr?.reviewedSha ?? null,
        handledThreadIds: draft.pr?.handledThreadIds ?? [],
        mergeSha: null
      }
    })
    if (pr.adopted) sub(ctx, "rehearsal", `Picked up the open pull request #${pr.pr.number}`, "ok")
    else if (pr.draftFallback) sub(ctx, "rehearsal", `Opened #${pr.pr.number} as ready with "[review pending]" (drafts need a paid GitHub plan); nothing blocks an early merge`, "warn")
    else sub(ctx, "rehearsal", `Opened draft pull request #${pr.pr.number}`, "ok")
  } else {
    ctx.state.update((draft) => {
      draft.pr = { host: deps.host.kind, number: null, url: pr.url, nodeId: null, isDraft: false, round: 0, reviewedSha: null, handledThreadIds: [], mergeSha: null }
    })
    if (pushed.mergeRequestOpened) sub(ctx, "rehearsal", "Pushed the branch and opened a draft merge request", "ok")
    else sub(ctx, "rehearsal", pr.url ? `Pushed ${gitState.branch}; open the pull request here: ${pr.url}` : `Pushed ${gitState.branch}; open a pull request for it on your git host`, "info")
  }
  await ctx.state.save()

  // §3z.8 / B14: the PR fields go to Infinite right after the PR is created or adopted, so the app sees the
  // pull request even when the rehearsal that follows fails.
  assertNoAgentAlive(deps, "runs PATCH")
  const opened = ctx.state.get().pr
  await bestEffortBridge(ctx, "rehearsal", "tell Infinite about the pull request", () =>
    deps.bridge.patchRun(runId, {
      ...(opened?.url && opened.number !== null && opened.url.startsWith("https://") ? { prUrl: opened.url, prNumber: opened.number } : {}),
      prHeadSha: head,
      phase: "in_pr"
    })
  )

  const approved = state.plan?.answers.conversions ?? []
  const outcome = await rehearse(ctx, deps, {
    step: "rehearsal",
    runId,
    head,
    facts,
    approvedConversions: approved,
    evidenceUrls: evidenceUrls(ctx),
    consentRequired: state.plan?.answers.consentMode === "required",
    ghReady: prepared.ghReady
  })
  announceRehearsal(ctx, "rehearsal", outcome, runId)
  recordRehearsalCells(ctx, outcome, { head, runId })
  applyRehearsalToJobs(ctx, deps, outcome, runId)

  // The names the rehearsal's click test proved (append-only union), after the tests (§3z.12 order).
  const prState = ctx.state.get().pr
  if (outcome.clickTested.length > 0) {
    assertNoAgentAlive(deps, "runs PATCH")
    const patched = await bestEffortBridge(ctx, "rehearsal", "tell Infinite which conversions the click test proved", () =>
      deps.bridge.patchRun(runId, { clickTestedConversions: outcome.clickTested })
    )
    if (patched) await rememberClickTested(ctx, deps, runId, outcome.clickTested)
  }
  await recordClickTests(ctx, deps, { step: "rehearsal", runId, outcome, approved })
  await ctx.state.save()

  const graded = Object.values(outcome.grades)
  const passing = graded.filter((result) => result?.state === "pass").length
  const prLabel = prState?.number ? `Pull request #${prState.number}` : "Branch pushed"
  const line =
    outcome.state === "undetermined"
      ? `${prLabel} · rehearsal undetermined (${outcome.reason?.replace(/_/g, " ")})`
      : `${prLabel} · rehearsal: ${passing} of ${graded.length} tools fire correctly · nothing sent`
  status(ctx, "rehearsal", line)
  return { kind: "ok", status: line }
}

export const step: WizardStep<"rehearsal"> = {
  id: "rehearsal",
  title: meta.title,
  who: [...meta.who],
  learn: meta.learn,
  requiredCapabilities: [...meta.requiredCapabilities],
  // §3d.1: the rehearsal hashes the head SHA (a new commit re-runs it).
  // Review I1 P3-1: the rehearsal's inputs are the TREE the jobs produced (the branch, its base, the plan and every
  // recorded job edit), never `git.headSha`, which this step itself moves when it commits: a resume of an
  // unmerged run no longer re-runs the rehearsal (and its preview loads) when nothing changed.
  inputHash: (ctx) => {
    const state = ctx.state?.get?.()
    const git = state?.git ?? null
    const edits = (state?.jobs ?? [])
      .filter((item) => item.jobId !== "review_comments")
      .flatMap((item) => (item.edits ?? []).map((edit) => `${item.id}:${edit.editId}:${edit.file}`))
      .sort()
    return sha256(JSON.stringify(["rehearsal", git?.branch ?? "", git?.baseSha ?? "", state?.plan?.hash ?? null, edits]))
  },
  run
}

/**
 * Review I1 P1-5: an agent job the wizard could not check (still `claimed`) ships its code in this PR, so the
 * PR says so, by job and file: never presented as checked.
 */
export function notCheckedNotes(jobs: readonly ChecklistItem[]): string[] {
  const claimed = jobs.filter((item) => item.owner === "agent" && item.state === "claimed")
  if (claimed.length === 0) return []
  const list = claimed
    .map((item) => {
      const files = [...new Set((item.edits ?? []).map((edit) => edit.file))]
      return `${item.title}${files.length > 0 ? ` (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""})` : ""}`
    })
    .join("; ")
  return [`Not checked by the wizard: the agent's code for ${list} is in this pull request, but no check of the wizard's passed on it. Review it yourself.`]
}
