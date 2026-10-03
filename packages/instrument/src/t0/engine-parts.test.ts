// The T0 page parts in isolation (lane O6): the virtual clock, the DOM, the cookie jar and the Next
// bootstrap decoder. These are pure host-side helpers (no site code runs here), each with a negative.
import { describe, expect, it } from "vitest"

import { buildAnalyticsModuleSource } from "../frameworks/managed-files.js"
import type { InstallPlan } from "../types.js"
import { VirtualClock } from "./clock.js"
import { CookieJar } from "./cookie-jar.js"
import { T0Document, T0Element, T0Event, matchesSelector, parseMarkupInto } from "./dom.js"
import { decodeNextBootstrap } from "./next-bootstrap.js"

describe("the virtual clock", () => {
  it("fires timers in due order only when advanced, and Date / performance read virtual time", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 0, 1))
    const order: string[] = []
    clock.setTimeout(() => order.push("b@50"), 50)
    clock.setTimeout(() => order.push("a@10"), 10)
    clock.setTimeout(() => order.push("c@400"), 400)
    expect(clock.pending()).toEqual([10, 50, 400])
    await clock.advance(60)
    expect(order).toEqual(["a@10", "b@50"])
    expect(new (clock.dateClass())().getTime()).toBe(Date.UTC(2026, 0, 1) + 60)
    expect(clock.performance().now()).toBe(60)
    await clock.advance(340)
    expect(order).toEqual(["a@10", "b@50", "c@400"])
  })

  it("negative: a cleared timer never fires; an interval repeats", async () => {
    const clock = new VirtualClock()
    let fired = 0
    let ticks = 0
    const id = clock.setTimeout(() => (fired += 1), 10)
    clock.clearTimeout(id)
    clock.setTimeout(() => (ticks += 1), 100, true)
    await clock.advance(350)
    expect(fired).toBe(0)
    expect(ticks).toBe(3)
  })

  it("delivers a resource entry only to connected observers, only when reported", () => {
    const clock = new VirtualClock()
    const Observer = clock.performanceObserverClass() as new (callback: (list: { getEntries(): Array<{ name: string }> }) => void) => { observe(o: { type: string }): void; disconnect(): void }
    const seen: string[] = []
    const observer = new Observer((list) => seen.push(...list.getEntries().map((entry) => entry.name)))
    observer.observe({ type: "resource" })
    expect(seen).toEqual([])
    clock.reportResource("https://www.facebook.com/tr/?ev=Lead", "img", 0)
    observer.disconnect()
    clock.reportResource("https://www.facebook.com/tr/?ev=PageView", "img", 0)
    expect(seen).toEqual(["https://www.facebook.com/tr/?ev=Lead"])
    expect(clock.observing()).toBe(0)
  })
})

function document(): T0Document {
  return new T0Document(
    { onScriptConnected: () => undefined, onImageSrc: () => undefined, onAnchorActivation: () => undefined, onFormSubmission: () => undefined },
    (raw) => new URL(raw, "https://acme.com/").href
  )
}

