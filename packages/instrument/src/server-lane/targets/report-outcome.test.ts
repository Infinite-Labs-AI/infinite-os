// reportInfiniteOutcomeForMirror / reportInfiniteOutcome (§3j.5), EXECUTED as the JS helper (the same source as the
// TS helper with the types removed; every target, Node included, ships this one helper) against the shared 202 vectors in `contracts/server-lane-v1.vectors.json`
// (`outcomeResponses`). The same vectors tell the receiving side (1bu-1, lane C2) what to answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBrowserVm, plain } from "../../../test/site-code/browser-vm.js"
import { buildMetaPixelSnippet } from "../../providers/meta.js"
import { VECTORS } from "../../../test/server-lane-vectors.js"

import { outcomeHelperSource } from "./outcome-helper.js"

interface Report {
  accepted: boolean
  duplicate: boolean
  metaEventId: string | null
  metaEventName: string | null
  status: number | null
}
interface Helper {
  reportInfiniteOutcomeForMirror: (input: Record<string, unknown>) => Promise<Report>
  reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<number | null>
}

const here = dirname(fileURLToPath(import.meta.url))
const RESPONSES = (
  JSON.parse(readFileSync(resolve(here, "../../../contracts/server-lane-v1.vectors.json"), "utf8")) as {
    outcomeResponses: { cases: Array<{ name: string; status: number; body: string; report: Report }> }
  }
).outcomeResponses.cases

const WIRE_IDS = (
  JSON.parse(readFileSync(resolve(here, "../../../contracts/server-lane-v1.vectors.json"), "utf8")) as {
    outcomeWireIds: { cases: Array<{ type: string; eventId: string; wire: string }> }
  }
).outcomeWireIds.cases

const META_MATCH = (
  JSON.parse(readFileSync(resolve(here, "../../../contracts/server-lane-v1.vectors.json"), "utf8")) as {
    metaMatch: {
      email: { raw: string; normalized: string; sha256: string }
      externalId: { raw: string; normalized: string; sha256: string }
      name: { raw: string; normalized: string; sha256: string }
      city: { raw: string; normalized: string; sha256: string }
      digitCity: { raw: string; normalized: null }
      usState: { raw: string; country: string; normalized: string; sha256: string }
      zip: { raw: string; normalized: string; sha256: string }
      country: { raw: string; normalized: string; sha256: string }
      fullName: { raw: string; fn: string; ln: string }
      fullNameMultiWord: { raw: string; fn: string; ln: string }
    }
  }
).metaMatch

const BUILD = { siteSourceKey: "site_test", productionHosts: [VECTORS.host] }
const tempRoots: string[] = []

async function helper(form: "ts" | "js"): Promise<Helper> {
  const dir = mkdtempSync(join(tmpdir(), "instrument-report-outcome-"))
  tempRoots.push(dir)
  const id = Math.random().toString(16).slice(2)
  const path = join(dir, `infinite-outcome-${id}.${form === "ts" ? "ts" : "mjs"}`)
  writeFileSync(path, outcomeHelperSource(BUILD, form === "ts" ? {} : { language: "js", extension: "mjs" }))
  return (await import(pathToFileURL(path).href)) as Helper
}

