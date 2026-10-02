import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { O8_BEFORE_FACTS_PATH, O8_BEFORE_FACTS_SCHEMA, writeO8BeforeFile } from "../../../test/wizard/before-file.js"
import { fixtureResponse, loadTestRunCases } from "../../../test/wizard/fake-bridge.js"
import { nodeWizardFs } from "../../../test/wizard/step-harness.js"
import type { TagHosting, TagKeys } from "../contracts/bridge.js"
import type { BeforeFacts } from "../contracts/jobs.js"
import type { TestResult } from "../contracts/test-engine.js"
import { BEFORE_FACTS_PATH, BEFORE_FACTS_SCHEMA, observedIdsFromBefore, readBeforeFacts } from "./before-facts.js"
import { KEYS_RESULT_SCHEMA, applyKeysChoices, compareKeys, keysDigest, keysPlanLines, readKeysResult, writeKeysResult, type KeysStepResult } from "./keys-result.js"

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const OTHER_RUN = "0a0a0a0a-b0de-4c5f-8a21-3e4d5c6b7a80"

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
  it("reads the file lane O8's before writes: .infinite/wizard/before.json, schema infinite-tag.before-facts.v1", async () => {
    expect(BEFORE_FACTS_PATH).toBe(O8_BEFORE_FACTS_PATH)
    expect(BEFORE_FACTS_SCHEMA).toBe(O8_BEFORE_FACTS_SCHEMA)
    const dry = loadTestRunCases().find((candidate) => candidate.id === "dry_live_all_once")?.result as TestResult
    await writeO8BeforeFile(nodeWizardFs, root, RUN, facts(dry))
    expect(statSync(join(root, BEFORE_FACTS_PATH)).mode & 0o777).toBe(0o600)
    const read = await readBeforeFacts(nodeWizardFs, root, RUN)
    expect(read?.facts.observedProductionHost).toBe("acme-store.com")
    expect(read?.measuredAt).toBe("2026-10-02T09:05:00.000Z")
  })

  it("is run-scoped: another run's file, a file with no run id, or no run → null (a stale file is never this run's measurement)", async () => {
    await writeO8BeforeFile(nodeWizardFs, root, OTHER_RUN, facts(null))
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).toBeNull()
    await writeO8BeforeFile(nodeWizardFs, root, null, facts(null))
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).toBeNull()
    await writeO8BeforeFile(nodeWizardFs, root, RUN, facts(null))
    expect(await readBeforeFacts(nodeWizardFs, root, null)).toBeNull()
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).not.toBeNull()
  })

  it("a missing, corrupt or foreign file reads as null (never a guessed match)", async () => {
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).toBeNull()
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(join(root, BEFORE_FACTS_PATH), "{not json")
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).toBeNull()
    writeFileSync(join(root, BEFORE_FACTS_PATH), JSON.stringify({ schema: "something-else", runId: RUN, measuredAt: "x", facts: {} }))
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).toBeNull()
    // O2's old file name and schema are not read (O8's before never writes them).
    writeFileSync(join(root, ".infinite/wizard/before-facts.json"), JSON.stringify({ schema: "infinite-tag.wizard-before-facts.v1", writtenAt: "x", facts: facts(null) }))
    expect(await readBeforeFacts(nodeWizardFs, root, RUN)).toBeNull()
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

  it("compareKeys: a code-only match is a pass on the CODE (no live ids), never a live one", () => {
    const observed = observedIdsFromBefore(facts(null))
    const ga4 = compareKeys(keys(), { ga4MeasurementId: "G-FAKE00001", metaPixel: null }, observed).find((c) => c.tool === "ga4")
    expect(ga4).toMatchObject({ state: "pass", live: [], inCode: ["G-FAKE00001"] })
  })
})

