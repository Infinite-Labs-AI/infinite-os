import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { INFINITE_SERVER_EVENTS_DESTINATION, INFINITE_SERVER_LANE_RECEIPT_URL } from "../workspace-artifacts.js"

import {
  SERVER_LANE_BRIEF_BANNER,
  SERVER_LANE_POSITIONING,
  renderServerLaneBrief,
  serverLaneCopy,
  serverLaneWizardCopy
} from "./copy.js"
import { outcomeHelperSource } from "./targets/shared.js"

describe("the agent brief", () => {
  const brief = renderServerLaneBrief({
    status: { kind: "other-stack", framework: "Express" },
    moduleImportPath: "./lib/infinite-server-lane"
  })

  it("opens with the managed banner and the positioning line", () => {
    expect(brief.startsWith(`${SERVER_LANE_BRIEF_BANNER}\n# `)).toBe(true)
    expect(brief.slice(0, 900)).toContain("Consent, cookie banners, CMP code, privacy policies and terms pages belong to the site owner")
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
    // ONE external_id rule, the browser accessor's: trimmed only, case kept. Never "lowercased".
    expect(brief).toContain('external_id: createHash("sha256").update(String(user.id).trim()).digest("hex")')
    expect(brief).toContain("**trimmed only — its case is kept**")
    expect(brief).not.toMatch(/external_id[^\n]*\.toLowerCase\(\)/)
    expect(brief).not.toMatch(/`em` and `external_id` are sha256 hex of the trimmed, lowercased/)
    expect(brief).toContain("discarded")
    expect(brief).toContain("64-character hex digest is rejected")
    // eventId is Infinite's idempotency key; Infinite decides the event_id Meta receives (it derives
    // one for account- and visitor-deduped conversions), so the page must never build a Meta event ID.
    expect(brief).toContain("**`eventId` is Infinite's idempotency key, not Meta's event ID.**")
    expect(brief).toContain("Infinite derives a different id, which your pages never see")
    // Purchases are server events only, from the payment webhook; no browser twin; never on a click.
    expect(brief).toContain("**Purchases are server events only.**")
    expect(brief).toContain("// 2. In the PAYMENT WEBHOOK")
    expect(brief).toContain("**Never build a Meta event ID in the page, and never fire a Meta conversion")
    // Negative: the old, wrong advice is gone everywhere in the brief.
    expect(brief).not.toContain("Meta gets the same event_id")
    expect(brief).not.toContain("becomes Meta's `event_id`")
    expect(brief).not.toMatch(/eventID:\s*\\?"purchase:/)
    expect(brief).not.toMatch(/fbq\([^)]*\{\s*eventID/)
    // The not-yet-built server-instructed mirror is never promised.
    expect(brief).not.toContain("metaEventId")
    // The buyer's browser pair, and WHY it cannot come from the call to Infinite.
    expect(brief).toContain("the IP address of the browser")
    expect(brief).toContain("server-to-server")
    expect(brief).toContain("adMatchFromRequest(request")
    // A visitor's tampered cookie must never be able to delete a founder's conversion.
    expect(brief).toContain("a tampered cookie can never delete your purchase")
    // Meta's four required-parameter skips, and the verified-domain precondition.
    expect(brief).toContain("declines rather than sending a broken one")
    expect(brief).toContain("7-day window")
    expect(brief).toContain("verified in Meta Events Manager")
    // And the contract section lists it as an optional, outcome-only key.
    expect(brief).toContain("`adMatch` is OPTIONAL and outcome-only")
  })

  it("sets the SPA expectation, states DNT/GPC is honored, and shows the checkout→webhook carry", () => {
    // Task G: the SPA vs client-router-pageview expectation, and why it won't match PostHog.
    expect(brief).toContain("DOCUMENT REQUESTS")
    expect(brief).toContain("single-page app")
    expect(brief).toContain("$pageview")
    // Task C: DNT / Global-Privacy-Control are documented as honored.
    expect(brief).toContain("Do-Not-Track")
    expect(brief).toContain("Global-Privacy-Control")
    // Task A: the webhook carry pattern (compute at checkout, carry via metadata, pass properties.visitKey).
    expect(brief).toContain("infiniteVisitKey")
    expect(brief).toContain("metadata: { infinite_visit_key }")
    expect(brief).toContain("properties: { visitKey: session.metadata.infinite_visit_key }")
    // Task A: plain-object requests are read, not swallowed.
    expect(brief).toContain("plain object")
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

// The published README carries the same Meta rules as the brief: one external_id rule, eventId is
// Infinite's idempotency key (never Meta's event ID), purchases are server-only, and the page never
// builds a Meta event ID. The README ships in the npm package, so it is what customers read first.
describe("the README's Meta advice", () => {
  it("matches the brief, and the old wrong advice is gone", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8")
    expect(readme).toContain("**`eventId` is Infinite's idempotency key, not Meta's event ID.**")
    expect(readme).toContain("**Purchases are server events only.**")
    expect(readme).toContain("**trimmed only — its case is kept**")
    expect(readme).not.toContain("Meta gets the same event_id")
    expect(readme).not.toContain("becomes Meta's `event_id`")
    expect(readme).not.toMatch(/eventID:\s*"purchase:/)
    expect(readme).not.toMatch(/`em` and `external_id` are sha256 hex of the trimmed, lowercased/)
    expect(readme).not.toContain("hashed the same way\n")
  })
})

// Review fixes F1/F2/F5 on the Meta forwarding example. Every place a customer (or their agent)
// copies the recipe from: the brief in both languages, the README, and the generated helper's own
// doc comment.
const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8")
const BRIEF_TS = renderServerLaneBrief({ status: { kind: "other-stack", framework: "Express" } })
const BRIEF_JS = renderServerLaneBrief({
  status: { kind: "other-stack", framework: "Express" },
  outcomeImportSpecifier: "../lib/infinite-outcome.js",
  outcomeLanguage: "js"
})
const HELPER_TS = outcomeHelperSource({ siteSourceKey: "site_test", productionHosts: ["example.com"] })
const HELPER_JS = outcomeHelperSource(
  { siteSourceKey: "site_test", productionHosts: ["example.com"] },
  { language: "js", extension: "js" }
)
const RECIPE_SOURCES = { BRIEF_TS, BRIEF_JS, README, HELPER_TS, HELPER_JS }

/** Every distinct `X` in `eventId: "purchase:" + X` — one purchase must be reported under one id. */
function purchaseEventIdSources(text: string): Set<string> {
  return new Set([...text.matchAll(/eventId:\s*\\?"purchase:\\?"\s*\+\s*([\w.]+)/g)].map((match) => match[1]!))
}

/**
 * Run the `external_id` line of a recipe as the customer's checkout route would: the line becomes
 * one entry of an object literal (comment and trailing comma removed), evaluated with a real
 * sha256 and the given `user`. Throws exactly where the customer's checkout would throw.
 */
function runExternalIdLine(line: string, user: unknown): Record<string, unknown> {
  const entry = line
    .replace(/^\s*\*?\s*/, "")
    .replace(/\s*\/\/.*$/, "")
    .replace(/,\s*$/, "")
  return runInNewContext(`({ ${entry} })`, { createHash, user }) as Record<string, unknown>
}

function externalIdLines(text: string): string[] {
  return text.split("\n").filter((line) => /external_id: createHash\(/.test(line))
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

describe("the Meta forwarding example: one purchase, one eventId (review F1)", () => {
  it.each(Object.entries({ BRIEF_TS, BRIEF_JS, README }))("%s reports every purchase under the same eventId", (_name, text) => {
    const ids = purchaseEventIdSources(text)
    expect(ids.size).toBeGreaterThan(0)
    expect([...ids]).toEqual(["session.id"])
    // The Meta webhook call carries the visit key from checkout next to its adMatch block.
    expect(text).toMatch(/visitKey: session\.metadata\.infinite_visit_key\s+\/\/ carried from checkout/)
    expect(text).toContain("adMatch: await loadCheckoutAdMatch(session.id)")
    expect(text).toContain("the SAME id every time this purchase is reported")
  })

  it("tells the agent to MOVE the purchase report to the webhook, not to add a second one", () => {
    for (const brief of [BRIEF_TS, BRIEF_JS]) {
      expect(brief).toContain("report the purchase from your PAYMENT WEBHOOK INSTEAD of")
      expect(brief).toContain("and delete this call, so one purchase is")
    }
    expect(README).toContain("Report the purchase HERE and only here")
  })

  it("negative: the old copy reported one purchase under two different ids", () => {
    const old = [
      'eventId: "purchase:" + session.id,  // stable: a retried webhook is counted once',
      'eventId: \\"purchase:\\" + order.id,   // Infinite\'s idempotency key'
    ].join("\n")
    expect([...purchaseEventIdSources(old)].sort()).toEqual(["order.id", "session.id"])
  })
})

describe("the external_id recipe is safe to paste into a checkout route (review F2)", () => {
  const users: Array<[string, unknown, string | undefined]> = [
    ["a string id with capitals and spaces", { id: "  Acct_AbC-42 " }, sha("Acct_AbC-42")],
    ["a numeric id", { id: 42 }, sha("42")],
    ["a guest (no user)", undefined, undefined],
    ["a guest (null user)", null, undefined],
    ["a user without an id", {}, undefined]
  ]

  it.each(Object.entries(RECIPE_SOURCES))("%s: never throws, trims only, keeps case, skips guests", (_name, text) => {
    const lines = externalIdLines(text)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain("user.id.trim()")
      for (const [label, user, expected] of users) {
        const result = runExternalIdLine(line, user)
        expect(result.external_id, label).toBe(expected)
      }
    }
  })

  it("negative: the old recipe line throws on a numeric id and on a guest", () => {
    const old = '  external_id: createHash("sha256").update(user.id.trim()).digest("hex")  // trimmed only: never lowercase an id'
    expect(runExternalIdLine(old, { id: "Acct_A" }).external_id).toBe(sha("Acct_A"))
    expect(() => runExternalIdLine(old, { id: 42 })).toThrow(/trim is not a function/)
    expect(() => runExternalIdLine(old, undefined)).toThrow(/Cannot read properties of undefined/)
  })
})

describe("the event-ID copy uses the app's own dedupe labels and the real reason (review F5)", () => {
  it.each(Object.entries({ BRIEF_TS, README }))("%s", (_name, text) => {
    const flat = text.replace(/\s+/g, " ")
    expect(flat).toContain("*Every event* or *Once per session* in Infinite → Conversions it is this value")
    expect(flat).toContain("for *Once per account*, and for *Once per visitor (TTL)* when the outcome carries a `visitKey`")
    expect(flat).toContain("The page never builds a Meta event ID, so a browser Purchase has no server event")
    // Negative: the old labels and the old (false for Every-event bindings) reason are gone.
    expect(flat).not.toContain("counted once per account or once per visit")
    expect(flat).not.toContain("cannot carry the id Meta received")
  })
})

// The plain installer keeps its EXACT words (lane O5, build plan §O5 "Copy"): `install --server-lane`
// still installs nothing and says so, while the wizard has its own strings for decision 5 and the
// reportInfiniteOutcome / mirror recipes. The hash pins every string and every copy function's source as
// they were before the wizard build (computed at infinite-os 8bbf550 + F0).
describe("the plain installer's server-lane copy is byte-identical to before the wizard", () => {
  function serialise(value: unknown): unknown {
    if (typeof value === "function") return "fn:" + value.toString()
    if (Array.isArray(value)) return value.map(serialise)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, serialise(inner)]))
    }
    return value
  }

  it("hashes to the pre-wizard value", () => {
    const text = JSON.stringify(serialise(serverLaneCopy))
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "0b5a6ac57d3d0dfe4f93594e45213eed510c373eaacf10333307dd02050f4765"
    )
    expect(createHash("sha256").update(serverLaneCopy.status.targetPackages(["@vercel/functions"])).digest("hex")).toBe(
      "9b0fbf1256ca539e699938d069961dc145855359f994b43133afa58d89add7ec"
    )
  })

  it("negative: the wizard's npm line never leaks into install --server-lane output", () => {
    const brief = renderServerLaneBrief({
      status: {
        kind: "target",
        mode: "vercel-middleware",
        label: "Vercel",
        created: ["middleware.js", "lib/infinite-server-lane.js"],
        manual: [],
        installPackages: ["@vercel/functions"]
      }
    })
    expect(brief).toContain("infinite-tag never installs packages")
    const wizardLine = serverLaneWizardCopy.targetPackages(["@vercel/functions"])
    expect(wizardLine).toContain("The wizard installs it as its own plan line")
    expect(brief).not.toContain("as its own plan line")
    expect(brief).not.toContain(wizardLine)
    for (const recipe of [serverLaneWizardCopy.reportOutcomeRecipe(), serverLaneWizardCopy.webhookCaptureRecipe()]) {
      expect(brief).not.toContain(recipe[0]!)
    }
  })
})

describe("the wizard's recipes", () => {
  const report = serverLaneWizardCopy.reportOutcomeRecipe().join("\n")
  const webhook = serverLaneWizardCopy.webhookCaptureRecipe().join("\n")

  it("report from the awaited request with a stable eventId, and mirror only the returned id", () => {
    expect(report).toContain("reportInfiniteOutcome({")
    // B16: the raw stable id; the helper namespaces it as "<type>:<id>" on the wire
    expect(report).toMatch(/eventId: user\.id,/)
    expect(report).toContain('"sign_up:<id>"')
    expect(report).toContain("infiniteMetaMirror(data.metaEventName, data.metaEventId)")
    expect(report).not.toMatch(/eventID:|fbq\(/)
  })

  it("capture fbc, fbp, user agent and ip from one device at checkout; purchases from the webhook only", () => {
    expect(webhook).toContain("adMatchFromRequest(request")
    expect(webhook).toMatch(/one device/i)
    expect(webhook).toContain('eventId: "purchase:" + session.id')
    expect(webhook).not.toMatch(/\bph\b|phone_number|infiniteMetaMirror\(/)
  })

  it("speaks the JS helper's import specifier when the helper is .mjs", () => {
    expect(serverLaneWizardCopy.reportOutcomeRecipe("../lib/infinite-outcome.mjs", "js")[1]).toBe("```js")
    expect(serverLaneWizardCopy.reportOutcomeRecipe("../lib/infinite-outcome.mjs", "js").join("\n")).toContain(
      'from "../lib/infinite-outcome.mjs"'
    )
  })
})
