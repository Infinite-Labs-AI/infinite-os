// The Meta snippet infinite-tag WRITES, executed — not grepped.
//
// infinite.fast once lost the backslashes of a regex inside an emitted string (inject-analytics
// L357-359) and only executing the emitted head caught it. So these tests take the bytes exactly as
// they land in a customer's repo — the static-html `<script>` block and the Next module's string
// literal — and run them in node:vm against stubbed browser globals: no network, no real Meta.
//
// Ported from infinite-site @ 9f65b47:
//   • `.github/scripts/test-inject-analytics.mjs` L88-135 (the census: one init, one capture, one
//     matching accessor, capture before init) and L468-496 (autoConfig against fbevents' own parser);
//   • `.github/scripts/test-inject-analytics.mjs` L498-566 and `test-get-started-page.mjs` L1946+
//     (Manual Advanced Matching: real WebCrypto, independent digests, consent at call time).
import { createHash, webcrypto } from "node:crypto"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { buildAnalyticsModuleSource } from "../../frameworks/managed-files.js"
import type { InstallPlan } from "../../types.js"
import { metaProviderAdapter, type MetaPixelSnippetOptions } from "../meta.js"

import { buildMetaClickIdCaptureScript } from "./click-id.js"

const PIXEL = "1234567890123456"

interface PageOptions {
  search?: string
  hostname?: string
  storedConsent?: "granted" | "denied"
  doNotTrack?: string
  globalPrivacyControl?: boolean
  subtle?: boolean
}

/** Run emitted bytes as a page would, recording cookie writes, inserted scripts and storage writes. */
function runPage(source: string, options: PageOptions = {}) {
  const cookies: string[] = []
  const cookieWrites: Array<{ value: string; fbqDefined: boolean }> = []
  const inserted: string[] = []
  const storage = new Map<string, string>()
  const storageWrites: string[] = []
  if (options.storedConsent) storage.set("infinite_analytics_consent", options.storedConsent)
  // In a browser `window` IS the global object: the bootstrap defines `fbq` on it and calls it bare.
  const window: Record<string, unknown> = {}
  const scriptTag = { parentNode: { insertBefore: (node: { src: string }) => inserted.push(node.src) } }
  const document = {
    get cookie() {
      return cookies.join("; ")
    },
    set cookie(value: string) {
      cookieWrites.push({ value, fbqDefined: typeof window.fbq === "function" })
      const pair = value.split(";")[0]!
      if (/;max-age=0/.test(value)) return
      cookies.splice(0, cookies.length, ...cookies.filter((entry) => !entry.startsWith("_fbc=")), pair)
    },
    createElement: () => ({ async: false, src: "" }),
    getElementsByTagName: () => [scriptTag]
  }
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageWrites.push(key)
      storage.set(key, value)
    }
  }
  const context = Object.assign(window, {
    addEventListener: () => undefined,
    document,
    location: { search: options.search ?? "", hostname: options.hostname ?? "www.acme.com", protocol: "https:" },
    navigator: { doNotTrack: options.doNotTrack, globalPrivacyControl: options.globalPrivacyControl },
    localStorage: storageApi,
    sessionStorage: storageApi,
    setTimeout: (callback: () => void) => callback(),
    crypto: options.subtle === false ? {} : { subtle: webcrypto.subtle },
    TextEncoder,
    Uint8Array,
    Promise,
    URLSearchParams,
    Date,
    String,
    Number
  })
  window.window = window
  window.globalThis = window
  runInNewContext(source, context)
  const fbq = window.fbq as ({ queue: unknown[][] } & ((...args: unknown[]) => void)) | undefined
  return {
    window,
    cookieWrites,
    inserted,
    storageWrites,
    revoke: () => storage.set("infinite_analytics_consent", "denied"),
    queue: () => JSON.parse(JSON.stringify(Array.from(fbq?.queue ?? [], (entry) => Array.from(entry)))) as unknown[][],
    match: (identity: unknown) =>
      (window.infiniteMetaAdvancedMatch as (value: unknown) => Promise<boolean>)(identity),
    clickId: () => (window.infiniteMetaClickId as () => string)()
  }
}

/** The static-html bytes: the plan's `<script>` block, unwrapped exactly as the browser would. */
function staticHtmlScript(artifact: Record<string, unknown>, consentMode?: "required" | "not_required"): string {
  const plan = metaProviderAdapter.plan(
    "static-html",
    { pixelId: PIXEL, ...artifact } as never,
    consentMode ? ({ artifacts: { infinite: { consentMode } } } as never) : undefined
  )
  const snippet = plan.instructions[0]!.snippet
  expect(snippet.startsWith("<script>\n") && snippet.endsWith("\n</script>")).toBe(true)
  return snippet.slice("<script>\n".length, -"\n</script>".length)
}

