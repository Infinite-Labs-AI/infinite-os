// §3h.6 server-lane probe (lane O9): the ONE request meant to be recorded, so it carries no Purpose.
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch } from "../../../test/wizard/fixture-fetch.js"

import { sendServerLaneProbe, serverLaneProbePath } from "./server-lane-probe.js"

describe("server-lane probe", () => {
  it("is a plain document GET with no Purpose header", async () => {
    const path = serverLaneProbePath("7f3c2a91-b0de-4c5e-9f00-000000000000")
    expect(path).toBe("/__infinite_probe/7f3c2a91b0de")
    const fixture = fixtureFetch({ [`https://acme.com${path}`]: { status: 404 } })
    const sent = await sendServerLaneProbe("acme.com", path, { version: "t", fetch: fixture.fetch, now: FIXED_NOW })
    expect(sent).toEqual({ path, status: 404, sentAt: "2026-10-02T12:00:00.000Z", detail: null })
    expect(fixture.requests[0]!.headers.purpose).toBeUndefined()
    expect(fixture.requests[0]!.headers.accept).toBe("text/html")
    expect(fixture.requests[0]!.headers["user-agent"]).toMatch(/monitor/)
  })

  it("gives up on a stalled site at the probe deadline (review P3-4)", async () => {
    const stalled = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch
    const sent = await sendServerLaneProbe("acme.com", "/__infinite_probe/7f3c2a91b0de", { version: "t", fetch: stalled, now: FIXED_NOW, timeoutMs: 20 })
    expect(sent).toMatchObject({ status: 0, detail: "aborted" })
  })

  it("refuses a path without enough hex", () => {
    expect(() => serverLaneProbePath("xyz")).toThrow()
  })
})
