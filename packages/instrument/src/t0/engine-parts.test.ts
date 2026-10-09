// The T0 page parts in isolation (lane O6): the virtual clock, the DOM, the cookie jar and the Next
// bootstrap decoder. These are pure host-side helpers (no site code runs here), each with a negative.
import { describe, expect, it } from "vitest"

import { VirtualClock } from "./clock.js"
import { CookieJar } from "./cookie-jar.js"
import { T0Document, matchesSelector, parseMarkupInto } from "./dom.js"

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

