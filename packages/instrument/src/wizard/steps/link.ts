// Step 0 `link` (§3d.1, §3a.3): pair this site (repo + app root + folder) with ONE Infinite workspace.
//
// 1. Discover the desktop bridge (no app → blocked NO_APP; not a Mac → NOT_MAC; signed out → SIGNED_OUT).
// 2. On a resume, the open app must be the same runtime variant the run was linked through (a prod run is
//    never continued against a Dev or sandbox app): otherwise stop with RUNTIME_MISMATCH before ANY verb.
// 3. Ask the app to link: a crypto-random 4-digit code, the normalised repo label (never the raw remote), the
//    fingerprint, the app root and the folder. A remembered link answers at once (no card). Otherwise the
//    `link-code` overlay shows the code while the step long-polls; approved → linked; "Not me" → LINK_DECLINED;
//    expired → offer to retry; ESC → cancelled. Approval has ONE 5-minute window overall (§3a.2): a retry
//    gets a new code inside what is left of it (the engine's link budget sits just above that window).
// 4. Save the link (id, workspace name, time, runtime variant) and attach its id to the client.
// 5. The first link-scoped call is the subscription check: 402 → blocked SUBSCRIPTION_REQUIRED (decision 7).
// No run is created here (the `agent` step does that).
import { randomInt } from "node:crypto"
import { realpathSync } from "node:fs"
import { join } from "node:path"

import type { BridgeDescriptor, Link } from "../contracts/bridge.js"
import { BRIDGE_LIMITS } from "../contracts/bridge.js"
import type { AskFn, StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { ASK_CANCELLED, ASK_TIMEOUT } from "../contracts/asks.js"
import { isBridgeDiscoveryError, isBridgeError } from "../../bridge/errors.js"
import { bridgeErrorOutcome, discoveryOutcome, missingCapabilities, protocolOutcome, SUBSCRIPTION_MESSAGE } from "../../bridge/outcomes.js"
import { linkSiteFor } from "../../bridge/repo-identity.js"
import { hashInputs, PROCESS_NONCE, sub } from "../../bridge/step-kit.js"

const META = WIZARD_STEP_META.link
/** A new code and card at most this many times (each one can expire), all inside ONE approval window. */
export const MAX_LINK_ATTEMPTS = 3
/** A retry is offered only while at least this much of the window is left (time to read the code and approve). */
export const MIN_RETRY_WINDOW_MS = 30_000

/** `AskFn`'s options plus the signal that closes a display-only ask (see the O2 note: a §3d.8 amendment). */
type AskOptionsWithSignal = { timeoutMs?: number } & NonNullable<Parameters<AskFn>[2]> & { signal: AbortSignal }

export function newLinkCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, "0")
}

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A best-effort production host for the card's workspace pre-selection: a CNAME file, else package.json `homepage`. */
async function productionHostHint(ctx: WizardContext, deps: WizardDeps): Promise<string | null> {
  const appDir = join(ctx.root, ctx.appRoot === "." ? "" : ctx.appRoot)
  for (const file of [join(appDir, "public", "CNAME"), join(appDir, "CNAME"), join(ctx.root, "CNAME")]) {
    const text = await deps.fs.readText(file)
    const host = text?.split(/\r?\n/, 1)[0]?.trim().toLowerCase().replace(/\.$/, "")
    if (host && HOST_PATTERN.test(host)) return host
  }
  const pkg = await deps.fs.readText(join(appDir, "package.json"))
  if (pkg) {
    try {
      const homepage = (JSON.parse(pkg) as { homepage?: unknown }).homepage
      if (typeof homepage === "string") {
        const host = new URL(homepage).hostname.toLowerCase()
        if (HOST_PATTERN.test(host)) return host
      }
    } catch {
      // Not JSON or not a URL: no hint.
    }
  }
  return null
}

function variantLabel(descriptor: Pick<BridgeDescriptor, "runtime">): string {
  return `${descriptor.runtime.label} (${descriptor.runtime.variant})`
}

type WaitResult = { state: "approved"; link: Link } | { state: "declined" } | { state: "expired" } | { state: "cancelled" }

