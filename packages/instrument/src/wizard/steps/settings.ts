// Step 7 `settings` (§3d.1): "Infinite settings". Everything here goes through the desktop bridge; the wizard
// never runs `vercel` and never sees a secret.
//
// 1. Declare the conversions the user APPROVED (the plan's answer ∩ the cloud run's `approvedConversions`).
// 2. Save the server-lane settings on Vercel, ONLY when the plan's `server_lane` line was approved (no line, an
//    unanswered line or a declined one writes nothing to the customer's Vercel):
//    `provisionServerLaneEnv({redeploy:"skip"})`. No hosting connection id is sent (the cloud resolves it);
//    production is not restarted; they go live with the merge.
// 3. Mark GA4 key events ONLY for approved names whose offline (T0) click test passed
//    (`approved ∩ run.clickTestedConversions`); the rehearsal marks the rest after its own click tests.
// 4. Bind and enable the Meta relay only when its plan line was approved AND the cloud says it is available.
// The engine never calls these state-changing verbs while an agent child is alive (§3a.9.4); this step checks
// it too before the first one.
import type { ConversionDeclaration, ConversionDedupe, ConversionType, MetaRelayStatusResponse } from "../contracts/bridge.js"
import { CONVERSION_NAME_PATTERN } from "../contracts/bridge.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import type { PlanLineKind } from "../contracts/asks.js"
import { STEP_COPY_OVERRIDES, WIZARD_STEP_META } from "../contracts/steps.js"
import { isBridgeError } from "../../bridge/errors.js"
import { bridgeFailureLine, bridgeFailureOutcome, missingCapabilities, protocolOutcome } from "../../bridge/outcomes.js"
import { hashInputs, sub } from "../../bridge/step-kit.js"
import { readKeysResult } from "../handoff/keys-result.js"

const META = WIZARD_STEP_META.settings

/**
 * How a conversion name is declared (§3b `conversions`; Subscribe = custom + label "Subscribe", §3j.5).
 * §3z.7 (A27): protocol 1 never declares `visitor_ttl` (it needs a TTL the protocol has no field for, and the
 * cloud refuses it as `visitor_ttl_needs_ttl_minutes`), so a download counts once per event.
 */
export function conversionDeclaration(name: string): ConversionDeclaration {
  const declaration = declarationOf(name)
  if (!PROTOCOL_1_DEDUPES.includes(declaration.dedupe)) throw new Error(`conversion "${name}" would be declared with dedupe "${declaration.dedupe}", which protocol 1 never sends`)
  return declaration
}

/** §3z.7 (A27): the dedupe values protocol 1 declares (`visitor_ttl` needs a TTL field protocol 1 does not have). */
export const PROTOCOL_1_DEDUPES: readonly ConversionDedupe[] = ["event", "session", "account"]

function declarationOf(name: string): ConversionDeclaration {
  const table: Array<{ names: string[]; type: ConversionType; dedupe: ConversionDedupe; label?: string }> = [
    { names: ["signup", "sign_up", "signed_up", "registration", "complete_registration", "account_created"], type: "signup", dedupe: "account" },
    { names: ["lead", "contact", "contact_form", "form_submit", "demo_request", "request_demo", "waitlist"], type: "lead", dedupe: "event" },
    { names: ["booking", "book_demo", "booked", "book_call", "schedule"], type: "booking", dedupe: "event" },
    { names: ["purchase", "order", "order_completed", "checkout_complete", "checkout_completed"], type: "purchase", dedupe: "event" },
    { names: ["start_trial", "trial_started", "trial_start", "trial"], type: "trial", dedupe: "account" },
    { names: ["download", "app_download", "file_download"], type: "download", dedupe: "event" },
    { names: ["subscribe", "subscription_started", "subscribed"], type: "custom", dedupe: "account", label: "Subscribe" }
  ]
  const row = table.find((candidate) => candidate.names.includes(name))
  if (row) return { name, type: row.type, dedupe: row.dedupe, ...(row.label ? { label: row.label } : {}) }
  const label = name
    .split("_")
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ")
    .slice(0, 60)
  return { name, type: "custom", dedupe: "event", label }
}

/** The plan line kind of a saved line id (`<kind>` or `<kind>:<detail>`). */
function lineKind(id: string): string {
  return id.split(":", 1)[0] ?? id
}

/** The approval the user gave to the line(s) of a kind: true / false, or null (unanswered, or no such line). */
function lineApproval(ctx: WizardContext, kind: PlanLineKind): boolean | null {
  const lines = (ctx.state.get().plan?.lines ?? []).filter((line) => lineKind(line.id) === kind)
  if (lines.length === 0) return null
  if (lines.some((line) => line.approved === false)) return false
  if (lines.every((line) => line.approved === true)) return true
  return null
}

const RELAY_UNAVAILABLE_TEXT: Record<NonNullable<MetaRelayStatusResponse["reason"]>, string> = {
  not_rolled_out: "Meta server events: ready, waiting for Infinite to switch on",
  no_pixel: "Meta server events: your Meta connection has no pixel",
  infinite_dataset: "Meta server events: this workspace's pixel is Infinite's own, so it is not used here",
  non_production_source: "Meta server events: this site source is not production, so nothing is sent"
}