/** The Next bytes: `lib/infinite-analytics.ts` as written, its `bootstrapSource` literal decoded. */
function nextModuleScript(options: MetaPixelSnippetOptions = {}): string {
  const plan = metaProviderAdapter.plan("next-app-router", { pixelId: PIXEL, ...options } as never)
  const moduleSource = buildAnalyticsModuleSource({ instructions: plan.instructions } as InstallPlan)
  const literal = /const bootstrapSource = ("(?:[^"\\\n]|\\.)*")/.exec(moduleSource)?.[1]
  expect(literal).toBeDefined()
  return JSON.parse(literal!) as string
}

describe("the Meta snippet infinite-tag installs, executed", () => {
  it("captures the click id BEFORE the pixel exists, and opts out of autoConfig before init — in the static-html bytes and the Next bytes", () => {
    for (const source of [staticHtmlScript({}), nextModuleScript()]) {
      const page = runPage(source, { search: "?fbclid=IwAR0Landing_Click" })
      // Capture first: the cookie was written while fbq did not exist yet.
      expect(page.cookieWrites).toHaveLength(1)
      expect(page.cookieWrites[0]!.value).toMatch(/^_fbc=fb\.1\.[0-9]{13}\.IwAR0Landing_Click;domain=acme\.com;/)
      expect(page.cookieWrites[0]!.fbqDefined).toBe(false)
      expect(page.clickId()).toMatch(/^fb\.1\.[0-9]{13}\.IwAR0Landing_Click$/)
      expect(page.inserted).toEqual(["https://connect.facebook.net/en_US/fbevents.js"])
      const queue = page.queue()
      expect(queue).toEqual([["set", "autoConfig", "false", PIXEL], ["init", PIXEL], ["track", "PageView"]])
      // fbevents' own parser: only `true` / "true" opt IN; the string pixel id scopes it.
      const [, , value, target] = queue[0] as [string, string, unknown, unknown]
      expect(value === true || value === "true" ? "optIn" : "optOut").toBe("optOut")
      expect(target).toBe(PIXEL)
    }
  })

  it("the capture regexes survive the Next string literal (the backslash-loss incident)", () => {
    const source = nextModuleScript()
    expect(source).toContain("var FB_COOKIE = /^fb\\.[0-9]{1,2}\\.[0-9]{1,20}\\.[A-Za-z0-9_%.-]{1,512}$/;")
    // Executed: an fbclid with a dot still splits into Meta's four segments correctly.
    const page = runPage(source, { search: "?fbclid=a.b" })
    expect(page.clickId().split(".").slice(3).join(".")).toBe("a.b")
  })

  it("no fbclid: the snippet writes no cookie at all, and never _fbp", () => {
    const page = runPage(staticHtmlScript({}), { search: "?utm_source=newsletter" })
    expect(page.cookieWrites).toEqual([])
    expect(page.clickId()).toBe("")
    const landing = runPage(staticHtmlScript({}), { search: "?fbclid=X1" })
    expect(landing.cookieWrites.map((write) => write.value.split("=")[0])).toEqual(["_fbc"])
    expect(landing.storageWrites).toEqual([])
  })

  // Ported from infinite-site test-inject-analytics.mjs L460/L462 @ 9f65b47: "an explicit stored
  // denial writes no _fbc" and "a privacy signal with no decision defers the capture". The capture
  // follows the visitor's consent in EVERY mode — including the default not_required.
  it("consent_mode=not_required (the default): a recorded denial or a DNT/GPC signal writes no _fbc; a normal visitor and a grant do", () => {
    const cases: Array<[PageOptions, number]> = [
      [{ storedConsent: "denied" }, 0],
      [{ storedConsent: "denied", globalPrivacyControl: true }, 0],
      [{ globalPrivacyControl: true }, 0],
      [{ doNotTrack: "1" }, 0],
      [{}, 1],
      // An explicit grant on this site overrides the browser signal — the runtime's rule.
      [{ storedConsent: "granted", doNotTrack: "1" }, 1]
    ]
    for (const source of [staticHtmlScript({}), staticHtmlScript({}, "not_required"), nextModuleScript()]) {
      for (const [options, writes] of cases) {
        const page = runPage(source, { search: "?fbclid=X1", ...options })
        expect(page.cookieWrites, JSON.stringify(options)).toHaveLength(writes)
        if (writes === 0) expect(page.clickId()).toBe("")
        // The pixel itself is unchanged by this: it still boots.
        expect(page.inserted).toEqual(["https://connect.facebook.net/en_US/fbevents.js"])
      }
    }
    // Negative: the ungated capture this replaced writes Meta's ad-click cookie for the visitor who said no.
    const ungated = buildMetaClickIdCaptureScript()
    expect(runPage(ungated, { search: "?fbclid=X1", storedConsent: "denied" }).cookieWrites).toHaveLength(1)
    expect(runPage(ungated, { search: "?fbclid=X1", globalPrivacyControl: true }).cookieWrites).toHaveLength(1)
  })
})

