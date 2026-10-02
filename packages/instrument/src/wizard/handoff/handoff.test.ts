import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { fixtureResponse, loadTestRunCases } from "../../../test/wizard/fake-bridge.js"
import { nodeWizardFs } from "../../../test/wizard/step-harness.js"
import type { TagHosting, TagKeys } from "../contracts/bridge.js"
import type { BeforeFacts } from "../contracts/jobs.js"
import type { TestResult } from "../contracts/test-engine.js"
import { BEFORE_FACTS_PATH, observedIdsFromBefore, readBeforeFacts, writeBeforeFacts } from "./before-facts.js"
import { compareKeys, keysPlanLines } from "./keys-result.js"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinite-tag-handoff-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function keys(): TagKeys {
  const value = fixtureResponse("keys")
  delete value.protocolVersion
  delete value.requestId
  return value as unknown as TagKeys
}

function facts(dry: TestResult | null): BeforeFacts {
  const hosting = fixtureResponse("hosting")
  return {
    hosting: hosting as unknown as TagHosting,
    keys: keys(),
    census: {
      entries: [
        { tool: "ga4", kind: "gtm", id: "GTM-ABC123", file: "app/layout.tsx", line: 3, owner: "adopted" },
        { tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 14, owner: "adopted" },
        { tool: "meta", kind: "fbq_init", id: null, file: "app/layout.tsx", line: 20, owner: "adopted" }
      ],
      envSourcedIds: [],
      identify: { identifyCalls: [], resetCalls: [] }
    },
    dryLive: dry,
    checks: [],
    observedProductionHost: "acme-store.com"
  }
}

describe("before → keys hand-off", () => {
  it("round-trips through a 0600 file under .infinite/wizard", async () => {
    const dry = loadTestRunCases().find((candidate) => candidate.id === "dry_live_all_once")?.result as TestResult
    await writeBeforeFacts(nodeWizardFs, root, facts(dry), "2026-10-02T09:05:00.000Z")
    expect(statSync(join(root, BEFORE_FACTS_PATH)).mode & 0o777).toBe(0o600)
    const read = await readBeforeFacts(nodeWizardFs, root)
    expect(read?.observedProductionHost).toBe("acme-store.com")
  })

  it("a missing, corrupt or foreign file reads as null (never a guessed match)", async () => {
    expect(await readBeforeFacts(nodeWizardFs, root)).toBeNull()
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(join(root, BEFORE_FACTS_PATH), "{not json")
    expect(await readBeforeFacts(nodeWizardFs, root)).toBeNull()
    writeFileSync(join(root, BEFORE_FACTS_PATH), JSON.stringify({ schema: "something-else", facts: {} }))
    expect(await readBeforeFacts(nodeWizardFs, root)).toBeNull()
  })

  it("observed ids: a GTM container id and an env-sourced id are not compared as GA4 / Meta ids", () => {
    const observed = observedIdsFromBefore(facts(null))
    expect(observed.inCode.ga4).toEqual(["G-FAKE00001"])
    expect(observed.inCode.meta).toEqual([])
    expect(observed.liveMeasured).toBe(false)
  })

  it("compareKeys: a code id outside the connection is a problem; one inside is a pass", () => {
    const observed = observedIdsFromBefore(facts(null))
    const pass = compareKeys(keys(), { ga4MeasurementId: "G-FAKE00001", metaPixel: null }, observed)
    expect(pass.find((c) => c.tool === "ga4")).toMatchObject({ state: "pass" })
    const problem = compareKeys(keys(), { ga4MeasurementId: "G-FAKE00002", metaPixel: null }, observed)
    expect(problem.find((c) => c.tool === "ga4")).toMatchObject({ state: "problem", reason: "mismatch" })
    const line = keysPlanLines(keys(), problem).find((candidate) => candidate.id === "user_action:keys_mismatch_ga4")
    expect(line?.text).toContain("the code has G-FAKE00001")
  })
})
