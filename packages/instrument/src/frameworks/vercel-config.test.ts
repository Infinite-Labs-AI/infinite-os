import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { InfiniteProxySpec, PosthogProxySpec } from "../types.js"

import {
  buildNextConfigSource,
  buildPosthogRewritePairs,
  buildVercelJson,
  hasExactNextConfigRewrites,
  mergeVercelRewrites,
  parseVercelConfig,
  planNextConfigProxy,
  pruneVercelRewrites
} from "./vercel-config.js"

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "instrument-vercel-config-"))
  tempRoots.push(dir)
  return dir
}

const usProxy: PosthogProxySpec = {
  path: "/ingest",
  assetsHost: "https://us-assets.i.posthog.com",
  ingestHost: "https://us.i.posthog.com"
}
const infiniteProxy: InfiniteProxySpec = {
  path: "/infinite/events/collect",
  destination: "https://api.ultima.inc/api/analytics/events/collect"
}
const mixedProxy = { posthog: usProxy, infinite: infiniteProxy }
const INFINITE_COLLECT = {
  source: "/infinite/events/collect",
  destination: "https://api.ultima.inc/api/analytics/events/collect"
}

const US_STATIC = {
  source: "/ingest/static/:path(.*)",
  destination: "https://us-assets.i.posthog.com/static/:path"
}
const US_ARRAY = {
  source: "/ingest/array/:path(.*)",
  destination: "https://us-assets.i.posthog.com/array/:path"
}
const US_INGEST = {
  source: "/ingest/:path(.*)",
  destination: "https://us.i.posthog.com/:path"
}

it("refuses an escaped string whose decoded source collides with a managed rewrite", () => {
  const pairs = buildPosthogRewritePairs(usProxy).map((pair) => JSON.stringify(pair)).join(",")
  const escaped = "/ingest/:path" + String.fromCharCode(92) + "x28.*)"
  const config = `module.exports = { async rewrites() { return [{ source: "${escaped}", destination: "https://evil.example/:path" }, ${pairs}] } }`
  expect(hasExactNextConfigRewrites(config, usProxy)).toBe(false)
})

describe("buildVercelJson", () => {
  it("emits PostHog initialization routes before the exact Infinite collector route", () => {
    expect(JSON.parse(buildVercelJson(mixedProxy))).toEqual({
      rewrites: [US_STATIC, US_ARRAY, US_INGEST, INFINITE_COLLECT]
    })
  })
})

describe("mergeVercelRewrites", () => {
  it("is idempotent — re-merging a freshly built file is byte-identical", () => {
    const fresh = buildVercelJson(usProxy)
    expect(mergeVercelRewrites(parseVercelConfig(fresh), usProxy)).toBe(fresh)
  })

  it("appends our rewrites into an existing config, preserving other keys + entries in order", () => {
    const existing = {
      cleanUrls: true,
      rewrites: [{ source: "/api/:path*", destination: "/backend/:path*" }]
    }
    const merged = JSON.parse(mergeVercelRewrites(existing, usProxy))
    expect(merged.cleanUrls).toBe(true)
    expect(merged.rewrites).toEqual([
      { source: "/api/:path*", destination: "/backend/:path*" },
      US_STATIC,
      US_ARRAY,
      US_INGEST
    ])
  })

  it("refuses when a same-source rewrite already points at a non-PostHog destination", () => {
    const existing = {
      rewrites: [{ source: "/ingest/:path(.*)", destination: "/somewhere-else/:path*" }]
    }
    expect(() => mergeVercelRewrites(existing, usProxy)).toThrow(/unmanaged destination/)
  })

  it("refuses an unmanaged destination at the Infinite collector path", () => {
    const existing = {
      rewrites: [
        {
          source: "/infinite/events/collect",
          destination: "https://evil.example/events"
        }
      ]
    }
    expect(() => mergeVercelRewrites(existing, mixedProxy)).toThrow(/unmanaged destination/)
  })
})

describe("pruneVercelRewrites", () => {
  it("keeps unrelated rewrites + other keys and drops only ours", () => {
    const existing = {
      cleanUrls: true,
      rewrites: [
        US_STATIC,
        US_ARRAY,
        { source: "/api/:path*", destination: "/backend/:path*" },
        US_INGEST
      ]
    }
    const pruned = pruneVercelRewrites(existing, usProxy)
    expect(pruned.collapsed).toBe(false)
    const parsed = JSON.parse(pruned.contents!)
    expect(parsed.cleanUrls).toBe(true)
    expect(parsed.rewrites).toEqual([{ source: "/api/:path*", destination: "/backend/:path*" }])
  })

  it("does not claim same-source rewrites with destinations outside the exact install spec", () => {
    const euManaged = {
      rewrites: [
        {
          source: "/ingest/static/:path(.*)",
          destination: "https://eu-assets.i.posthog.com/static/:path"
        },
        {
          source: "/ingest/array/:path(.*)",
          destination: "https://eu-assets.i.posthog.com/array/:path"
        },
        {
          source: "/ingest/:path(.*)",
          destination: "https://eu.i.posthog.com/:path"
        }
      ]
    }
    expect(JSON.parse(pruneVercelRewrites(euManaged, usProxy).contents!)).toEqual(euManaged)
  })
})

describe("planNextConfigProxy", () => {
  it("does not prove commented, spread, or duplicate rewrite definitions", () => {
    const dir = makeTempDir()
    const exact = buildNextConfigSource(usProxy)
      .split("\n")
      .filter((line) => line.includes("{ source:"))
      .join("\n")
    for (const source of [
      `// ${exact.replaceAll("\n", "\n// ")}\nmodule.exports = {}\n`,
      `const inherited = [${exact}]\nmodule.exports = { async rewrites() { return [...inherited] } }\n`,
      `module.exports = { async rewrites() { return [${exact}] }, rewrites: async () => [] }\n`,
      `const config = { async rewrites() { return [${exact}] } }\nconfig.rewrites = async () => []\nexport default config\n`
    ]) {
      writeFileSync(join(dir, "next.config.js"), source)
      expect(planNextConfigProxy(dir, usProxy).blockers).not.toEqual([])
    }
  })
})
