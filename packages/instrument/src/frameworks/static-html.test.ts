import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { installManifestRelativePath } from "../manifest.js"
import { planInstallation } from "../plan.js"
import { uninstallInstallation } from "../uninstall.js"
import { verifyInstallation } from "../verify.js"
import type { WorkspaceInstallArtifacts } from "../types.js"
import { applyPosthogProxy } from "../workspace-artifacts.js"

import { isVerificationTokenContent } from "./static-html.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-static-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

function writeNestedFile(root: string, relativePath: string, contents: string): void {
  const absolutePath = join(root, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, contents)
}

const artifacts: WorkspaceInstallArtifacts = {
  ga4: { measurementId: "G-TEST123" },
  posthog: { projectKey: "phc_test", apiHost: "https://eu.i.posthog.example" },
  x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("static-html multi-page instrumentation", () => {
  it("injects the managed block into ordinary pages and leaves policy/build/vendor/hidden paths alone", () => {
    const root = copyFixture("static-html-multipage")
    // HTML that must NOT be instrumented (generated output, third-party, hidden).
    writeNestedFile(
      root,
      "node_modules/pkg/index.html",
      "<html><head></head><body>dep</body></html>\n"
    )
    writeNestedFile(root, "dist/index.html", "<html><head></head><body>built</body></html>\n")
    writeNestedFile(root, ".cache/index.html", "<html><head></head><body>cache</body></html>\n")

    const inspectResult = inspectWorkspace(root)
    expect(inspectResult.framework).toBe("static-html")
    // Discovery: index.html first, then sorted; excluded dirs never appear.
    expect(inspectResult.detectedFiles).toEqual(["index.html", "about.html", "privacy/index.html"])

    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts
    })
    expect(plan.blockers).toEqual([])
    expect(plan.files).toEqual(["index.html", "about.html", "privacy/index.html"])

    const applied = applyInstallation({ root, workspaceId: "ws_test", plan })
    expect(applied.changedFiles).toEqual([
      "index.html",
      "about.html",
      installManifestRelativePath
    ])

    for (const page of ["index.html", "about.html"]) {
      const html = readFileSync(join(root, page), "utf8")
      expect(html).toContain("<!-- infinite:start -->")
      expect(html).toContain("G-TEST123")
      expect(html).toContain("phc_test")
      expect(html).toContain("tw-pixel-123")
      // Exactly one managed block per page — no duplication.
      expect(html.match(/infinite:start/g)).toHaveLength(1)
    }

    // Excluded pages remain untouched.
    for (const excluded of [
      "privacy/index.html",
      "node_modules/pkg/index.html",
      "dist/index.html",
      ".cache/index.html"
    ]) {
      expect(readFileSync(join(root, excluded), "utf8")).not.toContain("infinite:start")
    }

    // The manifest records every instrumented page, and verify passes over all of them.
    const manifest = JSON.parse(readFileSync(join(root, installManifestRelativePath), "utf8"))
    expect(manifest.files).toEqual(["index.html", "about.html"])
    const verify = verifyInstallation({ root })
    expect(verify.buildOk).toBe(true)
  })

  it("is idempotent across a re-apply", () => {
    const root = copyFixture("static-html-multipage")
    const firstPlan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts
    })
    applyInstallation({ root, workspaceId: "ws_test", plan: firstPlan })
    const afterFirst = ["index.html", "about.html", "privacy/index.html"].map((p) =>
      readFileSync(join(root, p), "utf8")
    )

    const rerunPlan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts
    })
    const second = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: rerunPlan
    })

    expect(second.changedFiles).toEqual([])
    const afterSecond = ["index.html", "about.html", "privacy/index.html"].map((p) =>
      readFileSync(join(root, p), "utf8")
    )
    expect(afterSecond).toEqual(afterFirst)
  })

  it("restores every page byte-for-byte on uninstall", () => {
    const root = copyFixture("static-html-multipage")
    const before = ["index.html", "about.html", "privacy/index.html"].map((p) =>
      readFileSync(join(root, p), "utf8")
    )

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts
    })
    applyInstallation({ root, workspaceId: "ws_test", plan })

    const result = uninstallInstallation({ root })
    expect(result.restoredFiles).toEqual(["index.html", "about.html"])

    const after = ["index.html", "about.html", "privacy/index.html"].map((p) =>
      readFileSync(join(root, p), "utf8")
    )
    expect(after).toEqual(before)
    expect(existsSync(join(root, ".infinite"))).toBe(false)
  })

  it("blocks the whole plan when any page is missing </head>, naming that page", () => {
    const root = copyFixture("static-html-multipage")
    writeFileSync(
      join(root, "about.html"),
      "<!doctype html>\n<html><body><h1>About</h1></body></html>\n"
    )

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts
    })

    expect(plan.applyMode).toBe("plan-only")
    expect(plan.blockers).toContain(
      "Static HTML apply requires a closing </head> tag in about.html."
    )
    expect(() =>
      applyInstallation({
        root,
        workspaceId: "ws_test",
        plan,
        allowDirty: true
      })
    ).toThrow(/Refusing to apply/)
  })
})

