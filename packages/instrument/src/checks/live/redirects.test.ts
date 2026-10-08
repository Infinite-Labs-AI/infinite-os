// Redirect walk (lane O9). Incident guarded: 42e7a3c, a `vercel.json` redirect that ran before
// middleware — `redirectsCoveringPaths` flags it statically; the walk proves the hops keep the query.
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch, type FixtureHandler } from "../../../test/wizard/fixture-fetch.js"

import { checkRedirectWalk, redirectsCoveringPaths } from "./redirects.js"

const ctx = { runId: "7f3c2a91-b0de-4c5e-9f00-000000000000", now: FIXED_NOW }

function walk(routes: Record<string, FixtureHandler>, url = "https://acme.test/") {
  const fixture = fixtureFetch(routes)
  return checkRedirectWalk({ urls: [url] }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx).then((results) => ({ results, requests: fixture.requests }))
}

/** A redirect that keeps the query string. */
const keep = (to: string): FixtureHandler => (request) => ({ status: 301, headers: { location: `${to}${new URL(request.url).search}` } })

describe("redirect walk", () => {
  it("passes when every hop keeps the campaign tags; the walk of production carries utm_* only, never a click id (B19)", async () => {
    const { results, requests } = await walk({
      "https://acme.test/": keep("https://www.acme.test/"),
      "https://www.acme.test/": { status: 200 }
    })
    expect(results.map((result) => result.state)).toEqual(["pass"])
    expect(results[0]!.reason).toContain("1 hop")
    expect(requests.every((request) => request.method === "HEAD" && request.headers.purpose === "prefetch")).toBe(true)
    const first = new URL(requests[0]!.url)
    // negative: decision 12 — no fake click id ever reaches production
    expect(first.searchParams.get("fbclid")).toBeNull()
    expect(first.searchParams.get("gclid")).toBeNull()
    expect(first.searchParams.get("utm_source")).toBe("infinite_redirect_check")
  })

  it("is a problem when a hop drops the query (negative: the same hop keeping it passes)", async () => {
    const { results } = await walk({
      "https://acme.test/": { status: 308, headers: { location: "https://www.acme.test/" } },
      "https://www.acme.test/": { status: 200 }
    })
    expect(results[0]!.state).toBe("problem")
    expect(results[0]!.reason).toContain("drops utm_source, utm_medium, utm_campaign")
    expect(results[0]!.reason).not.toContain("fbclid")
  })

  it("a loop is a problem; an unreachable site is undetermined (never pass)", async () => {
    const loop = await walk({ "https://acme.test/": keep("https://acme.test/x"), "https://acme.test/x": keep("https://acme.test/") })
    expect(loop.results[0]!.state).toBe("problem")
    const down = await walk({})
    expect(down.results[0]!.state).toBe("undetermined")
    const notFound = await walk({ "https://acme.test/": { status: 404 } })
    expect(notFound.results[0]!.state).toBe("undetermined")
  })
})

describe("config redirects that run before middleware", () => {
  it("flags a redirect covering a conversion or matcher path (negative: an unrelated redirect)", () => {
    const vercelJson = JSON.stringify({ redirects: [{ source: "/signup/:path*", destination: "/start/:path*" }, { source: "/old", destination: "/" }] })
    expect(redirectsCoveringPaths(vercelJson, { conversionPaths: ["/signup/done"], matcherPaths: ["/pricing"] })).toEqual([
      { source: "/signup/:path*", covers: "/signup/done", why: "conversion_path" }
    ])
    expect(redirectsCoveringPaths(vercelJson, { conversionPaths: ["/checkout"], matcherPaths: [] })).toEqual([])
    expect(redirectsCoveringPaths("{not json", { conversionPaths: [], matcherPaths: [] })).toBeNull()
  })
})
