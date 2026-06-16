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
  it("breaks candidate ties deterministically by sorted apps/ directory name", () => {
    const root = makeTempRoot("instrument-inspect-tiebreak-")
    for (const appName of ["zeta", "alpha"]) {
      mkdirSync(join(root, "apps", appName), { recursive: true })
      writeFileSync(
        join(root, "apps", appName, "index.html"),
        "<html><head></head><body></body></html>\n"
      )
    }

    const result = inspectWorkspace(root)

    expect(result.framework).toBe("static-html")
    expect(result.appRoot).toBe("apps/alpha")
  })

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

  it("keeps static-html below the apply confidence gate when a framework-dep package.json is present", () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "mystery-app", private: true, dependencies: { react: "^18.0.0" } }, null, 2)}\n`
    )

    const result = inspectWorkspace(root)

    expect(result.framework).toBe("static-html")
    expect(result.confidence).toBeLessThan(0.75)
    expect(result.assumptions).toContain(
      "index.html sits next to a package.json, so this may be a framework app rather than a plain static site. Confirm before applying."
    )
  })

  it("treats static-html as confident when package.json has only build/lint tooling (no framework deps)", () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "my-static-site", private: true, devDependencies: { eslint: "^8.0.0", prettier: "^3.0.0" } }, null, 2)}\n`
    )

    const result = inspectWorkspace(root)

    expect(result.framework).toBe("static-html")
    expect(result.confidence).toBeGreaterThanOrEqual(0.75)
  })

  it("keeps plain static sites above the apply confidence gate", () => {
    const root = copyFixture("static-html-basic")

    const result = inspectWorkspace(root)

    expect(result.framework).toBe("static-html")
    expect(result.confidence).toBeGreaterThanOrEqual(0.75)
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

    const providers = detectUnmanagedProviders(root)

    expect(providers).not.toContain("posthog")
  })

  it("flags posthog when a real posthog.init( call is present", () => {
    const root = makeTempRoot("instrument-inspect-posthog-real-")
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import posthog from "posthog-js"',
        'posthog.init("phc_abc123", { api_host: "https://app.posthog.com" })',
        ""
      ].join("\n")
    )

    const providers = detectUnmanagedProviders(root)

    expect(providers).toContain("posthog")
  })

  it("flags posthog when the CDN loader host i.posthog.com is present", () => {
    const root = makeTempRoot("instrument-inspect-posthog-cdn-")
    writeFileSync(
      join(root, "index.html"),
      [
        "<!doctype html><html><head>",
        '  <script>!function(t,e){var o,n,p,r;e.__SV||(e.posthog=t,t._i=[],t.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.init).toString=function(){return"init called"};var u=document.createElement("script");u.type="text/javascript";u.async=!0;u.src="https://i.posthog.com/static/array.js";var l=document.getElementsByTagName("script")[0];l.parentNode.insertBefore(u,l)});',
        "  </script>",
        "</head><body></body></html>",
        ""
      ].join("\n")
    )

    const providers = detectUnmanagedProviders(root)

    expect(providers).toContain("posthog")
  })

  it("does NOT flag ga4 from bare 'google' or 'gtag' in prose", () => {
    const root = makeTempRoot("instrument-inspect-ga4-prose-")
    writeFileSync(
      join(root, "index.html"),
      [
        "<!doctype html><html><head><title>Docs</title></head>",
        "<body><p>We use google analytics but track nothing here. gtag is a product name.</p></body>",
        "</html>",
        ""
      ].join("\n")
    )

    const providers = detectUnmanagedProviders(root)

    expect(providers).not.toContain("ga4")
  })
})