describe("static-html posthog reverse proxy (vercel.json)", () => {
  const proxyArtifacts: WorkspaceInstallArtifacts = applyPosthogProxy(
    {
      posthog: { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" }
    },
    { proxy: true }
  )
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

  function planFor(root: string) {
    return planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
  }

  it("adds vercel.json (once) after the pages, writes the ordered rewrites, and verifies", () => {
    const root = copyFixture("static-html-multipage")
    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    expect(plan.files).toEqual(["index.html", "about.html", "privacy/index.html", "vercel.json"])

    const applied = applyInstallation({ root, workspaceId: "ws_test", plan })
    expect(applied.changedFiles).toEqual([
      "index.html",
      "about.html",
      "vercel.json",
      installManifestRelativePath
    ])
    expect(applied.warnings.join("\n")).toContain("vercel.json rewrites only apply on Vercel")

    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.rewrites).toEqual([US_STATIC, US_ARRAY, US_INGEST])
    // The page snippet uses the first-party path + region ui_host.
    const html = readFileSync(join(root, "index.html"), "utf8")
    expect(html).toContain('api_host: "/ingest"')
    expect(html).toContain('ui_host: "https://us.posthog.com"')

    const manifest = JSON.parse(readFileSync(join(root, installManifestRelativePath), "utf8"))
    expect(manifest.files).toEqual([
      "index.html",
      "about.html",
      "vercel.json"
    ])
    expect(verifyInstallation({ root }).buildOk).toBe(true)
  })

  it("merges into an existing vercel.json, preserving unrelated rewrites + keys", () => {
    const root = copyFixture("static-html-multipage")
    writeFileSync(
      join(root, "vercel.json"),
      `${JSON.stringify({ cleanUrls: true, rewrites: [{ source: "/api/:path*", destination: "/backend/:path*" }] }, null, 2)}\n`
    )

    applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root) })

    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.cleanUrls).toBe(true)
    expect(vercel.rewrites).toEqual([
      { source: "/api/:path*", destination: "/backend/:path*" },
      US_STATIC,
      US_ARRAY,
      US_INGEST
    ])
  })

  it("is idempotent — a re-apply does not rewrite vercel.json", () => {
    const root = copyFixture("static-html-multipage")
    applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root) })
    const before = readFileSync(join(root, "vercel.json"), "utf8")

    const applied = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: planFor(root)
    })
    expect(applied.changedFiles).toEqual([])
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(before)
  })

  it("deletes a created vercel.json on uninstall (collapses to empty)", () => {
    const root = copyFixture("static-html-multipage")
    applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root) })
    expect(existsSync(join(root, "vercel.json"))).toBe(true)

    const result = uninstallInstallation({ root })
    expect(result.removedFiles).toContain("vercel.json")
    expect(existsSync(join(root, "vercel.json"))).toBe(false)
    expect(existsSync(join(root, ".infinite"))).toBe(false)
  })

  it("prunes only our rewrites on uninstall, restoring a pre-existing vercel.json's entries", () => {
    const root = copyFixture("static-html-multipage")
    writeFileSync(
      join(root, "vercel.json"),
      `${JSON.stringify({ rewrites: [{ source: "/api/:path*", destination: "/backend/:path*" }] }, null, 2)}\n`
    )
    applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root) })

    const result = uninstallInstallation({ root })
    expect(result.restoredFiles).toContain("vercel.json")
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.rewrites).toEqual([{ source: "/api/:path*", destination: "/backend/:path*" }])
  })

  it("restores pre-existing formatting byte-for-byte and preserves a customer rule to the Infinite destination", () => {
    const root = copyFixture("static-html-multipage")
    const original = [
      "{",
      '\t"cleanUrls" : true,',
      '\t"rewrites" : [ { "source" : "/customer/events", "destination" : "https://api.ultima.inc/api/analytics/events/collect" } ]',
      "}",
      ""
    ].join("\r\n")
    writeFileSync(join(root, "vercel.json"), original)
    const infiniteArtifacts: WorkspaceInstallArtifacts = {
      infinite: {
        siteSourceKey: "site_public_123",
        collectPath: "/infinite/events/collect",
        productionHosts: ["example.com"],
        staticProxy: "vercel",
        consentMode: "required"
      }
    }
    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: infiniteArtifacts
    })

    applyInstallation({ root, workspaceId: "ws_test", plan })
    const installed = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(installed.rewrites).toContainEqual({
      source: "/customer/events",
      destination: "https://api.ultima.inc/api/analytics/events/collect"
    })
    expect(installed.rewrites).toContainEqual({
      source: "/infinite/events/collect",
      destination: "https://api.ultima.inc/api/analytics/events/collect"
    })

    uninstallInstallation({ root })
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(original)
  })

  it("refuses uninstall after a customer edits installed vercel.json", () => {
    const root = copyFixture("static-html-multipage")
    applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root) })
    const changed = readFileSync(join(root, "vercel.json"), "utf8").replace(
      /\n}\n$/,
      ',\n  "customer": true\n}\n'
    )
    writeFileSync(join(root, "vercel.json"), changed)

    expect(() => uninstallInstallation({ root, allowDirty: true })).toThrow(
      /changed|ownership|hash/i
    )
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(changed)
  })

  it("refuses to overwrite a conflicting same-source rewrite pointing at a non-posthog host", () => {
    const root = copyFixture("static-html-multipage")
    writeFileSync(
      join(root, "vercel.json"),
      `${JSON.stringify({ rewrites: [{ source: "/ingest/:path(.*)", destination: "https://not-posthog.example/:path*" }] }, null, 2)}\n`
    )
    const plan = planFor(root)
    expect(() =>
      applyInstallation({
        root,
        workspaceId: "ws_test",
        plan,
        allowDirty: true
      })
    ).toThrow(/unmanaged destination/)
  })

  it("reapplies PostHog plus Infinite as Infinite-only and restores customer bytes", () => {
    const root = copyFixture("static-html-multipage")
    const original = [
      "{",
      '\t"cleanUrls" : true,',
      '\t"rewrites" : [ { "source" : "/customer/ingest", "destination" : "https://us.i.posthog.com/customer" } ]',
      "}",
      ""
    ].join("\r\n")
    writeFileSync(join(root, "vercel.json"), original)
    const infiniteOnly: WorkspaceInstallArtifacts = {
      productionHosts: ["example.com"],
      infinite: {
        siteSourceKey: "site_public_123",
        collectPath: "/infinite/events/collect",
        productionHosts: ["example.com"],
        staticProxy: "vercel",
        consentMode: "required"
      }
    }
    const mixed = applyPosthogProxy(
      {
        ...infiniteOnly,
        posthog: { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" }
      },
      { proxy: true }
    )

    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: planInstallation({ root, workspaceId: "ws_test", artifacts: mixed })
    })
    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: planInstallation({ root, workspaceId: "ws_test", artifacts: infiniteOnly })
    })

    expect(JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).rewrites).toEqual([
      { source: "/customer/ingest", destination: "https://us.i.posthog.com/customer" },
      {
        source: "/infinite/events/collect",
        destination: "https://api.ultima.inc/api/analytics/events/collect"
      }
    ])
    const manifest = JSON.parse(readFileSync(join(root, installManifestRelativePath), "utf8"))
    expect(manifest.providers).toEqual(["infinite"])

    uninstallInstallation({ root })
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(original)
  })
})