function outcomeFor(error: unknown): StepOutcome | null {
  return bridgeFailureOutcome(error, { verb: "settings" })
}

/** §3z.4 row 9: `role_required`, a lock on one piece, and the named refusals are a user line; the step goes on. */
function pieceLine(ctx: WizardContext, error: unknown, piece: string): boolean {
  const line = bridgeFailureLine(error, piece)
  if (line === null) return false
  sub(ctx, "settings", `! ${line}`, "warn")
  return true
}

async function provisionServerLane(ctx: WizardContext, deps: WizardDeps): Promise<"saved" | "needs_you" | "skipped"> {
  const approval = lineApproval(ctx, "server_lane")
  if (approval !== true) {
    // Writing env vars to the customer's Vercel production needs the user's yes on the plan line.
    const why =
      approval === false
        ? "you said no to it in the plan"
        : (ctx.state.get().plan?.lines ?? []).some((line) => lineKind(line.id) === "server_lane")
          ? "its plan line was not approved"
          : "the plan has no server lane for this site"
    sub(ctx, "settings", `Server lane: nothing saved on Vercel (${why})`, "info")
    return "skipped"
  }
  sub(ctx, "settings", "Saving the server-lane settings on Vercel…", "pending")
  try {
    const response = await deps.bridge.provisionServerLaneEnv({ redeploy: "skip" }, { signal: ctx.signal })
    sub(ctx, "settings", STEP_COPY_OVERRIDES.settings.sub1, "ok")
    if (!("skipped" in response.redeploy)) {
      // The wizard asked for no redeploy; anything else is the cloud's doing and is reported, not hidden.
      sub(ctx, "settings", "! Infinite reported a production redeploy it was not asked for", "warn")
    }
    return "saved"
  } catch (error) {
    if (isBridgeError(error) && error.code === "missing_scope") {
      sub(ctx, "settings", "! Infinite can't write Vercel settings yet: allow env-var writes in Infinite (Connections › Vercel)", "warn")
      return "needs_you"
    }
    if (isBridgeError(error) && error.code === "ambiguous_connection") {
      if (!pieceLine(ctx, error, "Server lane")) sub(ctx, "settings", "! More than one Vercel connection matches this site: pick one in Infinite (Connections › Vercel)", "warn")
      return "needs_you"
    }
    if (pieceLine(ctx, error, "Server lane")) return "needs_you"
    throw error
  }
}

