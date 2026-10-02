// The probe transport (lane O9). Incident guarded: d2f1809, the guardrail counted its own visits until
// every probe declared `Purpose: prefetch`.
import { describe, expect, it } from "vitest"

import { fixtureFetch } from "../../../test/wizard/fixture-fetch.js"

import { decodedLiteralsWith, decodeJsStringBody } from "./js-literals.js"
import { isPrivateHost, LIVE_PROBE_MAX_BYTES, probeFetch, probeHeaders } from "./probe.js"

describe("probe transport", () => {
  it("declares itself a check on every request", async () => {
    expect(probeHeaders("1.2.3")).toMatchObject({ Purpose: "prefetch", "User-Agent": "infinite-tag-check/1.2.3 (+https://infinite.fast; analytics monitor)" })
    const fixture = fixtureFetch({ "https://acme.test/": { body: "ok" } })
    await probeFetch("https://acme.test/", { version: "1.2.3", fetch: fixture.fetch })
    expect(fixture.requests[0]!.headers.purpose).toBe("prefetch")
  })

  it("retries a 5xx, not a 404, and never turns a failure into ok", async () => {
    let calls = 0
    const flaky = fixtureFetch({ "https://acme.test/": () => (calls++ === 0 ? { status: 503 } : { body: "ok" }) })
    const ok = await probeFetch("https://acme.test/", { version: "1", fetch: flaky.fetch, attempts: 2, sleep: async () => undefined })
    expect(ok).toMatchObject({ ok: true, status: 200, text: "ok" })
    const missing = fixtureFetch({ "https://acme.test/": { status: 404 } })
    const notFound = await probeFetch("https://acme.test/", { version: "1", fetch: missing.fetch, attempts: 3, sleep: async () => undefined })
    expect(notFound).toMatchObject({ ok: false, status: 404 })
    expect(missing.requests).toHaveLength(1)
    const down = await probeFetch("https://nowhere.test/", { version: "1", fetch: fixtureFetch({}).fetch, attempts: 1 })
    expect(down).toMatchObject({ ok: false, status: 0 })
  })
})

describe("probe hygiene (review P3-4)", () => {
  it("follows a public redirect but refuses one into a loopback or private host", async () => {
    const fixture = fixtureFetch({
      "https://acme.test/": { status: 301, headers: { location: "https://www.acme.test/" } },
      "https://www.acme.test/": { body: "home" },
      "https://evil.test/": { status: 302, headers: { location: "http://127.0.0.1:4242/v1/keys" } },
      "https://private.test/": { status: 307, headers: { location: "http://10.0.0.5/admin" } }
    })
    const followed = await probeFetch("https://acme.test/", { version: "1", fetch: fixture.fetch, attempts: 1 })
    expect(followed).toMatchObject({ ok: true, status: 200, text: "home", finalUrl: "https://www.acme.test/" })
    expect(await probeFetch("https://evil.test/", { version: "1", fetch: fixture.fetch, attempts: 1 })).toMatchObject({ ok: false, status: 0 })
    expect(await probeFetch("https://private.test/", { version: "1", fetch: fixture.fetch, attempts: 1 })).toMatchObject({ ok: false, status: 0 })
    // The refused hop was never requested.
    expect(fixture.requests.map((request) => request.url)).not.toContain("http://127.0.0.1:4242/v1/keys")
    // Every hop carries the check header.
    expect(fixture.requests.every((request) => request.headers.purpose === "prefetch")).toBe(true)
  })

  it("classifies hosts without DNS", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "fd00::1", "0.0.0.0"]) {
      expect(isPrivateHost(host)).toBe(true)
    }
    for (const host of ["acme.com", "8.8.8.8", "172.32.0.1", "2606:4700::1"]) expect(isPrivateHost(host)).toBe(false)
  })

  it("reads at most LIVE_PROBE_MAX_BYTES of a body", async () => {
    const big = "x".repeat(LIVE_PROBE_MAX_BYTES + 1024)
    const fixture = fixtureFetch({ "https://acme.test/big": { body: big } })
    const read = await probeFetch("https://acme.test/big", { version: "1", fetch: fixture.fetch, attempts: 1 })
    expect(read.ok && read.text.length).toBe(LIVE_PROBE_MAX_BYTES)
  })
})

describe("JS string literals", () => {
  it("decodes escapes", () => {
    expect(decodeJsStringBody('posthog.init(\\"phc_x\\")\\n\\u0041\\x42\\u{43}')).toBe('posthog.init("phc_x")\nABC')
    expect(decodeJsStringBody("bad \\x4")).toBeNull()
  })

  it("finds only literals that carry analytics markers, skipping comments and interpolated templates", () => {
    const source = [
      '// "fbq(\'init\')" in a comment',
      'var a="no marker here", b="gtag(\\"config\\", \\"G-X1\\")";',
      "var c=`posthog.init(${key})`;",
      "var d='fbq(\\'init\\', \\'111222333444555\\')';"
    ].join("\n")
    expect(decodedLiteralsWith(source)).toEqual(['gtag("config", "G-X1")', "fbq('init', '111222333444555')"])
  })
})
