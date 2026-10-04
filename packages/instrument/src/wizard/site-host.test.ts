// §3y.1: the production host's precedence, the repo candidates (per source; preview-shaped ones dropped), the
// typed-address rules and the `--production-host` flag. Fakes only.
import { describe, expect, it } from "vitest"

import type { TagHosting, TagKeys } from "./contracts/bridge.js"
import { parseWizardArgs } from "./command.js"
import {
  askProductionHost,
  hostRefusalLine,
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
  it("Infinite's site source, then its Vercel connection, then this run's answer, then the flag", () => {
    expect(resolveProductionHost({ keys: keysWith(["Acme.com."]), hosting: hostingWith(["vercel-domain.com"]), flag: "flag.com" })).toEqual({ host: "acme.com", source: "infinite", decided: true })
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith(["vercel-domain.com"]), flag: "flag.com" })).toEqual({ host: "vercel-domain.com", source: "infinite", decided: true })
    const answered = { productionHost: "answer.com", source: "answer" as const, decidedAt: "t" }
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), site: answered, flag: "flag.com" })).toEqual({ host: "answer.com", source: "answer", decided: true })
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), flag: "https://Flag.com/path" })).toEqual({ host: "flag.com", source: "flag", decided: true })
  })

  it("an earlier 'not live yet' is decided (never asked again), but a later flag still names the host", () => {
    const none = { productionHost: null, source: "answer" as const, decidedAt: "t" }
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), site: none })).toEqual({ host: null, source: "answer", decided: true })
    expect(resolveProductionHost({ keys: keysWith([]), hosting: hostingWith([]), site: none, flag: "acme.com" })).toMatchObject({ host: "acme.com", source: "flag" })
  })

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

describe("repoHostCandidates (hints only; read-only)", () => {
  it("reads every source in order, deduped, and drops preview-shaped and malformed hints", async () => {
    const fs = fsOf({
      "/r/apps/web/public/CNAME": "cname-host.com\n",
      "/r/apps/web/src/app/layout.tsx": "export const metadata = { metadataBase: new URL('https://meta-base.com') }",
      "/r/apps/web/next-sitemap.config.js": "module.exports = { siteUrl: 'https://sitemap-host.com' }",
      "/r/apps/web/public/robots.txt": "Sitemap: https://acme-git-main-team.vercel.app/sitemap.xml\nSitemap: https://robots-host.com/s.xml",
      "/r/apps/web/index.html": '<meta content="https://og-host.com/" property="og:url">',
      "/r/apps/web/package.json": JSON.stringify({ homepage: "https://cname-host.com" }),
      "/r/apps/web/.env": "NEXT_PUBLIC_SITE_URL=https://env-host.com"
    })
    const candidates = await repoHostCandidates("/r", "apps/web", fs, { homepageUrl: "https://gh-host.com" })
    expect(candidates).toEqual([
      { host: "cname-host.com", source: "cname", file: "apps/web/public/CNAME" },
      { host: "meta-base.com", source: "next_metadata_base", file: "apps/web/src/app/layout.tsx" },
      { host: "sitemap-host.com", source: "next_sitemap", file: "apps/web/next-sitemap.config.js" },
      // The first Sitemap line is a preview address: dropped (no later line is tried for that file).
      { host: "og-host.com", source: "html_canonical", file: "apps/web/index.html" },
      { host: "gh-host.com", source: "github_homepage", file: null }
    ])
    // Never read from .env*.
    expect(candidates.some((candidate) => candidate.host === "env-host.com")).toBe(false)
  })

  it("a canonical link (either attribute order) and a robots Sitemap", async () => {
    const one = await repoHostCandidates("/r", ".", fsOf({ "/r/index.html": '<link href="https://canon.com/" rel="canonical">', "/r/public/robots.txt": "sitemap: https://robots.com/x" }))
    expect(one.map((candidate) => candidate.host)).toEqual(["robots.com", "canon.com"])
  })

  it("NEGATIVE: a repo with no hint gives none", async () => {
    expect(await repoHostCandidates("/r", ".", fsOf({ "/r/package.json": "{}" }))).toEqual([])
  })
})

