// Decision 4 (improve existing tags in place), executed — the edited pages are RUN in node:vm with
// stubbed browser globals, never grepped. Negatives run the original page and show the difference.
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it } from "vitest"

import { ADOPTED_META_HTML, ADOPTED_POSTHOG_HTML, cleanupSites, exists, fakeKeys, IDS, makeSite, notConnectedKeys, read } from "../../test/wizard/o7-fakes.js"
import { detectProvidersWithEvidence } from "../harness/inspect.js"
import { checkMetaAutoConfigOptOut } from "../providers/meta-browser/autoconfig.js"
import { reverseTextEdits } from "../server-lane/text-edits.js"

import { applyImproveEdit, CAPTURE_BLOCK_MARKER, detectAdoptedFacts, expressionInitOf, expressionOptOutLines, improveLinesFor, withSensitivePaths } from "./improve.js"

afterEach(cleanupSites)

/** Runs every inline <script> of a page in order, as a browser would, recording cookies and the fbq queue. */
function runPage(html: string, options: { search?: string; hostname?: string } = {}) {
  const cookies: string[] = []
  const cookieWrites: Array<{ value: string; fbqDefined: boolean }> = []
  const window: Record<string, unknown> = {}
  const storage = new Map<string, string>()
  const document = {
    get cookie() {
      return cookies.join("; ")
    },
    set cookie(value: string) {
      cookieWrites.push({ value, fbqDefined: typeof window.fbq === "function" })
      cookies.push(value.split(";")[0]!)
    },
    createElement: () => ({ async: false, src: "" }),
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => undefined } }]
  }
  const storageApi = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }
  Object.assign(window, {
    addEventListener: () => undefined,
    document,
    location: { search: options.search ?? "", hostname: options.hostname ?? "acme-store.com", protocol: "https:" },
    navigator: {},
    localStorage: storageApi,
    sessionStorage: storageApi,
    setTimeout: (callback: () => void) => callback(),
    URLSearchParams,
    Date,
    String,
    Number,
    posthog: { init: (...args: unknown[]) => ((window.posthogInits as unknown[][]) ??= []).push(args) }
  })
  window.window = window
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script[^>]*>/gi)) runInNewContext(match[1]!, window)
  const fbq = window.fbq as { queue?: unknown[][] } | undefined
  return {
    window,
    cookieWrites,
    queue: () => JSON.parse(JSON.stringify(Array.from(fbq?.queue ?? [], (entry) => Array.from(entry)))) as unknown[][]
  }
}

function linesFor(files: Record<string, string>, framework = "static-html", keys = fakeKeys(), sensitivePaths: string[] = [], vercelServed = true) {
  const root = makeSite(files)
  const detected = detectProvidersWithEvidence(root)
  const facts = detectAdoptedFacts(root, detected)
  return { root, facts, lines: improveLinesFor(facts, { framework, keys, sensitivePaths, vercelServed }) }
}

/** The edit input every test shares (a Vercel-served static site unless a test says otherwise). */
const edit = (root: string, line: Parameters<typeof applyImproveEdit>[0]["line"], overrides: Partial<Parameters<typeof applyImproveEdit>[0]> = {}) =>
  applyImproveEdit({ root, appRoot: ".", framework: "static-html", line, keys: fakeKeys(), consentMode: "not_required", runId: IDS.run, vercelServed: true, ...overrides })

it("refuses deterministic capture and autoconfig writes before touching a consent-bearing page", () => {
  const original = ADOPTED_META_HTML.replace("<head>", "<head>\n<script>fbq?.('consent','revoke');</script>")
  const { root, lines } = linesFor({ "index.html": original })
  const writes = lines.filter(line => line.kind === "capture_beside_adopted_pixel" || line.kind === "autoconfig_off_adopted")
  expect(writes).toHaveLength(2)
  for (const line of writes) {
    const result = edit(root, line)
    expect(result).toMatchObject({ ok: false, ownerRequirement: { path: "index.html", ownerBoundary: { kind: "frozen_unit" } } })
    expect(read(root, "index.html")).toBe(original)
  }
})

