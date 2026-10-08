import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildMetaPixelSnippet } from "../providers/meta.js"

import {
  META_SIGNALS_CONFIG_VERSION,
  extractMetaPixelIds,
  metaSignalsConfigUrl,
  parseMetaConfigEntry,
  probeMetaDelivery
} from "./config-probe.js"
import { maskPixelId, metaDeliveryHeadline } from "./copy.js"
import { checkMetaLane, sha256Hex } from "./lane.js"

/**
 * THE REAL THING. Captured 2026-09-21 from
 * `connect.facebook.net/signals/config/555500001111222?v=2.9.403&r=stable&domain=example.com`
 * — a domain that is not on that pixel's Traffic Permissions allow list, which is the same state
 * infinite.fast was in on 2026-09-20. Trimmed to its tail (the `config.set` data section) so it
 * stays readable; the block directive is byte-for-byte as Meta served it.
 *
 * A synthetic fixture would pin our own assumptions instead of Meta's behaviour, and the whole
 * reason this bug survived a night is that every assumption looked right.
 */
const BLOCKED_CONFIG = readFileSync(
  join(import.meta.dirname, "fixtures", "blocked-traffic-permissions.config.js.txt"),
  "utf8"
)

const PIXEL = "555500001111222"

/** A healthy config's shape: the two directives absent, and the pixel's load closed out. */
const ALLOWED_CONFIG = [
  `config.set("${PIXEL}", "prohibitedSources", {"prohibitedSources":[]});`,
  `fbq.loadPlugin("cookie");`,
  `fbq.loadPlugin("identity");`,
  `instance.configLoaded("${PIXEL}");`
].join("\n")

function stubFetch(status: number, body: string): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { impl, urls }
}

describe("parseMetaConfigEntry", () => {
  it("reads the block directive out of the real payload", () => {
    const entry = parseMetaConfigEntry(BLOCKED_CONFIG, PIXEL, "prohibitedPixels")
    expect(entry).toEqual({
      kind: "present",
      value: { lockWebpage: false, blockReason: "traffic_permissions" }
    })
  })

  it("separates 'not there' from 'there but unreadable' — the false-green guard", () => {
    // If Meta ever changes the literal's shape, this must NOT read as a healthy pixel.
    const mangled = `config.set("${PIXEL}", "prohibitedPixels", {lockWebpage: false,});`
    const entry = parseMetaConfigEntry(mangled, PIXEL, "prohibitedPixels")
    expect(entry.kind).toBe("unparseable")
  })
})

describe("metaSignalsConfigUrl", () => {
  it("always carries &domain= — without it Meta serves the generic config and the block is invisible", () => {
    const url = metaSignalsConfigUrl(PIXEL, "infinite.fast")
    expect(url).toBe(
      `https://connect.facebook.net/signals/config/${PIXEL}?v=${META_SIGNALS_CONFIG_VERSION}&r=stable&domain=infinite.fast`
    )
    expect(new URL(url).searchParams.get("domain")).toBe("infinite.fast")
  })
})