describe.each([ "js"] as const)("reportInfiniteOutcome (%s helper), executed", (form) => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
    process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  it("exports Meta's normalization/hash helpers from the generated outcome helper", async () => {
    const outcome = (await helper(form)) as unknown as {
      normalizeEmailForMeta: (value: string) => string | null
      normalizeNameForMeta: (value: string) => string | null
      normalizeCityForMeta: (value: string) => string | null
      normalizeStateForMeta: (value: string, country?: string | null) => string | null
      normalizeZipForMeta: (value: string) => string | null
      normalizeCountryForMeta: (value: string) => string | null
      hashEmailForMeta: (value: string) => string | null | Promise<string | null>
      hashNameForMeta: (value: string) => string | null | Promise<string | null>
      hashCityForMeta: (value: string) => string | null | Promise<string | null>
      hashStateForMeta: (value: string, country?: string | null) => string | null | Promise<string | null>
      hashZipForMeta: (value: string) => string | null | Promise<string | null>
      hashCountryForMeta: (value: string) => string | null | Promise<string | null>
      hashExternalId: (value: string) => string | null | Promise<string | null>
    }
    expect(outcome.normalizeEmailForMeta(META_MATCH.email.raw)).toBe(META_MATCH.email.normalized)
    expect(await outcome.hashEmailForMeta(META_MATCH.email.raw)).toBe(META_MATCH.email.sha256)
    expect(outcome.normalizeNameForMeta(META_MATCH.name.raw)).toBe(META_MATCH.name.normalized)
    expect(await outcome.hashNameForMeta(META_MATCH.name.raw)).toBe(META_MATCH.name.sha256)
    expect(outcome.normalizeCityForMeta(META_MATCH.city.raw)).toBe(META_MATCH.city.normalized)
    expect(await outcome.hashCityForMeta(META_MATCH.city.raw)).toBe(META_MATCH.city.sha256)
    expect(outcome.normalizeCityForMeta(META_MATCH.digitCity.raw)).toBeNull()
    expect(outcome.normalizeStateForMeta(META_MATCH.usState.raw, META_MATCH.usState.country)).toBe(META_MATCH.usState.normalized)
    expect(await outcome.hashStateForMeta(META_MATCH.usState.raw, META_MATCH.usState.country)).toBe(META_MATCH.usState.sha256)
    expect(outcome.normalizeZipForMeta(META_MATCH.zip.raw)).toBe(META_MATCH.zip.normalized)
    expect(await outcome.hashZipForMeta(META_MATCH.zip.raw)).toBe(META_MATCH.zip.sha256)
    expect(outcome.normalizeCountryForMeta(META_MATCH.country.raw)).toBe(META_MATCH.country.normalized)
    expect(await outcome.hashCountryForMeta(META_MATCH.country.raw)).toBe(META_MATCH.country.sha256)
    expect(await outcome.hashExternalId(META_MATCH.externalId.raw)).toBe(META_MATCH.externalId.sha256)
  })

  it.each(RESPONSES)("$name → the vector's report; reportInfiniteOutcome is its .status", async (vector) => {
    fetchMock = vi.fn(async () => new Response(vector.body, { status: vector.status }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(outcome.reportInfiniteOutcomeForMirror({ type: "sign_up", eventId: "signup:acct_991", path: "/signup" })).resolves.toEqual(
      vector.report
    )
    await expect(outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "signup:acct_991", path: "/signup" })).resolves.toBe(
      vector.report.status
    )
  })

  it.each(WIRE_IDS)("sends the wire eventId <type>:<eventId> (B16): $type / $wire", async (vector) => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[1]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    await (await helper(form)).reportInfiniteOutcome({ type: vector.type, eventId: vector.eventId, path: "/signup" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).eventId).toBe(vector.wire)
  })

  it("negative: one stable id reused for two outcome types never sends the same wire id", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    await outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "acct_991", path: "/signup" })
    await outcome.reportInfiniteOutcome({ type: "trial", eventId: "acct_991", path: "/trial" })
    const sent = fetchMock.mock.calls.map((call) => JSON.parse(String((call as [string, RequestInit])[1].body)).eventId)
    expect(new Set(sent).size).toBe(2)
  })

  it("negative: a call with no stable eventId is refused here (400) and sends nothing; it never throws", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const outcome = await helper(form)
    for (const input of [
      { type: "sign_up", path: "/signup" },
      { type: "sign_up", eventId: "", path: "/signup" },
      { type: "sign_up", eventId: "   ", path: "/signup" }
    ]) {
      await expect(outcome.reportInfiniteOutcome(input)).resolves.toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a network failure or the 2 s timeout resolves all-false / all-null and never rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect((await helper(form)).reportInfiniteOutcomeForMirror({ type: "sign_up", eventId: "e1", path: "/signup" })).resolves.toEqual({
      accepted: false,
      duplicate: false,
      metaEventId: null,
      metaEventName: null,
      status: null
    })

    // The 2 s budget ends in an abort: fetch rejects with an AbortError, exactly as here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")))
    )
    const pending = (await helper(form)).reportInfiniteOutcomeForMirror({ type: "sign_up", eventId: "e2", path: "/signup" })
    await expect(pending).resolves.toEqual({
      accepted: false,
      duplicate: false,
      metaEventId: null,
      metaEventName: null,
      status: null
    })
  })

  it("carries the page's campaign context as bounded properties, dropping unknown values", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    await outcome.reportInfiniteOutcome({
      type: "sign_up",
      eventId: "e3",
      path: "/signup",
      campaign: { campaignProvenance: "cookie", browserContext: "instagram_app", utmSource: "ignored" }
    })
    await outcome.reportInfiniteOutcome({
      type: "sign_up",
      eventId: "e4",
      path: "/signup",
      campaign: { campaignProvenance: "<script>", browserContext: "person@example.test" }
    })
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as [string, RequestInit])[1].body)))
    expect(bodies[0].properties).toMatchObject({ campaign_provenance: "cookie", browser_context: "instagram_app" })
    expect(bodies[0].properties).not.toHaveProperty("utmSource")
    expect(bodies[1].properties).not.toHaveProperty("campaign_provenance")
    expect(bodies[1].properties).not.toHaveProperty("browser_context")
  })

  // P3-5: Infinite refuses an event with more than 16 properties, whole. The campaign context is a
  // nice-to-have; it must never cost the outcome.
  it("adds the campaign context only while the event stays within 16 properties", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    const campaign = { campaignProvenance: "tab", browserContext: "browser" }
    const fourteen = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`p${index}`, index]))
    await outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "e5", path: "/signup", properties: fourteen, campaign })
    const fifteen = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`p${index}`, index]))
    await outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "e6", path: "/signup", properties: fifteen, campaign })
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as [string, RequestInit])[1].body)))
    // 14 + path = 15: room for one campaign key only.
    expect(Object.keys(bodies[0].properties)).toHaveLength(16)
    expect(bodies[0].properties).toHaveProperty("campaign_provenance", "tab")
    expect(bodies[0].properties).not.toHaveProperty("browser_context")
    // 15 + path = 16: no room; the outcome itself is unchanged.
    expect(Object.keys(bodies[1].properties)).toHaveLength(16)
    expect(bodies[1].properties).not.toHaveProperty("campaign_provenance")
  })
})

describe("the mixed-case external_id vector, across both legs", () => {
  it("the browser's matching accessor hashes it to the same bytes as the server leg", async () => {
    const vectors = JSON.parse(readFileSync(resolve(here, "../../../contracts/server-lane-v1.vectors.json"), "utf8")) as {
      outcomeExternalIdMixedCase: string
      outcomeExternalIdMixedCaseHash: string
    }
    const vm = createBrowserVm({ url: "https://acme.com/" })
    vm.runScript(buildMetaPixelSnippet("1234567890123456", { advancedMatching: true }))
    vm.window.__id = vectors.outcomeExternalIdMixedCase
    const attached = await (vm.evaluate("infiniteMetaAdvancedMatch({ externalId: window.__id })") as Promise<boolean>)
    expect(attached).toBe(true)
    const queue = (vm.window.fbq as { queue: ArrayLike<unknown>[] }).queue.map((args) => Array.from(args))
    expect(plain(queue.at(-1))).toEqual(["init", "1234567890123456", { external_id: vectors.outcomeExternalIdMixedCaseHash }])
  })
})
