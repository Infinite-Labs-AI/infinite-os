import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  META_SIGNALS_CONFIG_VERSION,
  extractMetaPixelIds,
  metaSignalsConfigUrl,
  parseMetaConfigEntry,
  probeMetaDelivery
} from "./config-probe.js"
import { isMetaDeliveryFailure, maskPixelId, metaDeliveryHeadline } from "./copy.js"
import { checkMetaLane, sha256Hex } from "./lane.js"

/**
 * THE REAL THING. Captured 2026-09-21 from
 * `connect.facebook.net/signals/config/914812061724377?v=2.9.403&r=stable&domain=example.com`
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

const PIXEL = "914812061724377"

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

describe("the blocked-config fixture", () => {
  it("carries Meta's verbatim traffic-permissions veto", () => {
    expect(BLOCKED_CONFIG).toContain(
      `config.set("${PIXEL}", "prohibitedPixels", {"lockWebpage":false,"blockReason":"traffic_permissions"});`
    )
  })
})

describe("parseMetaConfigEntry", () => {
  it("reads the block directive out of the real payload", () => {
    const entry = parseMetaConfigEntry(BLOCKED_CONFIG, PIXEL, "prohibitedPixels")
    expect(entry).toEqual({
      kind: "present",
      value: { lockWebpage: false, blockReason: "traffic_permissions" }
    })
  })

  it("reports an absent key as absent, never as a parse failure", () => {
    expect(parseMetaConfigEntry(ALLOWED_CONFIG, PIXEL, "prohibitedPixels")).toEqual({ kind: "absent" })
  })

  it("separates 'not there' from 'there but unreadable' — the false-green guard", () => {
    // If Meta ever changes the literal's shape, this must NOT read as a healthy pixel.
    const mangled = `config.set("${PIXEL}", "prohibitedPixels", {lockWebpage: false,});`
    const entry = parseMetaConfigEntry(mangled, PIXEL, "prohibitedPixels")
    expect(entry.kind).toBe("unparseable")
  })

  it("does not confuse one pixel's entry for another's", () => {
    expect(parseMetaConfigEntry(BLOCKED_CONFIG, "111111111111111", "prohibitedPixels")).toEqual({
      kind: "absent"
    })
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

  it("is not a Graph call, so it spends nothing from the shared Meta request budget", () => {
    expect(new URL(metaSignalsConfigUrl(PIXEL, "infinite.fast")).hostname).toBe("connect.facebook.net")
  })
})

describe("extractMetaPixelIds", () => {
  it("finds the id in the bootstrap this package writes and de-duplicates it", () => {
    const html = `<script>fbq('set','autoConfig','false','${PIXEL}');fbq('init', '${PIXEL}');fbq('track','PageView');fbq("init", "222222222222")</script>`
    expect(extractMetaPixelIds(html)).toEqual([PIXEL, "222222222222"])
  })

  it("returns nothing for a page with no Meta pixel", () => {
    expect(extractMetaPixelIds("<html><body>hi</body></html>")).toEqual([])
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

  it("classifies a clean config as allowed", async () => {
    const { impl } = stubFetch(200, ALLOWED_CONFIG)
    const finding = await probeMetaDelivery({
      pixelId: PIXEL,
      domain: "infinite.fast",
      version: "0.0.0-test",
      fetch: impl,
      sha256Hex
    })
    expect(finding.kind).toBe("allowed")
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

  it("reports an unknown id as pixel_not_found (Meta answers 404)", async () => {
    const { impl } = stubFetch(404, "")
    const finding = await probeMetaDelivery({
      pixelId: "000000000000000",
      domain: "infinite.fast",
      version: "0.0.0-test",
      fetch: impl,
      sha256Hex
    })
    expect(finding.kind).toBe("pixel_not_found")
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
  it("names the symptom, the cause, the remedy and the consequence", () => {
    const text = metaDeliveryHeadline({
      kind: "blocked",
      pixelId: PIXEL,
      domain: "infinite.fast",
      blockReason: "traffic_permissions",
      lockWebpage: false
    })
    expect(text).toContain("BLOCKED FROM TRANSMITTING on infinite.fast")
    expect(text).toContain("blockReason=traffic_permissions")
    expect(text).toContain("Traffic permissions")
    expect(text).toContain("_fbp/_fbc")
    expect(text).toContain("https://www.facebook.com/business/help/")
  })

  it("masks the pixel id rather than printing it whole", () => {
    expect(maskPixelId(PIXEL)).toBe("914812…4377")
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

  it("treats blocked, source_blocked and pixel_not_found as failures and the rest as not", () => {
    expect(isMetaDeliveryFailure({ kind: "blocked", pixelId: PIXEL, domain: "d", blockReason: "r", lockWebpage: false })).toBe(true)
    expect(isMetaDeliveryFailure({ kind: "source_blocked", pixelId: PIXEL, domain: "d" })).toBe(true)
    expect(isMetaDeliveryFailure({ kind: "pixel_not_found", pixelId: PIXEL, domain: "d" })).toBe(true)
    expect(isMetaDeliveryFailure({ kind: "allowed", pixelId: PIXEL, domain: "d" })).toBe(false)
    expect(isMetaDeliveryFailure({ kind: "unknown", pixelId: PIXEL, domain: "d", detail: "x" })).toBe(false)
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

  it("says so plainly when the page has no Meta pixel at all", async () => {
    const { impl, urls } = stubFetch(200, ALLOWED_CONFIG)
    const { verification } = await checkMetaLane({
      html: "<html></html>",
      url: "https://infinite.fast/",
      version: "0.0.0-test",
      fetch: impl
    })
    expect(verification.state).toBe("not_verifiable")
    expect(verification.state === "not_verifiable" && verification.reason).toContain("no fbq('init'")
    // No pixel means no probe: we do not call Meta to learn nothing.
    expect(urls).toEqual([])
  })

  it("reports BLOCKED when one of two pixels is blocked — the worst answer wins", async () => {
    const two = `<script>fbq('init','${PIXEL}');fbq('init','222222222222');</script>`
    const impl = (async (input: RequestInfo | URL) =>
      String(input).includes(PIXEL)
        ? new Response(BLOCKED_CONFIG, { status: 200 })
        : new Response(ALLOWED_CONFIG.replaceAll(PIXEL, "222222222222"), { status: 200 })) as unknown as typeof fetch

    const { verification } = await checkMetaLane({
      html: two,
      url: "https://infinite.fast/",
      version: "0.0.0-test",
      fetch: impl
    })
    expect(verification.state).toBe("no_receipt")
    expect(verification.state === "no_receipt" && verification.causes[0]).toContain("BLOCKED")
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
