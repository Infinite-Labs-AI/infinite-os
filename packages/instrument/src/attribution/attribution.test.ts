// First-touch attribution, EXECUTED: the landing script in a vm browser and the server cookie, run
// against each other.
//
// Ported from infinite-site @ 9f65b47:
//   - `.github/scripts/test-inject-analytics.mjs` L147-316: first touch, never overwritten, referrer
//     host, invalid ad ids, contamination, blocked storage, blocked cookies, no-UTM gives no cookie,
//     consent, http vs https, the 3800-byte boundary, and browser/server projection parity;
//   - `.github/scripts/test-routing-middleware.mjs` L465-483: the server cookie never overwrites, skips
//     unusable landings, filters contamination, and has the same 3800-byte boundary;
//   - `.github/scripts/test-signup-ab-composition.mjs` L26-52: `withCampaignCookie` decorates the final
//     response and changes nothing else.
// Where the customer-site version deliberately differs it says so and asserts the NEW rule:
//   - G11: the TAB copy is filtered at write time (infinite.fast asserted it stayed unfiltered);
//   - the capture follows the site's consent hook when one is given (infinite.fast captured regardless);
//   - the server cookie follows the deny-mode preview guard, not a fixed allowlist.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { createBrowserVm, plain } from "../../test/site-code/browser-vm.js"
import type { MetaBrowserGate } from "../providers/meta-browser/consent.js"

import {
  buildLandingAttributionScript,
  campaignMetadata,
  campaignWireMetadata,
  filterTabRecord,
  projectCampaignCookie
} from "./capture.js"
import { campaignCookieHeader, campaignCookieModuleSource, withCampaignCookie } from "./cookie.js"
import { infiniteUnsafeText } from "../conversions/scrub.js"
import {
  CAMPAIGN_KEY,
  CLICK_ID_CONTAMINATION_PATTERN,
  HOST_LABEL_SOURCE,
  META_AD_ID_PATTERN,
  META_PLACEMENT_PATTERN
} from "./patterns.js"

const KEY = CAMPAIGN_KEY
const GUARD = { exempt: ["acme.com"], deny: [] as string[] }
const CONSENT = { consentMode: "not_required" as const }

interface LandingOptions {
  pathname?: string
  search?: string
  referrer?: string
  protocol?: "https:" | "http:"
  sessionStorage?: Map<string, string>
  cookies?: string
  storageThrows?: boolean
  cookieThrows?: boolean
  storedConsent?: "granted" | "denied"
  userAgent?: string
  gate?: MetaBrowserGate
  now?: number
}

function land(options: LandingOptions = {}) {
  const url = `${options.protocol === "http:" ? "http" : "https"}://acme.com${options.pathname ?? "/"}${options.search ?? ""}`
  const vm = createBrowserVm({
    url,
    referrer: options.referrer ?? "",
    sessionStorage: options.sessionStorage ?? new Map(),
    cookies: options.cookies ? [options.cookies] : [],
    storageThrows: options.storageThrows,
    cookieThrows: options.cookieThrows,
    localStorage: options.storedConsent ? { infinite_analytics_consent: options.storedConsent } : {},
    userAgent: options.userAgent,
    now: options.now
  })
  // A landing URL with a non-ASCII-safe path is passed raw, as location.pathname would report it.
  if (options.pathname) (vm.window.location as { pathname: string }).pathname = options.pathname
  vm.runScript(buildLandingAttributionScript({ ownHosts: ["acme.com"], gate: options.gate ?? { kind: "none" } }))
  expect(vm.scriptErrors).toEqual([])
  return {
    vm,
    attribution: (): Record<string, unknown> => {
      const raw = vm.sessionValues.get(KEY)
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    },
    cookie: (): string | null => vm.cookies.values(KEY)[0] ?? null,
    record: (): Record<string, unknown> => JSON.parse(decodeURIComponent(vm.cookies.values(KEY)[0]!)) as Record<string, unknown>,
    writes: (): string[] => vm.cookies.writes.filter((value) => value.startsWith(KEY + "=")),
    campaign: (): Record<string, unknown> => plain(vm.evaluate("infiniteCampaign()")) as Record<string, unknown>
  }
}

const legacy = (record: Record<string, unknown>) => ({
  utm_source: record.utm_source,
  utm_medium: record.utm_medium,
  utm_campaign: record.utm_campaign,
  utm_term: record.utm_term,
  utm_content: record.utm_content,
  has_gclid: record.has_gclid,
  has_fbclid: record.has_fbclid,
  has_msclkid: record.has_msclkid,
  has_ttclid: record.has_ttclid,
  landing_path: record.landing_path
})

