// THE `before` hand-off (§3z.12 §3d.6, B1): ONE module owns the path, the schema and the envelope. `before`
// (lane O8) WRITES `.infinite/wizard/before.json` here; `keys` (O2) and `plan` / `install` (O7) READ it here.
// The file is `infinite-tag.before-facts.v1`: O8's `BeforeFactsFile`, with the cloud's `baseline` and the
// production build's `baselineBuild` INSIDE `facts` (= O7's `WizardBeforeFacts`). Gitignored, mode 0600,
// public IDs and facts only (never a secret).
//
// Every read is RUN-SCOPED: a file written by another run (it is gitignored, so it outlives the run) or with no
// run id is never this run's measurement. A missing, foreign or unreadable file never invents a match: the
// comparison reads `undetermined (not measured)`, measured values show "—".
//
// The IDs here are only ever COMPARED with the connection's. They are never used as keys (R2-16).
import { join } from "node:path"

import type { WizardFs } from "../contracts/deps.js"
import type { BeforeFacts, BuildResult, CheckResult } from "../contracts/jobs.js"
import type { BaselineResponseFields } from "../contracts/report.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import type { TestResult, TestTool } from "../contracts/test-engine.js"

export const BEFORE_FACTS_PATH = WIZARD_PATHS.beforeFacts
export const BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1" as const

/** `BeforeFacts` plus the cloud's baseline reads and the production build's baseline (O7 `WizardBeforeFacts`). */
export interface BeforeFactsWithBaseline extends BeforeFacts {
  /** The cloud's baseline reads (null when the read failed: never 0). */
  baseline: BaselineResponseFields | null
  baselineBuild: BuildResult | null
}

/** Everything `before` measured, as typed FACTS (no cell is computed from it here). */
export interface BeforeFactsFile {
  schema: typeof BEFORE_FACTS_SCHEMA
  runId: string
  writtenAt: string
  measuredAt: string
  productionHost: string | null
  scan: { framework: string; packageManager: string | null; appRoot: string; fileCount: number; truncated: boolean }
  facts: BeforeFactsWithBaseline
  /** `checks.gradeTestRun` of the dry load, per tool (null when no dry load ran). */
  grades: Partial<Record<TestTool, CheckResult>> | null
  /** The checks by moment, so the builder can map each to its FINISH_LINE_SOURCES input. */
  setupChecks: CheckResult[]
  envTargetChecks: CheckResult[]
  liveChecks: CheckResult[]
  /** The static CMP detector's answer (the grader's `cmpDetected` input when the window saw none). */
  cmpDetected: TestResult["environment"]["cmpDetected"]
  /** A login exists (auth detector): job 9 and the identity row apply. */
  loginFound: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function writeBeforeFactsFile(fs: WizardFs, root: string, file: BeforeFactsFile): Promise<void> {
  await fs.mkdirp(join(root, WIZARD_PATHS.dir), 0o700)
  await fs.writeTextAtomic(join(root, BEFORE_FACTS_PATH), `${JSON.stringify(file, null, 2)}\n`, 0o600)
}

/** THIS run's facts file, or null (no run yet, absent, unreadable, another schema, another run's, or malformed). */
export async function readBeforeFactsFile(fs: WizardFs, root: string, runId: string | null): Promise<BeforeFactsFile | null> {
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
  if (facts.dryLive !== null && facts.dryLive !== undefined && !isRecord(facts.dryLive)) return null
  if (!isRecord(facts.keys) || !isRecord(facts.hosting)) return null
  const normalized: BeforeFactsWithBaseline = {
    ...(facts as unknown as BeforeFactsWithBaseline),
    dryLive: (facts.dryLive ?? null) as BeforeFacts["dryLive"],
    baseline: isRecord(facts.baseline) ? (facts.baseline as unknown as BaselineResponseFields) : null,
    baselineBuild: isRecord(facts.baselineBuild) ? (facts.baselineBuild as unknown as BuildResult) : null
  }
  return { ...(parsed as unknown as BeforeFactsFile), facts: normalized }
}

/** The part of the file the `keys` step reads. */
export interface BeforeFactsEnvelope {
  schema: typeof BEFORE_FACTS_SCHEMA
  runId: string
  measuredAt: string
  facts: BeforeFactsWithBaseline
}

/** The facts `before` measured in THIS run (the `keys` step's view), or null. */
export async function readBeforeFacts(fs: WizardFs, root: string, runId: string | null): Promise<BeforeFactsEnvelope | null> {
  const file = await readBeforeFactsFile(fs, root, runId)
  return file ? { schema: file.schema, runId: file.runId, measuredAt: file.measuredAt, facts: file.facts } : null
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
