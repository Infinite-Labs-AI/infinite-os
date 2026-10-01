// LAST CLICK WINS for Meta's click id — ported from infinite.fast.
//
// Source: infinite-site `.github/scripts/test-meta-click-id.mjs` and
// `.github/scripts/fixtures/browser-cookie-jar.mjs` @ 9f65b47. Every case there is here, adapted:
//   • the consent gate is infinite-tag's optional hook (`./consent.ts`), not `__infiniteConsentGate`;
//   • the subdomain index at the host-only fallback names the host actually written (localhost = 0,
//     127.0.0.1 = 3) instead of infinite.fast's hard-coded 1;
//   • under a consent hook the accessor answers "" while the hook says no.
// Plus the customer-site cases infinite.fast never needed: www and multi-part public suffixes, a
// narrower-domain shadow on `www`, oversized click ids, and the never-`_fbp` / never-at-rest rules.
//
// These tests RUN the shipped script in node:vm against a cookie store that behaves like a browser,
// because the original bug only exists in the interaction between two cookies of the same name. A
// grep would have passed the broken version. Each rule also has a NEGATIVE case: the same assertion
// run against a deliberately broken copy of the script must fail, so a test that cannot fail is
// caught here rather than in production.
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { buildMetaClickIdCaptureScript, META_CLICK_ID_ACCESSOR } from "./click-id.js"
import type { MetaBrowserGate } from "./consent.js"

// ── The cookie jar (port of fixtures/browser-cookie-jar.mjs) ─────────────────────────────────────
//
// Faithful to the parts of RFC 6265bis that decide WHICH `_fbc` a page reads:
//   1. A HOST-ONLY cookie (no Domain attribute) and a DOMAIN cookie are two DIFFERENT cookies, even
//      on the apex host. A Domain cookie on `www.acme.com` and one on `acme.com` are different too.
//   2. Overwriting a cookie keeps its ORIGINAL creation time (RFC 6265 §5.3 step 11.3).
//   3. `document.cookie` lists longer paths first and, within a path, OLDEST FIRST.
// It rejects a Domain attribute naming a public suffix or a domain the page is not on, as browsers
// do. Every cookie here is path=/.
// The preview platforms' suffixes (vercel.app, netlify.app, pages.dev, github.io) are on the real
// Public Suffix List, so a browser refuses a Domain cookie on them exactly as it refuses co.uk.
const PUBLIC_SUFFIXES = new Set([
  "app",
  "vercel.app",
  "netlify.app",
  "dev",
  "pages.dev",
  "io",
  "github.io",
  "fast",
  "com",
  "co.uk",
  "uk"
])

const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

interface StoredCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  created: number
}

interface CookieJar {
  hostname: string
  writes: string[]
  read(): string
  write(written: string): void
  entries(name?: string): Array<{ domain: string; value: string }>
  attach(target: object): void
}

