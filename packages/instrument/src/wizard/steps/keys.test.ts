import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { writeO8BeforeFile } from "../../../test/wizard/before-file.js"
import { fixtureResponse, loadTestRunCases, startFakeBridge, type FakeBridge, type FakeBridgeScript } from "../../../test/wizard/fake-bridge.js"
import { makeContext, makeDeps, nodeWizardFs, type HarnessOptions } from "../../../test/wizard/step-harness.js"
import { openTagBridge } from "../../bridge/client.js"
import type { TagHosting, TagKeys } from "../contracts/bridge.js"
import type { BeforeFacts } from "../contracts/jobs.js"
import type { TestResult } from "../contracts/test-engine.js"
import { KEYS_RESULT_PATH, keysDigest, readKeysResult } from "../handoff/keys-result.js"
import { hashInputs, PROCESS_NONCE } from "../../bridge/step-kit.js"
import { step } from "./keys.js"

const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
let root: string
const bridges: FakeBridge[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinite-tag-keys-root-"))
})

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
  rmSync(root, { recursive: true, force: true })
})

function baseKeys(): TagKeys {
  const keys = fixtureResponse("keys")
  delete keys.protocolVersion
  delete keys.requestId
  return keys as unknown as TagKeys
}

function dryLive(change: (result: TestResult) => void = () => undefined): TestResult {
  const result = structuredClone(loadTestRunCases().find((candidate) => candidate.id === "dry_live_all_once")?.result) as TestResult
  change(result)
  return result
}

function beforeFacts(keys: TagKeys, dry: TestResult | null): BeforeFacts {
  const hosting = fixtureResponse("hosting")
  delete hosting.protocolVersion
  delete hosting.requestId
  return {
    hosting: hosting as unknown as TagHosting,
    keys,
    census: { entries: [], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } },
    dryLive: dry,
    checks: [],
    observedProductionHost: "www.acme-store.com"
  }
}

async function setup(keys: TagKeys, context: Partial<HarnessOptions> = {}, script: Partial<FakeBridgeScript> = {}) {
  const bridge = await startFakeBridge({ script: { link: "remembered", keys, ...script } })
  bridges.push(bridge)
  const client = openTagBridge({ env: bridge.env, platform: "darwin", tagVersion: "0.12.0-test" })
  // Link first (the keys verb is link-scoped).
  const linked = await client.requestLink({
    code: "1234",
    site: { repoFingerprint: `sha256:${"a".repeat(64)}`, repoLabel: "github.com/acme/acme-store", appRoot: ".", folderLabel: "~/x", productionHostHint: null },
    client: { tagVersion: "x" }
  })
  client.setLinkId(linked.link?.linkId ?? null)
  bridge.calls.length = 0
  const harness = makeContext({ root, runId: RUN_ID, ...context })
  return { bridge, harness, deps: makeDeps({ bridge: client }) }
}