describe("probeMetaDelivery", () => {
  it("classifies the real blocked payload as blocked, with Meta's own reason", async () => {
    const { impl, urls } = stubFetch(200, BLOCKED_CONFIG)
    const finding = await probeMetaDelivery({
      pixelId: PIXEL,
      domain: "infinite.fast",
      version: "0.0.0-test",
      fetch: impl,
      sha256Hex
    })
    expect(finding).toEqual({
      kind: "blocked",
      pixelId: PIXEL,
      domain: "infinite.fast",
      blockReason: "traffic_permissions",
      // lockWebpage:false is the SILENT variant — presence of the directive is the failure, not this.
      lockWebpage: false
    })
    expect(urls[0]).toContain("domain=infinite.fast")
  })

  it("catches the explicit BLOCK list, which names the domain as a sha256 digest", async () => {
    const hashed = sha256Hex("infinite.fast")
    const body = [
      `config.set("${PIXEL}", "prohibitedSources", {"prohibitedSources":[{"domain":"${hashed}"}]});`,
      `instance.configLoaded("${PIXEL}");`
    ].join("\n")
    const { impl } = stubFetch(200, body)
    const finding = await probeMetaDelivery({
      pixelId: PIXEL,
      domain: "infinite.fast",
      version: "0.0.0-test",
      fetch: impl,
      sha256Hex
    })
    expect(finding.kind).toBe("source_blocked")
  })

  it("NEVER turns a transport failure into a pass", async () => {
    const impl = (async () => {
      throw new Error("ENOTFOUND connect.facebook.net")
    }) as unknown as typeof fetch
    const finding = await probeMetaDelivery({
      pixelId: PIXEL,
      domain: "infinite.fast",
      version: "0.0.0-test",
      fetch: impl,
      sha256Hex
    })
    expect(finding.kind).toBe("unknown")
    expect(finding.kind === "unknown" && finding.detail).toContain("ENOTFOUND")
  })

  it("NEVER turns a body it does not understand into a pass", async () => {
    const { impl } = stubFetch(200, "// something else entirely")
    const finding = await probeMetaDelivery({
      pixelId: PIXEL,
      domain: "infinite.fast",
      version: "0.0.0-test",
      fetch: impl,
      sha256Hex
    })
    expect(finding.kind).toBe("unknown")
  })
})

describe("the message a customer reads", () => {
  it("masks the pixel id rather than printing it whole", () => {
    expect(maskPixelId(PIXEL)).toBe("555500…1222")
    expect(metaDeliveryHeadline({ kind: "allowed", pixelId: PIXEL, domain: "x.com" })).not.toContain(PIXEL)
  })

  it("says 'could not check', never 'healthy', when the probe failed", () => {
    const text = metaDeliveryHeadline({
      kind: "unknown",
      pixelId: PIXEL,
      domain: "infinite.fast",
      detail: "Meta answered HTTP 503 for the pixel config"
    })
    expect(text).toContain("Could not check")
    expect(text).toContain("NOT a pass")
  })
})

describe("checkMetaLane", () => {
  const html = `<script>fbq('init', '${PIXEL}');</script>`

  it("turns a blocked pixel into a no_receipt whose FIRST cause is the remedy", async () => {
    const { impl } = stubFetch(200, BLOCKED_CONFIG)
    const { verification } = await checkMetaLane({
      html,
      url: "https://infinite.fast/",
      version: "0.0.0-test",
      fetch: impl
    })
    expect(verification.state).toBe("no_receipt")
    expect(verification.state === "no_receipt" && verification.causes[0]).toContain(
      "BLOCKED FROM TRANSMITTING on infinite.fast"
    )
  })

  it("never reports an allowed pixel as verified — Meta has no install-time read-back", async () => {
    const { impl } = stubFetch(200, ALLOWED_CONFIG)
    const { verification } = await checkMetaLane({
      html,
      url: "https://infinite.fast/",
      version: "0.0.0-test",
      fetch: impl
    })
    expect(verification.state).toBe("not_verifiable")
    expect(verification.state === "not_verifiable" && verification.reason).toContain("not blocked")
    expect(verification.state === "not_verifiable" && verification.reason).toContain("Test Events")
  })

  it("does not pass when the probe could not run", async () => {
    const impl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch
    const { verification } = await checkMetaLane({
      html,
      url: "https://infinite.fast/",
      version: "0.0.0-test",
      fetch: impl
    })
    expect(verification.state).toBe("not_verifiable")
    expect(verification.state === "not_verifiable" && verification.reason).toContain("Could not check")
  })
})

describe("extractMetaPixelIds against the snippet we actually install", () => {
  it("finds the pixel id whether or not Manual Advanced Matching is installed", () => {
    // The advanced-matching accessor adds a SECOND fbq('init', …) call — one with user data, made
    // only when the customer's code calls it. The bootstrap init must stay exactly as it was or the
    // delivery probe stops recognising the pixel it is meant to be checking.
    for (const advancedMatching of [false, true]) {
      const html = `<html><head><script>${buildMetaPixelSnippet("1234567890123456", { advancedMatching })}</script></head></html>`
      expect(extractMetaPixelIds(html)).toEqual(["1234567890123456"])
    }
  })
})
