import { describe, expect, it, vi } from "vitest"

import {
  CloudReportSink,
  DesktopBridgeReportSink,
  NO_DESKTOP_REPORT_REASON,
  NoneReportSink,
  REPORT_STRING_MAX,
  buildHarnessReportPayload,
  redactProviderIds
} from "./report-sink.js"
import { createHarnessReport, transitionProvider, updateProvider } from "./state.js"

function report() {
  const out = createHarnessReport({ mode: "apply", root: "/home/founder/sites/acme", startedAt: "2026-09-02T10:00:00.000Z" })
  out.framework = "nextjs"
  out.hosting = "vercel"
  updateProvider(out, "ga4", (state) => ({
    ...transitionProvider(state, { to: "adopted", reason: "left byte-for-byte alone", key: "G-ABC123", evidence: "app/layout.tsx" }),
    verification: { kind: "adopted_not_ours" }
  }))
  updateProvider(out, "infinite", (state) =>
    transitionProvider(
      transitionProvider(state, { to: "installed", reason: "written this run; hash-verified against .infinite/install.json", evidence: "app/layout.tsx" }),
      { to: "verified", receiptAt: "2026-09-02T10:01:03.000Z" }
    )
  )
  updateProvider(out, "server_lane", (state) => ({
    ...transitionProvider(state, { to: "installed", reason: "Next.js middleware; brief written", evidence: "middleware.ts" }),
    verification: { kind: "no_receipt", causes: ["No server_lane event arrived within 60s.", "not deployed yet"] }
  }))
  updateProvider(out, "posthog", (state) => ({
    ...transitionProvider(state, { to: "installed", evidence: "app/layout.tsx" }),
    verification: { kind: "not_verifiable", reason: "no query key" }
  }))
  updateProvider(out, "x", (state) => transitionProvider(state, { to: "skipped", reason: "no key resolved (flags, saved artifacts, or .env)" }))
  return out
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("buildHarnessReportPayload", () => {
  it("reduces the seven rows to bounded state words, keeps receipts, and never ships keys", () => {
    const payload = buildHarnessReportPayload(report(), { engineProjectId: "proj_1", tagVersion: "0.7.0", repoLabel: "acme" })
    expect(payload).toMatchObject({
      engineProjectId: "proj_1",
      ranAt: "2026-09-02T10:00:00.000Z",
      tagVersion: "0.7.0",
      framework: "nextjs",
      hosting: "vercel",
      repoLabel: "acme"
    })
    expect(Object.keys(payload.providers)).toEqual(["ga4", "gtm", "posthog", "meta", "x", "infinite", "server_lane"])
    expect(payload.providers.ga4).toEqual({
      state: "adopted",
      via: "left byte-for-byte alone",
      evidenceFile: "app/layout.tsx",
      verification: { state: "adopted_not_ours" }
    })
    expect(payload.providers.infinite).toEqual({
      state: "verified",
      via: "written this run; hash-verified against .infinite/install.json",
      evidenceFile: "app/layout.tsx",
      verification: { state: "verified", receiptAt: "2026-09-02T10:01:03.000Z" }
    })
    expect(payload.providers.server_lane?.verification).toEqual({ state: "no_receipt", reason: "No server_lane event arrived within 60s." })
    expect(payload.providers.posthog?.verification).toEqual({ state: "not_verifiable", reason: "no query key" })
    expect(payload.providers.x).toEqual({ state: "skipped", via: "no key resolved (flags, saved artifacts, or .env)", verification: { state: "not_run" } })
    expect(payload.providers.meta).toEqual({ state: "absent", verification: { state: "not_run" } })
    expect(JSON.stringify(payload)).not.toContain("G-ABC123")
    expect(JSON.stringify(payload)).not.toContain("/home/founder")
  })

  it("bounds every string and keeps a non-file evidence clause out of evidenceFile", () => {
    const out = report()
    const long = "x".repeat(REPORT_STRING_MAX + 50)
    updateProvider(out, "gtm", (state) => transitionProvider(state, { to: "skipped", reason: long, evidence: "no Tag Manager container found" }))
    const payload = buildHarnessReportPayload(out, { engineProjectId: "proj_1", tagVersion: "0.7.0", repoLabel: long })
    expect(payload.providers.gtm?.via?.length).toBe(REPORT_STRING_MAX)
    expect(payload.providers.gtm?.evidenceFile).toBeUndefined()
    expect(payload.repoLabel?.length).toBe(REPORT_STRING_MAX)
  })

  it("redacts provider ids the harness quotes in a conflict clause — keys never leave the machine", () => {
    const out = report()
    updateProvider(out, "gtm", (state) =>
      transitionProvider(state, { to: "conflict", reason: "2 different ids found (G-AAAA1111, GTM-BBBB22); nothing installed", key: "G-AAAA1111", evidence: "index.html" })
    )
    updateProvider(out, "meta", (state) => ({
      ...transitionProvider(state, { to: "installed", reason: "pixel 123456789012345 written", evidence: "index.html" }),
      verification: { kind: "not_verifiable", reason: "phc_abcDEF123 has no query key" }
    }))
    const payload = buildHarnessReportPayload(out, { engineProjectId: "proj_1", tagVersion: "0.7.0" })
    expect(payload.providers.gtm?.via).toBe("2 different ids found (<id>, <id>); nothing installed")
    expect(payload.providers.meta?.via).toBe("pixel <id> written")
    expect(payload.providers.meta?.verification.reason).toBe("<id> has no query key")
    const wire = JSON.stringify(payload)
    for (const id of ["G-AAAA1111", "GTM-BBBB22", "123456789012345", "phc_abcDEF123"]) expect(wire).not.toContain(id)
    expect(redactProviderIds("GT-XYZ12345 and G-AB1")).toBe("<id> and G-AB1")
  })
})

describe("NoneReportSink", () => {
  it("never sends and names why — the CLI's reason when it has one, 'open the app' otherwise", async () => {
    const payload = buildHarnessReportPayload(report(), { engineProjectId: "p", tagVersion: "0.7.0" })
    expect(await new NoneReportSink().send(payload)).toEqual({ sent: false, reason: NO_DESKTOP_REPORT_REASON })
    expect(await new NoneReportSink("update the Infinite app").send(payload)).toEqual({ sent: false, reason: "update the Infinite app" })
  })
})

describe("DesktopBridgeReportSink", () => {
  const payload = buildHarnessReportPayload(report(), { engineProjectId: "proj_1", tagVersion: "0.7.0" })

  it("POSTs the app's loopback verb with the LOCAL bearer, protocolVersion 1, and no engineProjectId", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse(201, { id: "r1" })
    })
    const sink = new DesktopBridgeReportSink({ bridgeUrl: "http://127.0.0.1:54321/", token: "bridge_tok", fetch: fetchImpl as unknown as typeof fetch })
    expect(await sink.send(payload)).toEqual({ sent: true })
    expect(calls[0].url).toBe("http://127.0.0.1:54321/v1/analytics/report")
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer bridge_tok")
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toMatchObject({ protocolVersion: 1, tagVersion: "0.7.0", framework: "nextjs" })
    expect(body.engineProjectId).toBeUndefined()
  })

  it("names the app's own refusals: 409 not_ready with its state, 503 capability_unavailable → update, forwarded cloud answers as the cloud's", async () => {
    const cases: Array<[Response | Error, string]> = [
      [jsonResponse(409, { error: "not_ready", state: "subscription_required" }), "Infinite Desktop is not ready (subscription_required) — complete onboarding"],
      [jsonResponse(503, { error: { code: "capability_unavailable", message: "update" } }), "this Infinite Desktop version cannot verify — update the Infinite app"],
      [jsonResponse(503, { error: "cloud_unavailable", message: "The Infinite app is signed out or the cloud is unreachable." }), "The Infinite app is signed out or the cloud is unreachable."],
      [jsonResponse(404, { error: { code: "route_not_found" } }), "this Infinite Desktop version cannot verify — update the Infinite app"],
      [jsonResponse(402, { error: "entitlement_required" }), "subscription required — complete onboarding in Infinite Desktop"],
      [jsonResponse(400, { error: "invalid_request", reason: "unknown provider: mixpanel" }), "the Infinite app rejected the report: invalid_request — unknown provider: mixpanel"],
      [jsonResponse(401, {}), "the Infinite app rejected this terminal's bridge credentials (HTTP 401) — restart the app and re-run"],
      [new Error("ECONNREFUSED"), "the Infinite app was unreachable (ECONNREFUSED)"]
    ]
    for (const [answer, reason] of cases) {
      const fetchImpl = async () => {
        if (answer instanceof Error) throw answer
        return answer
      }
      const sink = new DesktopBridgeReportSink({ bridgeUrl: "http://127.0.0.1:1", token: "t", fetch: fetchImpl as unknown as typeof fetch })
      expect(await sink.send(payload)).toEqual({ sent: false, reason })
    }
  })
})