describe("improve lines for adopted tags (decision 4: optimise in place, never reinstall)", () => {
  it("adopted PostHog → proxy and defaults-bump lines (a separate line each), a preview-guard line, never an install", () => {
    const { lines } = linesFor({ "index.html": ADOPTED_POSTHOG_HTML })
    expect(lines.map((line) => line.id)).toEqual([
      "improve_additive:posthog:proxy",
      "posthog_defaults_bump_adopted:posthog:defaults",
      "preview_guard_adopted:posthog:init"
    ])
    expect(lines.find((line) => line.target === "proxy")).toMatchObject({ owner: "code", provider: "posthog", evidence: { file: "index.html" } })
    // F20: plain words on the plan screen, no setting name ("api_host", "rewrite").
    expect(lines.find((line) => line.target === "proxy")?.text).toBe(
      "PostHog: send events through your own domain (/ingest) so ad blockers do not drop them. Changes where your existing PostHog sends events, and adds a forwarding rule for /ingest to vercel.json."
    )
    const next = linesFor({ "index.html": ADOPTED_POSTHOG_HTML }, "next-app-router").lines.find((line) => line.target === "proxy")!
    for (const line of [...lines, next]) expect(line.text, line.id).not.toMatch(/api_host|ui_host|\brewrite\b/)
    // A reduction is never an improve line (R2-10): no "one init", no removal.
    for (const line of lines) expect(line.text).not.toMatch(/one init|remove|delete/i)
  })

  it("adopted PostHog on a single-page app without history page views → a capture_pageview:'history_change' line", () => {
    const html = ADOPTED_POSTHOG_HTML.replace(", defaults: '2025-05-24'", "")
    const { lines } = linesFor({ "index.html": html }, "vite-react")
    expect(lines.map((line) => line.id)).toContain("improve_additive:posthog:history_change")
    expect(lines.find((line) => line.target === "history_change")?.text).toBe("PostHog: count page changes in your single-page app. Changes your existing PostHog setup.")
    // Terminal QA #22: a plan line is plain words; config syntax ("capture_pageview: 'history_change'", "defaults
    // '2026-01-30'") never reaches the plan screen. The PostHog defaults line names its date in words.
    for (const line of lines) expect(line.text, line.id).not.toMatch(/[a-z]+_[a-z]+: '|defaults '|'\d{4}-\d{2}-\d{2}'/)
    expect(lines.find((line) => line.kind === "posthog_defaults_bump_adopted")?.text).toContain("PostHog's current recommended settings (their 2026-01-30 defaults).")
    // NEGATIVE (P2-14): a multi-page static site reloads on every page; the line would change nothing.
    expect(linesFor({ "index.html": html }, "static-html").lines.map((line) => line.id)).not.toContain("improve_additive:posthog:history_change")
  })

  it("P3-23: the proxy line only for an api_host that sends straight to PostHog Cloud (or the SDK default)", () => {
    const custom = ADOPTED_POSTHOG_HTML.replace("https://us.i.posthog.com", "https://e.acme.com")
    expect(linesFor({ "index.html": custom }).lines.map((line) => line.id)).not.toContain("improve_additive:posthog:proxy")
    const regionDefault = ADOPTED_POSTHOG_HTML.replace("api_host: 'https://us.i.posthog.com', ", "")
    expect(linesFor({ "index.html": regionDefault }).lines.map((line) => line.id)).toContain("improve_additive:posthog:proxy")
  })

  it("P1-5: a static site NOT served by Vercel gets no proxy line (a vercel.json rewrite would not serve /ingest)", () => {
    expect(linesFor({ "index.html": ADOPTED_POSTHOG_HTML }, "static-html", fakeKeys(), [], false).lines.map((line) => line.id)).not.toContain("improve_additive:posthog:proxy")
    // A Next app proxies through its own rewrites on any host (the agent's job 3).
    expect(linesFor({ "index.html": ADOPTED_POSTHOG_HTML }, "next-app-router", fakeKeys(), [], false).lines.find((line) => line.target === "proxy")?.owner).toBe("agent")
  })

  it("NEGATIVE: an adopted PostHog already on /ingest with history page views and current defaults gets no improve line", () => {
    const html = ADOPTED_POSTHOG_HTML.replace("api_host: 'https://us.i.posthog.com', defaults: '2025-05-24'", "api_host: '/ingest', defaults: '2026-01-30'").replace(
      "<script>",
      "<script>\n      if (location.hostname === 'acme-store.com')"
    )
    const { lines } = linesFor({ "index.html": html })
    expect(lines).toEqual([])
  })

  it("adopted Meta pixel → capture (code), automatic events off (code) and a Meta preview-guard line", () => {
    const { lines } = linesFor({ "index.html": ADOPTED_META_HTML })
    expect(lines.map((line) => [line.id, line.owner])).toEqual([
      ["capture_beside_adopted_pixel:meta:capture", "code"],
      ["autoconfig_off_adopted:meta:autoconfig", "code"],
      ["preview_guard_adopted:meta:init", "agent"]
    ])
    expect(lines[2]!.text).toMatch(/^Meta: keep preview sites silent/)
  })

  it("P1-7: a CMP-held pixel (type=text/plain + consent attributes): the capture is the agent's job, never code", () => {
    const held = ADOPTED_META_HTML.replace("<script>\n      !function", '<script type="text/plain" data-cookieconsent="marketing">\n      !function')
    const { lines, root } = linesFor({ "index.html": held })
    const line = lines.find((entry) => entry.kind === "capture_beside_adopted_pixel")!
    expect(line.owner).toBe("agent")
    // Even forced through as a code line, the edit refuses and leaves the page as it was.
    expect(edit(root, { ...line, owner: "code" })).toMatchObject({ ok: false, reason: expect.stringMatching(/consent manager/) })
    expect(read(root, "index.html")).toBe(held)
  })

  it("a pixel in a React component: the capture is the agent's job (code edits only touch HTML)", () => {
    const component = `export function Pixel() {\n  useEffect(() => { fbq('init', '${IDS.meta}'); fbq('track', 'PageView') }, [])\n  return null\n}\n`
    const { lines } = linesFor({ "index.html": "<!doctype html><html><head></head><body></body></html>", "src/pixel.tsx": component })
    expect(lines.find((line) => line.kind === "capture_beside_adopted_pixel")?.owner).toBe("agent")
  })

  it("GA4 adopted with an id that is not the connection's → an id line; the matching id gets none", () => {
    const gtag = (id: string) =>
      `<!doctype html><html><head><script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script><script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}gtag('js', new Date());gtag('config', '${id}');</script></head><body></body></html>`
    expect(linesFor({ "index.html": gtag(IDS.ga4Other) }).lines.map((line) => line.id)).toContain("improve_additive:ga4:id")
    expect(linesFor({ "index.html": gtag(IDS.ga4) }).lines.map((line) => line.id)).not.toContain("improve_additive:ga4:id")
  })
})

