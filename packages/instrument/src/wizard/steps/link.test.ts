import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { startFakeBridge, type FakeBridge, type FakeBridgeScript } from "../../../test/wizard/fake-bridge.js"
import { freshState, makeContext, makeDeps, type HarnessOptions } from "../../../test/wizard/step-harness.js"
import { openTagBridge } from "../../bridge/client.js"
import { exitCodeFor } from "../contracts/codes.js"
import { RUN_NOT_IN_WORKSPACE, step } from "./link.js"

let root: string
const bridges: FakeBridge[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinite-tag-link-root-"))
})

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
  rmSync(root, { recursive: true, force: true })
})

async function setup(script: Partial<FakeBridgeScript> = {}, context: Partial<HarnessOptions> = {}, remoteUrl?: string | null) {
  const bridge = await startFakeBridge({ script })
  bridges.push(bridge)
  const client = openTagBridge({ env: bridge.env, platform: "darwin", tagVersion: "0.12.0-test" })
  const harness = makeContext({ root, ...context })
  const deps = makeDeps({ bridge: client, ...(remoteUrl !== undefined ? { remoteUrl } : {}) })
  return { bridge, client, harness, deps }
}

describe("step link", () => {
  it("remembered link → no ask, linked at once, link id attached", async () => {
    const { bridge, client, harness, deps } = await setup({ link: "remembered" })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({ kind: "ok", status: "Linked: github.com/acme/acme-store → workspace Acme" })
    expect(harness.asks).toHaveLength(0)
    expect(harness.state().link).toEqual({ linkId: "lk_FAKElinkAcmeStore00000", workspaceName: "Acme", approvedAt: "2026-10-02T09:01:00.000Z", runtimeVariant: "prod" })
    expect(harness.saves).toBe(1)
    expect(client.currentLinkId()).toBe("lk_FAKElinkAcmeStore00000")
    expect(harness.subs()).toContain("✓ Remembered · workspace Acme")
    // Order: status → link.request → the first link-scoped call (the subscription check). No run is created.
    expect(bridge.calls.map((call) => call.verb)).toEqual(["status", "link.request", "keys"])
  })

  it("pending → the link-code overlay with a 4-digit code, then approved; the overlay is closed by the step", async () => {
    const { bridge, harness, deps } = await setup({ link: "approve", linkPollsBeforeAnswer: 2 })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome.kind).toBe("ok")
    expect(harness.asks).toHaveLength(1)
    const ask = harness.asks[0]
    expect(ask?.kind).toBe("link-code")
    const payload = ask?.payload as { code: string; site: { repoLabel: string; appRoot: string; folderLabel: string } }
    expect(payload.code).toMatch(/^[0-9]{4}$/)
    expect(payload.site.repoLabel).toBe("github.com/acme/acme-store")
    // The card shows the code it was sent.
    expect((bridge.callsFor("link.request")[0]?.body as { code: string }).code).toBe(payload.code)
    expect(ask?.closedByStep).toBe(true)
    expect(bridge.callsFor("link.poll")).toHaveLength(3)
    expect(harness.subs()).toEqual(expect.arrayContaining(["Waiting for approval in the Infinite app…", "✓ Approved · workspace Acme"]))
  })

  it("declined → INF_WIZ_LINK_DECLINED, nothing saved", async () => {
    const { harness, deps, client } = await setup({ link: "decline" })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_LINK_DECLINED", next: "halt" })
    expect(harness.state().link).toBeNull()
    expect(client.currentLinkId()).toBeNull()
    expect(harness.asks[0]?.closedByStep).toBe(true)
  })

  it("expired → offers to retry with a new code; yes → approved", async () => {
    let bridgeRef: FakeBridge | null = null
    const { bridge, harness, deps } = await setup(
      { link: "expire" },
      {
        answers: [
          "pending",
          () => {
            if (bridgeRef) bridgeRef.script.link = "approve"
            return true
          },
          "pending"
        ]
      }
    )
    bridgeRef = bridge
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome.kind).toBe("ok")
    expect(harness.asks.map((ask) => ask.kind)).toEqual(["link-code", "confirm", "link-code"])
    expect(bridge.callsFor("link.request")).toHaveLength(2)
    const codes = harness.asks.filter((ask) => ask.kind === "link-code").map((ask) => (ask.payload as { code: string }).code)
    expect(codes).toHaveLength(2)
  })

  it("expired (410) and the retry declined → INF_WIZ_LINK_EXPIRED", async () => {
    const { harness, deps } = await setup({ link: "expire_410" }, { answers: ["pending", false] })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "failed", code: "INF_WIZ_LINK_EXPIRED" })
  })

  it("the 5-minute window closing counts as expired, and no retry is offered past it", async () => {
    const { bridge, harness, deps } = await setup({ link: "pending" }, { answers: ["pending", false], clockStepMs: 120_000 })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "failed", code: "INF_WIZ_LINK_EXPIRED" })
    expect(bridge.callsFor("link.poll").length).toBeLessThan(5)
    expect(harness.asks.map((ask) => ask.kind)).toEqual(["link-code"])
  })

  it("a retry stays inside ONE 5-minute approval window (the engine's link budget is 6 minutes)", async () => {
    let bridgeRef: FakeBridge | null = null
    const { bridge, harness, deps } = await setup(
      { link: "expire" },
      {
        answers: [
          "pending",
          () => {
            if (bridgeRef) bridgeRef.script.link = "approve"
            return true
          },
          "pending"
        ],
        clockStepMs: 10_000
      }
    )
    bridgeRef = bridge
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    const [first, confirm, second] = harness.asks
    const firstMs = first?.options?.timeoutMs as number
    const confirmMs = confirm?.options?.timeoutMs as number
    const secondMs = second?.options?.timeoutMs as number
    expect(firstMs).toBeLessThanOrEqual(5 * 60_000)
    expect(confirmMs).toBeLessThan(firstMs)
    expect(secondMs).toBeLessThan(confirmMs)
  })

  it("the window closing on the code's own timer (ASK_TIMEOUT) → expired", async () => {
    const { harness, deps } = await setup({ link: "pending" }, { answers: ["__timeout__", false] })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "failed", code: "INF_WIZ_LINK_EXPIRED" })
  })

  it("a stray answer to the display-only code card is not an expiry: polling continues to approval", async () => {
    const { harness, deps } = await setup({ link: "approve", linkPollsBeforeAnswer: 2 }, { answers: ["stray"] })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome.kind).toBe("ok")
    expect(harness.asks.map((ask) => ask.kind)).toEqual(["link-code"])
  })

  it("a resumed run whose site is now linked to ANOTHER workspace stops (its run id belongs to the first one)", async () => {
    const state = freshState("", {
      runId: "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80",
      link: { linkId: "lk_FAKElinkGlobexSite00000", workspaceName: "Globex", approvedAt: "2026-10-01T09:01:00.000Z", runtimeVariant: "prod" }
    })
    const { client, harness, deps } = await setup({ link: "remembered" }, { state })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_LINK_DECLINED", next: "halt" })
    expect((outcome as { message: string }).message).toContain("started in the Infinite workspace Globex, but this site is now linked to Acme")
    expect(harness.state().link?.workspaceName).toBe("Globex")
    expect(client.currentLinkId()).toBeNull()
  })

  it("a re-link to the SAME workspace (a new link id) continues the run", async () => {
    const state = freshState("", {
      runId: "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80",
      link: { linkId: "lk_FAKEoldLinkAcmeStore000", workspaceName: "Acme", approvedAt: "2026-10-01T09:01:00.000Z", runtimeVariant: "prod" }
    })
    const { client, harness, deps } = await setup({ link: "remembered" }, { state })
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    expect(client.currentLinkId()).toBe("lk_FAKElinkAcmeStore00000")
  })

  it("B25: a resumed run asks runs.get once; a run this workspace does not know (404) halts LINK_DECLINED with --fresh", async () => {
    const state = freshState("", {
      runId: "0b9e8d7c-6a5b-4c3d-9e2f-1a0b9c8d7e6f",
      link: { linkId: "lk_FAKEoldLinkAcmeStore000", workspaceName: "Acme", approvedAt: "2026-10-01T09:01:00.000Z", runtimeVariant: "prod" }
    })
    const { bridge, harness, deps } = await setup({ link: "remembered" }, { state })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({ kind: "failed", code: "INF_WIZ_LINK_DECLINED", message: RUN_NOT_IN_WORKSPACE, next: "halt" })
    expect(RUN_NOT_IN_WORKSPACE).toContain("npx infinite-tag --fresh")
    expect(bridge.callsFor("runs.get")).toHaveLength(1)
  })

  it("B25 negative: a run the workspace knows goes on, and a fresh run (no run id) never asks runs.get", async () => {
    const resumed = freshState("", {
      runId: "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80",
      link: { linkId: "lk_FAKEoldLinkAcmeStore000", workspaceName: "Acme", approvedAt: "2026-10-01T09:01:00.000Z", runtimeVariant: "prod" }
    })
    const first = await setup({ link: "remembered" }, { state: resumed })
    expect((await step.run(first.harness.ctx, first.deps)).kind).toBe("ok")
    expect(first.bridge.callsFor("runs.get")).toHaveLength(1)
    const fresh = await setup({ link: "remembered" })
    expect((await step.run(fresh.harness.ctx, fresh.deps)).kind).toBe("ok")
    expect(fresh.bridge.callsFor("runs.get")).toHaveLength(0)
  })

  it("ESC on the code → cancelled (declined), polling stops", async () => {
    const { bridge, harness, deps } = await setup({ link: "pending" }, { answers: ["__cancelled__"] })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_LINK_DECLINED", message: "Linking was cancelled." })
    expect(bridge.callsFor("keys")).toHaveLength(0)
  })

  it("402 on the first link-scoped call → blocked SUBSCRIPTION_REQUIRED", async () => {
    const { harness, deps } = await setup({ link: "remembered", paid: false })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
  })

  it("prints the runtime variant when it is not prod", async () => {
    const { harness, deps } = await setup({ link: "remembered", runtime: { variant: "dev3", label: "Infinite Dev 3" } })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome.kind).toBe("ok")
    expect(harness.subs()[0]).toBe("Using Infinite Dev 3 (dev3), not the production Infinite app")
    expect(harness.state().link?.runtimeVariant).toBe("dev3")
  })

  it("resume against another runtime variant → RUNTIME_MISMATCH before any verb (negative: never calls a verb)", async () => {
    const state = freshState("", {
      link: { linkId: "lk_FAKElinkAcmeStore00000", workspaceName: "Acme", approvedAt: "2026-10-02T09:01:00.000Z", runtimeVariant: "prod" }
    })
    const { bridge, harness, deps } = await setup({ link: "remembered", runtime: { variant: "dev3", label: "Infinite Dev 3" } }, { state })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_RUNTIME_MISMATCH", next: "halt" })
    expect((outcome as { message: string }).message).toContain("This run was linked through Infinite prod; the open app is Infinite Dev 3 (dev3)")
    expect(bridge.calls).toHaveLength(0)
  })

  it("resume against the same variant re-links (remembered) and re-attaches the link id", async () => {
    const state = freshState("", {
      link: { linkId: "lk_FAKElinkAcmeStore00000", workspaceName: "Acme", approvedAt: "2026-10-02T09:01:00.000Z", runtimeVariant: "prod" }
    })
    const { client, harness, deps } = await setup({ link: "remembered" }, { state })
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    expect(client.currentLinkId()).toBe("lk_FAKElinkAcmeStore00000")
  })

  it("is never skipped on resume: its input hash changes per process but not within one", () => {
    const harness = makeContext({ root })
    expect(step.inputHash(harness.ctx)).toBe(step.inputHash(harness.ctx))
    expect(step.inputHash(harness.ctx)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("a credentialed remote never reaches the request, the state or the fingerprint input (negative)", async () => {
    const { bridge, harness, deps } = await setup({ link: "remembered" }, {}, "https://user:ghp_x@github.com/a/b.git")
    expect((await step.run(harness.ctx, deps)).kind).toBe("ok")
    const request = bridge.callsFor("link.request")[0]?.body as { site: { repoLabel: string; repoFingerprint: string } }
    expect(request.site.repoLabel).toBe("github.com/a/b")
    const everything = JSON.stringify([bridge.calls, harness.state(), harness.events])
    expect(everything).not.toContain("ghp_")
    expect(everything).not.toContain("user:")
    expect(everything).not.toContain("https://user")
  })

  it("sends a production host hint from a CNAME file", async () => {
    writeFileSync(join(root, "CNAME"), "Acme-Store.com\n")
    const { bridge, harness, deps } = await setup({ link: "remembered" })
    await step.run(harness.ctx, deps)
    expect((bridge.callsFor("link.request")[0]?.body as { site: { productionHostHint: string } }).site.productionHostHint).toBe("acme-store.com")
  })

  it("no app on a Mac → blocked NO_APP; another OS → blocked NOT_MAC", async () => {
    const home = mkdtempSync(join(tmpdir(), "infinite-tag-nohome-"))
    try {
      for (const [platform, code] of [
        ["darwin", "INF_WIZ_NO_APP"],
        ["linux", "INF_WIZ_NOT_MAC"]
      ] as const) {
        const client = openTagBridge({ env: { GROWTH_OS_HOME: home }, platform, tagVersion: "x" })
        const harness = makeContext({ root })
        const outcome = await step.run(harness.ctx, makeDeps({ bridge: client }))
        expect(outcome).toMatchObject({ kind: "blocked", code })
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("a bridge without the link capability → BRIDGE_PROTOCOL, no call", async () => {
    const { bridge, harness, deps } = await setup({ capabilities: ["tag.status.v1"] })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL" })
    expect(bridge.calls).toHaveLength(0)
  })

  it("review I2 P2-2: keys 409 foreign_site_hosts/infinite_workspace → a clean stop (LINK_DECLINED, exit 4) with one plain line", async () => {
    const { bridge, harness, deps } = await setup({ link: "remembered", errors: { keys: { code: "foreign_site_hosts", state: "infinite_workspace" } } })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({
      kind: "failed",
      code: "INF_WIZ_LINK_DECLINED",
      message: "This site is linked to Infinite's own workspace. Link it to its own workspace and run npx infinite-tag again.",
      next: "halt"
    })
    expect(exitCodeFor("INF_WIZ_LINK_DECLINED")).toBe(4)
    expect(bridge.calls.map((call) => call.verb)).toEqual(["status", "link.request", "keys"])
  })

  it("review I2 P2-2: keys 503 capability_unavailable/internal_workspace_unconfigured → parked (exit 3) with a plain line, never 'did not answer'", async () => {
    const { harness, deps } = await setup({ link: "remembered", errors: { keys: { code: "capability_unavailable", state: "internal_workspace_unconfigured" } } })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toMatchObject({ kind: "parked", code: "INF_WIZ_INFINITE_UNAVAILABLE", reason: "Infinite cannot set up sites right now (a setting is missing on Infinite's side). Nothing was changed." })
    expect(exitCodeFor("INF_WIZ_INFINITE_UNAVAILABLE")).toBe(3)
  })

  it("negative: keys 409 foreign_site_hosts with another state is not a link-declined stop", async () => {
    const { harness, deps } = await setup({ link: "remembered", errors: { keys: { code: "foreign_site_hosts", state: "disabled_source_other_hosts" } } })
    await expect(step.run(harness.ctx, deps)).rejects.toMatchObject({ code: "foreign_site_hosts" })
  })

  it("a signed-out app (409 signed_out) → blocked SIGNED_OUT", async () => {
    const { harness, deps } = await setup({ errors: { status: { code: "signed_out" } } })
    expect(await step.run(harness.ctx, deps)).toMatchObject({ kind: "blocked", code: "INF_WIZ_SIGNED_OUT" })
  })
})