describe("CloudReportSink", () => {
  const payload = buildHarnessReportPayload(report(), { engineProjectId: "proj_1", tagVersion: "0.7.0" })

  it("POSTs the payload with the bearer to /api/analytics/harness-report", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse(201, { id: "r1" })
    })
    const sink = new CloudReportSink({ origin: "https://api.ultima.inc/", token: "tok_1", fetch: fetchImpl as unknown as typeof fetch })
    expect(await sink.send(payload)).toEqual({ sent: true })
    expect(calls[0].url).toBe("https://api.ultima.inc/api/analytics/harness-report")
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok_1")
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ engineProjectId: "proj_1", tagVersion: "0.7.0" })
  })

  it("maps every failure to a reason and never throws", async () => {
    const cases: Array<[Response | Error, string]> = [
      [jsonResponse(401, { error: "unauthorized" }), "the cloud rejected this session (HTTP 401)"],
      [jsonResponse(402, { error: "entitlement_required" }), "subscription required — complete onboarding in Infinite Desktop"],
      [jsonResponse(404, { error: "not_linked" }), "this workspace is not linked to your Infinite account"],
      [jsonResponse(404, null), "the cloud report route is not available yet (HTTP 404)"],
      [jsonResponse(429, { error: "quota_exhausted" }), "rate limited by the cloud; try again in a minute"],
      [jsonResponse(400, { error: "invalid_request", reason: "unknown provider: mixpanel" }), "the cloud rejected the report: invalid_request — unknown provider: mixpanel"],
      [jsonResponse(503, { error: "subscription_check_unavailable" }), "the cloud report route was unavailable (HTTP 503)"],
      [new Error("ECONNREFUSED"), "the cloud was unreachable (ECONNREFUSED)"]
    ]
    for (const [answer, reason] of cases) {
      const fetchImpl = async () => {
        if (answer instanceof Error) throw answer
        return answer
      }
      const sink = new CloudReportSink({ origin: "https://api.ultima.inc", token: "tok_1", fetch: fetchImpl as unknown as typeof fetch })
      expect(await sink.send(payload)).toEqual({ sent: false, reason })
    }
  })
})
