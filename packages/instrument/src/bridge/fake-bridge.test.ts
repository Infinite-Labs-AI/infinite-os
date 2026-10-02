// The fake bridge (test/wizard/fake-bridge.ts) is a test double I1's end-to-end test relies on, so it is tested
// too: it must refuse what the real desktop refuses (§3a.2) and serve what the contract says (§3a).
import { statSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { deployCanceledThenServing, loadTestRunCases, phaseMoveAllowed, startFakeBridge, type FakeBridge } from "../../test/wizard/fake-bridge.js"
import type { TestRunRequest } from "../wizard/contracts/test-engine.js"
import { FAKE_BRIDGE_TOKEN } from "../wizard/contracts/bridge.js"
import { openTagBridge } from "./client.js"
import { readBridgeDescriptor } from "./descriptor.js"
import { BridgeError } from "./errors.js"

const bridges: FakeBridge[] = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
})

async function fake(script: Parameters<typeof startFakeBridge>[0] = {}) {
  const bridge = await startFakeBridge(script)
  bridges.push(bridge)
  return bridge
}

function raw(bridge: FakeBridge, options: { method?: string; path: string; headers?: Record<string, string>; body?: string; host?: string }) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: { error?: { code: string } } }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: { Authorization: `Bearer ${FAKE_BRIDGE_TOKEN}`, "X-Infinite-Tag-Version": "x", ...(options.host ? { Host: options.host } : {}), ...options.headers },
        agent: false
      },
      (res) => {
        let text = ""
        res.on("data", (chunk) => (text += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text || "{}") }))
      }
    )
    req.on("error", reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function linkedClient(bridge: FakeBridge) {
  const client = openTagBridge({ env: bridge.env, platform: "darwin", tagVersion: "x" })
  const request = await client.requestLink({
    code: "1234",
    site: { repoFingerprint: `sha256:${"a".repeat(64)}`, repoLabel: "github.com/acme/acme-store", appRoot: ".", folderLabel: "~/x", productionHostHint: null },
    client: { tagVersion: "x" }
  })
  const poll = request.link ? null : await client.pollLink(request.linkRequestId, 25)
  client.setLinkId(request.link?.linkId ?? poll?.link?.linkId ?? null)
  return client
}

describe("fake bridge", () => {
  it("writes an owner-only descriptor the real reader accepts", async () => {
    const bridge = await fake()
    expect(statSync(join(bridge.home, "desktop-tag")).mode & 0o777).toBe(0o700)
    expect(statSync(join(bridge.home, "desktop-tag", "bridge.json")).mode & 0o777).toBe(0o600)
    expect(readBridgeDescriptor({ env: bridge.env, platform: "darwin" }).url).toBe(bridge.url)
  })

  it("refuses an Origin header and a wrong Host before the bearer check (DNS rebinding)", async () => {
    const bridge = await fake()
    expect((await raw(bridge, { path: "/v1/status", headers: { Origin: "https://evil.example" } })).body.error?.code).toBe("origin_refused")
    expect((await raw(bridge, { path: "/v1/status", host: "localhost:1" })).body.error?.code).toBe("origin_refused")
    expect((await raw(bridge, { path: "/v1/status", headers: { Origin: "null", Authorization: "Bearer wrong" } })).status).toBe(403)
  })

  it("401 with WWW-Authenticate on a bad bearer; 404 / 405 on unknown routes and methods", async () => {
    const bridge = await fake()
    const unauthorized = await raw(bridge, { path: "/v1/status", headers: { Authorization: "Bearer nope" } })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers["www-authenticate"]).toBeTruthy()
    expect((await raw(bridge, { path: "/v1/turn", method: "POST" })).body.error?.code).toBe("route_not_found")
    expect((await raw(bridge, { path: "/v1/keys", method: "PUT" })).body.error?.code).toBe("method_not_allowed")
  })

  it("decodes bodies strictly: an unknown key → 400 unknown_field", async () => {
    const bridge = await fake()
    const response = await raw(bridge, {
      path: "/v1/link/revoke",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, requestId: "r", linkId: "lk_FAKElinkAcmeStore00000", extra: 1 })
    })
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe("unknown_field")
  })

  it("a link-scoped verb without an approved link → 404 link_not_found", async () => {
    const bridge = await fake()
    const response = await raw(bridge, { path: "/v1/keys", headers: { "X-Infinite-Link-Id": "lk_FAKElinkAcmeStore00000" } })
    expect(response.body.error?.code).toBe("link_not_found")
  })

  it("records every call in order without the bearer", async () => {
    const bridge = await fake()
    const client = await linkedClient(bridge)
    await client.keys()
    expect(bridge.calls.map((call) => call.verb)).toEqual(["link.request", "link.poll", "keys"])
    expect(JSON.stringify(bridge.calls)).not.toContain(FAKE_BRIDGE_TOKEN)
  })

  it("scripts the proof claim (won / lost) and the deploy sequence (canceled + a later serving SHA)", async () => {
    const bridge = await fake({ script: { proofClaim: "lost", deploy: deployCanceledThenServing("9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d7") } })
    const client = await linkedClient(bridge)
    const runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    await expect(client.claimProof(runId, "tag")).rejects.toMatchObject({ code: "claimed_by_other", state: "proving" })
    const merge = "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6"
    expect((await client.deployStatus(merge)).mergeDeployment?.state).toBe("building")
    const later = await client.deployStatus(merge)
    expect(later.mergeDeployment?.state).toBe("canceled")
    expect(later.serving?.sha).toBe("9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d7")
    // The last state repeats.
    expect((await client.deployStatus(merge)).mergeDeployment?.state).toBe("canceled")
    bridge.script.proofClaim = "won"
    expect(await client.claimProof(runId, "tag")).toMatchObject({ granted: true, proofState: "proving" })
  })

  it("serves the fixture test result for each mode, after the scripted number of running polls", async () => {
    const bridge = await fake({ script: { testPollsBeforeDone: 1 } })
    const client = await linkedClient(bridge)
    const started = await client.startTest({
      mode: "dry_live",
      runId: "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80",
      productionHost: "acme-store.com",
      targets: [{ url: "https://acme-store.com/", label: "home" }],
      expect: {},
      deadlineMs: 120_000
    })
    expect((await client.pollTest(started.testRunId, 25)).state).toBe("running")
    const done = await client.pollTest(started.testRunId, 25)
    expect(done.state).toBe("done")
    expect(done.result?.mode).toBe("dry_live")
  })

  it("402 on paid verbs when unsubscribed; link verbs stay free", async () => {
    const bridge = await fake({ script: { paid: false } })
    const client = await linkedClient(bridge)
    await expect(client.hosting()).rejects.toBeInstanceOf(BridgeError)
    expect(bridge.callsFor("hosting")[0]?.status).toBe(402)
    expect(bridge.callsFor("link.request")[0]?.status).toBe(200)
  })
})

