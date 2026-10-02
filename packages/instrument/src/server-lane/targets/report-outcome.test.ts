// reportInfiniteOutcome (§3j.5), EXECUTED in every generated form — the TS helper, the JS helper and the
// Node twin — against the shared 202 vectors in `contracts/server-lane-v1.vectors.json`
// (`outcomeResponses`). The same vectors tell the receiving side (1bu-1, lane C2) what to answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBrowserVm, plain } from "../../../test/site-code/browser-vm.js"
import { buildMetaPixelSnippet } from "../../providers/meta.js"
import { VECTORS } from "../helpers.test.js"

import { nodeLaneModuleSource, nodeOutcomeHelperSource } from "./node.js"
import { outcomeHelperSource } from "./shared.js"

interface Report {
  accepted: boolean
  duplicate: boolean
  metaEventId: string | null
  metaEventName: string | null
}
interface Helper {
  reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<Report>
  postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
}

const here = dirname(fileURLToPath(import.meta.url))
const RESPONSES = (
  JSON.parse(readFileSync(resolve(here, "../../../contracts/server-lane-v1.vectors.json"), "utf8")) as {
    outcomeResponses: { cases: Array<{ name: string; status: number; body: string; report: Report }> }
  }
).outcomeResponses.cases

const BUILD = { siteSourceKey: "site_test", productionHosts: [VECTORS.host] }
const tempRoots: string[] = []

async function helper(form: "ts" | "js" | "node"): Promise<Helper> {
  const dir = mkdtempSync(join(tmpdir(), "instrument-report-outcome-"))
  tempRoots.push(dir)
  const id = Math.random().toString(16).slice(2)
  if (form === "node") {
    writeFileSync(join(dir, "infinite-server-lane.js"), nodeLaneModuleSource(BUILD))
    const path = join(dir, `infinite-outcome-${id}.js`)
    writeFileSync(path, nodeOutcomeHelperSource())
    return (await import(pathToFileURL(path).href)) as Helper
  }
  const path = join(dir, `infinite-outcome-${id}.${form === "ts" ? "ts" : "mjs"}`)
  writeFileSync(path, outcomeHelperSource(BUILD, form === "ts" ? {} : { language: "js", extension: "mjs" }))
  return (await import(pathToFileURL(path).href)) as Helper
}

describe.each(["ts", "js", "node"] as const)("reportInfiniteOutcome (%s helper), executed", (form) => {
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

  it.each(RESPONSES)("$name → the vector's report; postInfiniteOutcome is its .accepted", async (vector) => {
    fetchMock = vi.fn(async () => new Response(vector.body, { status: vector.status }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    await expect(outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "signup:acct_991", path: "/signup" })).resolves.toEqual(
      vector.report
    )
    await expect(outcome.postInfiniteOutcome({ type: "sign_up", eventId: "signup:acct_991" })).resolves.toBe(vector.report.accepted)
  })

  it("sends the caller's stable eventId verbatim", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[1]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    await (await helper(form)).reportInfiniteOutcome({ type: "sign_up", eventId: "signup:acct_991" })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).eventId).toBe("signup:acct_991")
  })

  it("negative: an old-style call with no eventId THROWS at once (and sends nothing)", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    for (const input of [{ type: "sign_up" }, { type: "sign_up", eventId: "" }, { type: "sign_up", eventId: "   " }]) {
      expect(() => outcome.reportInfiniteOutcome(input)).toThrow(/stable eventId/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    // postInfiniteOutcome keeps its old contract for existing callers: a random id, a boolean.
    await expect(outcome.postInfiniteOutcome({ type: "sign_up" })).resolves.toBe(true)
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).eventId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("a network failure or the 2 s timeout resolves all-false / all-null and never rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
    await expect((await helper(form)).reportInfiniteOutcome({ type: "sign_up", eventId: "e1" })).resolves.toEqual(RESPONSES[5]!.report)

    // The 2 s budget ends in an abort: fetch rejects with an AbortError, exactly as here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")))
    )
    const pending = (await helper(form)).reportInfiniteOutcome({ type: "sign_up", eventId: "e2" })
    await expect(pending).resolves.toEqual({ accepted: false, duplicate: false, metaEventId: null, metaEventName: null })
  })

  it("carries the page's campaign context as bounded properties, dropping unknown values", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = await helper(form)
    await outcome.reportInfiniteOutcome({
      type: "sign_up",
      eventId: "e3",
      campaign: { campaignProvenance: "cookie", browserContext: "instagram_app", utmSource: "ignored" }
    })
    await outcome.reportInfiniteOutcome({
      type: "sign_up",
      eventId: "e4",
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

  // P3-6: the wizard's webhook recipe imports these three from the outcome helper, in every form.
  it("exports adMatchFromRequest, infiniteVisitKey and postInfiniteOutcome, and signs the adMatch block in", async () => {
    fetchMock = vi.fn(async () => new Response(RESPONSES[0]!.body, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const outcome = (await helper(form)) as unknown as Helper & {
      adMatchFromRequest: (request: unknown, hashed?: Record<string, string>) => Record<string, string>
      infiniteVisitKey: unknown
    }
    expect(typeof outcome.adMatchFromRequest).toBe("function")
    expect(typeof outcome.infiniteVisitKey).toBe("function")
    const buyer = new Request("https://acme.com/checkout", {
      headers: {
        cookie: "_fbc=fb.1.1700000000000.OLD; _fbc=fb.1.1800000000000.NEW; _fbp=fb.1.1700000000000.123456",
        "user-agent": "Mozilla/5.0 Buyer",
        "x-forwarded-for": "203.0.113.9"
      }
    })
    const adMatch = outcome.adMatchFromRequest(buyer, { em: "a".repeat(64) })
    expect(adMatch).toEqual({
      em: "a".repeat(64),
      fbc: "fb.1.1800000000000.NEW",
      fbp: "fb.1.1700000000000.123456",
      client_ip_address: "203.0.113.9",
      client_user_agent: "Mozilla/5.0 Buyer"
    })
    await outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "e7", adMatch })
    await outcome.reportInfiniteOutcome({ type: "sign_up", eventId: "e8" })
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as [string, RequestInit])[1].body)))
    expect(bodies[0].adMatch).toEqual(adMatch)
    expect(bodies[1]).not.toHaveProperty("adMatch")
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