describe("the DOM", () => {
  it("parses markup and matches compound, descendant, child and attribute selectors", () => {
    const doc = document()
    parseMarkupInto(doc.body, '<main class="hero big"><p><a id="cta" href="/signup" data-infinite-conversion="sign_up">Go</a></p><form data-conversion="signup"><button type="submit">x</button></form></main>')
    const cta = doc.querySelector('[data-infinite-conversion="sign_up"]')!
    expect(cta.getAttribute("id")).toBe("cta")
    expect(matchesSelector(cta, "main.hero a#cta")).toBe(true)
    expect(matchesSelector(cta, "main > a")).toBe(false)
    expect(matchesSelector(cta, "p > a[href^='/sign']")).toBe(true)
    expect(doc.querySelectorAll("button, form").map((node) => node.localName)).toEqual(["form", "button"])
    expect(matchesSelector(cta, "a:has(span)")).toBe(false)
  })

  it("runs capture listeners before bubble listeners, document before window on the way up", () => {
    const doc = document()
    const order: string[] = []
    const window = new (class extends T0Element {})(doc, "window")
    doc.windowTarget = window
    parseMarkupInto(doc.body, '<a id="x" href="/a">x</a>')
    doc.addEventListener("click", () => order.push("document bubble"))
    doc.addEventListener("click", () => order.push("document capture"), true)
    window.addEventListener("click", () => order.push("window bubble"))
    window.addEventListener("click", () => order.push("window capture"), { capture: true })
    doc.querySelector("#x")!.addEventListener("click", () => order.push("target"))
    doc.querySelector("#x")!.click()
    expect(order).toEqual(["window capture", "document capture", "target", "document bubble", "window bubble"])
  })

  it("reflects anchor target/rel as attributes (a plain property would hide a self-navigation)", () => {
    const doc = document()
    parseMarkupInto(doc.body, '<a id="x" href="/download">x</a>')
    const anchor = doc.querySelector("#x") as T0Element & { target: string; rel: string; href: string }
    anchor.target = "_blank"
    anchor.rel = "noopener"
    expect(anchor.getAttribute("target")).toBe("_blank")
    expect(anchor.getAttribute("rel")).toBe("noopener")
    expect(anchor.href).toBe("https://acme.com/download")
  })

  it("runs the default action only when not prevented", () => {
    const activations: string[] = []
    const doc = new T0Document(
      { onScriptConnected: () => undefined, onImageSrc: () => undefined, onAnchorActivation: (anchor) => activations.push(anchor.getAttribute("href")!), onFormSubmission: () => undefined },
      (raw) => raw
    )
    parseMarkupInto(doc.body, '<a id="go" href="/go">go</a><a id="stay" href="/stay">stay</a>')
    doc.querySelector("#stay")!.addEventListener("click", (event: T0Event) => event.preventDefault())
    doc.querySelector("#go")!.click()
    doc.querySelector("#stay")!.click()
    expect(activations).toEqual(["/go"])
  })
})

describe("the cookie jar (RFC 6265bis parts that decide which _fbc a page reads)", () => {
  it("keeps host-only and domain cookies apart, lists oldest first, and refuses public suffixes", () => {
    const jar = new CookieJar()
    jar.hostname = "www.acme.com"
    jar.write("_fbc=old;path=/")
    jar.write("_fbc=new;domain=acme.com;path=/")
    expect(jar.read()).toBe("_fbc=old; _fbc=new")
    jar.write("x=1;domain=com;path=/")
    jar.write("y=1;domain=vercel.app;path=/")
    expect(jar.entries().map((cookie) => cookie.name)).toEqual(["_fbc", "_fbc"])
    jar.write("_fbc=gone;path=/;max-age=0")
    expect(jar.entries("_fbc")).toEqual([{ name: "_fbc", value: "new", domain: ".acme.com" }])
    expect(jar.writes).toHaveLength(5)
  })
})

describe("decoding the Next managed module's bootstrapSource", () => {
  it("returns the exact bytes the client component appends, with its line", () => {
    const moduleSource = buildAnalyticsModuleSource({ instructions: [{ path: "lib/infinite-analytics.ts", provider: "ga4", snippet: 'var re = /\\d+/; window.x = "a\\"b";' }] } as unknown as InstallPlan)
    const decoded = decodeNextBootstrap(moduleSource)
    // O5 isolates each provider in its own try block (Phase 1 F4 follow-up), so the decoded bytes carry that wrapper.
    expect(decoded).toEqual({ ok: true, source: 'try {\nvar re = /\\d+/; window.x = "a\\"b";\n} catch (_infiniteProviderError) {}', line: 3 })
  })

  it("negative: a module without the literal, or with a broken one, is not decoded", () => {
    expect(decodeNextBootstrap("export const x = 1")).toEqual({ ok: false, reason: "no_bootstrap_literal" })
    expect(decodeNextBootstrap('const bootstrapSource = "\\x41"')).toEqual({ ok: false, reason: "undecodable_literal" })
  })
})