describe("Manual Advanced Matching, executed (ported from infinite.fast)", () => {
  const RAW_EMAIL = "  Founder@Example.COM "
  // Meta's rule verbatim: trim, lowercase. Computed independently with node:crypto.
  const EXPECTED_EM = createHash("sha256").update("founder@example.com", "utf8").digest("hex")
  // external_id: trim ONLY. Case is kept, because the server leg hashes it that way.
  const ACCOUNT_ID = "  Acct_42-XYZ "
  const EXPECTED_EXTERNAL_ID = createHash("sha256").update("Acct_42-XYZ", "utf8").digest("hex")
  const LOWERCASED_EXTERNAL_ID = createHash("sha256").update("acct_42-xyz", "utf8").digest("hex")
  const AM = staticHtmlScript({ advancedMatching: true })

  const inits = (page: ReturnType<typeof runPage>) => page.queue().filter((call) => call[0] === "init")

  it("normalises then hashes exactly once, on the same pixel the bootstrap used, and keeps external_id's case", async () => {
    const page = runPage(AM)
    expect(await page.match({ email: RAW_EMAIL, externalId: ACCOUNT_ID })).toBe(true)
    expect(inits(page)).toEqual([["init", PIXEL], ["init", PIXEL, { em: EXPECTED_EM, external_id: EXPECTED_EXTERNAL_ID }]])
    // Negative: the "trimmed, lowercased" rule would have produced a different digest.
    expect(EXPECTED_EXTERNAL_ID).not.toBe(LOWERCASED_EXTERNAL_ID)
    expect(JSON.stringify(page.queue())).not.toContain(LOWERCASED_EXTERNAL_ID)
    const wire = JSON.stringify(page.queue())
    expect(wire).not.toMatch(/founder@example|Acct_42/i)
    expect(page.storageWrites).toEqual([])
  })

  it("never sends a phone number, whatever the caller passes", async () => {
    const page = runPage(AM)
    expect(await page.match({ email: RAW_EMAIL, phone: "+1 555 0100", ph: "15550100", externalId: ACCOUNT_ID })).toBe(true)
    const userData = inits(page)[1]![2] as Record<string, unknown>
    expect(Object.keys(userData).sort()).toEqual(["em", "external_id"])
    expect(await runPage(AM).match({ phone: "+1 555 0100", ph: "15550100" })).toBe(false)
  })

  it("refuses pre-hashed input; partial identity is fine; nothing honest means no call", async () => {
    const prehashed = runPage(AM)
    expect(await prehashed.match({ email: EXPECTED_EM, externalId: EXPECTED_EXTERNAL_ID })).toBe(false)
    expect(inits(prehashed)).toHaveLength(1)
    const emailOnly = runPage(AM)
    expect(await emailOnly.match({ email: RAW_EMAIL })).toBe(true)
    expect(inits(emailOnly)[1]).toEqual(["init", PIXEL, { em: EXPECTED_EM }])
    const nothing = runPage(AM)
    expect(await nothing.match({})).toBe(false)
    expect(await nothing.match({ email: "not-an-email", externalId: "" })).toBe(false)
    expect(await nothing.match(undefined)).toBe(false)
    expect(inits(nothing)).toHaveLength(1)
  })

  it("consent governs it at CALL time: a stored denial, DNT/GPC without a grant, and a revocation all attach nothing", async () => {
    const denied = runPage(AM, { storedConsent: "denied" })
    expect(await denied.match({ email: RAW_EMAIL })).toBe(false)
    expect(inits(denied)).toHaveLength(1)
    expect(await runPage(AM, { doNotTrack: "1" }).match({ email: RAW_EMAIL })).toBe(false)
    expect(await runPage(AM, { globalPrivacyControl: true }).match({ email: RAW_EMAIL })).toBe(false)
    // An explicit grant on this site overrides the privacy signal — the runtime's rule.
    expect(await runPage(AM, { doNotTrack: "1", storedConsent: "granted" }).match({ email: RAW_EMAIL })).toBe(true)
    const revoked = runPage(AM, { storedConsent: "granted" })
    expect(await revoked.match({ email: RAW_EMAIL })).toBe(true)
    revoked.revoke()
    expect(await revoked.match({ email: RAW_EMAIL })).toBe(false)
    // Negative: without the call-time check a denied visitor's identity would have been attached.
    const unchecked = AM.replace("if (!infiniteConsentAllows()) return false;", "")
    expect(unchecked).not.toBe(AM)
    expect(await runPage(unchecked, { storedConsent: "denied" }).match({ email: RAW_EMAIL })).toBe(true)
  })

  it("always resolves: no crypto.subtle (an insecure origin) or no fbq means false, never a throw or a partial digest", async () => {
    const insecure = runPage(AM, { subtle: false })
    expect(await insecure.match({ email: RAW_EMAIL, externalId: ACCOUNT_ID })).toBe(false)
    expect(inits(insecure)).toHaveLength(1)
    // The accessor alone, with no Meta bootstrap on the page (blocked, or not loaded yet).
    const accessorOnly = AM.slice(AM.lastIndexOf("\n(function () {\n  if (typeof window.infiniteMetaAdvancedMatch"))
    expect(await runPage(accessorOnly).match({ email: RAW_EMAIL })).toBe(false)
  })
})
