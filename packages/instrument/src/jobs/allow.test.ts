import { describe, expect, it } from "vitest"

import { buildAllow, checkEdit, globalDenyReason, isConsentLine, normalizeRepoPath, touchesConsent, unionAllow } from "./allow.js"
import { globToRegExp, matchesGlob } from "./glob.js"

describe("glob", () => {
  it("compiles the deny-list forms", () => {
    expect(matchesGlob("apps/web/.env.local", "**/.env*")).toBe(true)
    expect(matchesGlob(".env", ".env*")).toBe(true)
    expect(matchesGlob("apps/web/dist/x.js", "**/dist/**")).toBe(true)
    expect(matchesGlob("dist/x.js", "**/dist/**")).toBe(true)
    expect(matchesGlob(".git/config", ".git/**")).toBe(true)
    // Negatives.
    expect(matchesGlob("src/distance.ts", "**/dist/**")).toBe(false)
    expect(matchesGlob("apps/web/env.ts", "**/.env*")).toBe(false)
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false)
  })
})

describe("allowlist rules (§3e.2)", () => {
  const cmpFiles = ["components/cookie-banner.tsx"]

  it("never includes .env*, lockfiles, package.json, build output, node_modules or a CMP file", () => {
    const allow = buildAllow(
      [
        "app/layout.tsx",
        ".env",
        "apps/web/.env.production",
        "pnpm-lock.yaml",
        "apps/web/package-lock.json",
        "yarn.lock",
        "package.json",
        "apps/web/package.json",
        "dist/index.html",
        "build/main.js",
        ".next/server/app.js",
        "apps/web/out/index.html",
        "node_modules/posthog-js/x.js",
        ".infinite/install.json",
        ".claude/settings.json",
        ".codex/config.toml",
        ".git/HEAD",
        "components/cookie-banner.tsx",
        "app/layout.tsx",
        "../outside.ts",
        "/etc/passwd"
      ],
      [],
      cmpFiles
    )
    expect(allow).toEqual({ files: ["app/layout.tsx"], create: [] })
  })

  it("names why a path is denied", () => {
    expect(globalDenyReason("apps/web/.env.local", cmpFiles)).toEqual({ kind: "global_deny", glob: "**/.env*" })
    expect(globalDenyReason("components/cookie-banner.tsx", cmpFiles)).toEqual({ kind: "cmp_file" })
    expect(globalDenyReason("../x", cmpFiles)).toEqual({ kind: "invalid_path" })
    expect(globalDenyReason("app/page.tsx", cmpFiles)).toBeNull()
  })

  it("checks one edit: the deny wins, no deletion, creation only where listed", () => {
    const allow = { files: ["app/layout.tsx"], create: ["lib/new.ts"] }
    expect(checkEdit(allow, "app/layout.tsx", "modify", cmpFiles)).toEqual({ ok: true })
    expect(checkEdit(allow, "lib/new.ts", "create", cmpFiles)).toEqual({ ok: true })
    expect(checkEdit(allow, "README.md", "modify", cmpFiles)).toEqual({ ok: false, reason: "outside_allowlist", path: "README.md" })
    expect(checkEdit(allow, "app/layout.tsx", "delete", cmpFiles)).toEqual({ ok: false, reason: "deletion_refused", path: "app/layout.tsx" })
    expect(checkEdit(allow, "lib/other.ts", "create", cmpFiles)).toEqual({ ok: false, reason: "creation_not_listed", path: "lib/other.ts" })
    expect(checkEdit({ files: [".env"], create: [] }, ".env", "modify", cmpFiles)).toMatchObject({ ok: false, reason: "denied" })
  })

  it("normalises paths and refuses escapes", () => {
    expect(normalizeRepoPath("./app//layout.tsx")).toBe("app/layout.tsx")
    expect(normalizeRepoPath("app/../../x")).toBeNull()
    expect(normalizeRepoPath("C:/x")).toBeNull()
    expect(normalizeRepoPath("app\\x")).toBeNull()
  })

  it("recognises consent calls and CMP APIs (and not ordinary analytics)", () => {
    expect(isConsentLine("gtag('consent', 'update', { ad_storage: 'granted' })")).toBe(true)
    expect(isConsentLine("window.__tcfapi('addEventListener', 2, cb)")).toBe(true)
    expect(isConsentLine("OneTrust.OnConsentChanged(cb)")).toBe(true)
    expect(isConsentLine("posthog.opt_in_capturing()")).toBe(true)
    expect(isConsentLine("localStorage.setItem('analytics_consent', 'granted')")).toBe(true)
    expect(touchesConsent(["infiniteTrack('signup')", "gtag('consent', 'default', {})"])).toBe(true)
    // Negatives.
    expect(isConsentLine("gtag('config', 'G-ABC123')")).toBe(false)
    expect(isConsentLine("infiniteTrack('signup')")).toBe(false)
    expect(touchesConsent(["fbq('init', '1234567890123456')"])).toBe(false)
  })

  it("unions allowlists through the same filter", () => {
    expect(unionAllow([{ files: ["a.ts", "b.ts"], create: [] }, { files: ["b.ts", "package.json"], create: ["c.ts"] }], [])).toEqual({ files: ["a.ts", "b.ts"], create: ["c.ts"] })
  })
})