function createCookieJar({ hostname = "infinite.fast", initial = [] as string[] } = {}): CookieJar {
  const store: StoredCookie[] = []
  let created = 0
  const host = () => String(jar.hostname).toLowerCase()

  function write(written: string): void {
    const [pair = "", ...attributes] = String(written).split(";")
    const separator = pair.indexOf("=")
    if (separator === -1) return
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1)
    let domain: string | null = null
    let path = "/"
    let maxAge: number | null = null
    for (const attribute of attributes) {
      const at = attribute.indexOf("=")
      const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
      const raw = at === -1 ? "" : attribute.slice(at + 1).trim()
      if (key === "domain") domain = raw.replace(/^\./, "").toLowerCase()
      if (key === "path") path = raw || "/"
      if (key === "max-age") maxAge = Number(raw)
    }
    let hostOnly = true
    if (domain !== null) {
      if (PUBLIC_SUFFIXES.has(domain) && domain !== host()) return
      if (!domainMatches(host(), domain)) return
      hostOnly = domain === host() && PUBLIC_SUFFIXES.has(domain)
    } else {
      domain = host()
    }
    const index = store.findIndex(
      (cookie) =>
        cookie.name === name && cookie.domain === domain && cookie.hostOnly === hostOnly && cookie.path === path
    )
    if (maxAge !== null && maxAge <= 0) {
      if (index !== -1) store.splice(index, 1)
      return
    }
    if (index !== -1) {
      store[index]!.value = value // rule 2: the creation time survives an overwrite
      return
    }
    store.push({ name, value, domain, hostOnly, path, created: created++ })
  }

  const visible = () =>
    store
      .filter((cookie) => (cookie.hostOnly ? cookie.domain === host() : domainMatches(host(), cookie.domain)))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created) // rule 3

  const jar: CookieJar = {
    hostname,
    writes: [],
    read: () => visible().map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    write: (written) => {
      jar.writes.push(String(written))
      write(written)
    },
    entries: (name) =>
      visible()
        .filter((cookie) => name === undefined || cookie.name === name)
        .map((cookie) => ({ domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`, value: cookie.value })),
    attach: (target) =>
      Object.defineProperty(target, "cookie", { get: jar.read, set: jar.write, configurable: true })
  }
  for (const cookie of initial) write(cookie)
  return jar
}

// ── One page load ────────────────────────────────────────────────────────────────────────────────

const FIRST = "TEST_NOT_REAL_FIRST"
const SECOND = "TEST_NOT_REAL_SECOND"
const THIRD = "IwAR0Third_click.Id-99"
const segments = (value: string) => String(value).split(".")
const clickIdOf = (value: string) => segments(value).slice(3).join(".")
const clickMsOf = (value: string) => Number(segments(value)[2])

const SHIPPED = buildMetaClickIdCaptureScript()
const REQUIRED_GATE: MetaBrowserGate = { kind: "infinite-consent", mode: "required" }

interface LoadOptions {
  search?: string
  protocol?: string
  cookiesBlocked?: boolean
  gate?: MetaBrowserGate
  /** The Infinite runtime's persisted decision, as it would sit in localStorage. */
  storedConsent?: "granted" | "denied"
  doNotTrack?: string
  script?: string
}

/**
 * One page load in a browser whose cookies live in `jar`. Everything else a page has is deliberately
 * absent, so a new dependency of the script fails here. Storage is recorded so the never-at-rest
 * rule can be asserted.
 */
function loadPage(jar: CookieJar, options: LoadOptions = {}) {
  const { search = "", protocol = "https:", cookiesBlocked = false } = options
  const script = options.script ?? buildMetaClickIdCaptureScript(options.gate ? { gate: options.gate } : {})
  const storage = new Map<string, string>()
  if (options.storedConsent) storage.set("infinite_analytics_consent", options.storedConsent)
  const storageWrites: string[] = []
  const document = {}
  if (cookiesBlocked) {
    Object.defineProperty(document, "cookie", {
      get: () => {
        throw new Error("SecurityError: cookies are blocked")
      },
      set: () => {
        throw new Error("SecurityError: cookies are blocked")
      }
    })
  } else {
    jar.attach(document)
  }
  const listeners = new Map<string, Array<() => void>>()
  const timers: Array<() => void> = []
  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }
  }
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageWrites.push(`${key}=${value}`)
      storage.set(key, value)
    }
  }
  const context: Record<string, unknown> = {
    window,
    document,
    location: { search, hostname: jar.hostname, protocol },
    navigator: { doNotTrack: options.doNotTrack },
    localStorage: storageApi,
    sessionStorage: storageApi,
    setTimeout: (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    URLSearchParams,
    Date,
    String,
    Number
  }
  context.globalThis = context
  runInNewContext(script, context)
  const flush = () => {
    while (timers.length > 0) timers.shift()!()
  }
  return {
    window,
    storageWrites,
    fbc: () => (window[META_CLICK_ID_ACCESSOR] as () => string)(),
    /** The site's consent UI grants, and the runtime persists it (as it does after a real gesture). */
    grant: () => {
      storage.set("infinite_analytics_consent", "granted")
      for (const listener of listeners.get("infinite:analytics-consent-change") ?? []) listener()
      flush()
    },
    /** A consent event the runtime did NOT accept (no gesture): nothing is persisted. */
    unpersistedGrant: () => {
      for (const listener of listeners.get("infinite:analytics-consent-change") ?? []) listener()
      flush()
    },
    revoke: () => storage.set("infinite_analytics_consent", "denied")
  }
}

/**
 * A MODEL of what Meta's fbevents.js did to `_fbc` in infinite.fast's live capture (2026-09-29) and
 * nothing more: on a landing with an fbclid it reads the FIRST `_fbc`; if that already carries this
 * click it re-saves it under its own Domain cookie, otherwise it writes a new value for this click.
 */
function metaPixelLanding(jar: CookieJar, fbclid: string, now: number, domain = "infinite.fast"): string {
  const first = jar.read().split("; ").find((part) => part.startsWith("_fbc="))?.slice(5) ?? ""
  const index = domain.split(".").length - 1
  const fbc = first && clickIdOf(first) === fbclid ? first : `fb.${index}.${now}.${fbclid}`
  jar.write(`_fbc=${fbc};domain=${domain};path=/;max-age=7776000;samesite=Lax;secure`)
  return fbc
}

/** A deliberately broken copy of the shipped script, for the negative cases. */
function broken(find: string, replace: string): string {
  expect(SHIPPED).toContain(find)
  return SHIPPED.replace(find, replace)
}

// ── The assertions, as functions, so each can be pointed at a broken script ────────────────────

function assertSecondClickWins(script: string): void {
  const jar = createCookieJar({ hostname: "infinite.fast" })
  loadPage(jar, { search: `?fbclid=${FIRST}&utm_source=facebook`, script })
  metaPixelLanding(jar, FIRST, Date.now())
  const second = loadPage(jar, { search: `?fbclid=${SECOND}&utm_source=facebook`, script })
  const beacon2 = metaPixelLanding(jar, SECOND, Date.now() + 1)
  expect(clickIdOf(beacon2)).toBe(SECOND)
  expect(clickIdOf(second.fbc())).toBe(SECOND)
  expect(second.fbc()).toBe(beacon2)
  expect(jar.entries("_fbc")).toEqual([{ domain: ".infinite.fast", value: beacon2 }])
  expect(loadPage(jar, { search: "", script }).fbc()).toBe(beacon2)
}

function assertIndexForHost(script: string, hostname: string, cookieDomain: string, index: string): void {
  const jar = createCookieJar({ hostname })
  const page = loadPage(jar, { search: "?fbclid=AbC123xyz", script })
  expect(page.fbc()).toMatch(new RegExp(`^fb\\.${index}\\.[0-9]{13}\\.AbC123xyz$`))
  expect(jar.entries("_fbc")).toEqual([{ domain: cookieDomain, value: page.fbc() }])
}

function assertNoClickNoWrite(script: string): void {
  const jar = createCookieJar({
    hostname: "infinite.fast",
    initial: [
      `_fbc=fb.1.1790645529960.${FIRST};path=/;max-age=7776000;samesite=Lax;secure`,
      `_fbc=fb.1.1790645538268.${SECOND};domain=infinite.fast;path=/;max-age=7776000;samesite=Lax;secure`
    ]
  })
  const page = loadPage(jar, { search: "?utm_source=newsletter", script })
  expect(page.fbc()).toBe(`fb.1.1790645538268.${SECOND}`)
  expect(jar.writes).toEqual([])
}

describe("Meta _fbc landing capture (ported from infinite.fast)", () => {
  it("THE CAPTURED SEQUENCE: two landings with different fbclids leave ONE cookie holding the SECOND click (06b2ce8)", () => {
    assertSecondClickWins(SHIPPED)
    // Negative: the pre-06b2ce8 capture — a HOST-ONLY write beside Meta's Domain cookie, never
    // retired — leaves two cookies, and the same assertion fails.
    // Every broken copy is built OUTSIDE the toThrow closure: `broken()` asserts its search string is
    // present, and a drifted search string throwing inside the closure would pass vacuously.
    const hostOnlyNeverRetired = broken("var domains = cookieDomains();", "var domains = [];").replace(
      "if (storedFbcs(false).length) {",
      "if (false) {"
    )
    expect(hostOnlyNeverRetired).not.toBe(SHIPPED)
    expect(() => assertSecondClickWins(hostOnlyNeverRetired)).toThrow()
    // Negative: a first-listed reader returns the OLDER click while a duplicate exists.
    const firstListed = broken(
      "if (!newest || Number(values[index].split(\".\")[2]) > Number(newest.split(\".\")[2])) newest = values[index];",
      "if (!newest) newest = values[index];"
    )
    expect(() => assertNoClickNoWrite(firstListed)).toThrow()
  })

  it("a returning visitor with the legacy host-only duplicate: the newest click is read, nothing is tidied, the next click heals it", () => {
    assertNoClickNoWrite(SHIPPED)
    const jar = createCookieJar({
      hostname: "infinite.fast",
      initial: [
        `_fbc=fb.1.1790645529960.${FIRST};path=/;max-age=7776000;samesite=Lax;secure`,
        `_fbc=fb.1.1790645538268.${SECOND};domain=infinite.fast;path=/;max-age=7776000;samesite=Lax;secure`
      ]
    })
    expect(jar.read()).toBe(`_fbc=fb.1.1790645529960.${FIRST}; _fbc=fb.1.1790645538268.${SECOND}`)
    const before = Date.now()
    const click = loadPage(jar, { search: `?fbclid=${THIRD}` })
    const written = click.fbc()
    expect(clickIdOf(written)).toBe(THIRD)
    expect(segments(written)[1]).toBe("1")
    expect(clickMsOf(written) >= before && clickMsOf(written) <= Date.now()).toBe(true)
    expect(jar.entries("_fbc")).toEqual([{ domain: ".infinite.fast", value: written }])
    expect(jar.writes).toEqual([
      "_fbc=;path=/;max-age=0;samesite=Lax;secure",
      `_fbc=${written};domain=infinite.fast;path=/;max-age=7776000;samesite=Lax;secure`
    ])
    // Negative: a capture that "tidies" on every page load writes with no fbclid on the URL.
    const tidiesEveryLoad = broken("if (!fbclid) return;\n", 'if (!fbclid) { document.cookie = "_fbc=;path=/;max-age=0"; return; }\n')
    expect(() => assertNoClickNoWrite(tidiesEveryLoad)).toThrow()
  })

  it("a reload of the landing URL is the same click: nothing is rewritten and Meta's own cookie is left alone", () => {
    const jar = createCookieJar({ hostname: "infinite.fast" })
    const landing = loadPage(jar, { search: `?fbclid=${FIRST}` })
    const original = landing.fbc()
    const writes = jar.writes.length
    const reload = loadPage(jar, { search: `?fbclid=${FIRST}` })
    expect(reload.fbc()).toBe(original)
    expect(jar.writes.length).toBe(writes)
    const metaJar = createCookieJar({
      hostname: "infinite.fast",
      initial: [`_fbc=fb.1.1700000000000.${FIRST};domain=infinite.fast;path=/`]
    })
    const repeat = loadPage(metaJar, { search: `?fbclid=${FIRST}` })
    expect(metaJar.writes).toEqual([])
    expect(repeat.fbc()).toBe(`fb.1.1700000000000.${FIRST}`)
  })

  it("a new click replaces Meta's own cookie for an older click", () => {
    const jar = createCookieJar({
      hostname: "infinite.fast",
      initial: [`_fbc=fb.1.1700000000000.${FIRST};domain=infinite.fast;path=/`]
    })
    const page = loadPage(jar, { search: `?fbclid=${SECOND}` })
    expect(clickIdOf(page.fbc())).toBe(SECOND)
    expect(jar.entries("_fbc")).toEqual([{ domain: ".infinite.fast", value: page.fbc() }])
    expect(jar.writes.length).toBe(2)
  })

  it("a malformed stored _fbc cannot describe any click, so a new fbclid replaces it", () => {
    const jar = createCookieJar({ hostname: "infinite.fast", initial: ["_fbc=fb.1.notms.IwAR0bad;path=/"] })
    const page = loadPage(jar, { search: "?fbclid=IwAR0recoverable" })
    expect(page.fbc()).toMatch(/^fb\.1\.[0-9]{13}\.IwAR0recoverable$/)
    expect(jar.entries("_fbc").map((cookie) => cookie.value)).toEqual([page.fbc()])
  })

  it("first ever landing: ONE write, straight into Meta's scope", () => {
    const jar = createCookieJar({ hostname: "infinite.fast" })
    const page = loadPage(jar, { search: `?fbclid=${FIRST}` })
    expect(jar.writes).toHaveLength(1)
    expect(jar.writes[0]).toMatch(
      new RegExp(`^_fbc=fb\\.1\\.[0-9]{13}\\.${FIRST};domain=infinite\\.fast;path=/;max-age=7776000;samesite=Lax;secure$`)
    )
    expect(jar.entries("_fbc")).toEqual([{ domain: ".infinite.fast", value: page.fbc() }])
  })

  it("the subdomain index names the domain the cookie is DEFINED on: apex, www, a multi-part public suffix, a preview host", () => {
    assertIndexForHost(SHIPPED, "acme.com", ".acme.com", "1")
    assertIndexForHost(SHIPPED, "www.acme.com", ".acme.com", "1")
    assertIndexForHost(SHIPPED, "www.infinite.fast", ".infinite.fast", "1")
    // co.uk is a public suffix: the browser refuses it, so the cookie lands on acme.co.uk — index 2.
    assertIndexForHost(SHIPPED, "shop.acme.co.uk", ".acme.co.uk", "2")
    assertIndexForHost(SHIPPED, "acme.co.uk", ".acme.co.uk", "2")
    // vercel.app is a public suffix too: the deployment's own host, index 2.
    assertIndexForHost(SHIPPED, "acme-abc.vercel.app", ".acme-abc.vercel.app", "2")
    // Negative: infinite.fast's hard-coded index is wrong on a co.uk customer.
    const hardCodedIndex = broken("var value = format(domainIndex(domains[index]), fbclid);", "var value = format(1, fbclid);")
    expect(() => assertIndexForHost(hardCodedIndex, "shop.acme.co.uk", ".acme.co.uk", "2")).toThrow()
  })

  it("localhost and bare IPs cannot carry a Domain cookie: host-only, indexed by the host written, no Secure over http", () => {
    for (const [hostname, index] of [
      ["localhost", "0"],
      ["127.0.0.1", "3"]
    ] as const) {
      const jar = createCookieJar({ hostname })
      const page = loadPage(jar, { search: "?fbclid=Local1", protocol: "http:" })
      expect(page.fbc()).toMatch(new RegExp(`^fb\\.${index}\\.[0-9]{13}\\.Local1$`))
      expect(jar.entries("_fbc")).toEqual([{ domain: hostname, value: page.fbc() }])
      expect(jar.writes.join("\n")).not.toMatch(/secure/)
    }
    // Negative: infinite.fast's fallback (`format(1, …)`) mislabels the localhost cookie.
    const bad = broken("format(domainIndex(hostName()), fbclid)", "format(1, fbclid)")
    const jar = createCookieJar({ hostname: "localhost" })
    const page = loadPage(jar, { search: "?fbclid=Local1", protocol: "http:", script: bad })
    expect(page.fbc()).not.toMatch(/^fb\.0\./)
  })

  it("retires an older copy on a NARROWER domain (www.acme.com beside acme.com) so it cannot shadow the new click", () => {
    // A customer's own hand-written or tag-manager writer left `_fbc` on www.acme.com (and a
    // host-only copy). Both are older, so both are listed first, and fbevents would re-save FIRST.
    const jar = createCookieJar({
      hostname: "www.acme.com",
      initial: [
        `_fbc=fb.1.1700000000000.${FIRST};path=/`,
        `_fbc=fb.2.1700000000001.${FIRST};domain=www.acme.com;path=/`
      ]
    })
    const page = loadPage(jar, { search: `?fbclid=${SECOND}` })
    expect(clickIdOf(page.fbc())).toBe(SECOND)
    expect(jar.entries("_fbc")).toEqual([{ domain: ".acme.com", value: page.fbc() }])
    expect(jar.read().split("; ")[0]).toBe(`_fbc=${page.fbc()}`)
    // Negative: without the narrower-domain retire, the stale www copy is still listed FIRST.
    const shadowed = createCookieJar({
      hostname: "www.acme.com",
      initial: [`_fbc=fb.2.1700000000001.${FIRST};domain=www.acme.com;path=/`]
    })
    loadPage(shadowed, {
      search: `?fbclid=${SECOND}`,
      script: broken("if (storedFbcs(false).length > 1) {", "if (false) {")
    })
    expect(clickIdOf(shadowed.read().split("; ")[0]!.slice(5))).toBe(FIRST)
    // And on an apex with nothing to shadow, the retire never fires: one write, as on infinite.fast.
    const clean = createCookieJar({ hostname: "www.acme.com" })
    loadPage(clean, { search: `?fbclid=${SECOND}` })
    expect(clean.writes).toHaveLength(1)
  })

  it("the fbclid is carried byte for byte: case-sensitive, no trim, no extra decoding", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: "?fbclid=IwAR0MiXeD_Case.%2541-x" })
    // URLSearchParams decodes once (%25 -> %), which is the decoding Meta expects; nothing further.
    expect(clickIdOf(page.fbc())).toBe("IwAR0MiXeD_Case.%41-x")
  })

  it("malformed and oversized click ids are never written and never returned", () => {
    for (const fbclid of [encodeURIComponent("has spaces;and=semicolons"), "x".repeat(401), "<script>"]) {
      const jar = createCookieJar({ hostname: "acme.com" })
      const page = loadPage(jar, { search: `?fbclid=${fbclid}` })
      expect(page.fbc()).toBe("")
      expect(jar.writes).toEqual([])
    }
    // The bound is inclusive: 400 characters is a valid payload segment.
    const longest = createCookieJar({ hostname: "acme.com" })
    expect(clickIdOf(loadPage(longest, { search: `?fbclid=${"x".repeat(400)}` }).fbc())).toBe("x".repeat(400))
    // Negative: without the shape check an oversized id is written.
    const unbounded = createCookieJar({ hostname: "acme.com" })
    loadPage(unbounded, {
      search: `?fbclid=${"x".repeat(401)}`,
      script: broken('return FBCLID.test(value) ? value : "";', "return value;")
    })
    expect(unbounded.writes).not.toEqual([])
  })

  it("never writes _fbp and never puts the fbclid anywhere but _fbc", () => {
    const scenarios: LoadOptions[] = [
      { search: `?fbclid=${FIRST}` },
      { search: `?fbclid=${SECOND}&utm_source=facebook` },
      { search: "" },
      { search: `?fbclid=${FIRST}`, gate: REQUIRED_GATE, storedConsent: "granted" }
    ]
    for (const options of scenarios) {
      const jar = createCookieJar({ hostname: "www.acme.com", initial: [`_fbc=fb.1.1700000000000.${THIRD};path=/`] })
      const page = loadPage(jar, options)
      expect(jar.writes.every((write) => write.startsWith("_fbc="))).toBe(true)
      expect(jar.writes.join("\n")).not.toContain("_fbp")
      expect(jar.entries().map((cookie) => cookie.value).join("|")).not.toContain("_fbp")
      expect(page.storageWrites).toEqual([])
    }
    expect(SHIPPED).not.toMatch(/_fbp|setItem|sessionStorage/)
  })

  it("the accessor is a pure read: it never writes, and returns the URL click in Meta's format when it could not be stored", () => {
    const jar = createCookieJar({ hostname: "infinite.fast", initial: [`_fbc=fb.1.1700000000000.${FIRST};path=/`] })
    // Blocked cookies: nothing throws, and the click is still available on its landing page. Index 1
    // here is Meta's documented value for an fbc that is not saved as a cookie.
    const blocked = loadPage(createCookieJar(), { search: `?fbclid=${FIRST}`, cookiesBlocked: true })
    expect(blocked.fbc()).toMatch(new RegExp(`^fb\\.1\\.[0-9]{13}\\.${FIRST}$`))
    const noClick = loadPage(createCookieJar({ hostname: "infinite.fast" }), { search: "?utm_source=x" })
    expect(noClick.fbc()).toBe("")
    const writesBefore = jar.writes.length
    const reader = loadPage(jar, { search: "" })
    reader.fbc()
    reader.fbc()
    expect(jar.writes.length).toBe(writesBefore)
  })

  it("is NOT host-guarded: preview hosts still capture (decision 15 — it writes a cookie and sends nothing)", () => {
    // A preview platform's suffix is public, so the cookie lands on the deployment's own host.
    for (const [hostname, domain, index] of [
      ["acme-git-feature.vercel.app", ".acme-git-feature.vercel.app", "2"],
      ["deploy-preview-3--acme.netlify.app", ".deploy-preview-3--acme.netlify.app", "2"],
      ["feature.acme.pages.dev", ".acme.pages.dev", "2"],
      ["acme.github.io", ".acme.github.io", "2"],
      ["staging.acme.com", ".acme.com", "1"]
    ] as const) {
      const jar = createCookieJar({ hostname })
      const page = loadPage(jar, { search: "?fbclid=Preview1" })
      expect(page.fbc()).toMatch(new RegExp(`^fb\\.${index}\\.[0-9]{13}\\.Preview1$`))
      expect(jar.entries("_fbc")).toEqual([{ domain, value: page.fbc() }])
    }
  })

  it("runs once per page even if the snippet is emitted twice", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: `?fbclid=${FIRST}`, script: `${SHIPPED}\n${SHIPPED}` })
    expect(jar.writes).toHaveLength(1)
    expect(clickIdOf(page.fbc())).toBe(FIRST)
  })
})

describe("Meta _fbc capture under the optional consent hook (consent_mode=required)", () => {
  it("withheld: no write and an empty accessor; a grant the runtime persisted captures while the URL still has the click", () => {
    const jar = createCookieJar({ hostname: "infinite.fast", initial: [`_fbc=fb.1.1700000000000.${FIRST};path=/`] })
    const page = loadPage(jar, { search: `?fbclid=${SECOND}`, gate: REQUIRED_GATE })
    expect(jar.writes).toEqual([])
    expect(page.fbc()).toBe("")
    page.grant()
    expect(clickIdOf(page.fbc())).toBe(SECOND)
    expect(jar.entries("_fbc").map((cookie) => clickIdOf(cookie.value))).toEqual([SECOND])
  })

  it("a consent event the runtime did not persist (no gesture) opens nothing", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: `?fbclid=${FIRST}`, gate: REQUIRED_GATE })
    page.unpersistedGrant()
    expect(jar.writes).toEqual([])
    // Negative: a hook that trusts the bare event would have written.
    const naive = createCookieJar({ hostname: "acme.com" })
    const naivePage = loadPage(naive, {
      search: `?fbclid=${FIRST}`,
      gate: REQUIRED_GATE,
      script: buildMetaClickIdCaptureScript({ gate: REQUIRED_GATE }).replace(
        "if (started || !infiniteConsentAllows()) return;",
        "if (started) return;"
      )
    })
    naivePage.unpersistedGrant()
    expect(naive.writes).not.toEqual([])
  })

  it("a stored denial writes nothing, even with DNT off", () => {
    const denied = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(denied, { search: `?fbclid=${FIRST}`, gate: REQUIRED_GATE, storedConsent: "denied" })
    expect(denied.writes).toEqual([])
    expect(page.fbc()).toBe("")
  })

  it("a stored grant captures at once, overriding DNT — the runtime's rule, in the runtime's order", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    loadPage(jar, { search: `?fbclid=${FIRST}`, gate: REQUIRED_GATE, storedConsent: "granted", doNotTrack: "1" })
    expect(jar.entries("_fbc")).toHaveLength(1)
  })

  it("the accessor re-checks on every call: a revocation empties it", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: `?fbclid=${FIRST}`, gate: REQUIRED_GATE, storedConsent: "granted" })
    expect(clickIdOf(page.fbc())).toBe(FIRST)
    page.revoke()
    expect(page.fbc()).toBe("")
  })

  it("the builder's hook-less default ignores consent — which is why infinite-tag never emits it (see meta.ts)", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    loadPage(jar, { search: `?fbclid=${FIRST}`, doNotTrack: "1" })
    expect(jar.entries("_fbc")).toHaveLength(1)
  })
})

// Ported from infinite-site test-inject-analytics.mjs L458-466 @ 9f65b47 (the consent block of the
// `_fbc` capture). infinite.fast's gate starts a normal visitor at once, never starts after a stored
// denial, and defers a DNT/GPC visitor until a live grant. infinite-tag emits its capture under the
// not_required hook by default, which applies the same rule through the runtime's recorded decision.
describe("Meta _fbc capture under the optional consent hook (consent_mode=not_required, the default)", () => {
  const NOT_REQUIRED_GATE: MetaBrowserGate = { kind: "infinite-consent", mode: "not_required" }

  it("a normal visitor is captured at once", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: `?fbclid=${FIRST}`, gate: NOT_REQUIRED_GATE })
    expect(jar.entries("_fbc").map((cookie) => clickIdOf(cookie.value))).toEqual([FIRST])
    expect(clickIdOf(page.fbc())).toBe(FIRST)
  })

  it("an explicit stored denial writes no _fbc", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: "?fbclid=IwAR0denied", gate: NOT_REQUIRED_GATE, storedConsent: "denied" })
    expect(jar.writes).toEqual([])
    expect(page.fbc()).toBe("")
    // Negative: the ungated capture writes for the same visitor.
    const ungated = createCookieJar({ hostname: "acme.com" })
    loadPage(ungated, { search: "?fbclid=IwAR0denied", storedConsent: "denied" })
    expect(ungated.writes).not.toEqual([])
  })

  it("a privacy signal with no decision defers the capture; a live grant captures right then, while the fbclid is still on the URL", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: "?fbclid=IwAR0deferred", gate: NOT_REQUIRED_GATE, doNotTrack: "1" })
    expect(jar.writes).toEqual([])
    expect(page.fbc()).toBe("")
    page.grant()
    expect(page.fbc()).toMatch(/^fb\.1\.[0-9]{13}\.IwAR0deferred$/)
    expect(jar.entries("_fbc")).toEqual([{ domain: ".acme.com", value: page.fbc() }])
  })

  it("a stored grant overrides the privacy signal, and a later revocation empties the accessor", () => {
    const jar = createCookieJar({ hostname: "acme.com" })
    const page = loadPage(jar, { search: `?fbclid=${FIRST}`, gate: NOT_REQUIRED_GATE, storedConsent: "granted", doNotTrack: "1" })
    expect(jar.entries("_fbc")).toHaveLength(1)
    page.revoke()
    expect(page.fbc()).toBe("")
  })
})
