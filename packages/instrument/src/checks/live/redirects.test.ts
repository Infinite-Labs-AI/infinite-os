// Redirect walk (lane O9). Incident guarded: 42e7a3c, a `vercel.json` redirect that ran before
// middleware — `redirectsCoveringPaths` flags it statically; the walk proves the hops keep the query.
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch, loopbackSite, type FixtureHandler } from "../../../test/wizard/fixture-fetch.js"

import { checkRedirectWalk, redirectsCoveringPaths, redirectTestParams, vercelSourcePattern } from "./redirects.js"

const ctx = { runId: "7f3c2a91-b0de-4c5e-9f00-000000000000", now: FIXED_NOW }

function walk(routes: Record<string, FixtureHandler>, url = "https://acme.test/") {
  const fixture = fixtureFetch(routes)
  return checkRedirectWalk({ urls: [url] }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx).then((results) => ({ results, requests: fixture.requests }))
}

/** A redirect that keeps the query string. */
const keep = (to: string): FixtureHandler => (request) => ({ status: 301, headers: { location: `${to}${new URL(request.url).search}` } })

describe("redirect walk", () => {
  it("passes when every hop keeps the campaign tags, and marks the click ids as test values", async () => {
    const { results, requests } = await walk({
      "https://acme.test/": keep("https://www.acme.test/"),
      "https://www.acme.test/": { status: 200 }
    })
    expect(results.map((result) => result.state)).toEqual(["pass"])
    expect(results[0]!.reason).toContain("1 hop")
    expect(requests.every((request) => request.method === "HEAD" && request.headers.purpose === "prefetch")).toBe(true)
    const first = new URL(requests[0]!.url)
    expect(first.searchParams.get("fbclid")).toBe("INFINITE_TEST_NOT_REAL_7f3c2a")
    expect(first.searchParams.get("utm_source")).toBe("infinite_check")
  })

  it("is a problem when a hop drops the query (negative: the same hop keeping it passes)", async () => {
    const { results } = await walk({
      "https://acme.test/": { status: 308, headers: { location: "https://www.acme.test/" } },
      "https://www.acme.test/": { status: 200 }
    })
    expect(results[0]!.state).toBe("problem")
    expect(results[0]!.reason).toContain("drops utm_source, utm_medium, utm_campaign, fbclid, gclid")
  })

  it("falls back to GET when the server refuses HEAD", async () => {
    const { results, requests } = await walk({
      "https://acme.test/": (request) => (request.method === "HEAD" ? { status: 405 } : { status: 200, body: "<html></html>" })
    })
    expect(results[0]!.state).toBe("pass")
    expect(requests.map((request) => request.method)).toEqual(["HEAD", "GET"])
    expect(requests.every((request) => request.headers.purpose === "prefetch")).toBe(true)
  })

  it("a loop is a problem; an unreachable site is undetermined (never pass)", async () => {
    const loop = await walk({ "https://acme.test/": keep("https://acme.test/x"), "https://acme.test/x": keep("https://acme.test/") })
    expect(loop.results[0]!.state).toBe("problem")
    const down = await walk({})
    expect(down.results[0]!.state).toBe("undetermined")
    const notFound = await walk({ "https://acme.test/": { status: 404 } })
    expect(notFound.results[0]!.state).toBe("undetermined")
  })

  it("walks a real HTTP redirect on a loopback fixture server", async () => {
    const site = await loopbackSite("https://acme-site.test", (request, response) => {
      const url = new URL(request.url ?? "/", "http://x")
      if (url.pathname === "/old") {
        response.writeHead(302, { location: `/new${url.search}` })
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<html></html>")
    })
    try {
      const results = await checkRedirectWalk({ urls: ["https://acme-site.test/old"] }, { version: "t", fetch: site.fetch, attempts: 1 }, ctx)
      expect(results[0]!.state).toBe("pass")
      expect(site.requests.map((request) => new URL(request.url).pathname)).toEqual(["/old", "/new"])
      expect(site.requests.every((request) => request.headers.purpose === "prefetch")).toBe(true)
    } finally {
      await site.close()
    }
  })

  it("names doctor's walk without a run id", () => {
    expect(redirectTestParams(null).fbclid).toBe("INFINITE_TEST_NOT_REAL_doctor")
  })
})

describe("config redirects that run before middleware", () => {
  it("matches Vercel source patterns", () => {
    expect(vercelSourcePattern("/signup/:path*").test("/signup/start")).toBe(true)
    expect(vercelSourcePattern("/old-blog/:slug").test("/old-blog/a/b")).toBe(false)
    expect(vercelSourcePattern("/(.*)").test("/anything")).toBe(true)
  })

  it("flags a redirect covering a conversion or matcher path (negative: an unrelated redirect)", () => {
    const vercelJson = JSON.stringify({ redirects: [{ source: "/signup/:path*", destination: "/start/:path*" }, { source: "/old", destination: "/" }] })
    expect(redirectsCoveringPaths(vercelJson, { conversionPaths: ["/signup/done"], matcherPaths: ["/pricing"] })).toEqual([
      { source: "/signup/:path*", covers: "/signup/done", why: "conversion_path" }
    ])
    expect(redirectsCoveringPaths(vercelJson, { conversionPaths: ["/checkout"], matcherPaths: [] })).toEqual([])
    expect(redirectsCoveringPaths("{not json", { conversionPaths: [], matcherPaths: [] })).toBeNull()
  })
})
