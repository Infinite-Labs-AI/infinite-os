import { git } from "../agents/git-exec.js"
import type { WizardContext } from "./contracts/deps.js"
import type { OwnerBoundaryMeasurement } from "../jobs/owner-diff.js"

/** Backfill saved branch history without pretending it is a record of commits we measured. */
export async function prepareCommitHistory(ctx: WizardContext, headSha: string): Promise<void> {
  const state = ctx.state.get()
  if (state.commitHistory) return
  const recorded = state.wizardCommits ?? []
  const priorHeads: string[] = []
  if (recorded.length === 0) {
    for (const sha of [...new Set([state.git?.headSha, state.pr?.reviewedSha, state.lastPush?.sha])]) {
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || sha === state.git?.baseSha) continue
      if ((await git(ctx.root, ["merge-base", "--is-ancestor", sha, headSha])).code === 0) priorHeads.push(sha)
    }
  }
  const unverifiedReason = recorded.length === 0 ? "the older state has no complete record of the commits this run made" : undefined
  ctx.state.update(draft => {
    draft.wizardCommits ??= []
    draft.commitHistory = { version: 1, priorHeads, ...(unverifiedReason ? { unverifiedReason } : {}),
      ...(unverifiedReason && priorHeads.length === 0 && headSha !== state.git?.baseSha ? { unclassifiedHead: headSha } : {}) }
  })
  await ctx.state.save()
  if (unverifiedReason) ctx.emit.emit("step.sub", { step: "review", tone: "warn", text: "Earlier commit history is unverified; saved branch heads identify earlier run history, not commits whose consent or policy changes were checked." })
}

/** A rewrite is not evidence of owner authorship. Preserve the gap even after later measured commits. */
export async function acknowledgeUnverifiedHistory(ctx: WizardContext, headSha: string, measurement: OwnerBoundaryMeasurement): Promise<boolean> {
  let history = ctx.state.get().commitHistory!
  if (measurement.unverifiedReason && (ctx.state.get().wizardCommits?.length ?? 0) > 0 && !history.unverifiedReason) {
    ctx.state.update(draft => { draft.commitHistory = { ...history, unverifiedReason: measurement.unverifiedReason, unclassifiedHead: headSha } })
    await ctx.state.save()
    history = ctx.state.get().commitHistory!
  }
  if (!history.unclassifiedHead) return true
  if (history.resolution === "declined") return false
  if (history.resolution) return true
  const explanation = "This run cannot identify who made its earlier local commits from the saved record. That history remains unverified; please review the changed files."
  ctx.emit.emit("step.sub", { step: "review", tone: "warn", text: explanation })
  let resolution: "accepted" | "noninteractive" | "declined"
  if (ctx.options.yes || ctx.options.nested) resolution = "noninteractive"
  else {
    const answer = await ctx.ask("confirm", { question: `${explanation}\nContinue with that existing local history?`, defaultYes: false })
    resolution = answer === false ? "declined" : answer === true ? "accepted" : "noninteractive"
  }
  ctx.state.update(draft => { draft.commitHistory = { ...history, resolution, priorHeads: resolution === "declined" ? history.priorHeads : [...new Set([...history.priorHeads, history.unclassifiedHead!])] } })
  await ctx.state.save()
  return resolution !== "declined"
}
