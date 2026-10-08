import * as childProcess from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { startFakeBridge, type FakeBridge, type FakeBridgeScript } from "../../../test/wizard/fake-bridge.js"
import { freshState, makeContext, makeDeps, nodeWizardFs } from "../../../test/wizard/step-harness.js"
import { openTagBridge } from "../../bridge/client.js"
import type { WizardRunState } from "../contracts/state.js"
import { KEYS_RESULT_SCHEMA, writeKeysResult } from "../handoff/keys-result.js"
import { step } from "./settings.js"
import { writeBeforeFacts } from "../../../test/wizard/o7-fakes.js"

// Every way to start a process, spied: the settings step must never start one (no `vercel`, ever).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    fork: vi.fn(actual.fork)
  }
})

const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
let root: string
const bridges: FakeBridge[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinite-tag-settings-root-"))
})

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

type PlanLines = Array<{ id: string; approved: boolean | null }>

function planState(conversions: string[], lines: PlanLines): Partial<WizardRunState> {
  return {
    runId: RUN_ID,
    plan: {
      hash: `sha256:${"b".repeat(64)}`,
      answers: { consentMode: "not_required", conversions, privacyApproved: true, npmInstall: true, metaGoal: "StartTrial" },
      lines
    }
  }
}

async function setup(options: {
  conversions: string[]
  lines: PlanLines
  approved: string[]
  clickTested: string[]
  script?: Partial<FakeBridgeScript>
  agentAlive?: boolean
  /** The run that wrote keys.json (default this run). */
  keysRunId?: string
}) {
  const bridge = await startFakeBridge({ script: { link: "remembered", ...options.script } })
  bridges.push(bridge)
  bridge.script.run = { ...bridge.script.run, runId: RUN_ID, approvedConversions: options.approved, clickTestedConversions: options.clickTested }
  const client = openTagBridge({ env: bridge.env, platform: "darwin", tagVersion: "0.12.0-test" })
  const linked = await client.requestLink({
    code: "1234",
    site: { repoFingerprint: `sha256:${"a".repeat(64)}`, repoLabel: "github.com/acme/acme-store", appRoot: ".", folderLabel: "~/x", productionHostHint: null },
    client: { tagVersion: "x" }
  })
  client.setLinkId(linked.link?.linkId ?? null)
  bridge.calls.length = 0
  await writeKeysResult(nodeWizardFs, root, {
    schema: KEYS_RESULT_SCHEMA,
    runId: options.keysRunId ?? RUN_ID,
    at: "2026-10-02T09:06:00.000Z",
    linkId: linked.link?.linkId ?? null,
    keysDigest: `sha256:${"c".repeat(64)}`,
    choices: { ga4MeasurementId: "G-FAKE00001", metaPixel: { pixelId: "1234567890123456", sourceRef: "meta_src_FAKE_0001" } },
    comparisons: [],
    lines: [],
    metaInstall: true
  })
  // `before`'s facts for this run, as a real run has them (the server lane's fresh re-check reads its keys).
  await writeBeforeFacts(nodeWizardFs, root, RUN_ID, {
    hosting: { provider: bridge.script.hosting.provider, vercel: bridge.script.hosting.vercel },
    keys: bridge.script.keys,
    census: { entries: [], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } },
    dryLive: null,
    checks: [],
    observedProductionHost: "acme-store.com"
  })
  const harness = makeContext({ root, runId: RUN_ID, state: freshState(root, planState(options.conversions, options.lines)) })
  return { bridge, harness, deps: makeDeps({ bridge: client, agentAlive: options.agentAlive ?? false }) }
}

const ALL_APPROVED: PlanLines = [
  { id: "install_provider:infinite", approved: true },
  { id: "account_settings:ga4", approved: true },
  { id: "account_settings:hosting", approved: true },
  { id: "meta_relay", approved: true }
]

function bodies(bridge: FakeBridge): string {
  return JSON.stringify(bridge.calls.map((call) => call.body))
}