describe("the landing script: first touch in the tab", () => {
  it("records bounded UTM values and click ids by PRESENCE only, never the query string", () => {
    const storage = new Map<string, string>()
    const page = land({
      search:
        "?utm_source=NEWSLETTER&utm_medium=Email&utm_campaign=" +
        "A".repeat(140) +
        "&utm_term=Launch%20Term&utm_content=Hero%7CBuy&gclid=RAW_GCLID&fbclid=RAW_FB&msclkid=RAW_MS&ttclid=RAW_TT",
      sessionStorage: storage
    })
    expect(legacy(page.attribution())).toEqual({
      utm_source: "NEWSLETTER",
      utm_medium: "Email",
      utm_campaign: "A".repeat(128),
      utm_term: "Launch Term",
      utm_content: "Hero|Buy",
      has_gclid: true,
      has_fbclid: true,
      has_msclkid: true,
      has_ttclid: true,
      landing_path: "/"
    })
    expect(storage.get(KEY)).not.toMatch(/RAW_GCLID|RAW_FB|RAW_MS|RAW_TT/)
    expect(storage.get(KEY)).not.toMatch(/\?utm_source|gclid=|fbclid=|msclkid=|ttclid=/)

    const first = page.attribution()
    land({ pathname: "/pricing", search: "?utm_source=OVERRIDE&gclid=SECOND_RAW_VALUE", sessionStorage: storage })
    expect(JSON.parse(storage.get(KEY)!)).toEqual(first)
  })

  it("a direct visitor still gets a first-touch landing_path record", () => {
    expect(legacy(land({ pathname: "/terms/" }).attribution())).toEqual({
      utm_source: "",
      utm_medium: "",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      has_gclid: false,
      has_fbclid: false,
      has_msclkid: false,
      has_ttclid: false,
      landing_path: "/terms/"
    })
  })

  it("captures the referrer HOST (not own, well-formed) and well-formed Meta ids", () => {
    const captured = land({
      search: "?utm_source=facebook&ad_id=123&adset_id=456&campaign_id=789&utm_placement=instagram_stories",
      referrer: "https://Facebook.com./path?secret=value",
      userAgent: "Mozilla/5.0 Instagram 300.0"
    })
    const record = captured.attribution()
    expect(record.referrer_host).toBe("facebook.com")
    expect([record.meta_ad_id, record.meta_adset_id, record.meta_campaign_id, record.meta_placement]).toEqual([
      "123",
      "456",
      "789",
      "instagram_stories"
    ])
    expect(record.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
    expect(captured.campaign()).toEqual({
      campaignProvenance: "tab",
      browserContext: "instagram_app",
      referrerHost: "facebook.com",
      metaAdId: "123",
      metaAdsetId: "456",
      metaCampaignId: "789",
      metaPlacement: "instagram_stories",
      campaignCapturedAt: record.captured_at,
      utmSource: "facebook",
      landingPath: "/"
    })
    for (const referrer of ["https://acme.com/", "https://ACME.com./x", "", "https://" + "a".repeat(254) + "/"]) {
      expect(land({ search: "?utm_source=x", referrer }).attribution().referrer_host).toBe("")
    }
    const invalid = land({ search: "?utm_source=x&ad_id=123%0A&adset_id=abc&campaign_id=&utm_placement=instagram%20stories" })
    for (const key of ["meta_ad_id", "meta_adset_id", "meta_campaign_id", "meta_placement"]) {
      expect(invalid.attribution()[key]).toBe("")
    }
  })

  it("G11: the tab copy is FILTERED at write time (infinite.fast kept it raw)", () => {
    const contaminated = land({ search: "?utm_source=paid&utm_term=gclid%3DSECRET&utm_content=x%26fbclid%3DY&utm_medium=person%40example.test" })
    expect(contaminated.attribution().utm_term).toBe("")
    expect(contaminated.attribution().utm_content).toBe("")
    expect(contaminated.attribution().utm_medium).toBe("")
    expect(contaminated.attribution().utm_source).toBe("paid")
    for (const path of ["/gclid=SECRET", "/foo fbclid=SECRET", "/foo%20msclkid%3DSECRET", "/u/5551234567"]) {
      const run = land({ search: "?utm_source=paid", pathname: path })
      expect(run.attribution().landing_path).toBe("")
      expect(JSON.stringify(run.attribution())).not.toMatch(/SECRET|5551234567/)
    }
  })

  it("negative: the unfiltered tab projection (infinite.fast's) would have stored the click id", () => {
    const payload = { utm_term: "gclid=SECRET", landing_path: "/" }
    expect(filterTabRecord(payload, infiniteUnsafeText).utm_term).toBe("")
    expect(filterTabRecord(payload, () => false).utm_term).toBe("") // the click-id filter alone
    expect(JSON.parse(JSON.stringify(payload)).utm_term).toBe("gclid=SECRET")
  })
})

describe("the landing script: the 7-day first-touch cookie", () => {
  it("a UTM landing writes it once, host-only, with the browser projection (v1)", () => {
    const landing = land({ search: "?utm_source=facebook&fbclid=RAW_CLICK", pathname: "/audit/" })
    expect(landing.writes()).toHaveLength(1)
    expect(landing.writes()[0]).toMatch(/;path=\/;max-age=604800;samesite=Lax;secure$/)
    expect(landing.record()).toEqual({ ...landing.attribution(), v: 1 })
    expect(landing.writes()[0]).not.toMatch(/RAW_CLICK|Domain=|HttpOnly/i)
  })

  it("never overwrites or renews an existing cookie, even a malformed one", () => {
    const seed = land({ search: "?utm_source=facebook" })
    for (const cookies of [KEY + "=" + seed.cookie(), KEY + "=", KEY + "=bad-json"]) {
      const later = land({ search: "?utm_source=second", cookies })
      expect(later.writes()).toEqual([])
      expect(later.attribution().utm_source).toBe("second")
    }
  })

  it("the two copies are independent: a tab stash, blocked storage, blocked cookies", () => {
    const tab = new Map([[KEY, JSON.stringify({ utm_source: "old-tab" })]])
    const newLanding = land({ search: "?utm_source=new-cookie", sessionStorage: tab })
    expect(newLanding.attribution().utm_source).toBe("old-tab")
    expect(newLanding.record().utm_source).toBe("new-cookie")
    expect(land({ search: "?utm_source=blocked", storageThrows: true }).record().utm_source).toBe("blocked")
    expect(land({ search: "?utm_source=tab-survives", cookieThrows: true }).attribution().utm_source).toBe("tab-survives")
  })

  it("no usable UTM, no cookie: an unusable first visit never takes the first-touch slot", () => {
    for (const search of ["", "?fbclid=CLICK_ONLY", "?utm_source=", "?utm_source=%20", "?utm_source=%00%01%7F&utm_campaign=%09%0A"]) {
      expect(land({ search }).writes()).toEqual([])
    }
    const storage = new Map<string, string>()
    const first = land({
      search: "?utm_source=gclid%3DSECRET&utm_medium=fbclid%3DSECRET&utm_campaign=msclkid%3DSECRET&utm_term=ttclid%3DSECRET",
      pathname: "/first/",
      sessionStorage: storage
    })
    expect(first.writes()).toEqual([])
    const later = land({ search: "?utm_source=facebook&utm_campaign=real_campaign", pathname: "/real/", sessionStorage: storage })
    expect(later.writes()).toHaveLength(1)
    expect(later.record()).toMatchObject({ utm_source: "facebook", utm_campaign: "real_campaign", landing_path: "/real/" })
  })

  it("contamination never reaches the cookie", () => {
    const contaminated = land({ search: "?utm_source=paid&utm_term=gclid%3DSECRET&utm_content=x%26fbclid%3DY" })
    expect(contaminated.record()).toMatchObject({ utm_term: "", utm_content: "", v: 1 })
    expect(contaminated.writes()[0]).not.toMatch(/SECRET|fbclid%3D/i)
  })

  it("http writes no secure attribute", () => {
    expect(land({ search: "?utm_source=paid", protocol: "http:" }).writes()[0]).not.toMatch(/;secure/)
  })

  it("3800 encoded bytes is an inclusive ceiling; one byte over skips the cookie, never the tab", () => {
    const seed = land({ search: "?utm_source=paid", pathname: "/" })
    const padding = 3800 - seed.cookie()!.length
    for (const extra of [0, 1]) {
      const path = "/" + "a".repeat(padding + extra)
      const boundary = land({ search: "?utm_source=paid", pathname: path })
      expect(boundary.attribution().landing_path).toBe(path)
      expect(boundary.writes()).toHaveLength(extra === 0 ? 1 : 0)
      if (extra === 0) expect(boundary.cookie()!.length).toBe(3800)
    }
  })
})

describe("the landing script: consent", () => {
  it("with no hook (infinite.fast parity) a stored denial does not stop the capture", () => {
    expect(land({ search: "?utm_source=paid", storedConsent: "denied" }).record().utm_source).toBe("paid")
  })

  it("with the Infinite hook (what infinite-tag emits) a denial captures nothing and infiniteCampaign() says none", () => {
    const gate: MetaBrowserGate = { kind: "infinite-consent", mode: "not_required" }
    const denied = land({ search: "?utm_source=paid", storedConsent: "denied", gate })
    expect(denied.writes()).toEqual([])
    expect(denied.attribution()).toEqual({})
    expect(denied.campaign()).toMatchObject({ campaignProvenance: "none" })
    const required = land({ search: "?utm_source=paid", gate: { kind: "infinite-consent", mode: "required" } })
    expect(required.writes()).toEqual([])
    const granted = land({ search: "?utm_source=paid", storedConsent: "granted", gate: { kind: "infinite-consent", mode: "required" } })
    expect(granted.record().utm_source).toBe("paid")
  })
})

describe("infiniteCampaign()", () => {
  it("falls back to the cookie in a new tab (provenance 'cookie'), and to 'none' with nothing stored", () => {
    const seed = land({ search: "?utm_source=facebook&utm_campaign=spring", referrer: "https://facebook.com/" })
    const newTab = land({ cookies: KEY + "=" + seed.cookie(), userAgent: "Mozilla/5.0 [FBAN/FBIOS;FBAV/400.0]" })
    // A new tab has its own (direct) tab record, so clear it to model the new-tab read.
    newTab.vm.sessionValues.clear()
    expect(newTab.campaign()).toMatchObject({
      campaignProvenance: "cookie",
      browserContext: "facebook_app",
      utmSource: "facebook",
      utmCampaign: "spring",
      referrerHost: "facebook.com"
    })
    const nothing = land({ storageThrows: true, cookieThrows: true })
    expect(nothing.campaign()).toMatchObject({ campaignProvenance: "none" })
  })
})

describe("the browser cookie is scrubbed like the tab copy (P2-1)", () => {
  it("blanks an email or phone number in a UTM before writing the 7-day cookie", () => {
    const page = land({ search: "?utm_source=newsletter&utm_term=jane.doe%40example.com&utm_content=%2B1%20555%20123%204567" })
    expect(page.record()).toMatchObject({ utm_source: "newsletter", utm_term: "", utm_content: "" })
    expect(decodeURIComponent(page.cookie()!)).not.toMatch(/jane|555/)
    expect(page.attribution()).toMatchObject({ utm_term: "", utm_content: "" })
  })

  it("negative: a landing whose ONLY campaign value was personal claims no first-touch cookie slot", () => {
    const page = land({ search: "?utm_source=jane.doe%40example.com" })
    expect(page.cookie()).toBeNull()
  })
})

describe("the server cookie", () => {
  const fixed = Date.parse("2026-09-27T09:12:59.123Z")
  const request = (url: string, headers: Record<string, string> = {}, method = "GET") =>
    new Request(url, { method, headers })

  it("shares the browser projection, differing only in its version", () => {
    const search = "?utm_source=facebook&ad_id=123&utm_placement=feed&utm_term=foo%20gclid%3DSECRET"
    const referrer = "https://facebook.com./path?secret=value"
    const browser = land({ search, referrer, pathname: "/audit/", now: fixed })
    const header = campaignCookieHeader(request("https://acme.com/audit/" + search, { referer: referrer }), GUARD, fixed, CONSENT)!
    const server = JSON.parse(decodeURIComponent(header.split(";")[0]!.split("=")[1]!)) as Record<string, unknown>
    expect(server).toEqual({ ...browser.record(), v: 2 })
    expect(browser.record().v).toBe(1)
    expect(server.captured_at).toBe("2026-09-27T09:12:00.000Z")
    expect(header).toMatch(/; Path=\/; Max-Age=15552000; SameSite=Lax; Secure$/)
  })

  it("never overwrites, and skips unusable landings", () => {
    for (const cookie of [KEY + "=old-without-time", KEY + "=", KEY + "=%broken"]) {
      expect(campaignCookieHeader(request("https://acme.com/?utm_source=new", { cookie }), GUARD, fixed, CONSENT)).toBeNull()
    }
    for (const url of ["https://acme.com/", "https://acme.com/?utm_source=%20", "https://acme.com/?utm_term=foo%20gclid%3DSECRET"]) {
      expect(campaignCookieHeader(request(url), GUARD, fixed, CONSENT)).toBeNull()
    }
    expect(campaignCookieHeader(request("https://acme.com/?utm_source=x", {}, "POST"), GUARD, fixed, CONSENT)).toBeNull()
    expect(campaignCookieHeader(request("http://acme.com/?utm_source=x"), GUARD, fixed, CONSENT)).toBeNull()
    const header = campaignCookieHeader(request("https://acme.com/?utm_source=paid&utm_term=%2Ffbclid%3DSECRET"), GUARD, fixed, CONSENT)!
    expect(JSON.parse(decodeURIComponent(header.split(";")[0]!.split("=")[1]!)).utm_term).toBe("")
  })

  it("follows the preview guard: production and unknown hosts set it, previews and loopback do not", () => {
    for (const [host, sets] of [
      ["acme.com", true],
      ["ACME.com.", true],
      ["staging.acme.com", true],
      ["acme-abc123.vercel.app", false],
      ["localhost", false],
      ["x.netlify.app", false]
    ] as const) {
      expect(campaignCookieHeader(request(`https://${host}/?utm_source=paid`), GUARD, fixed, CONSENT) !== null).toBe(sets)
    }
  })

  // P2-1: the cookie goes to the site's server (and its logs) on every request for 180 days, so it is
  // scrubbed like the tab copy, and it follows the consent mode (it cannot see a recorded grant).
  it("blanks an email or phone number in a UTM; a landing whose only campaign value was personal writes nothing", () => {
    const header = campaignCookieHeader(
      request("https://acme.com/?utm_source=newsletter&utm_term=jane.doe%40example.com&utm_content=%2B1%20555%20123%204567"),
      GUARD,
      fixed,
      CONSENT
    )!
    const record = JSON.parse(decodeURIComponent(header.split(";")[0]!.split("=")[1]!)) as Record<string, unknown>
    expect(record).toMatchObject({ utm_source: "newsletter", utm_term: "", utm_content: "" })
    expect(decodeURIComponent(header.split(";")[0]!)).not.toMatch(/jane|555/)
    expect(campaignCookieHeader(request("https://acme.com/?utm_source=jane.doe%40example.com"), GUARD, fixed, CONSENT)).toBeNull()
  })

  it("never writes under required consent mode, and skips Sec-GPC / DNT requests otherwise", () => {
    const url = "https://acme.com/?utm_source=paid"
    expect(campaignCookieHeader(request(url), GUARD, fixed, { consentMode: "required" })).toBeNull()
    expect(campaignCookieHeader(request(url, { "sec-gpc": "1" }), GUARD, fixed, CONSENT)).toBeNull()
    expect(campaignCookieHeader(request(url, { dnt: "1" }), GUARD, fixed, CONSENT)).toBeNull()
    // Negative: the same landing with no signal under not_required writes.
    expect(campaignCookieHeader(request(url), GUARD, fixed, CONSENT)).not.toBeNull()
  })

  it("3800 encoded bytes is an inclusive ceiling", () => {
    const seed = campaignCookieHeader(request("https://acme.com/?utm_source=paid"), GUARD, fixed, CONSENT)!
    const padding = 3800 - seed.split(";")[0]!.split("=")[1]!.length
    expect(campaignCookieHeader(request("https://acme.com/" + "a".repeat(padding) + "?utm_source=paid"), GUARD, fixed, CONSENT)).not.toBeNull()
    expect(campaignCookieHeader(request("https://acme.com/" + "a".repeat(padding + 1) + "?utm_source=paid"), GUARD, fixed, CONSENT)).toBeNull()
  })

  it("withCampaignCookie decorates the final response and changes nothing else", async () => {
    const req = request("https://acme.com/?utm_source=paid")
    const base = async () =>
      new Response("unchanged HTML", {
        status: 200,
        headers: { "content-type": "text/html", "cache-control": "private, no-store", "set-cookie": "existing=1; Path=/" }
      })
    const decorated = withCampaignCookie(base, { guard: GUARD, consent: CONSENT, isDocument: () => true, now: () => fixed })
    const before = await base()
    const after = await decorated(req)
    expect(after.status).toBe(before.status)
    expect(await after.text()).toBe("unchanged HTML")
    for (const [key, value] of before.headers) if (key !== "set-cookie") expect(after.headers.get(key)).toBe(value)
    expect(after.headers.getSetCookie().slice(0, -1)).toEqual(before.headers.getSetCookie())
    expect(after.headers.getSetCookie()).toHaveLength(before.headers.getSetCookie().length + 1)
    // Not a document, not HTML, or not 2xx: untouched.
    for (const response of [
      withCampaignCookie(base, { guard: GUARD, consent: CONSENT, isDocument: () => false }),
      withCampaignCookie(async () => new Response("{}", { headers: { "content-type": "application/json" } }), { guard: GUARD, consent: CONSENT, isDocument: () => true }),
      withCampaignCookie(async () => new Response("no", { status: 404, headers: { "content-type": "text/html" } }), { guard: GUARD, consent: CONSENT, isDocument: () => true })
    ]) {
      const result = await response(req)
      expect(result.headers.getSetCookie().filter((value) => value.startsWith(KEY))).toEqual([])
    }
  })
})

describe("the emitted server-cookie module", () => {
  const dir = mkdtempSync(join(tmpdir(), "instrument-campaign-cookie-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const fixed = Date.parse("2026-09-27T09:12:59.123Z")

  it("produces byte-identical headers to the TS twin, and has no backtick or ${", async () => {
    const source = campaignCookieModuleSource(GUARD, CONSENT)
    expect(source).not.toMatch(/`|\$\{/)
    const file = join(dir, "campaign-cookie.mjs")
    writeFileSync(file, source)
    const emitted = (await import(pathToFileURL(file).href)) as {
      infiniteCampaignCookieHeader(request: Request, now?: number): string | null
      withInfiniteCampaignCookie(handler: (request: Request) => Promise<Response>, options: { isDocument(): boolean; now?: () => number }): (request: Request) => Promise<Response>
    }
    for (const url of [
      "https://acme.com/audit/?utm_source=facebook&ad_id=123&utm_term=foo%20gclid%3DSECRET",
      "https://ACME.com./?utm_source=paid",
      "https://acme-abc123.vercel.app/?utm_source=paid",
      "https://acme.com/?fbclid=only",
      "http://acme.com/?utm_source=paid",
      "https://acme.com/?utm_source=newsletter&utm_term=jane.doe%40example.com",
      "https://acme.com/?utm_source=jane.doe%40example.com"
    ]) {
      for (const headers of [{ referer: "https://facebook.com/" }, { referer: "https://facebook.com/", "sec-gpc": "1" }]) {
        const req = new Request(url, { headers })
        expect(emitted.infiniteCampaignCookieHeader(req, fixed)).toBe(campaignCookieHeader(req, GUARD, fixed, CONSENT))
      }
    }
    const requiredFile = join(dir, "campaign-cookie-required.mjs")
    writeFileSync(requiredFile, campaignCookieModuleSource(GUARD, { consentMode: "required" }))
    const required = (await import(pathToFileURL(requiredFile).href)) as typeof emitted
    expect(required.infiniteCampaignCookieHeader(new Request("https://acme.com/?utm_source=paid"), fixed)).toBeNull()
    const wrapped = emitted.withInfiniteCampaignCookie(async () => new Response("x", { headers: { "content-type": "text/html" } }), {
      isDocument: () => true,
      now: () => fixed
    })
    const response = await wrapped(new Request("https://acme.com/?utm_source=paid"))
    expect(response.headers.getSetCookie()[0]).toMatch(new RegExp("^" + KEY + "="))
  })
})

describe("one definition of the patterns", () => {
  it("every serialized copy matches the shared constants", () => {
    const sources = [campaignMetadata, projectCampaignCookie, campaignWireMetadata, filterTabRecord].map((fn) => fn.toString())
    expect(sources[0]).toContain(META_AD_ID_PATTERN.source)
    expect(sources[0]).toContain(META_PLACEMENT_PATTERN.source)
    expect(sources[0]).toContain(HOST_LABEL_SOURCE)
    expect(sources[1]).toContain(CLICK_ID_CONTAMINATION_PATTERN.source)
    expect(sources[2]).toContain(META_AD_ID_PATTERN.source)
    expect(sources[3]).toContain(CLICK_ID_CONTAMINATION_PATTERN.source)
    for (const source of sources) expect(source).not.toMatch(/`|\$\{|<\//)
  })

  it("the landing script has no backtick, ${ or </", () => {
    expect(buildLandingAttributionScript({ ownHosts: ["acme.com"], gate: { kind: "infinite-consent", mode: "required" } })).not.toMatch(
      /`|\$\{|<\//
    )
  })
})
