// Choose the PR's push destination before the agent edits anything. Origin remains the production base.
import { canPush } from "../github/repo.js"
import { wizardGitExtras } from "../git/index.js"
import type { StepOutcome, WizardContext, WizardDeps } from "./contracts/deps.js"
import type { PushTarget } from "./contracts/state.js"

const refused = (message: string): StepOutcome => ({ kind: "failed", code: "INF_WIZ_PUSH_REFUSED", message, next: "halt" })

export function forkTargetMatches(target: { remoteUrl: string; headOwner: string }, repoName: string | null = null): boolean {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(target.headOwner)) return false
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(target.remoteUrl)
  return match?.[1]?.toLowerCase() === target.headOwner.toLowerCase() && (repoName === null || match[2]?.toLowerCase() === repoName.toLowerCase())
}

export async function ensurePushTarget(ctx: WizardContext, deps: WizardDeps, say: (text: string) => void): Promise<StepOutcome | null> {
  if (deps.host.kind !== "github") return null
  const facts = await deps.host.repoFacts().catch(() => null)
  if (!facts || "unsupported" in facts) return refused("GitHub repository permissions could not be read. Sign in with gh, then run npx infinite-tag again.")
  const saved = ctx.state.get().pushTarget
  const git = wizardGitExtras(deps.git)
  if (saved?.kind === "fork") {
    if (!forkTargetMatches(saved, facts.nameWithOwner?.split("/")[1] ?? null)) return refused("The saved fork does not match this GitHub repository; it cannot be pushed.")
    if (!git?.setPushRemote) return refused("The wizard cannot restore the approved fork push destination on this run.")
    git.setPushRemote(saved.remoteUrl)
    say(`This run will push to your fork (${saved.headOwner}) and open a pull request to the original repo.`)
    return null
  }
  if (canPush(facts.viewerPermission)) {
    if (saved?.kind !== "origin") {
      ctx.state.update((state) => { state.pushTarget = { kind: "origin", remoteUrl: null, headOwner: null } })
      await ctx.state.save()
    }
    return null
  }
  const permission = facts.viewerPermission ?? "unknown"
  if (facts.allowForking !== true) {
    return refused(`Your GitHub access is ${permission}, and this repo does not allow forks${facts.allowForking === null || facts.allowForking === undefined ? " (or its fork setting could not be read)" : ""}. Ask the repo owner for write access or permission to fork.`)
  }
  if (!git?.setPushRemote || !deps.host.createFork) return refused("This wizard cannot open a pull request from a fork. Update infinite-tag, then try again.")
  const auth = await deps.host.auth()
  if (!auth.ok || !auth.login) return refused("GitHub is not signed in. Run gh auth login, then npx infinite-tag again.")
  say(`Your GitHub access is ${permission}; this repo allows forks. The branch can go to your fork for a pull request.`)
  if (ctx.options.yes || ctx.options.nested) return refused("Creating a fork needs your explicit answer. Run npx infinite-tag without --yes, or ask the repo owner for write access.")
  const approved = await ctx.ask("confirm", { question: "Create your fork and open the pull request from it?", defaultYes: false })
  if (approved !== true) return refused("Fork pull request was not approved. Ask the repo owner for write access, or run npx infinite-tag again to choose a fork.")
  const origin = await deps.git.remoteUrl()
  const preferSsh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/.test(origin ?? "")
  let fork: { remoteUrl: string; headOwner: string }
  try {
    fork = await deps.host.createFork(preferSsh)
    if (fork.headOwner.toLowerCase() !== auth.login.toLowerCase() || !forkTargetMatches(fork, facts.nameWithOwner?.split("/")[1] ?? null)) throw new Error("GitHub returned a fork that is not owned by your signed-in account")
    git.setPushRemote(fork.remoteUrl)
  } catch (error) {
    return refused(`GitHub could not create or use your fork: ${error instanceof Error ? error.message : String(error)}. Ask the repo owner for write access or fork permission.`)
  }
  const target: PushTarget = { kind: "fork", remoteUrl: fork.remoteUrl, headOwner: fork.headOwner }
  ctx.state.update((state) => { state.pushTarget = target })
  await ctx.state.save()
  say(`Fork ready (${fork.headOwner}); the pull request will target the original repo.`)
  return null
}
