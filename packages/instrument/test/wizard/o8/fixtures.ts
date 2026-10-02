// Lane O8 test fixtures. The keys, hosting, baseline and dry-load facts are read from F0's cross-repo
// contract fixtures (`contracts/tag-wizard-v1/bridge-verbs.fixtures.json`), so these tests run against
// the same shapes the desktop app answers with. Every value there is an obvious fake.
import { readFileSync } from "node:fs"

import type { HostingResponse, KeysResponse, TagHosting, TagKeys } from "../../../src/wizard/contracts/bridge.js"
import type { BeforeFacts, CensusEntry, CensusResult, ScanResult } from "../../../src/wizard/contracts/jobs.js"
import type { BaselineResponseFields } from "../../../src/wizard/contracts/report.js"
import type { TestResult } from "../../../src/wizard/contracts/test-engine.js"

export const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
export const OTHER_RUN_ID = "11111111-2222-4333-8444-555555555555"

interface FixtureRow {
  verb: string | null
  status: number
  path: string
  response: Record<string, unknown>
}

const ROWS = JSON.parse(
  readFileSync(new URL("../../../contracts/tag-wizard-v1/bridge-verbs.fixtures.json", import.meta.url), "utf8")
) as FixtureRow[]

function firstSuccess(verb: string, predicate: (row: FixtureRow) => boolean = () => true): Record<string, unknown> {
  const row = ROWS.find((candidate) => candidate.verb === verb && candidate.status < 300 && predicate(candidate))
  if (!row) throw new Error(`no ${verb} success row in the contract fixtures`)
  return JSON.parse(JSON.stringify(row.response)) as Record<string, unknown>
}

const strip = <T>(response: Record<string, unknown>): T => {
  const { protocolVersion: _v, requestId: _r, ...rest } = response
  return rest as T
}

export const keysResponse = (): KeysResponse => firstSuccess("keys") as unknown as KeysResponse
export const fixtureKeys = (): TagKeys => strip<TagKeys>(firstSuccess("keys"))
export const hostingResponse = (): HostingResponse => {
  const response = firstSuccess("hosting") as unknown as HostingResponse
  // The story's row asks for env targets; a plain `hosting()` read returns none.
  if (response.vercel) delete response.vercel.envTargets
  return response
}
export const fixtureHosting = (): TagHosting => strip<TagHosting>(hostingResponse() as unknown as Record<string, unknown>)
export const baselineResponse = (): Record<string, unknown> => firstSuccess("baseline")
export const fixtureBaseline = (): BaselineResponseFields => strip<BaselineResponseFields>(firstSuccess("baseline"))

/** The story's production `dry_live` result (the first dry_live poll with a result). */
export function fixtureDryLive(): TestResult {
  const response = firstSuccess("test.poll", (row) => {
    const result = (row.response as { result?: { mode?: string; loads?: Array<{ label: string }> } }).result
    return result?.mode === "dry_live" && result.loads?.[0]?.label === "home"
  })
  return (response as unknown as { result: TestResult }).result
}

export function census(entries: Array<Partial<CensusEntry> & Pick<CensusEntry, "tool" | "kind" | "file" | "line">>, extra: Partial<CensusResult> = {}): CensusResult {
  return {
    entries: entries.map((entry) => ({ id: null, owner: "adopted", ...entry })),
    envSourcedIds: [],
    identify: { identifyCalls: [], resetCalls: [] },
    ...extra
  }
}

export function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return { root: "/repo", appRoot: ".", framework: "next-app-router", packageManager: "pnpm", fileCount: 12, truncated: false, ...overrides }
}

export function beforeFacts(overrides: Partial<BeforeFacts> = {}): BeforeFacts {
  return {
    hosting: fixtureHosting(),
    keys: fixtureKeys(),
    census: census([]),
    dryLive: null,
    checks: [],
    observedProductionHost: "www.acme-store.com",
    ...overrides
  }
}