/** A fixture request of a mode, without its envelope (the client adds it). */
function requestOf(id: string): Omit<TestRunRequest, "protocolVersion" | "requestId"> {
  const found = loadTestRunCases().find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no fixture ${id}`)
  const { protocolVersion: _v, requestId: _r, ...rest } = structuredClone(found.request) as TestRunRequest
  return rest
}

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"

describe("fake bridge refuses what D2 and C1 refuse", () => {
  it("real_visit: a fake click id, clicks, an SPA navigation or two targets → 400 (decision 12), even with a claim", async () => {
    const bridge = await fake()
    const client = await linkedClient(bridge)
    await client.claimProof(RUN, "tag")
    const real = requestOf("real_visit_delivering")
    for (const bad of [
      { ...real, fakeClickId: true },
      { ...real, clicks: [{ selector: "a", label: "a" }] },
      { ...real, spaNavigation: { path: "/pricing" } },
      { ...real, targets: [...real.targets, { url: "https://acme-store.com/pricing", label: "pricing" }] }
    ]) {
      await expect(client.startTest(bad)).rejects.toMatchObject({ status: 400, code: "invalid_request" })
    }
    expect(bridge.callsFor("test.start").every((call) => call.status === 400)).toBe(true)
  })

  it("real_visit only after the tag's granted proof claim: none → 409; claimed → started", async () => {
    const bridge = await fake()
    const client = await linkedClient(bridge)
    const real = requestOf("real_visit_delivering")
    await expect(client.startTest(real)).rejects.toMatchObject({ status: 409, code: "claimed_by_other", state: "pending" })
    await client.claimProof(RUN, "tag")
    expect((await client.startTest(real)).state).toBe("queued")
  })

  it("dry_live: a fake click id or clicks against production → 400; against the preview's own URL → allowed", async () => {
    const bridge = await fake()
    const client = await linkedClient(bridge)
    const dry = requestOf("dry_live_all_once")
    await expect(client.startTest({ ...dry, fakeClickId: true })).rejects.toMatchObject({ status: 400, code: "invalid_request" })
    await expect(client.startTest({ ...dry, clicks: [{ selector: "a", label: "a" }] })).rejects.toMatchObject({ status: 400 })
    const preview = requestOf("dry_live_preview_self_beacon")
    expect((await client.startTest({ ...preview, fakeClickId: true })).state).toBe("queued")
    // Every fixture request is accepted as it stands (the rules match the contract's own cases).
    for (const testCase of loadTestRunCases()) {
      if (testCase.request.mode === "real_visit") continue
      const { protocolVersion: _v, requestId: _r, ...body } = testCase.request as TestRunRequest
      expect((await client.startTest(body)).state, testCase.id).toBe("queued")
    }
  })

  it("ONE proof claim: a second claim (or a claim on a finished run) → 409 claimed_by_other with the state", async () => {
    const bridge = await fake()
    const client = await linkedClient(bridge)
    expect(await client.claimProof(RUN, "tag")).toMatchObject({ granted: true })
    await expect(client.claimProof(RUN, "desktop")).rejects.toMatchObject({ code: "claimed_by_other", state: "proving" })
    await client.patchRun(RUN, { proofState: "proven" })
    await expect(client.claimProof(RUN, "tag")).rejects.toMatchObject({ code: "claimed_by_other", state: "proven" })
  })

  it("PATCH: proofState only while proving (409), the same result again is a no-op; phase forward only (400); mergeSha once (400)", async () => {
    const bridge = await fake()
    const client = await linkedClient(bridge)
    await expect(client.patchRun(RUN, { proofState: "proven" })).rejects.toMatchObject({ status: 409, code: "claimed_by_other", state: "pending" })
    await client.claimProof(RUN, "tag")
    expect((await client.patchRun(RUN, { proofState: "proven" })).run.proofState).toBe("proven")
    expect((await client.patchRun(RUN, { proofState: "proven" })).run.proofState).toBe("proven")
    await expect(client.patchRun(RUN, { proofState: "problem" })).rejects.toMatchObject({ status: 409, code: "claimed_by_other" })

    expect((await client.patchRun(RUN, { phase: "merged" })).run.phase).toBe("merged")
    await expect(client.patchRun(RUN, { phase: "in_pr" })).rejects.toMatchObject({ status: 400, code: "invalid_request", field: "patch.phase" })
    expect((await client.patchRun(RUN, { phase: "merged" })).run.phase).toBe("merged")

    const sha = "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6"
    await client.patchRun(RUN, { mergeSha: sha })
    await expect(client.patchRun(RUN, { mergeSha: "0".repeat(40) })).rejects.toMatchObject({ status: 400, field: "patch.mergeSha" })
  })

  it("phaseMoveAllowed mirrors C1: forward only, abandoned from an unfinished phase, nothing out of a finished run", () => {
    expect(phaseMoveAllowed("before", "in_pr")).toBe(true)
    expect(phaseMoveAllowed("merged", "in_pr")).toBe(false)
    expect(phaseMoveAllowed("in_pr", "abandoned")).toBe(true)
    expect(phaseMoveAllowed("proven", "abandoned")).toBe(false)
    expect(phaseMoveAllowed("abandoned", "proven")).toBe(false)
    expect(phaseMoveAllowed("proven", "proven")).toBe(true)
  })

  it("hangUpAfter: the verb takes effect, then the connection drops (an app dying mid-response)", async () => {
    const bridge = await fake({ script: { hangUpAfter: ["runs.proof-claim"] } })
    const client = await linkedClient(bridge)
    await expect(client.claimProof(RUN, "tag")).rejects.toMatchObject({ code: "network_error" })
    expect(bridge.script.run.proofState).toBe("proving")
    // Once only.
    await expect(client.claimProof(RUN, "tag")).rejects.toMatchObject({ code: "claimed_by_other" })
  })
})
