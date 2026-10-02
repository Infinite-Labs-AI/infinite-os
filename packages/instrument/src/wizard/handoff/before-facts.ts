// The `before` → `keys` hand-off: the IDs the live site and the code use, as measured by `before` (lane O8).
//
// §3d.1 says the `keys` step compares the connection's IDs "with the live IDs from `before`", but the run state
// (§3d.6) has no field for them and WizardDeps no channel. `before` (O8, `steps/before.ts`) therefore writes its
// facts to `.infinite/wizard/before.json` (gitignored, mode 0600) as a `BeforeFactsFile`
// `{schema:"infinite-tag.before-facts.v1", runId, measuredAt, facts, …}`; this module READS that file. O8 owns the
// writer and the full envelope; only the fields read here are declared below, so the two cannot drift silently
// (a renamed path, schema or field reads as "not measured", and the fix-round test pins O8's names).
//
// The read is RUN-SCOPED: a file written by another run (it is gitignored, so it outlives the run) or with no
// run id is never this run's measurement. A missing, foreign or unreadable file never invents a match: the
// comparison reads `undetermined (not measured)`.
//
// The IDs here are only ever COMPARED with the connection's. They are never used as keys (R2-16).
import { join } from "node:path"

import type { WizardFs } from "../contracts/deps.js"
import type { BeforeFacts } from "../contracts/jobs.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import type { TestTool } from "../contracts/test-engine.js"

/** O8's `BEFORE_FACTS_PATH` (`steps/before.ts`). */
export const BEFORE_FACTS_PATH = `${WIZARD_PATHS.dir}/before.json` as const
/** O8's `BEFORE_FACTS_SCHEMA` (`steps/before.ts`). */
export const BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1" as const

/** The part of O8's `BeforeFactsFile` this step reads. */
export interface BeforeFactsEnvelope {
  schema: typeof BEFORE_FACTS_SCHEMA
  runId: string
  measuredAt: string
  facts: BeforeFacts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The facts `before` measured in THIS run, or null when the file is missing, unreadable, another schema, or
 * written by another run (or there is no run yet).
 */
export async function readBeforeFacts(fs: WizardFs, root: string, runId: string | null): Promise<BeforeFactsEnvelope | null> {
  if (runId === null) return null
  const text = await fs.readText(join(root, BEFORE_FACTS_PATH))
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schema !== BEFORE_FACTS_SCHEMA || parsed.runId !== runId || !isRecord(parsed.facts)) return null
  if (typeof parsed.measuredAt !== "string") return null
  const facts = parsed.facts
  if (!isRecord(facts.census) || !Array.isArray(facts.census.entries)) return null
  if (facts.dryLive !== null && !isRecord(facts.dryLive)) return null
  return { schema: BEFORE_FACTS_SCHEMA, runId, measuredAt: parsed.measuredAt, facts: facts as unknown as BeforeFacts }
}

export type ObservedIds = Record<TestTool, string[]>

/** The shape of each tool's public id (a literal of another shape in the code is not that tool's id). */
const ID_SHAPE: Record<TestTool, RegExp> = {
  ga4: /^G-[A-Z0-9]{4,}$/,
  posthog: /^phc_[A-Za-z0-9]+$/,
  meta: /^[0-9]{15,16}$/,
  infinite: /^\S+$/
}

function emptyIds(): ObservedIds {
  return { infinite: [], ga4: [], posthog: [], meta: [] }
}

function pushUnique(list: string[], value: string | null | undefined): void {
  if (typeof value === "string" && value && !list.includes(value)) list.push(value)
}

/**
 * The IDs `before` saw: `live` from the dry load's beacons (cancelled, nothing sent), `inCode` from the census's
 * literal IDs (an env-sourced ID has no literal and is not listed).
 */
export function observedIdsFromBefore(facts: BeforeFacts): { live: ObservedIds; inCode: ObservedIds; liveMeasured: boolean } {
  const live = emptyIds()
  const inCode = emptyIds()
  const dry = facts.dryLive
  if (dry) {
    for (const event of dry.ga4.events) pushUnique(live.ga4, event.tid)
    for (const event of dry.posthog.events) pushUnique(live.posthog, event.projectKey)
    for (const tr of dry.meta.tr) pushUnique(live.meta, tr.pixelId)
    for (const event of dry.infinite.events) pushUnique(live.infinite, event.siteSourceKey)
  }
  for (const entry of facts.census.entries) {
    if (entry.tool === "x" || entry.id === null) continue
    // A GTM container id (GTM-…) is not a GA4 measurement id; only ids of the tool's own shape compare.
    if (!ID_SHAPE[entry.tool].test(entry.id)) continue
    pushUnique(inCode[entry.tool], entry.id)
  }
  return { live, inCode, liveMeasured: dry !== null }
}
