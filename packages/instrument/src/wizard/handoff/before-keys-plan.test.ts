// B1 (§3z.12 §3d.6): the before → keys → plan hand-off goes through ONE module per file. `before` (O8) writes
// `.infinite/wizard/before.json`, the `keys` step (O2) reads it and writes `keys.json`, and the plan / install
// steps (O7) read both. Every read is run-scoped; another run's file is never this run's measurement.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { fakeBefore, fakeKeys, IDS } from "../../../test/wizard/o7-fakes.js"
import { narrowKeysToChoices, readBeforeFacts as readPlanBefore, readKeysChoices } from "../../install/before-facts.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { nodeWizardFs } from "../fs.js"
import { BEFORE_FACTS_SCHEMA, readBeforeFacts as readKeysBefore, writeBeforeFactsFile, type BeforeFactsFile } from "./before-facts.js"
import { KEYS_RESULT_SCHEMA, writeKeysResult } from "./keys-result.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "infinite-tag-b1-"))
  roots.push(root)
  return root
}

function factsFile(runId: string): BeforeFactsFile {
  const keys = fakeKeys({
    ga4: {
      status: "connected",
      propertyLabel: "Acme",
      streams: [
        { measurementId: IDS.ga4, defaultUri: "https://acme-store.com", streamName: "Web" },
        { measurementId: IDS.ga4Other, defaultUri: "https://blog.acme-store.com", streamName: "Blog" }
      ]
    }
  })
  return {
    schema: BEFORE_FACTS_SCHEMA,
    runId,
    writtenAt: "2026-10-02T10:01:00.000Z",
    measuredAt: "2026-10-02T10:01:00.000Z",
    productionHost: "acme-store.com",
    scan: { framework: "next-app-router", packageManager: "pnpm", appRoot: ".", fileCount: 12, truncated: false },
    facts: { ...fakeBefore({ keys }), baseline: null, baselineBuild: { ok: false, failureSignature: ["TS2304 app/page.tsx"], durationMs: 9 } },
    grades: null,
    setupChecks: [],
    envTargetChecks: [],
    liveChecks: [],
    cmpDetected: null,
    loginFound: true
  }
}

describe("before → keys → plan (one hand-off module per file, run-scoped)", () => {
  it("the plan reads what before wrote (baselineBuild inside facts) and the keys step's stream choice", async () => {
    const root = repo()
    await writeBeforeFactsFile(nodeWizardFs, root, factsFile(IDS.run))
    // the file is at the §3d.6 path, 0600
    expect(JSON.parse(readFileSync(join(root, WIZARD_PATHS.beforeFacts), "utf8")).schema).toBe(BEFORE_FACTS_SCHEMA)

    // keys step: the same facts
    const forKeys = await readKeysBefore(nodeWizardFs, root, IDS.run)
    expect(forKeys?.facts.observedProductionHost).toBe("acme-store.com")
    await writeKeysResult(nodeWizardFs, root, {
      schema: KEYS_RESULT_SCHEMA,
      runId: IDS.run,
      at: "2026-10-02T10:02:00.000Z",
      linkId: null,
      keysDigest: `sha256:${"0".repeat(64)}`,
      choices: { ga4MeasurementId: IDS.ga4Other, metaPixel: null },
      comparisons: [],
      lines: [],
      metaInstall: true
    })

    // plan step: the facts, with the baseline build inside, and the keys narrowed to the chosen stream
    const before = await readPlanBefore(nodeWizardFs, root, IDS.run)
    expect(before?.baselineBuild).toEqual({ ok: false, failureSignature: ["TS2304 app/page.tsx"], durationMs: 9 })
    const choices = await readKeysChoices(nodeWizardFs, root, IDS.run)
    const narrowed = narrowKeysToChoices(before!.keys, choices)
    expect(narrowed.ga4.streams.map((stream) => stream.measurementId)).toEqual([IDS.ga4Other])
  })

  it("negative: another run's files are never this run's (the plan then re-reads, never reuses)", async () => {
    const root = repo()
    await writeBeforeFactsFile(nodeWizardFs, root, factsFile("99999999-2222-4333-8444-555555555555"))
    await writeKeysResult(nodeWizardFs, root, {
      schema: KEYS_RESULT_SCHEMA,
      runId: "99999999-2222-4333-8444-555555555555",
      at: "2026-10-02T10:02:00.000Z",
      linkId: null,
      keysDigest: `sha256:${"0".repeat(64)}`,
      choices: { ga4MeasurementId: IDS.ga4Other, metaPixel: null },
      comparisons: [],
      lines: [],
      metaInstall: true
    })
    expect(await readKeysBefore(nodeWizardFs, root, IDS.run)).toBeNull()
    expect(await readPlanBefore(nodeWizardFs, root, IDS.run)).toBeNull()
    expect(await readKeysChoices(nodeWizardFs, root, IDS.run)).toBeNull()
    // and with no run yet, nothing is read at all
    expect(await readPlanBefore(nodeWizardFs, root, null)).toBeNull()
    // a stale choice narrows nothing
    expect(narrowKeysToChoices(fakeKeys(), null).ga4.streams).toHaveLength(1)
  })
})