function keysResult(runId: string, change: Partial<KeysStepResult> = {}): KeysStepResult {
  return {
    schema: KEYS_RESULT_SCHEMA,
    runId,
    at: "2026-10-02T09:06:00.000Z",
    linkId: "lk_FAKElinkAcmeStore00000",
    keysDigest: keysDigest(keys()),
    choices: { ga4MeasurementId: "G-FAKE00002", metaPixel: { pixelId: "1234567890123456", sourceRef: "meta_src_FAKE_0001" } },
    comparisons: [],
    lines: [],
    metaInstall: true,
    ...change
  }
}

describe("keys → plan hand-off", () => {
  it("keys.json is run-scoped: another run's choices are never read", async () => {
    await writeKeysResult(nodeWizardFs, root, keysResult(OTHER_RUN))
    expect(await readKeysResult(nodeWizardFs, root, RUN)).toBeNull()
    expect(await readKeysResult(nodeWizardFs, root, null)).toBeNull()
    await writeKeysResult(nodeWizardFs, root, keysResult(RUN))
    expect((await readKeysResult(nodeWizardFs, root, RUN))?.choices.ga4MeasurementId).toBe("G-FAKE00002")
  })

  it("keysDigest is the connections only: the same keys with another envelope hash the same; a changed id does not", () => {
    const a = { ...keys(), protocolVersion: 1, requestId: "00000000-0000-4000-8000-000000000001" } as TagKeys
    const b = { ...keys(), protocolVersion: 1, requestId: "00000000-0000-4000-8000-000000000002" } as TagKeys
    expect(keysDigest(a)).toBe(keysDigest(b))
    expect(keysDigest(a)).toBe(keysDigest(keys()))
    // Key order does not matter.
    const reordered = Object.fromEntries(Object.entries(keys()).reverse()) as unknown as TagKeys
    expect(keysDigest(reordered)).toBe(keysDigest(keys()))
    const changed = keys()
    changed.ga4.streams = changed.ga4.streams.slice(0, 1)
    expect(keysDigest(changed)).not.toBe(keysDigest(keys()))
  })

  it("applyKeysChoices narrows GA4 to the chosen stream and Meta to the chosen pixel; never adds an id", () => {
    const base = keys()
    base.meta = {
      status: "multiple",
      pixels: [
        { pixelId: "1234567890123456", sourceRef: "meta_src_FAKE_0001", adAccountLabel: null },
        { pixelId: "6543210987654321", sourceRef: "meta_src_FAKE_0002", adAccountLabel: null }
      ]
    }
    const narrowed = applyKeysChoices(base, keysResult(RUN, { choices: { ga4MeasurementId: "G-FAKE00002", metaPixel: { pixelId: "6543210987654321", sourceRef: "meta_src_FAKE_0002" } } }))
    expect(narrowed.ga4.streams.map((stream) => stream.measurementId)).toEqual(["G-FAKE00002"])
    expect(narrowed.meta).toEqual({ status: "connected", pixels: [{ pixelId: "6543210987654321", sourceRef: "meta_src_FAKE_0002", adAccountLabel: null }] })
    // The input is not mutated.
    expect(base.ga4.streams).toHaveLength(2)
    // No result, or a choice that is not among the connection's ids → nothing narrowed, nothing added.
    expect(applyKeysChoices(base, null)).toEqual(base)
    const unknown = applyKeysChoices(base, keysResult(RUN, { choices: { ga4MeasurementId: "G-NOTMINE01", metaPixel: { pixelId: "1111111111111111", sourceRef: "meta_src_X" } } }))
    expect(unknown.ga4.streams).toHaveLength(2)
    expect(unknown.meta.status).toBe("multiple")
    expect(JSON.stringify(unknown)).not.toContain("G-NOTMINE01")
    // Meta is never made installable when keys said no Meta install (e.g. Infinite's own dataset).
    const noInstall = applyKeysChoices(base, keysResult(RUN, { metaInstall: false }))
    expect(noInstall.meta.status).toBe("multiple")
  })
})