async function enableMetaRelay(ctx: WizardContext, deps: WizardDeps): Promise<"on" | "waiting" | "skipped" | "needs_you"> {
  const approval = lineApproval(ctx, "meta_relay")
  if (approval !== true) {
    if (approval === false) sub(ctx, "settings", "Meta server events: not switched on (you said no to it in the plan)", "info")
    return "skipped"
  }
  const status = await deps.bridge.metaRelayStatus({ signal: ctx.signal })
  // §3z.7 (A23): bind when the line is approved AND (available OR not yet rolled out): at switch-on the
  // site already works, with no re-run. Any other reason (no pixel, Infinite's dataset, not production) waits.
  const notRolledOut = !status.available && status.reason === "not_rolled_out"
  if (!status.available && !notRolledOut) {
    sub(ctx, "settings", status.reason ? RELAY_UNAVAILABLE_TEXT[status.reason] : "Meta server events: not available yet", "info")
    return "waiting"
  }
  const runId = ctx.runId ?? ctx.state.get().runId
  const chosen = (await readKeysResult(deps.fs, ctx.root, runId))?.choices.metaPixel ?? null
  if (status.enabled && status.bound) {
    if (chosen && status.bound.pixelId !== chosen.pixelId) {
      // The browser pixel and the server events would go to different pixels, so the shared event id (D11)
      // could never dedupe. Reported, never re-bound without the user.
      sub(
        ctx,
        "settings",
        `! Meta server events are on for pixel ${status.bound.pixelId}, but this site uses pixel ${chosen.pixelId}. Switch the server events to ${chosen.pixelId} in Infinite (Connections › Meta)`,
        "warn"
      )
      return "needs_you"
    }
    sub(ctx, "settings", `✓ Meta server events: already on (pixel ${status.bound.pixelId})`, "ok")
    return "on"
  }
  const sourceRef = chosen?.sourceRef ?? null
  if (!sourceRef) {
    sub(ctx, "settings", "! Meta server events: no Meta pixel was chosen for this site, so nothing was switched on", "warn")
    return "needs_you"
  }
  try {
    const enabled = await deps.bridge.enableMetaRelay({ sourceRef, enable: true }, { signal: ctx.signal })
    if (!enabled.available) {
      // Bound while not rolled out: it reads "ready, waiting for Infinite to switch on".
      sub(ctx, "settings", `${RELAY_UNAVAILABLE_TEXT.not_rolled_out} (pixel ${enabled.bound?.pixelId ?? chosen?.pixelId ?? ""} bound)`, "info")
      return "waiting"
    }
    sub(ctx, "settings", `✓ Meta server events: on (pixel ${enabled.bound?.pixelId ?? chosen?.pixelId ?? ""})`, "ok")
    return "on"
  } catch (error) {
    if (isBridgeError(error) && error.code === "relay_not_available") {
      const reason = (error.state ?? "") as keyof typeof RELAY_UNAVAILABLE_TEXT
      sub(ctx, "settings", RELAY_UNAVAILABLE_TEXT[reason] ?? `Meta server events: not available (${error.state ?? "not available"})`, "info")
      return "waiting"
    }
    if (pieceLine(ctx, error, "Meta server events")) return "needs_you"
    throw error
  }
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const missing = missingCapabilities(deps.bridge, META.requiredCapabilities)
  if (missing.length > 0) return protocolOutcome(missing)
  const runId = ctx.runId ?? ctx.state.get().runId
  if (!runId) throw new Error("settings: no cloud run (the agent step creates it before this step runs)")
  if (deps.agents.isAgentAlive()) throw new Error("settings: a state-changing bridge verb while an agent child is alive (§3a.9.4)")
  const plan = ctx.state.get().plan
  if (!plan) return { kind: "skipped", reason: "No approved plan, so there are no settings to save." }

  try {
    const run = (await deps.bridge.getRun(runId, { signal: ctx.signal })).run
    const cloudApproved = new Set(run.approvedConversions)
    const approved = [...new Set(plan.answers.conversions)].filter((name) => cloudApproved.has(name) && CONVERSION_NAME_PATTERN.test(name))

    // 1. Conversions (approved names only).
    let declared: string[] = []
    if (approved.length > 0) {
      sub(ctx, "settings", `Declaring ${approved.length} conversion${approved.length === 1 ? "" : "s"} in Infinite…`, "pending")
      try {
        const response = await deps.bridge.declareConversions({ runId, conversions: approved.map(conversionDeclaration) }, { signal: ctx.signal })
        declared = response.declared
        if (declared.length > 0) sub(ctx, "settings", `✓ Conversions declared: ${declared.join(" · ")}`, "ok")
        for (const refused of response.refused) sub(ctx, "settings", `! Infinite refused ${refused.name} (${refused.reason})`, "warn")
      } catch (error) {
        // §3z.7 (A27): `would_drop_ga4_events` declares nothing and says why; a lock or a role is a user line.
        if (!pieceLine(ctx, error, "Conversions")) throw error
      }
    } else {
      sub(ctx, "settings", "No conversions were approved, so none were declared", "info")
    }

    // 2. Server lane on Vercel (no redeploy; goes live with the merge).
    const serverLane = await provisionServerLane(ctx, deps)

    // 3. GA4 key events: approved AND offline click-tested only.
    const clickTested = new Set(run.clickTestedConversions)
    const keyEventNames = approved.filter((name) => clickTested.has(name))
    let marked: string[] = []
    if (keyEventNames.length > 0) {
      const response = await deps.bridge.markGa4KeyEvents({ runId, names: keyEventNames }, { signal: ctx.signal })
      marked = [...response.created, ...response.alreadyExisted]
      if (marked.length > 0) {
        sub(ctx, "settings", `GA4 key events: marked for ${marked.length} conversion${marked.length === 1 ? "" : "s"} (click test passed)`, "ok")
      }
      for (const refused of response.refused) sub(ctx, "settings", `! GA4 key event not marked for ${refused.name} (${refused.reason})`, "warn")
    } else if (approved.length > 0) {
      sub(ctx, "settings", "GA4 key events: none yet (each is marked once its click test passes)", "info")
    }

    // 4. Meta relay (approved line AND available).
    const relay = await enableMetaRelay(ctx, deps)

    const parts = [
      serverLane === "saved" ? "Vercel: settings saved" : serverLane === "needs_you" ? "Vercel: needs your permission in Infinite" : "Vercel: skipped",
      `${declared.length} conversion${declared.length === 1 ? "" : "s"} declared`
    ]
    if (marked.length > 0) parts.push(`${marked.length} GA4 key event${marked.length === 1 ? "" : "s"}`)
    if (relay === "on") parts.push("Meta server events on")
    if (relay === "needs_you") parts.push("Meta server events: needs you in Infinite")
    return { kind: "ok", status: parts.join(" · ") }
  } catch (error) {
    const outcome = outcomeFor(error)
    if (outcome) return outcome
    throw error
  }
}

export const step: WizardStep<"settings"> = {
  id: "settings",
  title: META.title,
  who: [...META.who],
  learn: META.learn,
  requiredCapabilities: [...META.requiredCapabilities],
  inputHash: (ctx) => {
    // Tolerates a bare context (F0's structural test hashes `{}`).
    const state = ctx.state?.get()
    return hashInputs({
      step: "settings",
      runId: ctx.runId ?? state?.runId ?? null,
      plan: state?.plan?.hash ?? null,
      jobs: state?.steps.jobs?.inputHash ?? null
    })
  },
  run
}
