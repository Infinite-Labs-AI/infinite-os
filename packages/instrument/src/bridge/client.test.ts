import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { startFakeBridge, loadVerbFixtures, loadDescriptorExample, type FakeBridge } from "../../test/wizard/fake-bridge.js"
import { BRIDGE_ERROR_STATUS, BRIDGE_VERBS, FAKE_BRIDGE_TOKEN, type BridgeVerbId } from "../wizard/contracts/bridge.js"
import { createTagBridgeClient, openTagBridge, type BridgeTransport } from "./client.js"
import { BridgeError } from "./errors.js"

const bridges: FakeBridge[] = []
async function fake(script: Parameters<typeof startFakeBridge>[0] = {}): Promise<FakeBridge> {
  const bridge = await startFakeBridge(script)
  bridges.push(bridge)
  return bridge
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close()
})

function clientFor(bridge: FakeBridge) {
  return openTagBridge({ env: bridge.env, platform: "darwin", tagVersion: "0.12.0-test" })
}

async function caught(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof BridgeError) return error
    throw error
  }
  throw new Error("expected a BridgeError")
}

function withoutEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body }
  delete copy.protocolVersion
  delete copy.requestId
  return copy
}

const SITE = {
  repoFingerprint: `sha256:${"a".repeat(64)}`,
  repoLabel: "github.com/acme/acme-store",
  appRoot: "apps/web",
  folderLabel: "~/Github/acme-store",
  productionHostHint: "acme-store.com"
}

describe("TagBridgeClient against the fake bridge", () => {
  it("sends the bearer, the tag version and no Origin; status decodes strictly", async () => {
    const bridge = await fake()
    const client = clientFor(bridge)
    const status = await client.status()
    expect(status.service).toBe("infinite-desktop-tag")
    const call = bridge.calls[0]
    expect(call?.headers["x-infinite-tag-version"]).toBe("0.12.0-test")
    expect(call?.headers.origin).toBeUndefined()
    expect(call?.headers.host).toBe(`127.0.0.1:${bridge.port}`)
    // The fake records headers without the bearer; the token is never in a recorded call.
    expect(JSON.stringify(bridge.calls)).not.toContain(FAKE_BRIDGE_TOKEN)
  })

  it("link-scoped calls carry the link id; a link-scoped call before the link throws without a request", async () => {
    const bridge = await fake()
    const client = clientFor(bridge)
    await expect(client.keys()).rejects.toThrow(/link-scoped/)
    expect(bridge.calls).toHaveLength(0)
    const request = await client.requestLink({ code: "4729", site: SITE, client: { tagVersion: "0.12.0-test" } })
    const poll = await client.pollLink(request.linkRequestId, 25)
    expect(poll.state).toBe("approved")
    client.setLinkId(poll.link?.linkId ?? null)
    const keys = await client.keys()
    expect(keys.ga4.status).toBe("connected")
    expect(bridge.callsFor("keys")[0]?.headers["x-infinite-link-id"]).toBe(poll.link?.linkId)
    expect(bridge.callsFor("link.poll")[0]?.path).toMatch(/\?wait=25$/)
  })

  it("never calls a verb the descriptor does not advertise", async () => {
    const bridge = await fake({ script: { capabilities: ["tag.status.v1", "tag.link.v1"] } })
    const client = clientFor(bridge)
    client.setLinkId("lk_FAKElinkAcmeStore00000")
    const error = await caught(client.keys())
    expect(error.code).toBe("capability_missing")
    expect(bridge.calls).toHaveLength(0)
    expect(client.has("tag.status.v1")).toBe(true)
    expect(client.has("tag.keys.v1")).toBe(false)
  })

  it("refuses to send a body field the verb does not take", async () => {
    const bridge = await fake()
    const client = clientFor(bridge)
    const body = { code: "4729", site: SITE, client: { tagVersion: "x" }, extra: true } as unknown as Parameters<typeof client.requestLink>[0]
    await expect(client.requestLink(body)).rejects.toThrow(/does not match the contract/)
    expect(bridge.calls).toHaveLength(0)
  })

  it("402 on a paid verb → BridgeError subscription_required", async () => {
    const bridge = await fake({ script: { paid: false, link: "remembered" } })
    const client = clientFor(bridge)
    const request = await client.requestLink({ code: "1234", site: SITE, client: { tagVersion: "x" } })
    client.setLinkId(request.link?.linkId ?? null)
    const error = await caught(client.keys())
    expect(error).toMatchObject({ status: 402, code: "subscription_required", retryable: false })
  })

  it("a restarted app (new port + token, same variant) is re-discovered once", async () => {
    const home = mkdtempSync(join(tmpdir(), "infinite-tag-restart-"))
    const first = await startFakeBridge({ home })
    const client = openTagBridge({ env: first.env, platform: "darwin", tagVersion: "x" })
    await client.status()
    await first.close()
    const second = await fake({ home })
    const status = await client.status()
    expect(status.bootId).toBe(second.descriptor.bootId)
    expect(status.bootId).not.toBe(first.descriptor.bootId)
    rmSync(home, { recursive: true, force: true })
  })

  it("a restarted app under another runtime variant is never followed", async () => {
    const home = mkdtempSync(join(tmpdir(), "infinite-tag-restart-"))
    const first = await startFakeBridge({ home })
    const client = openTagBridge({ env: first.env, platform: "darwin", tagVersion: "x" })
    await client.status()
    await first.close()
    const second = await fake({ home, script: { runtime: { variant: "dev3", label: "Infinite Dev 3" } } })
    second.rewriteDescriptor({ runtime: { variant: "dev3", label: "Infinite Dev 3" } })
    const error = await caught(client.status())
    expect(error.code).toBe("network_error")
    expect(second.calls).toHaveLength(0)
    rmSync(home, { recursive: true, force: true })
  })

  it("the report echo is checked", async () => {
    const descriptor = { ...loadDescriptorExample(), pid: process.pid }
    const transport: BridgeTransport = async (request) => {
      const body = JSON.parse(request.body ?? "{}") as { requestId: string }
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({ protocolVersion: 1, requestId: body.requestId, id: "x", phase: "live_today", storedAt: "t", echo: { schema: "infinite-tag.report.v2", runId: "00000000-0000-4000-8000-000000000000" } })
      }
    }
    const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport })
    client.setLinkId("lk_FAKElinkAcmeStore00000")
    const report = JSON.parse(JSON.stringify((loadVerbFixtures().find((row) => row.verb === "report")?.request as { report: unknown }).report))
    const error = await caught(client.postReport("7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80", "live_today", report))
    expect(error.code).toBe("bad_response")
  })
})

