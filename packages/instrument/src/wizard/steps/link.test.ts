import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { startFakeBridge, type FakeBridge, type FakeBridgeScript } from "../../../test/wizard/fake-bridge.js"
import { freshState, makeContext, makeDeps, type HarnessOptions } from "../../../test/wizard/step-harness.js"
import { openTagBridge } from "../../bridge/client.js"
import { exitCodeFor } from "../contracts/codes.js"
import { step } from "./link.js"

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

  it("§3x.8 (R3-7): keys 409 foreign_site_hosts/infinite_workspace → a clean stop (INFINITE_WORKSPACE, exit 2) naming --relink", async () => {
    const { bridge, harness, deps } = await setup({ link: "remembered", errors: { keys: { code: "foreign_site_hosts", state: "infinite_workspace" } } })
    const outcome = await step.run(harness.ctx, deps)
    expect(outcome).toEqual({
      kind: "failed",
      code: "INF_WIZ_INFINITE_WORKSPACE",
      message: "This workspace is Infinite's own and cannot take a customer site. Run npx infinite-tag --relink and pick another workspace.",
      next: "halt"
    })
    expect(exitCodeFor("INF_WIZ_INFINITE_WORKSPACE")).toBe(2)
    expect(bridge.calls.map((call) => call.verb)).toEqual(["status", "link.request", "keys"])
  })
})
