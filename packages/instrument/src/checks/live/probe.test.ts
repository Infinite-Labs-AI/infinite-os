// The probe transport (lane O9). Incident guarded: d2f1809, the guardrail counted its own visits until
// every probe declared `Purpose: prefetch`.
import { describe, expect, it } from "vitest"

import { fixtureFetch } from "../../../test/wizard/fixture-fetch.js"

import { LIVE_PROBE_MAX_BYTES, probeFetch } from "./probe.js"

describe("probe transport", () => {
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

  it("reads at most LIVE_PROBE_MAX_BYTES of a body", async () => {
    const big = "x".repeat(LIVE_PROBE_MAX_BYTES + 1024)
    const fixture = fixtureFetch({ "https://acme.test/big": { body: big } })
    const read = await probeFetch("https://acme.test/big", { version: "1", fetch: fixture.fetch, attempts: 1 })
    expect(read.ok && read.text.length).toBe(LIVE_PROBE_MAX_BYTES)
  })
})

