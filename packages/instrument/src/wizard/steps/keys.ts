// Step 3 `keys` (§3d.1): "Keys from Infinite · nothing to paste".
//
// The wizard's keys are the bridge `keys` verb ONLY: the user's Infinite connections, public IDs only (R2-16).
// No flag, discovered file or repo `.env` value is ever used as a key, whether or not the connection has one.
// `before` already read the keys silently (for the dry load's `expect`); this step re-reads them and:
// - asks which GA4 web stream is this site when the property has more than one (and which pixel when the Meta
//   connection has several); a choice is remembered for resumes; no answer → parked NEEDS_ANSWERS;
// - compares the connection's IDs with what `before` saw on the live site and in the code: a mismatch is a
//   plan line, never an overwrite;
// - turns every missing connection into a "connect it in Infinite" line (that tool's `ids_match_connections`
//   is `undetermined (not_connected)`);
// - when the workspace's Meta pixel is Infinite's own dataset, says so and never installs Meta.
// The result (choices, comparisons, lines) goes to `.infinite/wizard/keys.json` for the plan step.
import type { AskOption } from "../contracts/asks.js"
import { ASK_CANCELLED, ASK_TIMEOUT } from "../contracts/asks.js"
import type { TagKeys } from "../contracts/bridge.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { isBridgeError } from "../../bridge/errors.js"
import { bridgeErrorOutcome, missingCapabilities, protocolOutcome } from "../../bridge/outcomes.js"
import { hashInputs, sub } from "../../bridge/step-kit.js"
import { observedIdsFromBefore, readBeforeFacts } from "../handoff/before-facts.js"
import {
  KEYS_RESULT_SCHEMA,
  compareKeys,
  keysDigest,
  keysPlanLines,
  readKeysResult,
  writeKeysResult,
  type KeysChoices,
  type KeysStepResult,
  type KeysToolComparison
} from "../handoff/keys-result.js"

const META = WIZARD_STEP_META.keys

function hostOf(uri: string | null): string | null {
  if (!uri) return null
  try {
    return new URL(uri).hostname.toLowerCase()
  } catch {
    return null
  }
}

function needsAnswer(what: string): StepOutcome {
  return {
    kind: "parked",
    code: "INF_WIZ_NEEDS_ANSWERS",
    reason: `${what} needs your answer.`,
    resumeHint: "Run npx infinite-tag --resume in your own terminal to answer it."
  }
}

/** This site's GA4 stream: the only one, the one chosen before, or the user's answer (never guessed). */
async function chooseGa4Stream(
  ctx: WizardContext,
  keys: TagKeys,
  previous: KeysChoices | null,
  liveIds: readonly string[],
  hostHints: readonly string[]
): Promise<{ id: string | null } | { parked: StepOutcome }> {
  if (keys.ga4.status !== "connected" || keys.ga4.streams.length === 0) return { id: null }
  const streams = keys.ga4.streams
  if (streams.length === 1) return { id: streams[0]?.measurementId ?? null }
  const ids = streams.map((stream) => stream.measurementId)
  if (previous?.ga4MeasurementId && ids.includes(previous.ga4MeasurementId)) return { id: previous.ga4MeasurementId }
  const options: AskOption[] = streams.map((stream) => ({
    label: `${hostOf(stream.defaultUri) ?? stream.streamName ?? "web stream"}  (${stream.measurementId})`,
    value: stream.measurementId
  }))
  // Highlight (never pick) the stream the live site already uses, else the one on the production host.
  const preferred =
    streams.find((stream) => liveIds.includes(stream.measurementId)) ??
    streams.find((stream) => {
      const host = hostOf(stream.defaultUri)
      return host !== null && hostHints.includes(host)
    })
  const answer = await ctx.ask("single", {
    question: `The GA4 property has ${streams.length} web streams. Which one is this site?`,
    options,
    ...(preferred ? { default: preferred.measurementId } : {})
  })
  if (answer === ASK_CANCELLED || answer === ASK_TIMEOUT || !ids.includes(answer)) return { parked: needsAnswer("Choosing this site's GA4 stream") }
  return { id: answer }
}

/** This site's Meta pixel: the only one, the one chosen before, or the user's answer. */
async function chooseMetaPixel(
  ctx: WizardContext,
  keys: TagKeys,
  previous: KeysChoices | null,
  liveIds: readonly string[]
): Promise<{ pixel: KeysChoices["metaPixel"] } | { parked: StepOutcome }> {
  if ((keys.meta.status !== "connected" && keys.meta.status !== "multiple") || keys.meta.pixels.length === 0) return { pixel: null }
  const pixels = keys.meta.pixels
  const only = pixels.length === 1 ? pixels[0] : undefined
  if (only) return { pixel: { pixelId: only.pixelId, sourceRef: only.sourceRef } }
  const remembered = previous?.metaPixel ? pixels.find((pixel) => pixel.pixelId === previous.metaPixel?.pixelId) : undefined
  if (remembered) return { pixel: { pixelId: remembered.pixelId, sourceRef: remembered.sourceRef } }
  const preferred = pixels.find((pixel) => liveIds.includes(pixel.pixelId))
  const answer = await ctx.ask("single", {
    question: `Your Meta connection has ${pixels.length} pixels. Which one is this site's?`,
    options: pixels.map((pixel) => ({ label: `${pixel.adAccountLabel ?? "Meta pixel"}  (${pixel.pixelId})`, value: pixel.pixelId })),
    ...(preferred ? { default: preferred.pixelId } : {})
  })
  const chosen = typeof answer === "string" ? pixels.find((pixel) => pixel.pixelId === answer) : undefined
  if (!chosen) return { parked: needsAnswer("Choosing this site's Meta pixel") }
  return { pixel: { pixelId: chosen.pixelId, sourceRef: chosen.sourceRef } }
}

