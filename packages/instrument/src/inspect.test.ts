import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { detectUnmanagedProviders, inspectWorkspace } from "./inspect.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = makeTempRoot(`instrument-inspect-${name}-`)
  const target = join(targetRoot, name)
  cpSync(source, target, { recursive: true })
  return target
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("inspectWorkspace app root confinement", () => {
  it("refuses a relative app root that escapes the workspace root", () => {
    const root = copyFixture("static-html-basic")

    expect(() => inspectWorkspace(root, { appRoot: "../../etc" })).toThrow(
      /escapes the workspace root/
    )
  })

  it("refuses an absolute app root outside the workspace root and writes nothing", () => {
    const root = copyFixture("static-html-basic")
    const outside = makeTempRoot("instrument-inspect-outside-")
    const escapeTarget = join(outside, "victim")

    expect(() => inspectWorkspace(root, { appRoot: escapeTarget })).toThrow(
      /escapes the workspace root/
    )
    expect(existsSync(escapeTarget)).toBe(false)
  })

  it("refuses an app root that is a symlink pointing outside the workspace root", () => {
    const root = makeTempRoot("instrument-inspect-symlink-")
    const outside = makeTempRoot("instrument-inspect-symlink-target-")
    writeFileSync(join(outside, "index.html"), "<html><head></head><body></body></html>\n")
    symlinkSync(outside, join(root, "linked"))

    expect(() => inspectWorkspace(root, { appRoot: "linked" })).toThrow(
      /outside the workspace root/
    )
  })

  it("still accepts a legitimate relative app root inside the workspace root", () => {
    const root = makeTempRoot("instrument-inspect-nested-")
    const source = join(fixtureRoot, "../test/fixtures", "vite-react-basic")
    cpSync(source, join(root, "web"), { recursive: true })

    const result = inspectWorkspace(root, { appRoot: "web" })

    expect(result.framework).toBe("vite-react")
    expect(result.appRoot).toBe("web")
    expect(result.blockers).toEqual([])
  })
})

describe("inspectWorkspace detection robustness", () => {
  it("flags hybrid Next.js repos and still selects the app router", () => {
    const root = copyFixture("next-app-router-basic")
    mkdirSync(join(root, "pages"), { recursive: true })
    writeFileSync(
      join(root, "pages", "index.tsx"),
      "export default function Legacy(): null {\n  return null\n}\n"
    )

    const result = inspectWorkspace(root)

    expect(result.framework).toBe("next-app-router")
    expect(result.assumptions).toContain(
      "Both app/ and pages/ router trees were detected. App Router wiring was selected; confirm the app/ tree is the active router before applying."
    )
  })
})

describe("detectUnmanagedProviders — FIX 3: tighter provider markers", () => {
  it("does NOT flag posthog from bare product-name copy in an HTML file", () => {
    const root = makeTempRoot("instrument-inspect-posthog-copy-")
    writeFileSync(
      join(root, "index.html"),
      [
        "<!doctype html>",
        "<html><head><title>Analytics comparison</title></head>",
        "<body>",
        "  <p>We evaluated posthog and decided to use our own system.</p>",
        "</body></html>",
        ""
      ].join("\n")
    )

    const providers = detectUnmanagedProviders(root).map((entry) => entry.provider)

    expect(providers).not.toContain("posthog")
  })
})

