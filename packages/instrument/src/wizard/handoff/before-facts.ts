// The `before` → `keys` hand-off: the IDs the live site and the code use, measured by `before` (lane O8).
//
// §3d.1 says the `keys` step compares the connection's IDs "with the live IDs from `before`", but the run state
// (§3d.6) has no field for them and WizardDeps no channel. This lane therefore defines ONE file both steps use:
// `.infinite/wizard/before-facts.json` (under the wizard's gitignore fence, mode 0600), holding `before`'s
// BeforeFacts. `before` writes it with `writeBeforeFacts` (an integration item for O8/I1, recorded in the O2
// note); `keys` reads it with `readBeforeFacts`. A missing or unreadable file never invents a match: the
// comparison reads `undetermined (not measured)`.
//
// The IDs here are only ever COMPARED with the connection's. They are never used as keys (R2-16).
import { join } from "node:path"

import type { WizardFs } from "../contracts/deps.js"
import type { BeforeFacts } from "../contracts/jobs.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import type { TestTool } from "../contracts/test-engine.js"

export const BEFORE_FACTS_PATH = `${WIZARD_PATHS.dir}/before-facts.json` as const
export const BEFORE_FACTS_SCHEMA = "infinite-tag.wizard-before-facts.v1" as const

interface BeforeFactsFile {
  schema: typeof BEFORE_FACTS_SCHEMA
  writtenAt: string
  facts: BeforeFacts
}

export async function writeBeforeFacts(fs: WizardFs, root: string, facts: BeforeFacts, writtenAt: string): Promise<void> {
  const file: BeforeFactsFile = { schema: BEFORE_FACTS_SCHEMA, writtenAt, facts }
  await fs.mkdirp(join(root, WIZARD_PATHS.dir), 0o700)
  await fs.writeTextAtomic(join(root, BEFORE_FACTS_PATH), `${JSON.stringify(file, null, 2)}\n`, 0o600)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The facts `before` saved, or null when the file is missing, unreadable or not this schema. */
export async function readBeforeFacts(fs: WizardFs, root: string): Promise<BeforeFacts | null> {
  const text = await fs.readText(join(root, BEFORE_FACTS_PATH))
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schema !== BEFORE_FACTS_SCHEMA || !isRecord(parsed.facts)) return null
  const facts = parsed.facts
  if (!isRecord(facts.census) || !Array.isArray(facts.census.entries)) return null
  if (facts.dryLive !== null && !isRecord(facts.dryLive)) return null
  return facts as unknown as BeforeFacts
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