function keySub(ctx: WizardContext, label: string, comparison: KeysToolComparison | undefined): void {
  if (!comparison) return
  switch (comparison.reason) {
    case "not_connected":
      sub(ctx, "keys", `! ${label}: not connected in Infinite (connect it there; nothing is made up)`, "warn")
      return
    case "read_failed":
      sub(ctx, "keys", `! ${label}: Infinite could not read the connection`, "warn")
      return
    case "no_pixel":
      sub(ctx, "keys", `! ${label}: the connection has no pixel`, "warn")
      return
    case "no_stream":
      sub(ctx, "keys", `! ${label}: the property has no web stream`, "warn")
      return
    case "infinite_dataset":
      sub(ctx, "keys", `${label}: this workspace's pixel is Infinite's own; never installed on a customer site`, "info")
      return
    default:
      sub(ctx, "keys", `✓ ${label}`, "ok")
  }
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const missing = missingCapabilities(deps.bridge, META.requiredCapabilities)
  if (missing.length > 0) return protocolOutcome(missing)

  sub(ctx, "keys", "Reading your Infinite connections…", "pending")
  let keys: TagKeys
  try {
    keys = await deps.bridge.keys({ signal: ctx.signal })
  } catch (error) {
    if (isBridgeError(error)) {
      const outcome = bridgeErrorOutcome(error)
      if (outcome) return outcome
    }
    throw error
  }

  const before = await readBeforeFacts(deps.fs, ctx.root)
  const observed = before ? observedIdsFromBefore(before) : null
  const previous = (await readKeysResult(deps.fs, ctx.root))?.choices ?? null
  const hostHints = [
    ...keys.infinite.productionHosts.map((host) => host.toLowerCase()),
    ...(before?.observedProductionHost ? [before.observedProductionHost.toLowerCase()] : [])
  ]

  const ga4 = await chooseGa4Stream(ctx, keys, previous, observed ? [...observed.live.ga4, ...observed.inCode.ga4] : [], hostHints)
  if ("parked" in ga4) return ga4.parked
  const meta = await chooseMetaPixel(ctx, keys, previous, observed ? [...observed.live.meta, ...observed.inCode.meta] : [])
  if ("parked" in meta) return meta.parked
  const choices: KeysChoices = { ga4MeasurementId: ga4.id, metaPixel: meta.pixel }

  const comparisons = compareKeys(keys, choices, observed)
  const byTool = new Map(comparisons.map((comparison) => [comparison.tool, comparison]))
  keySub(ctx, "PostHog project key", byTool.get("posthog"))
  keySub(ctx, choices.ga4MeasurementId ? `GA4 measurement ID (${choices.ga4MeasurementId})` : "GA4 measurement ID", byTool.get("ga4"))
  keySub(ctx, choices.metaPixel ? `Meta pixel (${choices.metaPixel.pixelId})` : "Meta pixel", byTool.get("meta"))

  const problems = comparisons.filter((comparison) => comparison.state === "problem")
  for (const problem of problems) {
    const label = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta" }[problem.tool]
    sub(ctx, "keys", `! ${label}: the live site uses a different ID than your Infinite connection (a plan line, not an overwrite)`, "warn")
  }
  const compared = comparisons.filter((comparison) => comparison.state === "pass")
  if (observed === null) {
    sub(ctx, "keys", "Live IDs were not measured in this run, so they are not compared", "info")
  } else if (problems.length === 0 && compared.length > 0) {
    sub(ctx, "keys", "✓ Live site uses the same IDs", "ok")
  }

  const lines = keysPlanLines(keys, comparisons)
  const metaInstall = keys.meta.status !== "infinite_dataset" && choices.metaPixel !== null
  const result: KeysStepResult = {
    schema: KEYS_RESULT_SCHEMA,
    at: ctx.now().toISOString(),
    linkId: ctx.state.get().link?.linkId ?? null,
    keysDigest: keysDigest(keys),
    choices,
    comparisons,
    lines,
    metaInstall
  }
  await writeKeysResult(deps.fs, ctx.root, result)

  const toConnect = comparisons.filter((comparison) => comparison.reason === "not_connected" || comparison.reason === "read_failed").length
  const status = toConnect > 0 ? `Keys from Infinite · ${toConnect} to connect in Infinite` : "Keys from Infinite · nothing to paste"
  return { kind: "ok", status }
}

export const step: WizardStep<"keys"> = {
  id: "keys",
  title: META.title,
  who: [...META.who],
  learn: META.learn,
  requiredCapabilities: [...META.requiredCapabilities],
  inputHash: (ctx) => {
    // Tolerates a bare context (F0's structural test hashes `{}`).
    const state = ctx.state?.get()
    return hashInputs({ step: "keys", linkId: state?.link?.linkId ?? null, before: state?.steps.before?.inputHash ?? null })
  },
  run
}
