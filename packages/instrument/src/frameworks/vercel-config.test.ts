import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { InfiniteProxySpec, PosthogProxySpec } from "../types.js"
import { computeContentHash } from "../manifest.js"

import {
  buildNextConfigSource,
  buildPosthogRewritePairs,
  buildVercelJson,
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

describe("buildPosthogRewritePairs", () => {
  it("orders the assets rule before the catch-all and derives the prefix from proxy.path", () => {
    expect(buildPosthogRewritePairs(usProxy)).toEqual([US_STATIC, US_ARRAY, US_INGEST])
  })

  it("uses the proxy.path prefix rather than a hardcoded /ingest", () => {
    const pairs = buildPosthogRewritePairs({ ...usProxy, path: "/ph" })
    expect(pairs[0].source).toBe("/ph/static/:path(.*)")
    expect(pairs[1].source).toBe("/ph/array/:path(.*)")
    expect(pairs[2].source).toBe("/ph/:path(.*)")
  })
})

describe("buildVercelJson", () => {
  it("emits the three rewrites with a trailing newline", () => {
    const json = buildVercelJson(usProxy)
    expect(json.endsWith("\n")).toBe(true)
    expect(JSON.parse(json)).toEqual({
      rewrites: [US_STATIC, US_ARRAY, US_INGEST]
    })
  })

  it("emits PostHog initialization routes before the exact Infinite collector route", () => {
    expect(JSON.parse(buildVercelJson(mixedProxy))).toEqual({
      rewrites: [US_STATIC, US_ARRAY, US_INGEST, INFINITE_COLLECT]
    })
  })
})

describe("parseVercelConfig", () => {
  it("refuses unparseable JSON and non-object JSON", () => {
    expect(() => parseVercelConfig("{not json")).toThrow(/not valid JSON/)
    expect(() => parseVercelConfig("[]")).toThrow(/not a JSON object/)
    expect(parseVercelConfig('{"rewrites":[]}')).toEqual({ rewrites: [] })
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

  it("replaces our entries in place (no duplication) on a re-merge of a merged config", () => {
    const existing = {
      rewrites: [US_STATIC, { source: "/x/:p*", destination: "/y/:p*" }, US_INGEST]
    }
    const merged = JSON.parse(mergeVercelRewrites(existing, usProxy))
    expect(merged.rewrites).toEqual([
      US_STATIC,
      { source: "/x/:p*", destination: "/y/:p*" },
      US_INGEST,
      US_ARRAY
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
  it("signals collapse when only our rewrites remain", () => {
    const created = parseVercelConfig(buildVercelJson(usProxy))
    expect(pruneVercelRewrites(created, usProxy)).toEqual({ collapsed: true })
  })

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

  it("prunes the exact mixed managed set while preserving unrelated rewrites", () => {
    const unrelated = { source: "/api/:path*", destination: "/backend/:path*" }
    const installed = parseVercelConfig(mergeVercelRewrites({ rewrites: [unrelated] }, mixedProxy))
    const pruned = pruneVercelRewrites(installed, mixedProxy)

    expect(pruned.collapsed).toBe(false)
    expect(JSON.parse(pruned.contents!)).toEqual({ rewrites: [unrelated] })
  })
})

describe("buildNextConfigSource", () => {
  it("stamps the managed banner on line 1 and emits the rewrites", () => {
    const source = buildNextConfigSource(usProxy)
    expect(source.split("\n")[0]).toBe("// Managed by Infinite. Public install artifacts only.")
    expect(source).toContain("async rewrites()")
    expect(source).toContain(
      '{ source: "/ingest/static/:path(.*)", destination: "https://us-assets.i.posthog.com/static/:path" }'
    )
    expect(source).toContain(
      '{ source: "/ingest/array/:path(.*)", destination: "https://us-assets.i.posthog.com/array/:path" }'
    )
    expect(source).toContain(
      '{ source: "/ingest/:path(.*)", destination: "https://us.i.posthog.com/:path" }'
    )
  })

  it("includes the exact Infinite collector rewrite in a mixed Next config", () => {
    const source = buildNextConfigSource(mixedProxy)
    expect(source).toContain(
      '{ source: "/infinite/events/collect", destination: "https://api.ultima.inc/api/analytics/events/collect" }'
    )
  })
})

describe("planNextConfigProxy", () => {
  it("plans a CREATE of next.config.mjs when none exists", () => {
    const dir = makeTempDir()
    const plan = planNextConfigProxy(dir, usProxy)
    expect(plan.blockers).toEqual([])
    expect(plan.files).toEqual(["next.config.mjs"])
    expect(plan.instructions[0].action).toBe("create")
    expect(plan.instructions[0].path).toBe("next.config.mjs")
  })

  it("emits a blocker + manual instruction for an existing UNMANAGED next.config", () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "next.config.js"), "module.exports = {}\n")
    const plan = planNextConfigProxy(dir, usProxy)
    expect(plan.files).toEqual([])
    expect(plan.blockers.length).toBeGreaterThan(0)
    expect(plan.blockers[0]).toContain("next.config.js")
    expect(plan.instructions[0].action).toBe("modify")
    expect(plan.instructions[0].snippet).toContain("/ingest/static/:path(.*)")
  })

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

  it("proves exact rewrites in a typed next.config.ts", () => {
    const dir = makeTempDir()
    const exact = buildNextConfigSource(usProxy)
      .split("\n")
      .filter((line) => line.includes("{ source:"))
      .join("\n")
    writeFileSync(
      join(dir, "next.config.ts"),
      `import type { NextConfig } from "next"\nconst config: NextConfig = { async rewrites() { return [${exact}] } }\nexport default config\n`
    )

    expect(planNextConfigProxy(dir, usProxy)).toMatchObject({
      blockers: [],
      files: []
    })
  })

  it("treats a hash-owned MANAGED next.config.mjs as the idempotent re-apply", () => {
    const dir = makeTempDir()
    const source = buildNextConfigSource(usProxy)
    writeFileSync(join(dir, "next.config.mjs"), source)
    const plan = planNextConfigProxy(dir, usProxy, {
      "next.config.mjs": {
        kind: "created",
        installedHash: computeContentHash(source)
      }
    })
    expect(plan.blockers).toEqual([])
    expect(plan.files).toEqual(["next.config.mjs"])
    expect(plan.instructions[0].action).toBe("create")
  })
})
