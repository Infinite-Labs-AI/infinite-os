import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { INFINITE_SERVER_EVENTS_DESTINATION } from "../workspace-artifacts.js"

import {
  renderServerLaneBrief
} from "./copy.js"
import { createScanner } from "../review/scan.js"

describe("the agent brief", () => {
  const brief = renderServerLaneBrief({
    status: { kind: "other-stack", framework: "Express" },
    moduleImportPath: "./lib/infinite-server-lane"
  })

  it("keeps generated source-reference examples publishable through the real secret scanner", () => {
    const guide = renderServerLaneBrief({ status: { kind: "created", middlewarePath: "middleware.ts", modulePath: "lib/infinite-server-lane.ts" }, siteSourceKey: "site_fixture", productionHosts: ["example.test"] })
    const scanner = createScanner({ literals: [], allowedIds: [] })
    expect(guide).toContain("contextMetadata(context, { contentIds, numItems })")
    expect(scanner.redact(guide).hits).toEqual([])
    expect(scanner.findInCommit([{ path: "docs/infinite-server-lane.md", added: guide.split("\n").map((text, index) => ({ text, line: index + 1 })) }], () => false)).toEqual([])
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

  it("never contains a secret value or a raw-IP field", () => {
    expect(brief).not.toMatch(/INFINITE_SERVER_EVENT_SECRET\s*=\s*"[^<]/)
    expect(brief).not.toContain('"clientIp"')
    expect(brief).not.toContain('"ip":')
  })

  it("is deterministic for the same input (byte-idempotent re-runs)", () => {
    const again = renderServerLaneBrief({
      status: { kind: "other-stack", framework: "Express" },
      moduleImportPath: "./lib/infinite-server-lane"
    })
    expect(again).toBe(brief)
  })
})

// Review fixes F1/F2/F5 on the Meta forwarding example. Every place this slice owns and a customer
// (or their agent) copies the recipe from: the brief in both languages and the README.
const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8")
const BRIEF_TS = renderServerLaneBrief({ status: { kind: "other-stack", framework: "Express" } })
const BRIEF_JS = renderServerLaneBrief({
  status: { kind: "other-stack", framework: "Express" },
  outcomeImportSpecifier: "../lib/infinite-outcome.js",
  outcomeLanguage: "js"
})

