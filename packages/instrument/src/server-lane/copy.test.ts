import { describe, expect, it } from "vitest"

import { INFINITE_SERVER_EVENTS_DESTINATION, INFINITE_SERVER_LANE_RECEIPT_URL } from "../workspace-artifacts.js"

import {
  SERVER_LANE_BRIEF_BANNER,
  SERVER_LANE_POSITIONING,
  renderServerLaneBrief,
  serverLaneCopy
} from "./copy.js"

describe("the agent brief", () => {
  const brief = renderServerLaneBrief({
    status: { kind: "other-stack", framework: "Express" },
    moduleImportPath: "./lib/infinite-server-lane"
  })

  it("opens with the managed banner and the positioning line", () => {
    expect(brief.startsWith(`${SERVER_LANE_BRIEF_BANNER}\n# `)).toBe(true)
    expect(brief).toContain(`> ${SERVER_LANE_POSITIONING}`)
    expect(SERVER_LANE_POSITIONING).toBe(
      "server-side analytics: every page your server serves and every outcome it confirms, counted where ad-blockers can't reach. A floor for people, never an exact share — installed by your agent in ten minutes."
    )
    expect(SERVER_LANE_POSITIONING).not.toContain("100%")
    expect(brief).not.toContain("100%")
  })

  it("states the contract verbatim: endpoint, headers, env, both body shapes, recipes, delivery, skips, never-send", () => {
    expect(brief).toContain(`POST ${INFINITE_SERVER_EVENTS_DESTINATION}`)
    expect(brief).toContain("`x-infinite-source-key: <site source key>`")
    expect(brief).toContain("`x-infinite-signature: <lowercase hex HMAC-SHA256 of the RAW request body under the secret>`")
    expect(brief).toContain("`INFINITE_SERVER_EVENT_SECRET`")
    expect(brief).toContain("`INFINITE_SITE_SOURCE_KEY`")
    expect(brief).toContain('"eventName": "site_document_request"')
    expect(brief).toContain('"userAgentFamily": "browser"')
    expect(brief).toContain('"visit:" + clientIp + "|" + userAgent + "|" + floor(epochSeconds / 1800)')
    expect(brief).toContain('"doc:" + hex HMAC-SHA256(secret, visitKey + "|" + path + "|" + occurredAtMs)')
    expect(brief).toContain("`browser | automation | unknown`")
    expect(brief).toContain('"eventName": "sign_up"')
    expect(brief).toContain("`accountKey` is optional")
    expect(brief).toContain("event.waitUntil(fetch(...))")
    expect(brief).toContain("`ctx.waitUntil`")
    expect(brief).toContain("`context.waitUntil`")
    expect(brief).toContain("Timeout 2000 ms")
    expect(brief).toContain("**Skip.**")
    expect(brief).toContain("**Never send.**")
  })

  it("carries every reference implementation and the verify command", () => {
    expect(brief).toContain("```ts\n// Managed by Infinite. Public install artifacts only.")
    expect(brief).toContain("export default withInfiniteServerLane()")
    expect(brief).toContain("// server.mjs (Express)")
    expect(brief).toContain("// infinite-server-lane.mjs — generic Node helper")
    expect(brief).toContain("// worker.js (Cloudflare Workers)")
    expect(brief).toContain("// netlify/edge-functions/infinite-server-lane.js")
    expect(brief).toContain("crypto.subtle.importKey")
    expect(brief).toContain('createHmac("sha256", SECRET)')
    expect(brief).toContain("npx infinite-tag verify --server-lane https://<your-production-host>/")
    expect(brief).toContain(INFINITE_SERVER_LANE_RECEIPT_URL)
    expect(brief).toContain("## Done when")
    expect(brief).toContain("- [ ] ")
  })

  it("documents adMatch as OPT-IN, customer-hashed, and never stored", () => {
    expect(brief).toContain(`### ${serverLaneCopy.adMatchHeading}`)
    // The audience gate is stated first, because the wrong founder double-counts by adding it.
    expect(brief).toContain("Meta ads and do not use PostHog")
    expect(brief).toContain("Send outcomes to Meta Conversions API")
    // The hashing recipe is spelled out, so nobody has to guess Meta's normalisation.
    expect(brief).toContain('createHash("sha256").update(email.trim().toLowerCase()).digest("hex")')
    expect(brief).toContain("discarded")
    expect(brief).toContain("64-character hex digest is rejected")
    // The dedup promise and the privacy promise both appear.
    expect(brief).toContain("so a browser pixel firing the same id deduplicates")
    expect(brief).toContain("are read from the outcome request's own headers at forwarding time")
    // And the contract section lists it as an optional, outcome-only key.
    expect(brief).toContain("`adMatch` is OPTIONAL and outcome-only")
  })

  it("never contains a secret value or a raw-IP field", () => {
    expect(brief).not.toMatch(/INFINITE_SERVER_EVENT_SECRET\s*=\s*"[^<]/)
    expect(brief).not.toContain('"clientIp"')
    expect(brief).not.toContain('"ip":')
  })

  it("renders the per-status paragraph and the exact addition only where needed", () => {
    const created = renderServerLaneBrief({
      status: { kind: "created", middlewarePath: "middleware.ts", modulePath: "lib/infinite-server-lane.ts" }
    })
    expect(created).toContain("infinite-tag CREATED `middleware.ts` and `lib/infinite-server-lane.ts`")
    expect(created).not.toContain(`### ${serverLaneCopy.exactAdditionHeading}`)

    const manual = renderServerLaneBrief({ status: { kind: "next-manual", modulePath: "lib/infinite-server-lane.ts" } })
    expect(manual).toContain(`### ${serverLaneCopy.exactAdditionHeading}`)
    expect(manual).toContain("export default withInfiniteServerLane(middleware)")

    expect(brief).toContain('This project was detected as "Express"')
  })

  it("is deterministic for the same input (byte-idempotent re-runs)", () => {
    const again = renderServerLaneBrief({
      status: { kind: "other-stack", framework: "Express" },
      moduleImportPath: "./lib/infinite-server-lane"
    })
    expect(again).toBe(brief)
  })
})
