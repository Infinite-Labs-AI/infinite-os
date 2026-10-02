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
import { conversionDeclaration, step } from "./settings.js"

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
  const harness = makeContext({ root, runId: RUN_ID, state: freshState(root, planState(options.conversions, options.lines)) })
  return { bridge, harness, deps: makeDeps({ bridge: client, agentAlive: options.agentAlive ?? false }) }
}

const ALL_APPROVED: PlanLines = [
  { id: "install_provider:infinite", approved: true },
  { id: "server_lane", approved: true },
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

  it("no name is click-tested yet → no key events are marked", async () => {
    const { bridge, harness, deps } = await setup({ conversions: ["signup"], lines: ALL_APPROVED, approved: ["signup"], clickTested: [] })
    await step.run(harness.ctx, deps)
    expect(bridge.callsFor("ga4-key-events")).toHaveLength(0)
    expect(harness.subs()).toContain("GA4 key events: none yet (each is marked once its click test passes)")
  })

  it("the Meta relay stays off unless its line was approved", async () => {
    for (const approved of [false, null]) {
      const { bridge, harness, deps } = await setup({
        conversions: ["signup"],
        lines: [
          { id: "server_lane", approved: true },
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

  it("§3z.7 (A23): an approved relay that is not rolled out yet is BOUND, and reads 'ready, waiting for Infinite to switch on'", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: [],
      lines: ALL_APPROVED,
      approved: [],
      clickTested: [],
      script: { metaRelay: { available: false, reason: "not_rolled_out", bound: null, enabled: false } }
    })
    await step.run(harness.ctx, deps)
    expect(bridge.callsFor("meta-relay.enable")).toHaveLength(1)
    expect(harness.subs().some((text) => text.startsWith("Meta server events: ready, waiting for Infinite to switch on"))).toBe(true)
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

  it("§3z.4: role_required on the relay is a user line and the step goes on (nothing changed)", async () => {
    const { harness, deps } = await setup({
      conversions: [],
      lines: ALL_APPROVED,
      approved: [],
      clickTested: [],
      script: { errors: { "meta-relay.enable": { code: "role_required", state: "owner_or_admin" } } }
    })
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    expect(harness.subs().some((text) => text.includes("owner or admin"))).toBe(true)
  })

  it("a declined server-lane line → no env write", async () => {
    const { bridge, harness, deps } = await setup({
      conversions: [],
      lines: [{ id: "server_lane", approved: false }],
      approved: [],
      clickTested: []
    })
    const outcome = await step.run(harness.ctx, deps)
    expect(bridge.callsFor("server-lane.provision-env")).toHaveLength(0)
    expect(outcome).toMatchObject({ kind: "ok", status: "Vercel: skipped · 0 conversions declared" })
  })

  it("no Vercel env-write scope → says what to do and carries on", async () => {
    const { harness, deps } = await setup({
      conversions: ["signup"],
      lines: ALL_APPROVED,
      approved: ["signup"],
      clickTested: [],
      script: { errors: { "server-lane.provision-env": { code: "missing_scope" } }, metaRelay: { available: false, reason: "not_rolled_out", bound: null, enabled: false } }
    })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "ok", status: "Vercel: needs your permission in Infinite · 1 conversion declared" })
    expect(harness.subs().some((text) => text.includes("allow env-var writes in Infinite"))).toBe(true)
  })

  it("refuses to run while an agent child is alive (the engine invariant)", async () => {
    const { bridge, harness, deps } = await setup({ conversions: ["signup"], lines: ALL_APPROVED, approved: ["signup"], clickTested: [], agentAlive: true })
    await expect(step.run(harness.ctx, deps)).rejects.toThrow(/agent child is alive/)
    expect(bridge.calls).toHaveLength(0)
  })

  it("402 → blocked SUBSCRIPTION_REQUIRED", async () => {
    const { harness, deps } = await setup({ conversions: ["signup"], lines: ALL_APPROVED, approved: ["signup"], clickTested: [], script: { paid: false } })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
  })
})

describe("step settings: the customer's Vercel is written only with the user's yes", () => {
  for (const [label, lines] of [
    ["no server_lane line in the plan (e.g. a static site, or no Infinite pixel)", [{ id: "meta_relay", approved: false }]],
    ["a server_lane line left unanswered", [{ id: "server_lane", approved: null }]]
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

  it("keys.json from another run is not this site's choice: the relay is not bound to it", async () => {
    const { bridge, harness, deps } = await setup({ conversions: [], lines: ALL_APPROVED, approved: [], clickTested: [], keysRunId: "0a0a0a0a-b0de-4c5f-8a21-3e4d5c6b7a80" })
    await step.run(harness.ctx, deps)
    expect(bridge.callsFor("meta-relay.enable")).toHaveLength(0)
    expect(harness.subs()).toContain("! Meta server events: no Meta pixel was chosen for this site, so nothing was switched on")
  })

  it("a cloud timeout mid-step → parked INFINITE_UNAVAILABLE (§3z.4), never 'open the app', not a crash", async () => {
    const { harness, deps } = await setup({
      conversions: ["signup"],
      lines: ALL_APPROVED,
      approved: ["signup"],
      clickTested: [],
      script: { errors: { conversions: { code: "upstream_timeout" } } }
    })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "parked", code: "INF_WIZ_INFINITE_UNAVAILABLE" })
  })
})

describe("conversionDeclaration", () => {
  it("maps names to the cloud's CONVERSION_TYPES (Subscribe = custom + label)", () => {
    expect(conversionDeclaration("start_trial")).toEqual({ name: "start_trial", type: "trial", dedupe: "account" })
    expect(conversionDeclaration("purchase")).toEqual({ name: "purchase", type: "purchase", dedupe: "event" })
    expect(conversionDeclaration("download")).toEqual({ name: "download", type: "download", dedupe: "visitor_ttl" })
    expect(conversionDeclaration("subscribe")).toEqual({ name: "subscribe", type: "custom", dedupe: "account", label: "Subscribe" })
    expect(conversionDeclaration("pricing_page_cta")).toEqual({ name: "pricing_page_cta", type: "custom", dedupe: "event", label: "Pricing page cta" })
  })
})