describe("step settings", () => {
  it("declares approved conversions, saves the server lane with redeploy skip, marks click-tested key events, enables the relay", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: ["signup", "lead", "subscribe"],
      lines: ALL_APPROVED,
      approved: ["signup", "lead", "subscribe"],
      clickTested: ["signup"]
    })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({ kind: "ok", status: "Vercel: settings saved · 3 conversions declared · 1 GA4 key event · Meta server events on" })
    expect(bridge.calls.map((call) => call.verb)).toEqual([
      "runs.get",
      "conversions",
      // §3y.6: a fresh hosting read re-checks that the lane can run before anything is written.
      "hosting",
      "server-lane.provision-env",
      "ga4-key-events",
      "meta-relay.status",
      "meta-relay.enable"
    ])
    const conversions = bridge.callsFor("conversions")[0]?.body as { runId: string; conversions: unknown[] }
    expect(conversions.runId).toBe(RUN_ID)
    expect(conversions.conversions).toEqual([
      { name: "signup", type: "signup", dedupe: "account" },
      { name: "lead", type: "lead", dedupe: "event" },
      { name: "subscribe", type: "custom", dedupe: "account", label: "Subscribe" }
    ])
    // No connection id is sent; the cloud resolves it. Never a production redeploy.
    expect(bridge.callsFor("server-lane.provision-env")[0]?.body).toEqual({
      protocolVersion: 1,
      requestId: expect.any(String),
      redeploy: "skip"
    })
    expect((bridge.callsFor("ga4-key-events")[0]?.body as { names: string[] }).names).toEqual(["signup"])
    expect((bridge.callsFor("meta-relay.enable")[0]?.body as { sourceRef: string }).sourceRef).toBe("meta_src_FAKE_0001")
    expect(harness.subs()).toContain("✓ Saved on Vercel · goes live with your merge")
    expect(harness.subs().join("\n")).not.toMatch(/restart/i)
  })

  it("never starts a process (no vercel)", async () => {
    const { harness, deps } = await setup({ conversions: ["signup"], lines: ALL_APPROVED, approved: ["signup"], clickTested: ["signup"] })
    await step.run(harness.ctx, deps)
    for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
      expect(vi.mocked(childProcess[fn]), fn).not.toHaveBeenCalled()
    }
  })

  it("only approved names are sent anywhere; an unapproved click-tested name is never marked (negative)", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: ["signup", "purchase"],
      lines: ALL_APPROVED,
      approved: ["signup"],
      clickTested: ["signup", "purchase"]
    })
    await step.run(harness.ctx, deps)
    expect(bodies(bridge)).not.toContain("purchase")
    expect((bridge.callsFor("ga4-key-events")[0]?.body as { names: string[] }).names).toEqual(["signup"])
  })

  it("the Meta relay stays off unless its line was approved", async () => {
    for (const approved of [false, null]) {
      const { bridge, harness, deps } = await setup({
        conversions: ["signup"],
        lines: [
          { id: "account_settings:hosting", approved: true },
          { id: "meta_relay", approved }
        ],
        approved: ["signup"],
        clickTested: []
      })
      await step.run(harness.ctx, deps)
      expect(bridge.callsFor("meta-relay.enable")).toHaveLength(0)
      expect(bridge.callsFor("meta-relay.status")).toHaveLength(0)
    }
  })

  it("negative: a relay refused for another reason (Infinite's own dataset) is never bound", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: [],
      lines: ALL_APPROVED,
      approved: [],
      clickTested: [],
      script: { metaRelay: { available: false, reason: "infinite_dataset", bound: null, enabled: false } }
    })
    await step.run(harness.ctx, deps)
    expect(bridge.callsFor("meta-relay.enable")).toHaveLength(0)
    expect(harness.subs()).toContain("Meta server events: this workspace's pixel is Infinite's own, so it is not used here")
  })

  it("a declined server-lane line → no env write", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: [],
      lines: [{ id: "account_settings:hosting", approved: false }],
      approved: [],
      clickTested: []
    })
    const outcome = await step.run(harness.ctx, deps)
    expect(bridge.callsFor("server-lane.provision-env")).toHaveLength(0)
    expect(outcome).toMatchObject({ kind: "ok", status: "Vercel: skipped · 0 conversions declared" })
  })
})

describe("connected-account settings require their own approval", () => {
  for (const approved of [null] as const) {
    it(`does not imply GA4 will be marked after a passed click test when approval is ${approved}`, async () => {
      const { bridge, harness, deps } = await setup({
        conversions: ["signup"],
        lines: [{ id: "account_settings:ga4", approved }],
        approved: ["signup"],
        clickTested: ["signup"]
      })
      await step.run(harness.ctx, deps)
      expect(bridge.callsFor("ga4-key-events")).toHaveLength(0)
      expect(bridge.callsFor("server-lane.provision-env")).toHaveLength(0)
      expect(harness.subs()).toContain("GA4 key events: not marked (account changes were not approved in the plan)")
      expect(harness.subs().join("\n")).not.toContain("each is marked once its click test passes")
    })
  }
})

describe("step settings: the customer's Vercel is written only with the user's yes", () => {
  for (const [label, lines] of [
    ["a server_lane line left unanswered", [{ id: "account_settings:hosting", approved: null }]]
  ] as const) {
    it(`${label} → no env write (negative)`, async () => {
      const { bridge, harness, deps } = await setup({ conversions: [], lines: [...lines], approved: [], clickTested: [] })
      const outcome = await step.run(harness.ctx, deps)
      expect(bridge.callsFor("server-lane.provision-env")).toHaveLength(0)
      expect(outcome).toMatchObject({ kind: "ok", status: "Vercel: skipped · 0 conversions declared" })
      expect(harness.subs().some((text) => text.startsWith("Server lane: nothing saved on Vercel"))).toBe(true)
    })
  }
})

describe("step settings: Meta relay pixel", () => {
  it("already on for ANOTHER pixel than this site's → a warning, never reported as on", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: [],
      lines: ALL_APPROVED,
      approved: [],
      clickTested: [],
      script: { metaRelay: { available: true, reason: null, bound: { sourceRef: "meta_src_FAKE_0002", pixelId: "6543210987654321" }, enabled: true } }
    })
    const outcome = await step.run(harness.ctx, deps)
    expect(bridge.callsFor("meta-relay.enable")).toHaveLength(0)
    expect(harness.subs()).not.toContain("✓ Meta server events: already on (pixel 6543210987654321)")
    expect(harness.subs().some((text) => text.includes("but this site uses pixel 1234567890123456"))).toBe(true)
    expect((outcome as { status: string }).status).not.toContain("Meta server events on")
  })
})

it("a continued repository install never authorizes connected-account writes", async () => {
  const { bridge, harness, deps } = await setup({ conversions: ["signup"], lines: [{ id: "install_provider:infinite", approved: true }, { id: "server_lane", approved: true }], approved: ["signup"], clickTested: ["signup"] })
  await step.run(harness.ctx, deps)
  expect(bridge.callsFor("server-lane.provision-env")).toHaveLength(0)
  expect(bridge.callsFor("ga4-key-events")).toHaveLength(0)
})