describe("strict decoding (fixture-driven transport)", () => {
  const descriptor = { ...loadDescriptorExample(), pid: process.pid }

  function replay(status: number, body: unknown, headers: Record<string, string> = {}): BridgeTransport {
    return async () => ({ status, headers, body: typeof body === "string" ? body : JSON.stringify(body) })
  }

  function callFor(client: ReturnType<typeof createTagBridgeClient>, verb: BridgeVerbId, request: unknown): Promise<unknown> {
    const body = (request ?? {}) as Record<string, unknown>
    const runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    switch (verb) {
      case "status":
        return client.status()
      case "link.request":
        return client.requestLink(withoutEnvelope(body) as never)
      case "link.poll":
        return client.pollLink("lr_FAKElinkRequestAcme000", 25)
      case "link.revoke":
        return client.revokeLink("lk_FAKElinkAcmeStore00000")
      case "keys":
        return client.keys()
      case "hosting":
        return client.hosting()
      case "hosting.deploy":
        return client.deployStatus("9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6")
      case "runs.start":
        return client.startRun(withoutEnvelope(body) as never)
      case "runs.proof-claim":
        return client.claimProof(runId, "tag")
      case "runs.patch":
        return client.patchRun(runId, {})
      case "runs.get":
        return client.getRun(runId)
      case "receipts":
        return client.postReceipts(runId, withoutEnvelope(body) as never)
      case "report":
        return client.postReport(runId, "live_today", (body as { report: never }).report)
      case "baseline":
        return client.baseline(runId)
      case "site-source":
        return client.ensureSiteSource({ productionHosts: ["acme-store.com"], consentMode: "not_required" })
      case "conversions":
        return client.declareConversions({ runId, conversions: [] })
      case "ga4-key-events":
        return client.markGa4KeyEvents({ runId, names: [] })
      case "server-lane.status":
        return client.serverLaneStatus()
      case "server-lane.provision-env":
        return client.provisionServerLaneEnv({ redeploy: "skip" })
      case "meta-relay.status":
        return client.metaRelayStatus()
      case "meta-relay.enable":
        return client.enableMetaRelay({ sourceRef: "meta_src_FAKE_0001", enable: true })
      case "uninstall.remove-env":
        return client.removeServerLaneEnv()
      case "uninstall.disable-site-source":
        return client.disableSiteSource()
      case "test.start":
        return client.startTest(withoutEnvelope(body) as never)
      case "test.poll":
        return client.pollTest("tr_FAKEdryLive00000000000", 25)
      case "test.cancel":
        return client.cancelTest("tr_FAKEcancelledRun000000")
    }
  }

  const errorRows = loadVerbFixtures().filter((row) => row.status >= 400 && row.verb !== null && row.method === BRIDGE_VERBS[row.verb].method)

  it("covers every §3a.2 error code the fixtures show", () => {
    const codes = new Set(errorRows.map((row) => (row.response as { error: { code: string } }).error.code))
    // method_not_allowed / route_not_found rows address no verb this client can call; every other code is here.
    for (const code of Object.keys(BRIDGE_ERROR_STATUS)) {
      if (code === "method_not_allowed" || code === "route_not_found") continue
      expect(codes, code).toContain(code)
    }
  })

  it.each(errorRows.map((row) => [`${row.verb} ${row.status} ${(row.response as { error: { code: string } }).error.code}`, row] as const))(
    "%s maps to BridgeError {status, code, retryable}",
    async (_label, row) => {
      const envelope = row.response as { error: { code: string; retryable: boolean; state?: string; field?: string; upstreamStatus?: number } }
      const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport: replay(row.status, row.response, { "retry-after": "7" }) })
      client.setLinkId("lk_FAKElinkAcmeStore00000")
      const error = await caught(callFor(client, row.verb as BridgeVerbId, row.request))
      expect(error.status).toBe(row.status)
      expect(error.code).toBe(envelope.error.code)
      expect(error.retryable).toBe(envelope.error.retryable)
      if (envelope.error.state) expect(error.state).toBe(envelope.error.state)
      if (envelope.error.field) expect(error.field).toBe(envelope.error.field)
      if (envelope.error.upstreamStatus) expect(error.upstreamStatus).toBe(envelope.error.upstreamStatus)
      expect(error.retryAfterSeconds).toBe(7)
    }
  )

  it("an unknown error code → generic", async () => {
    const client = createTagBridgeClient(descriptor, {
      tagVersion: "x",
      transport: replay(418, { protocolVersion: 1, requestId: "r", error: { code: "teapot", message: "no", retryable: false } })
    })
    const error = await caught(client.status())
    expect(error).toMatchObject({ status: 418, code: "generic" })
  })

  it("a non-JSON error body → generic", async () => {
    const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport: replay(500, "<html>oops</html>") })
    const error = await caught(client.status())
    expect(error).toMatchObject({ status: 500, code: "generic", retryable: true })
  })

  it("every success fixture decodes", async () => {
    for (const row of loadVerbFixtures().filter((candidate) => candidate.status < 300 && candidate.verb !== null)) {
      const verb = row.verb as BridgeVerbId
      const transport: BridgeTransport = async (request) => {
        const sent = request.body ? (JSON.parse(request.body) as { requestId: string }) : null
        const response = { ...(row.response as Record<string, unknown>) }
        if (sent) response.requestId = sent.requestId
        return { status: row.status, headers: {}, body: JSON.stringify(response) }
      }
      const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport })
      client.setLinkId("lk_FAKElinkAcmeStore00000")
      if (verb === "report") {
        const report = (row.request as { report: { runId: string } }).report
        await expect(client.postReport(report.runId, (row.request as { phase: "proven_live" }).phase, report as never)).resolves.toBeTruthy()
        continue
      }
      await expect(callFor(client, verb, row.request), `${verb} ${row.path}`).resolves.toBeTruthy()
    }
  })

  it("an unknown response key → bad_response (strict)", async () => {
    const response = { ...(loadVerbFixtures().find((row) => row.verb === "status")?.response as object), surprise: 1 }
    const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport: replay(200, response) })
    expect((await caught(client.status())).code).toBe("bad_response")
  })

  it("a missing response key → bad_response", async () => {
    const response = { ...(loadVerbFixtures().find((row) => row.verb === "status")?.response as Record<string, unknown>) }
    delete response.bootId
    const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport: replay(200, response) })
    expect((await caught(client.status())).code).toBe("bad_response")
  })

  it("a request id that is not echoed → bad_response", async () => {
    const row = loadVerbFixtures().find((candidate) => candidate.verb === "site-source" && candidate.status === 200)
    const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport: replay(200, row?.response) })
    client.setLinkId("lk_FAKElinkAcmeStore00000")
    const error = await caught(client.ensureSiteSource({ productionHosts: ["acme-store.com"], consentMode: "not_required" }))
    expect(error.code).toBe("bad_response")
  })

  it("a wrong success status is an error, not a success", async () => {
    const row = loadVerbFixtures().find((candidate) => candidate.verb === "runs.start" && candidate.status === 201)
    const client = createTagBridgeClient(descriptor, { tagVersion: "x", transport: replay(200, row?.response) })
    client.setLinkId("lk_FAKElinkAcmeStore00000")
    const error = await caught(client.startRun({ tagVersion: "x", repoFingerprint: SITE.repoFingerprint, worker: "none", reviewer: "none" }))
    expect(error.code).toBe("generic")
  })
})
