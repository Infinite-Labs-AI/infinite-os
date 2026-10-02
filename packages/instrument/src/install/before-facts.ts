// What `before` measured, read for the `plan` and `install` steps, and what the `keys` step chose.
//
// The steps contract (§3d.8) gives a step no channel to the facts an earlier step measured, and a
// resume runs in a fresh process, so the facts live beside the run state in the gitignored wizard dir.
// ONE writer per file, and this lane writes neither (P1-9: three lanes had defined the hand-off three
// ways):
//   • `.infinite/wizard/before.json` is lane O8's (`before` writes it: schema
//     `infinite-tag.before-facts.v1`, `{runId, facts, baselineBuild, baseline, …}`). This module reads
//     the fields the plan uses: `facts`, `baseline` (C3) and `baselineBuild` (O6).
//   • `.infinite/wizard/keys.json` is lane O2's (`keys` writes it: schema `infinite-tag.wizard-keys.v1`,
//     `{choices: {ga4MeasurementId, metaPixel}}`). The plan narrows the connection's keys to those
//     choices, so a user who picked a GA4 stream or a Meta pixel gets exactly that one installed.
//
// When a file is absent, unreadable, another run's or another schema, the plan says so: measured values
// show "—", the guard uses only the hosts Infinite lists, and several streams/pixels are never guessed.
import { join } from "node:path"

import type { TagKeys } from "../wizard/contracts/bridge.js"
import type { WizardFs } from "../wizard/contracts/deps.js"
import type { BuildResult } from "../wizard/contracts/jobs.js"
import type { BaselineResponseFields } from "../wizard/contracts/report.js"
import { WIZARD_PATHS } from "../wizard/contracts/state.js"

import type { WizardBeforeFacts } from "./plan-model.js"

/** Lane O8's `BEFORE_FACTS_PATH` (`ios:…/src/wizard/steps/before.ts` on the O8 branch). */
export const BEFORE_FACTS_RELATIVE_PATH = `${WIZARD_PATHS.dir}/before.json`
/** Lane O8's `BEFORE_FACTS_SCHEMA`. */
export const BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1" as const

/** Lane O2's `KEYS_RESULT_PATH` / `KEYS_RESULT_SCHEMA` (`ios:…/src/wizard/handoff/keys-result.ts` on the O2 branch). */
export const KEYS_RESULT_RELATIVE_PATH = `${WIZARD_PATHS.dir}/keys.json`
export const KEYS_RESULT_SCHEMA = "infinite-tag.wizard-keys.v1" as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The facts of THIS run, or null (absent, unreadable, another run's, or another schema). */
export async function readBeforeFacts(fs: WizardFs, root: string, runId: string | null): Promise<WizardBeforeFacts | null> {
  const text = await fs.readText(join(root, BEFORE_FACTS_RELATIVE_PATH))
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schema !== BEFORE_FACTS_SCHEMA || !isRecord(parsed.facts)) return null
  if (runId !== null && typeof parsed.runId === "string" && parsed.runId !== runId) return null
  const facts = parsed.facts
  if (!isRecord(facts.census) || !Array.isArray(facts.census.entries) || !isRecord(facts.keys) || !isRecord(facts.hosting)) return null
  if (facts.dryLive !== null && facts.dryLive !== undefined && !isRecord(facts.dryLive)) return null
  return {
    ...(facts as unknown as WizardBeforeFacts),
    baseline: isRecord(parsed.baseline) ? (parsed.baseline as unknown as BaselineResponseFields) : null,
    baselineBuild: isRecord(parsed.baselineBuild) ? (parsed.baselineBuild as unknown as BuildResult) : null
  }
}

/** The `keys` step's choices among the connection's own ids (never a key from anywhere else). */
export interface KeysChoices {
  ga4MeasurementId: string | null
  metaPixel: { pixelId: string; sourceRef: string } | null
}

export async function readKeysChoices(fs: WizardFs, root: string): Promise<KeysChoices | null> {
  const text = await fs.readText(join(root, KEYS_RESULT_RELATIVE_PATH))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed) || parsed.schema !== KEYS_RESULT_SCHEMA || !isRecord(parsed.choices)) return null
    const ga4 = parsed.choices.ga4MeasurementId
    const meta = parsed.choices.metaPixel
    return {
      ga4MeasurementId: typeof ga4 === "string" ? ga4 : null,
      metaPixel: isRecord(meta) && typeof meta.pixelId === "string" ? { pixelId: meta.pixelId, sourceRef: typeof meta.sourceRef === "string" ? meta.sourceRef : "" } : null
    }
  } catch {
    return null
  }
}

/**
 * The connection's keys narrowed to the `keys` step's choices: the chosen GA4 stream / Meta pixel only,
 * and only when the connection still offers it (a stale choice narrows nothing, so nothing is guessed).
 */
export function narrowKeysToChoices(keys: TagKeys, choices: KeysChoices | null): TagKeys {
  if (!choices) return keys
  let narrowed = keys
  if (choices.ga4MeasurementId && keys.ga4.status === "connected") {
    const stream = keys.ga4.streams.find((entry) => entry.measurementId === choices.ga4MeasurementId)
    if (stream) narrowed = { ...narrowed, ga4: { ...keys.ga4, streams: [stream] } }
  }
  if (choices.metaPixel && (keys.meta.status === "connected" || keys.meta.status === "multiple")) {
    const pixel = keys.meta.pixels.find((entry) => entry.pixelId === choices.metaPixel!.pixelId)
    if (pixel) narrowed = { ...narrowed, meta: { ...keys.meta, status: "connected", pixels: [pixel] } }
  }
  return narrowed
}
