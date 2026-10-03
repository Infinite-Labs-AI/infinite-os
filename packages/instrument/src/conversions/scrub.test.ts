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
  "%2B1%20555%20123%204567",
  "%252B1%2520555%2520123%25204567",
  "person%2540example.test",
  "https%253A%252F%252Fprivate.example.test",
  "%2567clid%253DRAW",
  // plain shapes
  "person@example.test",
  "see https://private.example.test/x",
  "foo gclid=SECRET",
  "/fbclid=SECRET",
  "foo\tmsclkid=SECRET",
  "foo%20ttclid%3DSECRET",
  "5551234567",
  // the build plan's additions
  "a%2540b.example",
  encodeTimes("a@b.example", 5),
  // a value still encoded after four decodes is not trusted
  encodeTimes("a b", 5),
  // malformed percent-encoding is not trusted either
  "%E0%A4%A"
]

const SAFE = [
  "spring_sale",
  "Launch Term",
  "safe%20original",
  "9f2a5d41-7c0e-4b2a-9a77-2c0d8e4f6a10",
  "hero",
  "123456",
  encodeTimes("a b", 3),
  ""
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

  it("decodes through layers: 3× encoded benign text passes; an email under 1-5 layers never does", () => {
    // (Four or more layers of "%25" add a phone-shaped run of digits on their own, so the exemplar's
    // conservative digit rule flags any deeply encoded value — the safe direction.)
    expect(emitted(encodeTimes("a b", 3))).toBe(false)
    for (let layers = 1; layers <= 5; layers += 1) expect(emitted(encodeTimes("a@b.example", layers))).toBe(true)
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
  " 1 415 555 0100",
  "%2B1%20415%20555%200100",
  "+14155550100",
  "(415) 555-0100",
  "415-555-0100",
  "4155550100",
  "14155550100",
  "call 020 7946 0958",
  "alice@example.com",
  "alice%40example.com",
  "person%252540example.test",
  "https://private.example.test",
  "x gclid=SECRET"
]

const CAMPAIGN_KEPT = [
  "120211234567890123",
  "23851234567890123",
  "120211234567890",
  "spring_2026_10_03",
  "2026-10-03",
  "03-10-2026",
  "2026 10 03",
  "summer-sale-2026",
  "launch_2026",
  "ad_120211234567890123",
  "5551234",
  "9f2a5d41-7c0e-4b2a-9a77-2c0d8e4f6a10",
  "spring_sale"
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