describe("applyImproveEdit: the deterministic code edits (approved lines only)", () => {
  it("the capture-only block beside an adopted pixel: writes _fbc from the landing fbclid BEFORE the pixel exists, pixel untouched", () => {
    const { root, lines } = linesFor({ "index.html": ADOPTED_META_HTML })
    const line = lines.find((entry) => entry.kind === "capture_beside_adopted_pixel")!
    const result = edit(root, line)
    expect(result.ok).toBe(true)
    const after = read(root, "index.html")
    expect(after).toContain(CAPTURE_BLOCK_MARKER)

    const page = runPage(after, { search: "?fbclid=AbC123" })
    expect(typeof page.window.infiniteMetaClickId).toBe("function")
    const fbcWrite = page.cookieWrites.find((write) => write.value.startsWith("_fbc="))
    expect(fbcWrite?.value).toMatch(/^_fbc=fb\.1\.\d+\.AbC123/)
    expect(fbcWrite?.fbqDefined).toBe(false)
    expect(page.queue()).toEqual([["init", IDS.meta], ["track", "PageView"]])

    // NEGATIVE: the original page captures nothing.
    const original = runPage(ADOPTED_META_HTML, { search: "?fbclid=AbC123" })
    expect(original.window.infiniteMetaClickId).toBeUndefined()
    expect(original.cookieWrites).toEqual([])

    // The record reverses to the exact original bytes.
    expect(result.ok && result.record && reverseTextEdits(after, result.record.textEdits)).toBe(ADOPTED_META_HTML)
  })

  it("the capture follows a recorded 'no' under consent_mode=required (the optional hook, never a banner)", () => {
    const { root, lines } = linesFor({ "index.html": ADOPTED_META_HTML })
    const line = lines.find((entry) => entry.kind === "capture_beside_adopted_pixel")!
    edit(root, line, { consentMode: "required" })
    const page = runPage(read(root, "index.html"), { search: "?fbclid=AbC123" })
    expect(page.cookieWrites.filter((write) => write.value.startsWith("_fbc="))).toEqual([])
  })

  it("D10: one literal autoConfig opt-out before the adopted init — automatic events are off, in order", () => {
    const { root, lines } = linesFor({ "index.html": ADOPTED_META_HTML })
    const line = lines.find((entry) => entry.kind === "autoconfig_off_adopted")!
    const result = edit(root, line)
    expect(result.ok && result.record?.planLineId).toBe("autoconfig_off_adopted:meta:autoconfig")
    const after = read(root, "index.html")
    const page = runPage(after)
    expect(page.queue()).toEqual([["set", "autoConfig", false, IDS.meta], ["init", IDS.meta], ["track", "PageView"]])
    expect((page.window.fbq as { disablePushState?: boolean }).disablePushState).toBe(true)
    expect(checkMetaAutoConfigOptOut(after, IDS.meta, "adopted").reason).toBe("opted_out_before_init")
    // NEGATIVE: the original page queues no opt-out.
    expect(runPage(ADOPTED_META_HTML).queue()[0]).toEqual(["init", IDS.meta])
    // Applying it twice changes nothing more.
    expect(edit(root, line)).toEqual({ ok: true, record: null })
  })

  it("review P2: a pixel whose id comes from a variable also gets Meta's automatic events and history PageViews turned off", () => {
    const html = ADOPTED_META_HTML.replace(`fbq('init', '${IDS.meta}');`, `var metaPixelId = window.__sitePixelId;\n        fbq('init', metaPixelId);`)
    expect(html).not.toBe(ADOPTED_META_HTML)
    const { root, facts, lines } = linesFor({ "index.html": html })
    expect(facts.meta[0]?.pixelId).toBeNull()
    expect(facts.meta[0]?.expressionInit).toMatchObject({ receiver: "fbq", idExpression: "metaPixelId", pushStateOff: false })
    const line = lines.find((entry) => entry.kind === "autoconfig_off_adopted")!
    expect(line.owner).toBe("code")
    expect(line.text).toContain("metaPixelId")
    const result = edit(root, line)
    expect(result.ok).toBe(true)
    const after = read(root, "index.html")
    const page = runPage(after.replace("<head>", `<head>\n<script>window.__sitePixelId = '${IDS.meta}';</script>`))
    expect(page.queue()).toEqual([["set", "autoConfig", false, IDS.meta], ["init", IDS.meta], ["track", "PageView"]])
    expect((page.window.fbq as { disablePushState?: boolean }).disablePushState).toBe(true)
    // Once set, nothing more is proposed or written.
    expect(edit(root, line)).toEqual({ ok: true, record: null })
    expect(linesFor({ "index.html": after }).lines.find((entry) => entry.kind === "autoconfig_off_adopted")).toBeUndefined()
  })

  it("review P2: the env-var init in a module keeps its own receiver, and TypeScript gets a form that compiles on any pixel type", () => {
    const source = "if (!metaInitialized) {\n    trackingWindow.fbq(\"init\", process.env.NEXT_PUBLIC_META_PIXEL_ID);\n  }"
    expect(expressionInitOf(source)).toMatchObject({ receiver: "trackingWindow.fbq", idExpression: "process.env.NEXT_PUBLIC_META_PIXEL_ID", pushStateOff: false })
    expect(expressionOptOutLines("trackingWindow.fbq", "process.env.NEXT_PUBLIC_META_PIXEL_ID", true)).toEqual([
      "trackingWindow.fbq('set', 'autoConfig', false, process.env.NEXT_PUBLIC_META_PIXEL_ID);",
      "Object.assign(trackingWindow.fbq, { disablePushState: true });"
    ])
    expect(expressionInitOf(`fbq('init', '${IDS.meta}')`)).toBeNull()
    expect(expressionInitOf("fbq.disablePushState = true; fbq('init', pixelId)")?.pushStateOff).toBe(true)
  })

  it("the PostHog /ingest rewrite in vercel.json, region from the connection; reversal removes the file it created", () => {
    const { root, lines } = linesFor({ "index.html": ADOPTED_POSTHOG_HTML })
    const line = lines.find((entry) => entry.target === "proxy")!
    const eu = fakeKeys({
      posthog: { status: "connected", projectKey: IDS.posthog, apiHost: "https://eu.i.posthog.com", ingestHost: "https://eu.i.posthog.com", uiHost: "https://eu.posthog.com", region: "eu" }
    })
    const result = edit(root, line, { keys: eu })
    expect(result.ok).toBe(true)
    const rewrites = JSON.parse(read(root, "vercel.json")).rewrites as Array<{ source: string; destination: string }>
    expect(rewrites.map((rewrite) => rewrite.destination)).toEqual(expect.arrayContaining([expect.stringContaining("https://eu-assets.i.posthog.com"), expect.stringContaining("https://eu.i.posthog.com")]))
    expect(result.ok && result.record?.beforeHash).toBeNull()
    expect(result.ok && result.record && reverseTextEdits(read(root, "vercel.json"), result.record.textEdits)).toBe("")
  })

  it("NEGATIVE: no connection and an api_host that names no region → the proxy is refused, never guessed", () => {
    const html = ADOPTED_POSTHOG_HTML.replace("api_host: 'https://us.i.posthog.com', ", "")
    const { root, lines } = linesFor({ "index.html": html }, "static-html", notConnectedKeys())
    const line = lines.find((entry) => entry.target === "proxy")!
    const result = edit(root, line, { keys: notConnectedKeys() })
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/region is unknown/) })
    expect(exists(root, "vercel.json")).toBe(false)
  })

  it("P1-5 NEGATIVE: the vercel.json rewrite is refused on a site Vercel does not serve", () => {
    const { root, lines } = linesFor({ "index.html": ADOPTED_POSTHOG_HTML })
    const line = lines.find((entry) => entry.target === "proxy")!
    expect(edit(root, line, { vercelServed: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/not served by Vercel/) })
    expect(exists(root, "vercel.json")).toBe(false)
  })

  it("P0-2 NEGATIVE: a consent-gated fbq('init') is never made unconditional — the opt-out becomes the agent's", () => {
    const gated = ADOPTED_META_HTML.replace(`fbq('init', '${IDS.meta}');`, `if (window.__hasAdConsent) fbq('init', '${IDS.meta}');`)
    const multiLine = ADOPTED_META_HTML.replace(`fbq('init', '${IDS.meta}');`, `if (window.__hasAdConsent)\n        fbq('init', '${IDS.meta}');`)
    for (const html of [gated, multiLine]) {
      const { root, lines } = linesFor({ "index.html": html })
      const line = lines.find((entry) => entry.kind === "autoconfig_off_adopted")!
      expect(line.owner).toBe("agent")
      // Forced through as code, the edit refuses: run with consent false, the queue stays empty.
      expect(edit(root, { ...line, owner: "code" })).toMatchObject({ ok: false, reason: expect.stringMatching(/condition/) })
      expect(read(root, "index.html")).toBe(html)
      expect(runPage(read(root, "index.html")).queue()).toEqual([["track", "PageView"]])
    }
  })

  it("NEGATIVE: an agent-owned line is never applied by code", () => {
    const { root, lines } = linesFor({ "index.html": ADOPTED_META_HTML })
    const guard = lines.find((entry) => entry.kind === "preview_guard_adopted")!
    expect(edit(root, guard)).toMatchObject({ ok: false })
    expect(read(root, "index.html")).toBe(ADOPTED_META_HTML)
  })

  it("D17 on a managed PostHog is an artifact option, and only when PostHog is installed", () => {
    expect(withSensitivePaths({ posthog: { projectKey: IDS.posthog, apiHost: "/ingest" } }, ["/account"]).posthog).toMatchObject({ sensitivePaths: ["/account"] })
    expect(withSensitivePaths({}, ["/account"])).toEqual({})
  })
})


it("offers no sensitive-page edit when adopted PostHog has replay and autocapture off already", () => {
  const html = `<html><head><script>posthog.init('${IDS.posthog}', {autocapture: false, disable_session_recording: true});</script></head><body></body></html>`
  expect(linesFor({ "index.html": html }, "static-html", fakeKeys(), ["/account"]).lines.some(line => line.kind === "sensitive_pages")).toBe(false)
})