/** Long-poll the request until it is answered, the user presses ESC, or the approval window (`deadline`) closes. */
async function waitForApproval(
  ctx: WizardContext,
  deps: WizardDeps,
  linkRequestId: string,
  code: string,
  site: { repoLabel: string; appRoot: string; folderLabel: string },
  deadline: number
): Promise<WaitResult> {
  const closeAsk = new AbortController()
  const options: AskOptionsWithSignal = { timeoutMs: Math.max(1, deadline - ctx.now().getTime()), signal: closeAsk.signal }
  // The card is display-only: ESC cancels, the ask's own timer means the window closed. Any other answer (a
  // stray `ask.answer` from a JSON client) closes the overlay but changes nothing: the step keeps polling.
  const never = new Promise<never>(() => undefined)
  const askClosed: Promise<"cancelled" | "timeout"> = ctx.ask("link-code", { code, site }, options).then((answer) => {
    if (closeAsk.signal.aborted) return never
    if (answer === ASK_CANCELLED) return "cancelled" as const
    if (answer === ASK_TIMEOUT) return "timeout" as const
    return never
  })
  const stopPolling = new AbortController()
  const onAbort = () => stopPolling.abort()
  ctx.signal.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      if (ctx.signal.aborted) return { state: "cancelled" }
      const remainingMs = deadline - ctx.now().getTime()
      if (remainingMs <= 0) return { state: "expired" }
      const waitSeconds = Math.max(1, Math.min(BRIDGE_LIMITS.longPollMaxSeconds, Math.floor(remainingMs / 1000)))
      const polledAt = ctx.now().getTime()
      const poll = deps.bridge.pollLink(linkRequestId, waitSeconds, { signal: stopPolling.signal }).then(
        (response) => ({ kind: "poll" as const, response }),
        (error: unknown) => ({ kind: "error" as const, error })
      )
      const first = await Promise.race([poll, askClosed])
      if (first === "cancelled" || first === "timeout") {
        stopPolling.abort()
        // ESC → cancelled; the ask's own timer is the approval window closing → expired.
        return { state: first === "cancelled" ? "cancelled" : "expired" }
      }
      if (first.kind === "error") {
        if (isBridgeError(first.error) && first.error.code === "expired") return { state: "expired" }
        if (isBridgeError(first.error) && (first.error.code === "timeout" || first.error.code === "rate_limited")) {
          await deps.clock.sleep((first.error.retryAfterSeconds ?? 1) * 1000, ctx.signal)
          continue
        }
        throw first.error
      }
      const response = first.response
      if (response.state === "approved" && response.link) return { state: "approved", link: response.link }
      if (response.state === "declined") return { state: "declined" }
      if (response.state === "expired") return { state: "expired" }
      // Still pending. A bridge that answers at once (no long-poll) is paced to one poll a second.
      if (ctx.now().getTime() - polledAt < 1_000) await deps.clock.sleep(1_000, ctx.signal)
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort)
    stopPolling.abort()
    // Close the link-code overlay (approval, decline, expiry or abort all end it).
    closeAsk.abort()
  }
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  let descriptor: BridgeDescriptor
  try {
    descriptor = deps.bridge.descriptor
  } catch (error) {
    if (isBridgeDiscoveryError(error)) return discoveryOutcome(error)
    throw error
  }

  const prior = ctx.state.get().link
  if (prior && prior.runtimeVariant !== descriptor.runtime.variant) {
    return {
      kind: "failed",
      code: "INF_WIZ_RUNTIME_MISMATCH",
      message: `This run was linked through Infinite ${prior.runtimeVariant}; the open app is ${variantLabel(descriptor)}. Open the same Infinite app (or set GROWTH_OS_HOME for it), or start a fresh run.`,
      next: "halt"
    }
  }
  if (descriptor.runtime.variant !== "prod") {
    sub(ctx, "link", `Using ${variantLabel(descriptor)}, not the production Infinite app`, "warn")
  }

  const missing = missingCapabilities(deps.bridge, META.requiredCapabilities)
  if (missing.length > 0) return protocolOutcome(missing)

  try {
    const status = await deps.bridge.status({ signal: ctx.signal })
    if (status.runtime.variant !== descriptor.runtime.variant) {
      return {
        kind: "failed",
        code: "INF_WIZ_RUNTIME_MISMATCH",
        message: `The bridge file says Infinite ${descriptor.runtime.variant}, but the app answering is ${status.runtime.label} (${status.runtime.variant}). Quit the other Infinite app, then run npx infinite-tag again.`,
        next: "halt"
      }
    }

    let realRoot = ctx.root
    try {
      realRoot = realpathSync(ctx.root)
    } catch {
      // Keep the given root.
    }
    const site = linkSiteFor({
      rawRemote: await deps.git.remoteUrl(),
      realRoot,
      root: ctx.root,
      appRoot: ctx.appRoot,
      productionHostHint: await productionHostHint(ctx, deps)
    })

    let link: Link | null = null
    // ONE approval window for every attempt (§3a.2 "link approval ≤ 5 min overall").
    const deadline = ctx.now().getTime() + BRIDGE_LIMITS.linkApprovalMs
    for (let attempt = 1; attempt <= MAX_LINK_ATTEMPTS && link === null; attempt++) {
      const code = newLinkCode()
      sub(ctx, "link", "Asking the Infinite app to link this site…", "pending")
      const request = await deps.bridge.requestLink({ code, site, client: { tagVersion: deps.tagVersion } }, { signal: ctx.signal })
      if (request.state === "approved" && request.link) {
        link = request.link
        sub(ctx, "link", `✓ Remembered · workspace ${link.workspace.name}`, "ok")
        break
      }
      sub(ctx, "link", "Waiting for approval in the Infinite app…", "pending")
      const result = await waitForApproval(
        ctx,
        deps,
        request.linkRequestId,
        code,
        { repoLabel: site.repoLabel, appRoot: site.appRoot, folderLabel: site.folderLabel },
        deadline
      )
      if (result.state === "approved") {
        link = result.link
        sub(ctx, "link", `✓ Approved · workspace ${link.workspace.name}`, "ok")
        break
      }
      if (result.state === "declined") {
        return { kind: "failed", code: "INF_WIZ_LINK_DECLINED", message: "The link was declined in the Infinite app (\"Not me\").", next: "halt" }
      }
      if (result.state === "cancelled") {
        // An interrupt (Ctrl+C) is the engine's to handle (exit 130), never a declined link.
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted")
        return { kind: "failed", code: "INF_WIZ_LINK_DECLINED", message: "Linking was cancelled.", next: "halt" }
      }
      sub(ctx, "link", "! The link request expired", "warn")
      if (attempt >= MAX_LINK_ATTEMPTS) break
      // A retry only while the window still leaves time to read a new code and approve it.
      const left = deadline - ctx.now().getTime()
      if (left < MIN_RETRY_WINDOW_MS) break
      const retry = await ctx.ask(
        "confirm",
        { question: "The link request expired before it was approved. Try again with a new code?", defaultYes: true },
        { timeoutMs: left }
      )
      if (retry !== true || deadline - ctx.now().getTime() < MIN_RETRY_WINDOW_MS) break
    }
    if (link === null) {
      return { kind: "failed", code: "INF_WIZ_LINK_EXPIRED", message: "The link request expired. Run npx infinite-tag again when the Infinite app is open.", next: "halt" }
    }

    // A resumed run belongs to the workspace it was started in: its run id means nothing to another one.
    if (prior && ctx.state.get().runId !== null && prior.linkId !== link.linkId && prior.workspaceName !== link.workspace.name) {
      return {
        kind: "failed",
        code: "INF_WIZ_LINK_DECLINED",
        message: `This run was started in the Infinite workspace ${prior.workspaceName}, but this site is now linked to ${link.workspace.name}. Link it to ${prior.workspaceName} again to continue this run, or start a fresh run.`,
        next: "halt"
      }
    }

    deps.bridge.setLinkId(link.linkId)
    const linked = link
    ctx.state.update((state) => {
      state.link = { linkId: linked.linkId, workspaceName: linked.workspace.name, approvedAt: linked.approvedAt, runtimeVariant: descriptor.runtime.variant }
    })
    await ctx.state.save()

    // The first link-scoped call: an unsubscribed workspace stops here, before anything else runs.
    if (deps.bridge.has("tag.keys.v1")) {
      try {
        await deps.bridge.keys({ signal: ctx.signal })
      } catch (error) {
        if (isBridgeError(error) && error.code === "subscription_required") {
          return { kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED", reason: SUBSCRIPTION_MESSAGE }
        }
        throw error
      }
    }

    return { kind: "ok", status: `Linked: ${site.repoLabel} → workspace ${link.workspace.name}` }
  } catch (error) {
    if (isBridgeError(error)) {
      const outcome = bridgeErrorOutcome(error)
      if (outcome) return outcome
    }
    throw error
  }
}

export const step: WizardStep<"link"> = {
  id: "link",
  title: META.title,
  who: [...META.who],
  learn: META.learn,
  requiredCapabilities: [...META.requiredCapabilities],
  // Never skipped on resume: every process re-checks the runtime variant and re-attaches the link id.
  inputHash: (ctx) => hashInputs({ step: "link", root: ctx.root, appRoot: ctx.appRoot, process: PROCESS_NONCE }),
  run
}