describe("askProductionHost", () => {
  it("a chosen candidate is the host; ESC is 'not live yet'", async () => {
    const say: string[] = []
    const ctx = (answers: unknown[]) => ({ ask: (async () => answers.shift()) as never })
    expect(await askProductionHost(ctx(["acme.com"]), [{ host: "acme.com", source: "cname", file: "CNAME" }], (text) => say.push(text))).toBe("acme.com")
    expect(await askProductionHost(ctx(["__cancelled__"]), [], (text) => say.push(text))).toBeNull()
    expect(await askProductionHost(ctx(["__type__", "Acme.COM"]), [], (text) => say.push(text))).toBe("acme.com")
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

const VERCEL_REFUSAL = (host: string) => `Infinite needs your site's own domain. ${host} is a Vercel address — add a custom domain in Vercel, then run npx infinite-tag again.`

describe("--production-host", () => {
  it("is validated like the typed answer; a bad value is a usage error", () => {
    const ok = parseWizardArgs(["--production-host", "https://Acme.com"], "/r")
    expect(ok.ok && ok.value.options.productionHost).toBe("acme.com")
    const bad = parseWizardArgs(["--production-host", "nope"], "/r")
    expect(!bad.ok && bad.message).toContain("isn't a domain name")
    expect(parseWizardArgs(["--production-host"], "/r").ok).toBe(false)
  })

  it("NEGATIVE: every Vercel address is refused with the founder's line: production alias, branch alias, hash URL, bare vercel.app", () => {
    for (const host of Object.values(VERCEL_HOSTS)) {
      const parsed = parseWizardArgs(["--production-host", `https://${host}/`], "/r")
      expect(parsed.ok, host).toBe(false)
      expect(!parsed.ok && parsed.message, host).toBe(`--production-host: ${VERCEL_REFUSAL(host)}`)
      // The flag has no field to press ESC in: no "ESC" or "It isn't live yet" advice (review-2 P3-5).
      expect(!parsed.ok && parsed.message).not.toMatch(/ESC|It isn't live yet|type your own/)
    }
    const netlify = parseWizardArgs(["--production-host", "acme.netlify.app"], "/r")
    expect(!netlify.ok && netlify.message).toBe("--production-host: Infinite needs your site's own domain. acme.netlify.app is a Netlify address — add a custom domain in Netlify, then run npx infinite-tag again.")
  })
})

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

  it("the refusal line says the site needs its own domain and how to add one, per platform; the re-ask adds what to do now", () => {
    expect(hostRefusalLine({ reason: "preview", shown: VERCEL_HOSTS.productionAlias }, "final")).toBe(`! ${VERCEL_REFUSAL(VERCEL_HOSTS.productionAlias)}`)
    const reask = hostRefusalLine({ reason: "preview", shown: VERCEL_HOSTS.productionAlias })
    expect(reask).toBe(`! ${VERCEL_REFUSAL(VERCEL_HOSTS.productionAlias)} Or type your own domain now (ESC if it has none yet).`)
    expect(reask.length).toBeLessThanOrEqual(240)
    // NEGATIVE: never an alias as advice (the old "use your project's address in Vercel › Domains"), never "preview".
    for (const host of Object.values(VERCEL_HOSTS)) {
      const line = hostRefusalLine({ reason: "preview", shown: host })
      expect(line, host).not.toMatch(/Vercel › Domains|e\.g\.|preview/)
    }
    expect(hostRefusalLine({ reason: "preview", shown: "acme.pages.dev" }, "final")).toContain("is a Cloudflare Pages address — add a custom domain in Cloudflare Pages")
    expect(hostRefusalLine({ reason: "preview", shown: "github.io" }, "final")).toContain("is a GitHub Pages address")
    expect(hostRefusalLine({ reason: "preview", shown: "app.localhost" }, "final")).toBe("! Infinite needs your site's own domain. app.localhost is a local address, not your live site.")
    expect(hostRefusalLine({ reason: "not_host", shown: "nope" }, "final")).toBe("! nope isn't a domain name")
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

describe("a refused typed address: the re-ask says why (R2-3)", () => {
  it("the second text question starts with the refusal's reason; a second refusal is 'not live yet'", async () => {
    const asked: Array<{ kind: string; payload: { question?: string } }> = []
    const answers: unknown[] = ["__type__", VERCEL_HOSTS.productionAlias, VERCEL_HOSTS.branchAlias]
    const ctx = { ask: (async (kind: string, payload: { question?: string }) => {
      asked.push({ kind, payload })
      return answers.shift()
    }) as never }
    const said: string[] = []
    expect(await askProductionHost(ctx, [], (text) => said.push(text))).toBeNull()
    const texts = asked.filter((entry) => entry.kind === "text").map((entry) => entry.payload.question ?? "")
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe("Your live site's address (for example acme.com):")
    expect(texts[1]).toContain(VERCEL_REFUSAL(VERCEL_HOSTS.productionAlias))
    // A text field has no "It isn't live yet" option: ESC is the way (review-2 P3-5).
    expect(texts[1]).toContain("(ESC if it has none yet).")
    expect(texts[1]).not.toContain('choose "It isn')
    expect(texts[1]).toMatch(/Your live site's address \(for example acme\.com\):$/)
    expect(said).toEqual([`! ${VERCEL_REFUSAL(VERCEL_HOSTS.productionAlias)} Or type your own domain now (ESC if it has none yet).`, `! ${VERCEL_REFUSAL(VERCEL_HOSTS.branchAlias)}`])
  })

  it("review-2 P3-7: an invalid single-ask answer is re-asked ONCE, and the text question carries the reason", async () => {
    const asked: Array<{ kind: string; payload: { question?: string } }> = []
    const answers: unknown[] = [VERCEL_HOSTS.hashUrl, "acme.com"]
    const ctx = { ask: (async (kind: string, payload: { question?: string }) => {
      asked.push({ kind, payload })
      return answers.shift()
    }) as never }
    const said: string[] = []
    expect(await askProductionHost(ctx, [], (text) => said.push(text))).toBe("acme.com")
    const texts = asked.filter((entry) => entry.kind === "text").map((entry) => entry.payload.question ?? "")
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(VERCEL_REFUSAL(VERCEL_HOSTS.hashUrl))
    expect(texts[0]).toContain("(ESC if it has none yet).")
    expect(texts[0]).toMatch(/Your live site's address \(for example acme\.com\):$/)
    expect(said).toEqual([expect.stringContaining(VERCEL_REFUSAL(VERCEL_HOSTS.hashUrl))])
    // NEGATIVE: only ONE re-ask after an invalid single answer; a second refusal is "not live yet".
    const twice: unknown[] = ["nope", "still nope", "acme.com"]
    expect(await askProductionHost({ ask: (async () => twice.shift()) as never }, [], () => undefined)).toBeNull()
    expect(twice).toEqual(["acme.com"])
  })

  it("NEGATIVE: a production alias typed after a refusal is refused too; a custom domain typed after one is the host", async () => {
    const alias: unknown[] = ["__type__", VERCEL_HOSTS.hashUrl, `https://${VERCEL_HOSTS.productionAlias}/`]
    expect(await askProductionHost({ ask: (async () => alias.shift()) as never }, [], () => undefined)).toBeNull()
    const custom: unknown[] = ["__type__", VERCEL_HOSTS.productionAlias, "https://www.acme-store.com/"]
    expect(await askProductionHost({ ask: (async () => custom.shift()) as never }, [], () => undefined)).toBe("www.acme-store.com")
  })
})