describe("step keys", () => {
  it("two GA4 web streams → ONE single ask; the choice is saved for the plan", async () => {
    const keys = baseKeys()
    await writeO8BeforeFile(nodeWizardFs, root, RUN_ID, beforeFacts(keys, dryLive()))
    const { harness, deps } = await setup(keys, { answers: [(payload: unknown) => (payload as { options: Array<{ value: string }> }).options[0]?.value] })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({ kind: "ok", status: "Keys from Infinite · nothing to paste" })
    expect(harness.asks).toHaveLength(1)
    const ask = harness.asks[0]
    expect(ask?.kind).toBe("single")
    const payload = ask?.payload as { question: string; options: Array<{ label: string; value: string }>; default?: string }
    expect(payload.question).toBe("The GA4 property has 2 web streams. Which one is this site?")
    expect(payload.options.map((option) => option.value)).toEqual(["G-FAKE00001", "G-FAKE00002"])
    expect(payload.options[0]?.label).toBe("www.acme-store.com  (G-FAKE00001)")
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    expect(result?.choices.ga4MeasurementId).toBe("G-FAKE00001")
    expect(result?.choices.metaPixel).toEqual({ pixelId: "1234567890123456", sourceRef: "meta_src_FAKE_0001" })
    expect(harness.subs()).toContain("✓ Live site uses the same IDs")
  })

  it("a remembered stream choice is reused (no second ask)", async () => {
    const keys = baseKeys()
    const first = await setup(keys, { answers: ["G-FAKE00002"] })
    expect((await step.run(first.harness.ctx, first.deps)).kind).toBe("ok")
    const second = await setup(keys)
    expect((await step.run(second.harness.ctx, second.deps)).kind).toBe("ok")
    expect(second.harness.asks).toHaveLength(0)
    expect((await readKeysResult(nodeWizardFs, root, RUN_ID))?.choices.ga4MeasurementId).toBe("G-FAKE00002")
  })

  it("no answer to the stream ask → parked NEEDS_ANSWERS (never a guessed stream)", async () => {
    const { harness, deps } = await setup(baseKeys(), { answers: ["__cancelled__"] })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS" })
    expect(await readKeysResult(nodeWizardFs, root, RUN_ID)).toBeNull()
  })

  it("a live ID that differs from the connection → a plan line, not an overwrite", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    await writeO8BeforeFile(
      nodeWizardFs,
      root,
      RUN_ID,
      beforeFacts(
        keys,
        dryLive((result) => {
          for (const event of result.ga4.events) event.tid = "G-OLDSTREAM9"
        })
      )
    )
    const { harness, deps } = await setup(keys)
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    const ga4 = result?.comparisons.find((comparison) => comparison.tool === "ga4")
    expect(ga4).toMatchObject({ state: "problem", reason: "mismatch", expected: ["G-FAKE00001"], live: ["G-OLDSTREAM9"] })
    const line = result?.lines.find((candidate) => candidate.id === "user_action:keys_mismatch_ga4")
    expect(line).toMatchObject({ kind: "user_action", requires: "user_action" })
    expect(line?.text).toContain("the live site sends G-OLDSTREAM9, but your Infinite connection is G-FAKE00001")
    expect(line?.text).toContain("will not overwrite")
    // The choice stays the connection's id.
    expect(result?.choices.ga4MeasurementId).toBe("G-FAKE00001")
    expect(harness.subs().some((text) => text.includes("a plan line, not an overwrite"))).toBe(true)
  })

  it("wizard keys come from the keys verb only: a repo .env id and no GA4 connection → no GA4 key, a connect line (negative)", async () => {
    writeFileSync(join(root, ".env"), "NEXT_PUBLIC_GA_ID=G-FAKE\nNEXT_PUBLIC_POSTHOG_KEY=phc_envOnlyKey\n")
    writeFileSync(join(root, ".env.local"), "NEXT_PUBLIC_GA_ID=G-FAKE\n")
    const keys = baseKeys()
    keys.ga4 = { status: "not_connected", propertyLabel: null, streams: [] }
    const { bridge, harness, deps } = await setup(keys)
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({ kind: "ok", status: "Keys from Infinite · 1 to connect in Infinite" })
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    expect(result?.choices.ga4MeasurementId).toBeNull()
    expect(result?.comparisons.find((comparison) => comparison.tool === "ga4")).toMatchObject({ state: "undetermined", reason: "not_connected", expected: [] })
    expect(result?.lines.find((line) => line.id === "user_action:connect_ga4")?.text).toContain("Connect GA4 in Infinite")
    const everything = JSON.stringify([readFileSync(join(root, KEYS_RESULT_PATH), "utf8"), harness.events, harness.asks, bridge.calls])
    expect(everything).not.toContain("G-FAKE")
    expect(everything).not.toContain("phc_envOnlyKey")
    expect(harness.asks).toHaveLength(0)
  })

  it("Infinite's own Meta dataset → an info line and Meta is never installed", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    keys.meta = { status: "infinite_dataset", pixels: [] }
    const { harness, deps } = await setup(keys)
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    expect(result?.metaInstall).toBe(false)
    expect(result?.choices.metaPixel).toBeNull()
    expect(result?.lines.find((line) => line.id === "user_action:meta_infinite_dataset")).toMatchObject({
      requires: "info",
      text: "This workspace's Meta pixel is Infinite's own; it is never installed on a customer site. Meta is skipped."
    })
    expect(harness.subs()).toContain("Meta pixel: this workspace's pixel is Infinite's own; never installed on a customer site")
  })

  it("several Meta pixels → a pixel ask", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    keys.meta = {
      status: "multiple",
      pixels: [
        { pixelId: "1234567890123456", sourceRef: "meta_src_FAKE_0001", adAccountLabel: "Acme Ads (fake)" },
        { pixelId: "6543210987654321", sourceRef: "meta_src_FAKE_0002", adAccountLabel: "Acme EU (fake)" }
      ]
    }
    const { harness, deps } = await setup(keys, { answers: ["6543210987654321"] })
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    expect(harness.asks[0]?.kind).toBe("single")
    expect((await readKeysResult(nodeWizardFs, root, RUN_ID))?.choices.metaPixel).toEqual({ pixelId: "6543210987654321", sourceRef: "meta_src_FAKE_0002" })
  })

  it("without before's facts nothing is claimed to match (undetermined, not measured)", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    const { harness, deps } = await setup(keys)
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    for (const tool of ["ga4", "posthog", "meta", "infinite"]) {
      expect(result?.comparisons.find((comparison) => comparison.tool === tool)).toMatchObject({ state: "undetermined", reason: "not_measured" })
    }
    expect(harness.subs()).not.toContain("✓ Live site uses the same IDs")
  })

  it("Vercel env writes not granted → a user line", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    keys.serverLane.envWriteGranted = false
    const { harness, deps } = await setup(keys)
    await step.run(harness.ctx, deps)
    expect((await readKeysResult(nodeWizardFs, root, RUN_ID))?.lines.map((line) => line.id)).toContain("user_action:vercel_env_write")
  })

  it("402 → blocked SUBSCRIPTION_REQUIRED", async () => {
    const { harness, deps } = await setup(baseKeys(), {}, { errors: { keys: { code: "subscription_required" } } })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
  })

  it("a code-only match is never claimed as the live site (the live load did not run)", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    const facts = beforeFacts(keys, null)
    facts.census.entries = [{ tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 14, owner: "adopted" }]
    await writeO8BeforeFile(nodeWizardFs, root, RUN_ID, facts)
    const { harness, deps } = await setup(keys)
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    expect(harness.subs()).not.toContain("✓ Live site uses the same IDs")
    expect(harness.subs()).toContain("✓ IDs in your code match your Infinite connections (the live site was not measured)")
  })

  it("the live load ran but did not send a compared id → the code match is not called a live one", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    const facts = beforeFacts(
      keys,
      dryLive((result) => {
        result.ga4.events = []
      })
    )
    facts.census.entries = [{ tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 14, owner: "adopted" }]
    await writeO8BeforeFile(nodeWizardFs, root, RUN_ID, facts)
    const { harness, deps } = await setup(keys)
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    expect(harness.subs()).not.toContain("✓ Live site uses the same IDs")
    expect(harness.subs()).toContain("✓ IDs in your code match your Infinite connections")
  })

  it("a before file left by ANOTHER run is not this run's measurement (undetermined, nothing claimed)", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    await writeO8BeforeFile(nodeWizardFs, root, "0a0a0a0a-b0de-4c5f-8a21-3e4d5c6b7a80", beforeFacts(keys, dryLive()))
    const { harness, deps } = await setup(keys)
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    expect(result?.comparisons.find((comparison) => comparison.tool === "ga4")).toMatchObject({ state: "undetermined", reason: "not_measured" })
    expect(harness.subs()).not.toContain("✓ Live site uses the same IDs")
  })

  it("keys.json records the run and a digest of the connections only", async () => {
    const keys = baseKeys()
    keys.ga4.streams = keys.ga4.streams.slice(0, 1)
    const { harness, deps } = await setup(keys)
    await step.run(harness.ctx, deps)
    const result = await readKeysResult(nodeWizardFs, root, RUN_ID)
    expect(result?.runId).toBe(RUN_ID)
    expect(result?.keysDigest).toBe(keysDigest(keys))
  })

  it("is never skipped on resume (connections may have changed): its hash carries the process nonce", () => {
    const harness = makeContext({ root, runId: RUN_ID })
    expect(step.inputHash(harness.ctx)).toBe(step.inputHash(harness.ctx))
    expect(step.inputHash(harness.ctx)).toBe(hashInputs({ step: "keys", linkId: null, before: null, process: PROCESS_NONCE }))
  })

  it("the app quits mid-run (connection refused) → blocked NO_APP, not a crash", async () => {
    const { bridge, harness, deps } = await setup(baseKeys())
    await bridge.close()
    bridges.splice(bridges.indexOf(bridge), 1)
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_NO_APP" })
  })

  it("a cloud 502 on keys → parked INFINITE_UNAVAILABLE with a retry hint (§3z.4), not a crash", async () => {
    const { harness, deps } = await setup(baseKeys(), {}, { errors: { keys: { code: "cloud_error", upstreamStatus: 502 } } })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_INFINITE_UNAVAILABLE" })
    expect((outcome as { resumeHint: string }).resumeHint).toContain("in a minute")
  })

  it("negative: a damaged link store (internal_error, not retryable) blocks NO_APP with the Linked sites hint", async () => {
    const { harness, deps } = await setup(baseKeys(), {}, { errors: { keys: { code: "internal_error", retryable: false } } })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_NO_APP" })
    expect((outcome as { reason: string }).reason).toContain("Linked sites")
  })
})
