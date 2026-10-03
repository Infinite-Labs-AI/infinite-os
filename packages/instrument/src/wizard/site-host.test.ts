// §3y.1: the production host's precedence, the repo candidates (per source; preview-shaped ones dropped), the
// typed-address rules and the `--production-host` flag. Fakes only.
import { describe, expect, it } from "vitest"

import type { TagHosting, TagKeys } from "./contracts/bridge.js"
import { parseWizardArgs } from "./command.js"
import {
  askProductionHost,
  candidateLabel,
  hostRefusalLine,
  isPreviewShapedHost,
  isVercelPreviewShape,
  parseHostInput,
  repoHostCandidates,
  resolveProductionHost,
  vercelProductionAliasFrom
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

describe("--production-host", () => {
  it("is validated like the typed answer; a bad value is a usage error", () => {
    const ok = parseWizardArgs(["--production-host", "https://Acme.com"], "/r")
    expect(ok.ok && ok.value.options.productionHost).toBe("acme.com")
    const preview = parseWizardArgs(["--production-host", "acme-git-main-team.vercel.app"], "/r")
    expect(preview.ok).toBe(false)
    expect(!preview.ok && preview.message).toContain("Vercel preview address")
    const netlify = parseWizardArgs(["--production-host", "acme.netlify.app"], "/r")
    expect(!netlify.ok && netlify.message).toContain("preview-style address")
    // A Vercel production alias is the user's explicit answer (live run 2): accepted.
    const alias = parseWizardArgs(["--production-host", "https://infinite-tag-smoke-site.vercel.app"], "/r")
    expect(alias.ok && alias.value.options.productionHost).toBe("infinite-tag-smoke-site.vercel.app")
    const bad = parseWizardArgs(["--production-host", "nope"], "/r")
    expect(!bad.ok && bad.message).toContain("isn't a domain name")
    expect(parseWizardArgs(["--production-host"], "/r").ok).toBe(false)
  })
})

describe("a Vercel production alias is a production host (live run 2)", () => {
  it("<project>.vercel.app is accepted; branch aliases, deployment URLs and nested hosts stay preview-shaped", () => {
    for (const alias of ["infinite-tag-smoke-site.vercel.app", "acme.vercel.app", "acme-chaos-edge.vercel.app", "my-marketing-site.vercel.app"]) {
      expect(parseHostInput(alias), alias).toEqual({ ok: true, host: alias })
      expect(isPreviewShapedHost(alias), alias).toBe(false)
    }
    // NEGATIVES: Vercel's preview shapes never answer the ask.
    for (const preview of [
      "infinite-tag-smoke-site-git-infinite-tag-2026-10-03-chaos-edge.vercel.app",
      "infinite-tag-smoke-site-mix177n53-chaos-edge.vercel.app",
      "infinite-tag-smoke-site-4v41bifkj-chaos-edge.vercel.app",
      "www.acme.vercel.app",
      // 1bu-1's rule exactly (fail closed): a hash-shaped LAST segment is a deployment URL too.
      "acme-a1b2c3d4e.vercel.app"
    ]) {
      expect(isVercelPreviewShape(preview), preview).toBe(true)
      expect(parseHostInput(preview), preview).toMatchObject({ ok: false, reason: "preview" })
    }
  })

  it("a refused Vercel preview names the alias to give instead, in full", () => {
    const line = hostRefusalLine({ reason: "preview", shown: "infinite-tag-smoke-site-mix177n53-chaos-edge.vercel.app" })
    expect(line).toContain("infinite-tag-smoke-site.vercel.app")
    expect(line).toContain("Vercel preview address")
    expect(hostRefusalLine({ reason: "preview", shown: "acme-git-main-team.vercel.app" })).toContain("acme.vercel.app")
  })

  it("the GitHub Production deployment URL (live smoke shape) names the alias; a monorepo environment names the project", () => {
    expect(vercelProductionAliasFrom("https://infinite-tag-smoke-site-mix177n53-chaos-edge.vercel.app")).toBe("infinite-tag-smoke-site.vercel.app")
    expect(vercelProductionAliasFrom(null, "Production – web")).toBe("web.vercel.app")
    // NEGATIVES: a custom domain or an unshaped URL names nothing.
    expect(vercelProductionAliasFrom("https://acme.com")).toBeNull()
    expect(vercelProductionAliasFrom("https://acme.vercel.app")).toBeNull()
    expect(vercelProductionAliasFrom("not a url")).toBeNull()
    expect(vercelProductionAliasFrom(null, "Production")).toBeNull()
  })

  it("the alias is offered as a candidate, labelled with where it came from", async () => {
    const candidates = await repoHostCandidates("/r", ".", fsOf({}), { vercelProductionAlias: "infinite-tag-smoke-site.vercel.app" })
    expect(candidates).toEqual([{ host: "infinite-tag-smoke-site.vercel.app", source: "vercel_production", file: null }])
    expect(candidateLabel(candidates[0]!)).toBe("infinite-tag-smoke-site.vercel.app  (from your Vercel production deployments)")
  })
})

describe("a refused typed address: the re-ask says why (R2-3)", () => {
  it("the second text question starts with the refusal's reason; a second refusal is 'not live yet'", async () => {
    const asked: Array<{ kind: string; payload: { question?: string } }> = []
    const answers: unknown[] = ["__type__", "acme-git-main-team.vercel.app", "acme.netlify.app"]
    const ctx = { ask: (async (kind: string, payload: { question?: string }) => {
      asked.push({ kind, payload })
      return answers.shift()
    }) as never }
    const said: string[] = []
    expect(await askProductionHost(ctx, [], (text) => said.push(text))).toBeNull()
    const texts = asked.filter((entry) => entry.kind === "text").map((entry) => entry.payload.question ?? "")
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe("Your live site's address (for example acme.com):")
    expect(texts[1]).toContain("acme-git-main-team.vercel.app is a Vercel preview address")
    expect(texts[1]).toContain("acme.vercel.app")
    expect(texts[1]).toMatch(/Your live site's address \(for example acme\.com\):$/)
    expect(said).toHaveLength(2)
  })

  it("a production alias typed after a refusal is the host", async () => {
    const answers: unknown[] = ["__type__", "acme-a1b2c3d4e-team.vercel.app", "https://acme.vercel.app/"]
    const ctx = { ask: (async () => answers.shift()) as never }
    expect(await askProductionHost(ctx, [], () => undefined)).toBe("acme.vercel.app")
  })
})
