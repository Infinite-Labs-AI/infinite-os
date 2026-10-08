// The site owner's hand-off for server conversions (review P0-6): the file the wizard writes into the pull
// request, and the section of the pull request's description that repeats its steps.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { InstallManifest } from "../types.js"

import {
  renderServerEventsHandoff,
  renderServerEventsPrSection,
  serverConversionsOf,
  serverEventsPrSectionFromRepo,
  SERVER_EVENTS_HANDOFF_BANNER,
  SERVER_EVENTS_HANDOFF_FILE,
  withHandoffInReceipt,
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

  it("opens with the managed banner and says the code stays off until the steps are done", () => {
    expect(text.startsWith(`${SERVER_EVENTS_HANDOFF_BANNER}\n# Turn on server conversions`)).toBe(true)
    expect(text).toContain("The code stays switched off until you do the steps below")
    expect(text).toContain("Stripe gets an ordinary 200")
  })

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

  it("tailors itself: Meta already connected, Infinite can write the env vars, no Stripe, no PostHog", () => {
    const leads = renderServerEventsHandoff({ ...STORE, conversions: ["lead"], envSetByInfinite: true, metaConnected: true, usesStripe: false, usesPosthog: false, productionHost: null })
    expect(leads).not.toContain("Stripe")
    expect(leads).not.toContain("PostHog")
    expect(leads).toContain("check that **Send outcomes to Meta Conversions API** is on")
    expect(leads).toContain("run `infinite analytics` with the Infinite app open")
    expect(leads).toContain("`<your-domain>`")
    expect(leads).toContain("sign up once yourself")
  })

  it("only server conversions get the hand-off", () => {
    expect(serverConversionsOf(["purchase", "add_to_cart", "view_item", "lead", "purchase", "cta_click"])).toEqual(["purchase", "lead"])
    expect(serverConversionsOf(["add_to_cart"])).toEqual([])
  })
})

describe("the pull request section", () => {
  it("repeats the file's steps and points at the file", () => {
    const section = renderServerEventsPrSection(STORE, SERVER_EVENTS_HANDOFF_FILE)
    expect(section).toContain("## Your steps before server conversions reach Infinite and Meta")
    expect(section).toContain("They are also in `docs/infinite-server-events.md`.")
    expect(section.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(9)
  })

  it("is read back from the repo exactly as written (the receipt names the file)", async () => {
    const root = mkdtempSync(join(tmpdir(), "instrument-handoff-"))
    tempRoots.push(root)
    const contents = renderServerEventsHandoff(STORE)
    const path = `web/${SERVER_EVENTS_HANDOFF_FILE}`
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
    const receipt = withHandoffInReceipt({ serverLane: { mode: "next-middleware", created: ["web/lib/infinite-outcome.ts"] }, configOwnership: {} } as unknown as InstallManifest, path, contents)
    expect(receipt.serverLane?.created).toEqual(["web/lib/infinite-outcome.ts", path])
    expect(receipt.configOwnership?.[path]).toMatchObject({ kind: "created" })
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify(receipt))
    const read = async (file: string) => {
      try {
        return readFileSync(file, "utf8")
      } catch {
        return null
      }
    }
    const section = await serverEventsPrSectionFromRepo(root, read)
    expect(section).toBe(renderServerEventsPrSection(STORE, path))
    // No receipt record, or a file someone rewrote without the banner: no section.
    writeFileSync(join(root, path), "# my notes\n1. something\n")
    await expect(serverEventsPrSectionFromRepo(root, read)).resolves.toBeNull()
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify({ serverLane: { mode: "brief" } }))
    await expect(serverEventsPrSectionFromRepo(root, read)).resolves.toBeNull()
  })
})
