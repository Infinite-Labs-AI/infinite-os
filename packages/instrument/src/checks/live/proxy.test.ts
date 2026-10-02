// T1 PostHog proxy (lane O9). Incident guarded: the month-long silent outage (a dead first-party path
// sends every event nowhere while the page looks instrumented).
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch } from "../../../test/wizard/fixture-fetch.js"

import { checkPosthogProxy } from "./proxy.js"

const ctx = { runId: "run-1", now: FIXED_NOW }
const run = (routes: Parameters<typeof fixtureFetch>[0], apiHost = "/ingest") => {
  const fixture = fixtureFetch(routes)
  return checkPosthogProxy({ origin: "https://acme.test", apiHost }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx).then((results) => ({
    result: results[0]!,
    requests: fixture.requests
  }))
}

describe("PostHog proxy", () => {
  it("passes when <api_host>/static/array.js is the PostHog library", async () => {
    const { result, requests } = await run({ "https://acme.test/ingest/static/array.js": { body: "/* posthog */" } })
    expect(result).toMatchObject({ checkId: "posthog_proxy", state: "pass", evidence: [{ url: "https://acme.test/ingest/static/array.js" }] })
    expect(requests[0]!.headers.purpose).toBe("prefetch")
  })

  it("is a problem on a 404 or on bytes that are not PostHog (negative of the pass above)", async () => {
    expect((await run({ "https://acme.test/ingest/static/array.js": { status: 404 } })).result.state).toBe("problem")
    expect((await run({ "https://acme.test/ingest/static/array.js": { body: "<!doctype html>" } })).result.state).toBe("problem")
  })

  it("is undetermined when the site cannot be reached, and info when PostHog is not proxied at all", async () => {
    expect((await run({})).result.state).toBe("undetermined")
    const direct = await run({}, "https://eu.i.posthog.com")
    expect(direct.result.state).toBe("info")
    expect(direct.requests).toEqual([])
  })
})
