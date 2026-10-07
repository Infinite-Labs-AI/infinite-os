import { loadPlanApprovals } from "../../install/step-inputs.js"
// Step 8 `rehearsal` (§3d.1, lane O4): commit → push → draft PR → wait for the Vercel preview → rehearse it
// under the production hostname (nothing sent) + load the preview's own URL → grade (O6's grader) → PATCH the
// run (PR fields, phase `in_pr`, `clickTestedConversions`) → mark GA4 key events for the rehearsal-click-tested
// names only. A protected preview, a non-Vercel host or no preview is `undetermined`, never pass.
import type { ChecklistItem } from "../contracts/jobs.js"
import { homedir } from "node:os"
import { finalSealPath } from "../../agents/paths.js"
import { verifyFinalSeal } from "../../agents/fence.js"
import { buildVerdict } from "../../checks/build.js"
import { createHash } from "node:crypto"
import { join } from "node:path"

import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { PR_LOOP_LIMITS } from "../contracts/git-host.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { readBeforeFactsFile } from "../handoff/before-facts.js"
import { verdictFactsFor } from "../verdict-facts.js"
import type { TestTool } from "../contracts/test-engine.js"
import { wizardGitExtras, type WizardGitOps } from "../../git/index.js"
import { canPush } from "../../github/repo.js"
import { forkTargetMatches } from "../push-target.js"
import { resolveVercelSignal } from "../vercel-signal.js"
import { isUnsupported } from "../../hosts/other.js"
import { howToReviewSection } from "../../review/brief.js"
import {
  allowlistUnion,
  assertNoAgentAlive,
  bestEffortBridge,
  bridgeStop,
  buildScanner,
  runPublicIds,
  loadRunFacts,
  manifestFiles,
  repoLabelFrom,
  requireRunId,
  status,
  sub,
  type RunFacts
} from "../../review/context.js"
import { hookFixItem, runFixRound } from "../../review/fix.js"
import { isGitHubAdapter } from "../../hosts/github.js"
import { buildPrBody } from "../../review/post.js"
import { parseLedger, REVIEW_LEDGER_PATH } from "../../review/ledger.js"
import { applyRehearsalToJobs, rehearsalCheckResults, recordGa4KeyEventCells, recordRehearsalCells, rehearsalCountWords, rehearsalLines, rehearsalToolCount, rehearse, type RehearsalOutcome } from "../../review/rehearse.js"
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

/**
 * The production pages a test may load beyond home: the page `before`'s dry load navigated to, then the jobs' URL
 * evidence (DECISIONS §1.7 / §5.2). Since job 10 is seeded from the success branch in code (§1.3) it carries no URL,
 * so without `before`'s page no rehearsal or post-deploy load ever ran a client-side navigation and the Meta
 * page-change check could never be measured.
 */
export async function testPageUrls(ctx: WizardContext, deps: Pick<WizardDeps, "fs">): Promise<string[]> {
  const before = await readBeforeFactsFile(deps.fs, ctx.root, ctx.runId)
  // The page `before` navigated to comes FIRST, so a rehearsal's client-side navigation is the one `before` measured.
  const navigated = before?.spaNavigation && before.productionHost ? [`https://${before.productionHost}${before.spaNavigation.path}`] : []
  return [...navigated, ...evidenceUrls(ctx)]
}

/** Emits the per-tool `check.result` events and the design's sub-status lines for one rehearsal. */
export function announceRehearsal(ctx: WizardContext, step: "rehearsal" | "review", outcome: RehearsalOutcome, runId: string): void {
  for (const tool of Object.keys(outcome.grades) as TestTool[]) {
    const result = outcome.grades[tool]
    if (!result) continue
    ctx.emit.emit("check.result", { checkId: result.checkId, tier: "RH", state: result.state, ...(result.reason ? { reason: result.reason } : {}), runId })
  }
  for (const line of rehearsalLines(outcome, ctx.state.get().jobs)) sub(ctx, step, line.text, line.tone)
}

