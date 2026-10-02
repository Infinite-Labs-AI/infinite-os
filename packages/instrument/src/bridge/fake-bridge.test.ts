// The fake bridge (test/wizard/fake-bridge.ts) is a test double I1's end-to-end test relies on, so it is tested
// too: it must refuse what the real desktop refuses (§3a.2) and serve what the contract says (§3a).
import { statSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { deployCanceledThenServing, startFakeBridge, type FakeBridge } from "../../test/wizard/fake-bridge.js"
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
