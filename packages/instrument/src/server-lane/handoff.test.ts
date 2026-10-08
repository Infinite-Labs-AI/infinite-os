// The site owner's hand-off for server conversions (review P0-6): the file the wizard writes into the pull
// request, and the section of the pull request's description that repeats its steps.
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import {
  renderServerEventsHandoff,
  type ServerEventsHandoffFacts
} from "./handoff.js"

const STORE: ServerEventsHandoffFacts = {
  conversions: ["purchase", "begin_checkout", "lead"],
  productionHost: "shop.example",
  siteSourceKey: "site_public_test",
  envSetByInfinite: false,
  metaConnected: false,
  usesStripe: true,
  usesPosthog: true,
  webhookUrlPath: "/api/stripe-webhook"
}

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe("the owner hand-off file", () => {
  const text = renderServerEventsHandoff(STORE)

  it("names every step, in order: Sources, Conversions from Your server, Generate secret, env vars, Stripe, Meta, domain", () => {
    const steps = text.split("\n").filter((line) => /^\d+\. /.test(line))
    const order = [
      /Site Analytics → Settings → Sources\*\* and check that `shop\.example`/,
      /Conversions\*\*, add `purchase`, `begin_checkout` and `lead`, each with the source \*\*Your server\*\*/,
      /Server events\*\*, click \*\*Generate secret\*\*/,
      /`INFINITE_SITE_SOURCE_KEY` = `site_public_test`.*`INFINITE_SERVER_EVENT_SECRET`.*`LEAD_ID_SECRET`.*`STRIPE_WEBHOOK_SECRET`/,
      /Stripe → Developers → Webhooks\*\*, add an endpoint `https:\/\/shop\.example\/api\/stripe-webhook` that listens to `checkout\.session\.completed` and `checkout\.session\.async_payment_succeeded`/,
      /connect Meta, then .*turn on \*\*Send outcomes to Meta Conversions API\*\*/,
      /Meta Business Settings → Brand safety → Domains\*\*, verify `shop\.example`/,
      /PostHog .*turn it off for `purchase`, `begin_checkout` and `lead`/,
      /make one real purchase \(test-mode payments are ignored on purpose/
    ]
    expect(steps).toHaveLength(order.length)
    order.forEach((pattern, index) => expect(steps[index]).toMatch(pattern))
  })

  it("never prints a secret value, and never jargon", () => {
    expect(text).not.toMatch(/INFINITE_SERVER_EVENT_SECRET` = `[^t]/)
    expect(text).toContain("never into chat, email or a file")
    for (const jargon of ["metaEventId", "adMatch", "eventID", "top-level path", "dedupe", "relay"]) expect(text).not.toContain(jargon)
  })
})