/** The rehearsal-click-tested bookkeeping (§3d.1): PATCH first (append-only), then GA4 key events for exactly those names ∩ approved. */
export async function recordClickTests(
  ctx: WizardContext,
  deps: WizardDeps,
  input: { step: "rehearsal" | "review"; runId: string; outcome: RehearsalOutcome; approved: readonly string[] }
): Promise<void> {
  if (!ctx.state.get().plan?.lines.some(line => line.id === "account_settings:ga4" && line.approved === true)) return
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
  // The report's "In this pull request" column says what Infinite marked (its own response, this run).
  recordGa4KeyEventCells(ctx, marked.length, input.runId, input.step === "review" ? "new_names" : "all")
  if (marked.length > 0) sub(ctx, input.step, `GA4 key events: marked for ${marked.length} conversion${marked.length === 1 ? "" : "s"} (click test passed)`, "ok")
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
  const loaded = await loadRunFacts(deps, ctx.state.get().site ?? null)
  // §3y.4: the Vercel signal and project name without an Infinite Vercel connection (read once, cached in state).
  const signal = await resolveVercelSignal(ctx, deps, loaded.hosting)
  const facts = { ...loaded, vercelSignal: signal.signal, vercelProject: signal.projectName }
  // LF4-P3-5: the ids the run read from the site are public too (a site-read pixel id in a live-bytes reason).
  const scanner = buildScanner(ctx, deps, [...new Set([...facts.connectionIds, ...(await runPublicIds(ctx, deps))])])
  const remoteUrl = await git.remoteUrl()
  let ghReady = false
  let isPrivate = false
  if (deps.host.kind === "github") {
    const auth = await deps.host.auth()
    ghReady = auth.ok
    if (ghReady) {
      const repo = await deps.host.repoFacts().catch(() => null)
      if (repo && !isUnsupported(repo)) {
        isPrivate = repo.isPrivate
        if (repo.viewerPermission !== null && !canPush(repo.viewerPermission) && state.pushTarget?.kind !== "fork") {
          return failed(
            "INF_WIZ_PUSH_REFUSED",
            `Your GitHub access to this repo is ${repo.viewerPermission ?? "unknown"}, and no fork was approved before the agent step. Run npx infinite-tag again to choose a fork, or ask for write access.`
          )
        }
      }
    }
  }
  if (state.pushTarget?.kind === "fork") {
    if (!forkTargetMatches(state.pushTarget)) return failed("INF_WIZ_PUSH_REFUSED", "The saved fork destination is invalid.")
    if (!ghReady) return failed("INF_WIZ_PUSH_REFUSED", "GitHub is not signed in, so the fork pull request cannot be opened. Run gh auth login, then npx infinite-tag again.")
    if (!git.setPushRemote) return failed("INF_WIZ_PUSH_REFUSED", "The approved fork destination could not be restored.")
    git.setPushRemote(state.pushTarget.remoteUrl)
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

/** Existing runs remain the owner's choice; this helper never closes or changes a PR. */
export async function olderWizardPrNotes(host: WizardDeps["host"], branch: string): Promise<string[]> {
  if (!host.olderWizardPrs) return []
  try {
    const rows = await host.olderWizardPrs(branch)
    return [...new Set(rows.map(row => row.number).filter(number => Number.isSafeInteger(number) && number > 0))]
      .map(number => `Older wizard pull request #${number} is still open on another branch. To close it yourself: gh pr close ${number}`)
  } catch {
    return ["Could not check for older open wizard pull requests; review your repository's open pull requests."]
  }
}

async function rehearsalRun(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const prepared = await prepareShip(ctx, deps)
  if (!isShipContext(prepared)) return prepared
  const { runId, git, facts, scanner } = prepared
  const state = ctx.state.get()
  const gitState = state.git!
  for (const note of await olderWizardPrNotes(deps.host, gitState.branch)) sub(ctx, "rehearsal", note, "info")
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

  // Run the site's build AND lint scripts on the final tree before opening a PR. A missing local
  // executable is unmeasured, never the same red baseline; a new failure cannot ride into customer CI.
  const before = await readBeforeFactsFile(deps.fs, ctx.root, runId)
  const validate = async () => before?.facts.localValidation === "not_measured"
    ? { state: "undetermined" as const, reason: "local validation not measured; PR checks decide" }
    : buildVerdict(await deps.checks.build(), async () => before?.facts.baselineBuild ?? { failureSignature: [] })
  let validation = await validate()
  const worker = state.agent?.worker ?? null
  for (let round = 1; validation.state === "problem" && worker && round <= PR_LOOP_LIMITS.maxFixRounds; round += 1) {
    const reason = validation.reason ?? "site validation failed"
    const generated = managed.filter((file) => reason.includes(file))
    if (generated.length > 0) break // Infinite's own emitted source is never delegated to the site's agent.
    const fixable = allowlist.filter((file) => reason.includes(file))
    if (fixable.length === 0) break
    sub(ctx, "rehearsal", `${worker === "codex" ? "Codex" : "Claude Code"} is fixing ${fixable.length} new site-check failure(s) before the pull request…`, "pending")
    const item = hookFixItem(fixable, reason)
    ctx.emit.emit("job.seeded", { item })
    const fix = await runFixRound(ctx, deps, { step: "rehearsal", worker, items: [item], scanner })
    if (fix.run.outcome === "out_of_usage") return { kind: "parked", code: "INF_WIZ_AGENT_OUT_OF_USAGE", reason: "The worker agent is out of usage while fixing site validation.", resumeHint: "Run `npx infinite-tag` again when your plan resets." }
    if (fix.run.edits.length > 0) await deps.installer.recordEdits(fix.run.edits)
    validation = await validate()
  }
  if (validation.state !== "pass" && !(validation.state === "undetermined" && before?.facts.localValidation === "not_measured"))
    return failed("INF_WIZ_VALIDATION_FAILED", `${validation.state === "undetermined" ? "The working-tree build or lint could not be measured" : "The site's build or lint found a new failure"}: ${scanner.redact(validation.reason ?? "not checked").text}. Resolve this before resuming.`)

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

  const unwired = (await loadPlanApprovals(ctx, deps))?.ownerWiring?.canWire === false
  const title = unwired ? `Infinite tag NOT installed: other analytics changes (${state.displayId})` : `Infinite: set up analytics so the site collects properly (${state.displayId})`
  sub(ctx, "rehearsal", "Pushing the branch…", "pending")
  const pushed = await pushBranch({ ctx, deps, git, scanner, hostKind: deps.host.kind, base: gitState.base, branch: gitState.branch, title })
  if (pushed.kind === "failed") return failed("INF_WIZ_PUSH_REFUSED", pushed.message)

  const reportFacts = await verdictFactsFor(ctx, deps)
  const report = deps.report.build({
    runId,
    tagVersion: deps.tagVersion,
    site: { repoLabel: prepared.repoLabel, productionHost: facts.productionHost },
    columns: ctx.state.get().report,
    provenLivePending: "deploy",
    day7: null,
    notes: [],
    verdictFacts: reportFacts
  })
  const diffText = await git.diff(gitState.baseSha, head)
  const bodyInput = {
    reportMarkdown: deps.report.renderMarkdown(report, reportFacts.ownerBoundary, reportFacts.jobs),
    ownerBoundary: reportFacts.ownerBoundary,
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
  }
  const body = buildPrBody(bodyInput)
  sub(ctx, "rehearsal", "Opening draft pull request…", "pending")
  const pr = await ensurePr({ deps, remoteUrl: prepared.remoteUrl, base: gitState.base, branch: gitState.branch, title, body, root: ctx.root, ghReady: prepared.ghReady, headOwner: state.pushTarget?.kind === "fork" ? state.pushTarget.headOwner : null })
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
    evidenceUrls: await testPageUrls(ctx, deps),
    consentRequired: state.plan?.answers.consentMode === "required",
    ghReady: prepared.ghReady
  })
  announceRehearsal(ctx, "rehearsal", outcome, runId)
  recordRehearsalCells(ctx, outcome, { head, runId, keys: facts.keys })
  await applyRehearsalToJobs(ctx, deps, outcome, runId, head, "rehearsal")

  // The initial body makes no promise of a rehearsal. Only name checks once they ran,
  // and never replace a body edited by the repo owner in the meantime.
  const measured = rehearsalCheckResults(outcome, { at: ctx.now().toISOString(), runId, jobs: ctx.state.get().jobs })
  const measuredIds = new Set(measured.shared.filter(check => check.state === "pass" || check.state === "problem").map(check => check.checkId))
  const checkedJobs = state.jobs.filter(job => job.checks.some(check => check.tier === "RH" && measuredIds.has(check.id))).map(job => job.id)
  const oldNotes = notCheckedNotes(state.jobs)
  const updatedBody = buildPrBody({ ...bodyInput, notes: [...bodyInput.notes.filter(note => !oldNotes.includes(note)), ...notCheckedNotes(state.jobs, checkedJobs)] })
  if (updatedBody !== body && isGitHubAdapter(deps.host) && ctx.state.get().pr?.number != null) {
    const number = ctx.state.get().pr!.number!
    try {
      const current = await deps.host.gh.json<{ body?: string }>(["pr", "view", String(number), "--json", "body"])
      if (current.body === body) await deps.host.gh.run(["pr", "edit", String(number), "--body-file", "-"], { input: updatedBody })
    } catch {
      sub(ctx, "rehearsal", "Could not refresh the pull request's rehearsal note; see the what-happened comment.", "warn")
    }
  }


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

  // R4-10: the one count the report's "Live test per tool" cell uses (never every graded tool).
  const count = rehearsalToolCount(outcome)
  const prLabel = prState?.number ? `Pull request #${prState.number}` : "Branch pushed"
  const line =
    outcome.state === "undetermined"
      ? `${prLabel} · rehearsal undetermined (${outcome.reason?.replace(/_/g, " ")})`
      : `${prLabel} · rehearsal: ${rehearsalCountWords(count)} · nothing sent`
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
export function notCheckedNotes(jobs: readonly ChecklistItem[], rehearsalCheckedIds: readonly string[] = []): string[] {
  const claimed = jobs.filter((item) => item.owner === "agent" && item.state === "claimed")
  if (claimed.length === 0) return []
  const list = claimed
    .map((item) => {
      const files = [...new Set((item.edits ?? []).map((edit) => edit.file))]
      return `${item.title}${files.length > 0 ? ` (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""})` : ""}`
    })
    .join("; ")
  const checked = claimed.filter(job => rehearsalCheckedIds.includes(job.id)).map(job => job.title)
  return [`Not checked at pull request creation: the agent's code for ${list} is in this pull request. ${checked.length > 0 ? `The preview rehearsal checked: ${checked.join("; ")}. ` : ""}Current results are in the what-happened comment.`]
}
