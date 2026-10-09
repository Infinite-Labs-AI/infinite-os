// §3y.1: the production host's precedence, the repo candidates (per source; preview-shaped ones dropped), the
// typed-address rules and the `--production-host` flag. Fakes only.
import { describe, expect, it } from "vitest"

import type { TagHosting, TagKeys } from "./contracts/bridge.js"
import { parseWizardArgs } from "./command.js"
import {
  askProductionHost,
  isPreviewShapedHost,
  parseHostInput,
  repoHostCandidates,
  resolveProductionHost
} from "./site-host.js"

function fsOf(files: Record<string, string>) {
  return { readText: async (path: string) => files[path] ?? null }
}

const keysWith = (hosts: string[]): Pick<TagKeys, "infinite"> => ({
  infinite: { status: hosts.length > 0 ? "ready" : "not_provisioned", siteSourceKey: hosts.length > 0 ? "site_x" : null, productionHosts: hosts, consentMode: null, consentStorageKey: null, collectPath: null }
})
const hostingWith = (domains: string[]): TagHosting =>
  domains.length === 0
    ? { provider: "none", vercel: null }
    : {
        provider: "vercel",
        vercel: { projectRef: "p", projectName: "acme", productionBranch: "main", rootDirectory: null, framework: null, productionDomains: domains, productionAliases: [], envWriteGranted: false, previewProtection: "none" }
      }

describe("resolveProductionHost (§3y.1 precedence)", () => {
  it("NEGATIVE: nothing known → undecided (the one ask), and a preview-shaped flag is never a host", () => {
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]) })).toEqual({ host: null, source: null, decided: false })
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), flag: "acme-git-main-team.vercel.app" }).decided).toBe(false)
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), flag: "acme-a1b2c3d4e-team.vercel.app" }).decided).toBe(false)
    // Founder ruling 2026-10-03: a project's production alias is never a host either.
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), flag: "acme.vercel.app" }).decided).toBe(false)
  })
})

describe("parseHostInput", () => {
  it("accepts a host or an https URL; refuses non-hosts and preview-shaped hosts", () => {
    expect(parseHostInput(" WWW.Acme.com ")).toEqual({ ok: true, host: "www.acme.com" })
    expect(parseHostInput("https://acme.com/pricing?x=1")).toEqual({ ok: true, host: "acme.com" })
    expect(parseHostInput("acme.com/pricing")).toEqual({ ok: true, host: "acme.com" })
    expect(parseHostInput("not a host")).toMatchObject({ ok: false, reason: "not_host" })
    expect(parseHostInput("localhost")).toMatchObject({ ok: false, reason: "not_host" })
    for (const preview of ["shop-git-main-acme.vercel.app", "shop-a1b2c3d4e-acme.vercel.app", "a.shop.vercel.app", "shop.netlify.app", "shop.pages.dev", "app.localhost"]) {
      expect(parseHostInput(preview), preview).toMatchObject({ ok: false, reason: "preview" })
      expect(isPreviewShapedHost(preview)).toBe(true)
    }
  })
})

/** Every Vercel address shape: none is ever the production host (founder ruling 2026-10-03). */
const VERCEL_HOSTS = {
  productionAlias: "example-shop-site.vercel.app",
  teamAlias: "example-shop-site-example-team.vercel.app",
  branchAlias: "example-shop-site-git-main-example-team.vercel.app",
  hashUrl: "example-shop-site-mix177n53-example-team.vercel.app",
  bare: "vercel.app"
} as const

describe("only a custom domain is a production host (founder ruling 2026-10-03)", () => {
  it("NEGATIVE: every *.vercel.app is refused — the production alias, the team alias, a branch alias, a hash URL, a nested host", () => {
    for (const host of [...Object.values(VERCEL_HOSTS), "acme.vercel.app", "ACME.vercel.app.", "acme2.vercel.app", "www.acme.vercel.app"]) {
      expect(parseHostInput(host), host).toMatchObject({ ok: false, reason: "preview" })
      expect(isPreviewShapedHost(host), host).toBe(true)
    }
  })

  it("NEGATIVE: every bare platform domain is refused (vercel.app, netlify.app, pages.dev, github.io), and their subdomains", () => {
    for (const host of ["vercel.app", "netlify.app", "pages.dev", "github.io", "Vercel.App.", "acme.netlify.app", "acme.pages.dev"]) {
      expect(parseHostInput(host), host).toMatchObject({ ok: false, reason: "preview" })
      expect(isPreviewShapedHost(host), host).toBe(true)
      expect(parseWizardArgs(["--production-host", host], "/r").ok, host).toBe(false)
    }
  })

  it("a custom domain is accepted, a look-alike of a platform name included", () => {
    for (const host of ["acme.com", "www.acme-store.com", "myvercel.app", "notvercel.app", "vercel.app.acme.com"]) {
      expect(parseHostInput(host), host).toEqual({ ok: true, host })
      expect(isPreviewShapedHost(host), host).toBe(false)
    }
  })

  it("NEGATIVE: the host ask never offers a *.vercel.app candidate, from any repo file or the GitHub homepage", async () => {
    const candidates = await repoHostCandidates(
      "/r",
      ".",
      fsOf({
        "/r/public/CNAME": `${VERCEL_HOSTS.productionAlias}\n`,
        "/r/app/layout.tsx": `export const metadata = { metadataBase: new URL("https://${VERCEL_HOSTS.teamAlias}") }`,
        "/r/public/robots.txt": "Sitemap: https://vercel.app/sitemap.xml",
        "/r/package.json": JSON.stringify({ homepage: "https://acme.github.io" })
      }),
      { homepageUrl: `https://${VERCEL_HOSTS.productionAlias}` }
    )
    expect(candidates).toEqual([])
    const asked: Array<{ default?: unknown; options?: Array<{ value: string }> }> = []
    const ctx = { ask: (async (_kind: string, payload: { default?: unknown; options?: Array<{ value: string }> }) => {
      asked.push(payload)
      return "__none__"
    }) as never }
    await askProductionHost(ctx, candidates, () => undefined)
    expect(asked[0]!.options!.map((option) => option.value)).toEqual(["__type__", "__none__"])
    expect(asked[0]!.default).toBe("__type__")
  })
})