// Meta's domain-verification file (and Google's google<hash>.html) is .html by extension only: its
// body is a bare token the provider checks byte for byte, with no </head>. Before this, one such
// file blocked the WHOLE static-site install. infinite.fast hit the same thing and excluded its own
// file by name (849ccf1 at 9f65b47); a customer's filenames vary, so it is recognised by CONTENT.
describe("static-html domain-verification files", () => {
  // Synthetic tokens in the providers' real shapes (never a real customer's token).
  const META_FILE = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5.html"
  const META_BYTES = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5\n"
  const GOOGLE_FILE = "google0123456789abcdef.html"
  const GOOGLE_BYTES = "google-site-verification: google0123456789abcdef.html"
  const BOM_FILE = "verify/token.html"
  const BOM_BYTES = "\uFEFF  TEST_NOT_REAL_TOKEN_123  \r\n"

  const planFor = (root: string) =>
    planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_test", artifacts })

  it("installs on every real page and leaves each verification file byte-identical", () => {
    const root = copyFixture("static-html-multipage")
    writeNestedFile(root, META_FILE, META_BYTES)
    writeNestedFile(root, GOOGLE_FILE, GOOGLE_BYTES)
    writeNestedFile(root, BOM_FILE, BOM_BYTES)

    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    expect(plan.applyMode).toBe("supported")
    expect(plan.files).toEqual(expect.arrayContaining(["index.html", "about.html", "privacy/index.html"]))
    for (const file of [META_FILE, GOOGLE_FILE, BOM_FILE]) expect(plan.files).not.toContain(file)
    expect(plan.assumptions.join("\n")).toContain(`Left untouched: ${META_FILE}`)
    expect(plan.assumptions.join("\n")).toContain("no <head> is ever added")
    // Labelled by what the bytes show (the token SHAPE), never asserted to BE a verification file:
    // a one-line placeholder page has the same shape.
    expect(plan.assumptions.join("\n")).toContain("look like a verification token (one short line, no markup")
    expect(plan.assumptions.join("\n")).not.toMatch(/(is a|are) domain-verification file/)

    applyInstallation({ root, workspaceId: "ws_test", plan })
    expect(readFileSync(join(root, "about.html"), "utf8")).toContain("<!-- infinite:start -->")
    // Never "fixed" by adding a head, never injected: the provider reads these bytes exactly.
    expect(readFileSync(join(root, META_FILE), "utf8")).toBe(META_BYTES)
    expect(readFileSync(join(root, GOOGLE_FILE), "utf8")).toBe(GOOGLE_BYTES)
    expect(readFileSync(join(root, BOM_FILE), "utf8")).toBe(BOM_BYTES)

    uninstallInstallation({ root, dryRun: false })
    expect(readFileSync(join(root, META_FILE), "utf8")).toBe(META_BYTES)
  })

  it("still blocks a genuinely broken page: markup without </head>, an empty file, or a multi-line text file", () => {
    for (const [name, bytes] of [
      ["broken.html", "<!doctype html>\n<html><body><h1>Broken</h1></body></html>\n"],
      ["empty.html", ""],
      ["notes.html", "first line of prose\nsecond line of prose\n"]
    ] as const) {
      const root = copyFixture("static-html-multipage")
      writeNestedFile(root, name, bytes)
      const plan = planFor(root)
      expect(plan.applyMode).toBe("plan-only")
      expect(plan.blockers).toContain(`Static HTML apply requires a closing </head> tag in ${name}.`)
    }
  })

  it("says a lone one-line page LOOKS like a token, and how to make it a page", () => {
    const root = copyFixture("static-html-multipage")
    writeNestedFile(root, "coming-soon.html", "Coming soon\n")
    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    const assumption = plan.assumptions.find((line) => line.startsWith("Left untouched: coming-soon.html"))
    expect(assumption).toContain("coming-soon.html looks like a verification token")
    expect(assumption).toContain("If it is meant to be a page, it needs real HTML with a </head>")
    expect(assumption).not.toContain("is a domain-verification file")
  })

  it("never treats index.html as a verification file, even when it is a bare token", () => {
    const root = copyFixture("static-html-multipage")
    writeFileSync(join(root, "index.html"), "TEST_NOT_REAL_TOKEN\n")
    expect(planFor(root).blockers).toContain("Static HTML apply requires a closing </head> tag.")
  })

  it("recognises the token shape by content, never by name", () => {
    expect(isVerificationTokenContent("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5\n")).toBe(true)
    expect(isVerificationTokenContent("google-site-verification: google0123456789abcdef.html")).toBe(true)
    expect(isVerificationTokenContent("\uFEFF token \r\n")).toBe(true)
    // Negative cases: markup, emptiness, more than one line, or too long for a token.
    expect(isVerificationTokenContent("<html><head></head></html>")).toBe(false)
    expect(isVerificationTokenContent("token<br>")).toBe(false)
    expect(isVerificationTokenContent("   \n  ")).toBe(false)
    expect(isVerificationTokenContent("line one\nline two")).toBe(false)
    expect(isVerificationTokenContent("x".repeat(257))).toBe(false)
  })
})
