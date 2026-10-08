// The scrubber, ported with its cases from infinite-site `.github/scripts/test-get-started-page.mjs`
// @ 9f65b47 (the friction-lane block at L1663: a phone in three encodings, a twice-encoded email, a
// twice-encoded URL, an encoded click id), plus the build plan's `%2540` and 5-pass encodings. Every case
// runs the SERIALIZED browser text in node:vm and the TS function, and the two must agree.
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { infiniteUnsafeCampaign, infiniteUnsafeText, UNSAFE_CAMPAIGN_SOURCE, UNSAFE_TEXT_SOURCE } from "./scrub.js"

function emitted(value: unknown): boolean {
  return runInNewContext(`${UNSAFE_TEXT_SOURCE}\ninfiniteUnsafeText(value)`, { value }) as boolean
}

function encodeTimes(value: string, times: number): string {
  let out = value
  for (let index = 0; index < times; index += 1) out = encodeURIComponent(out)
  return out
}

const UNSAFE = [
  // the exemplar's friction-lane cases
  "+1 (555) 123-4567",
  "%252B1%2520555%2520123%25204567",
  "person%2540example.test",
  "%2567clid%253DRAW",
  // plain shapes
  "person@example.test",
  "see https://private.example.test/x",
  "5551234567",
  encodeTimes("a@b.example", 5),
  // malformed percent-encoding is not trusted either
  "%E0%A4%A"
]

const SAFE = [
  "spring_sale",
  "safe%20original",
  encodeTimes("a b", 3),
]

describe("infiniteUnsafeText", () => {
  it.each(UNSAFE)("flags %j", (value) => {
    expect(infiniteUnsafeText(value)).toBe(true)
    expect(emitted(value)).toBe(true)
  })

  it.each(SAFE)("passes %j", (value) => {
    expect(infiniteUnsafeText(value)).toBe(false)
    expect(emitted(value)).toBe(false)
  })

  it("treats a non-string as unsafe", () => {
    expect(emitted(42)).toBe(true)
    expect(emitted({ toString: () => "x" })).toBe(true)
  })

  it("serializes to plain browser source (no backtick, ${ or </)", () => {
    expect(UNSAFE_TEXT_SOURCE).toMatch(/^function infiniteUnsafeText\(value\)/)
    expect(UNSAFE_TEXT_SOURCE).not.toMatch(/`|\$\{|<\//)
  })
})

// W7c (review P1-2): the campaign rule. The SAME table is pinned in 1bu-1's `ingest.test.ts` against the cloud's
// `campaignValueCarriesPii`, so the tag and the door drop exactly the same campaign values.
function campaignEmitted(value: unknown): boolean {
  return runInNewContext(`${UNSAFE_CAMPAIGN_SOURCE}\ninfiniteUnsafeCampaign(value)`, { value }) as boolean
}

const CAMPAIGN_DROPPED = [
  "+1 415 555 0100",
  "(415) 555-0100",
  "4155550100",
  "call 020 7946 0958",
  "alice@example.com",
  "x gclid=SECRET"
]

const CAMPAIGN_KEPT = [
  "120211234567890123",
  "spring_2026_10_03",
  "03-10-2026",
  "5551234",
  "9f2a5d41-7c0e-4b2a-9a77-2c0d8e4f6a10",
]

describe("infiniteUnsafeCampaign (W7c)", () => {
  it.each(CAMPAIGN_DROPPED)("drops %j", (value) => {
    expect(infiniteUnsafeCampaign(value)).toBe(true)
    expect(campaignEmitted(value)).toBe(true)
  })

  it.each(CAMPAIGN_KEPT)("keeps %j", (value) => {
    expect(infiniteUnsafeCampaign(value)).toBe(false)
    expect(campaignEmitted(value)).toBe(false)
  })

  it("is plain ES5 the page can carry (no backticks, no template, no closing tag)", () => {
    expect(UNSAFE_CAMPAIGN_SOURCE).not.toMatch(/`|\$\{|<\//)
  })
})