describe("detectUnmanagedProviders — comment/string-safe provider evidence", () => {
  // A commented-out or in-string provider snippet must NOT be counted as an existing install — that
  // false ADOPTION would silently suppress the provider (no pixel installed anywhere).
  function mainTsx(root: string, body: string): void {
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src/main.tsx"), body)
  }

  it("ignores a COMMENTED posthog.init( (the live repro)", () => {
    const root = makeTempRoot("instrument-inspect-posthog-comment-")
    mainTsx(
      root,
      [
        'import { createRoot } from "react-dom/client"',
        '// posthog.init("phc_example", { api_host: "https://us.i.posthog.com" })',
        "createRoot(document.getElementById(\"root\")!).render(null)",
        ""
      ].join("\n")
    )
    expect(detectUnmanagedProviders(root).map((entry) => entry.provider)).not.toContain("posthog")
  })

  it("STILL flags a real call in code (regression): gtag( / posthog.init( / fbq( / twq(", () => {
    const root = makeTempRoot("instrument-inspect-real-calls-")
    mainTsx(
      root,
      [
        "gtag('js', new Date())",
        'posthog.init("phc_real", { api_host: "https://us.i.posthog.com" })',
        "fbq('init', '123456')",
        "twq('init', 'abcde')",
        ""
      ].join("\n")
    )
    const providers = detectUnmanagedProviders(root).map((entry) => entry.provider)
    expect(providers).toEqual(expect.arrayContaining(["ga4", "posthog", "x", "meta"]))
  })
})

describe("detectUnmanagedProviders — repo-wide walk + Tag Manager", () => {
  it("never adopts GA4 from a bare GTM-XXXX token or a bare dataLayer.push( — a false positive silently drops a provider", () => {
    const tokenRoot = makeTempRoot("instrument-inspect-gtm-token-")
    mkdirSync(join(tokenRoot, "app"), { recursive: true })
    writeFileSync(join(tokenRoot, "app/layout.tsx"), "export const GTM_MODE = 'GTM-CONTAINERLESS'\nconst id = 'GTM-WXYZ99'\n")
    expect(detectUnmanagedProviders(tokenRoot)).toEqual([])

    const pushRoot = makeTempRoot("instrument-inspect-datalayer-push-")
    writeFileSync(join(pushRoot, "index.html"), "<script>window.dataLayer = window.dataLayer || []; dataLayer.push({event: 'purchase'})</script>\n")
    expect(detectUnmanagedProviders(pushRoot)).toEqual([])

    const snippetRoot = makeTempRoot("instrument-inspect-gtag-push-")
    writeFileSync(
      join(snippetRoot, "index.html"),
      "<script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date());</script>\n"
    )
    expect(detectUnmanagedProviders(snippetRoot)).toEqual([
      { provider: "ga4", via: "snippet", file: "index.html" }
    ])
  })

  it.each([
    ["@next/third-parties/google <GoogleAnalytics>", "app/layout.tsx", "import { GoogleAnalytics } from '@next/third-parties/google'\nexport default function Layout() { return <GoogleAnalytics gaId=\"G-ABC123\" /> }\n"],
  ])("adopts GA4 installed through %s (else the site gets double-tagged)", (_label, file, contents) => {
    const root = makeTempRoot("instrument-inspect-ga4-lib-")
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
    expect(detectUnmanagedProviders(root)).toEqual([{ provider: "ga4", via: "snippet", file }])
  })

  it("skips node_modules, build output, dot-dirs, and oversized files", () => {
    const root = makeTempRoot("instrument-inspect-skip-")
    for (const dir of ["node_modules/foo", ".git", ".next", "dist", "build", "out", ".vercel", "coverage"]) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, "gtag.js"), "gtag('config','G-1')\n")
    }
    writeFileSync(join(root, "huge.js"), `${"//".padEnd(600 * 1024, "x")}\ngtag('config','G-1')\n`)
    writeFileSync(join(root, "notes.md"), "gtag('config','G-1')\n")

    expect(detectUnmanagedProviders(root)).toEqual([])
  })

  it("ignores managed Infinite files and managed HTML blocks", () => {
    const root = makeTempRoot("instrument-inspect-managed-")
    mkdirSync(join(root, "lib"), { recursive: true })
    writeFileSync(
      join(root, "lib/infinite-analytics.ts"),
      "// Managed by Infinite. Public install artifacts only.\ngtag('config','G-1')\nposthog.init('phc_1')\n"
    )
    writeFileSync(
      join(root, "index.html"),
      "<html><head><!-- infinite:start -->\n<script>fbq('init','1')</script>\n<!-- infinite:end --></head><body></body></html>\n"
    )

    expect(detectUnmanagedProviders(root)).toEqual([])
  })
})

