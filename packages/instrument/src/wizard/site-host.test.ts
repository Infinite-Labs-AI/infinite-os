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
  vercelProductionAliasesFrom
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
    expect(!preview.ok && preview.message).toContain("looks like a Vercel preview")
    // The flag has no field to press ESC in: no "ESC" or "It isn't live yet" advice (review-2 P3-5).
    expect(!preview.ok && preview.message).not.toMatch(/ESC|It isn't live yet/)
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

  it("a refused Vercel preview LOOKS like one (a heuristic) and points at the team's own address as an example", () => {
    const line = hostRefusalLine({ reason: "preview", shown: "infinite-tag-smoke-site-mix177n53-chaos-edge.vercel.app" })
    expect(line).toContain("looks like a Vercel preview")
    expect(line).toContain("Vercel › Domains (e.g. infinite-tag-smoke-site-chaos-edge.vercel.app)")
    expect(line.length).toBeLessThanOrEqual(240)
    expect(line.endsWith(", or press ESC if it isn't live yet.")).toBe(true)
    // NEGATIVE: never "is a Vercel preview address" as a fact (review-2 P3-1), never a text field "option".
    expect(line).not.toMatch(/is a Vercel preview/)
    expect(line).not.toContain('choose "It isn')
    expect(hostRefusalLine({ reason: "preview", shown: "acme-git-main-team.vercel.app" })).toContain("(e.g. acme.vercel.app)")
    // The last refusal (and the flag) has nothing left to press.
    expect(hostRefusalLine({ reason: "preview", shown: "acme.netlify.app" }, "final")).not.toContain("ESC")
    expect(hostRefusalLine({ reason: "not_host", shown: "nope" }, "final")).toBe("! nope isn't a domain name")
  })

  it("the GitHub Production deployment URL suggests the team's alias and the project-name guess; a monorepo environment names the project", () => {
    expect(vercelProductionAliasesFrom("https://infinite-tag-smoke-site-mix177n53-chaos-edge.vercel.app")).toEqual([
      { host: "infinite-tag-smoke-site-chaos-edge.vercel.app", source: "vercel_team_alias" },
      { host: "infinite-tag-smoke-site.vercel.app", source: "vercel_project_guess" }
    ])
    expect(vercelProductionAliasesFrom(null, "Production – web")).toEqual([{ host: "web.vercel.app", source: "vercel_project_guess" }])
    expect(vercelProductionAliasesFrom("https://web-a1b2c3d4e-acme.vercel.app", "Production – web")).toEqual([
      { host: "web-acme.vercel.app", source: "vercel_team_alias" },
      { host: "web.vercel.app", source: "vercel_project_guess" }
    ])
    // NEGATIVES: a custom domain or an unshaped URL names nothing.
    expect(vercelProductionAliasesFrom("https://acme.com")).toEqual([])
    expect(vercelProductionAliasesFrom("https://acme.vercel.app")).toEqual([])
    expect(vercelProductionAliasesFrom("not a url")).toEqual([])
    expect(vercelProductionAliasesFrom(null, "Production")).toEqual([])
  })

  it("review-2 P2-3: the derived aliases are offered as GUESSES, never as a fact and never pre-selected", async () => {
    const aliases = vercelProductionAliasesFrom("https://infinite-tag-smoke-site-mix177n53-chaos-edge.vercel.app")
    const candidates = await repoHostCandidates("/r", ".", fsOf({}), { vercelAliases: aliases })
    expect(candidates).toEqual([
      { host: "infinite-tag-smoke-site-chaos-edge.vercel.app", source: "vercel_team_alias", file: null },
      { host: "infinite-tag-smoke-site.vercel.app", source: "vercel_project_guess", file: null }
    ])
    expect(candidateLabel(candidates[0]!)).toBe("infinite-tag-smoke-site-chaos-edge.vercel.app  (a guess: your Vercel team's address for this project)")
    expect(candidateLabel(candidates[1]!)).toBe("infinite-tag-smoke-site.vercel.app  (a guess: Vercel names it after the project; it may be another team's)")
    for (const candidate of candidates) expect(candidateLabel(candidate)).not.toContain("from your Vercel production deployments")

    const asked: Array<{ default?: unknown; options?: Array<{ value: string }> }> = []
    const ctx = { ask: (async (_kind: string, payload: { default?: unknown; options?: Array<{ value: string }> }) => {
      asked.push(payload)
      return "__none__"
    }) as never }
    await askProductionHost(ctx, candidates, () => undefined)
    // Offered, but the default is "Type another address": accepting the default never names another team's site.
    expect(asked[0]!.options!.map((option) => option.value).slice(0, 2)).toEqual(candidates.map((candidate) => candidate.host))
    expect(asked[0]!.default).toBe("__type__")
  })

  it("a repo file naming the same alias corroborates it: the file's entry wins the dedupe and is the default", async () => {
    const aliases = vercelProductionAliasesFrom("https://acme-a1b2c3d4e-team.vercel.app")
    const candidates = await repoHostCandidates("/r", ".", fsOf({ "/r/public/CNAME": "acme.vercel.app\n" }), { vercelAliases: aliases })
    expect(candidates[0]).toEqual({ host: "acme.vercel.app", source: "cname", file: "public/CNAME" })
    const asked: Array<{ default?: unknown }> = []
    const ctx = { ask: (async (_kind: string, payload: { default?: unknown }) => {
      asked.push(payload)
      return "__none__"
    }) as never }
    await askProductionHost(ctx, candidates, () => undefined)
    expect(asked[0]!.default).toBe("acme.vercel.app")
  })

  it("review-2 P3-2: a bare platform domain is never a production host", () => {
    for (const bare of ["vercel.app", "netlify.app", "pages.dev", "Vercel.App."]) {
      expect(parseHostInput(bare), bare).toMatchObject({ ok: false, reason: "preview" })
      expect(isPreviewShapedHost(bare), bare).toBe(true)
    }
    expect(parseWizardArgs(["--production-host", "vercel.app"], "/r").ok).toBe(false)
    // NEGATIVE: a real host that merely ends in the same letters is untouched.
    expect(parseHostInput("myvercel.app")).toEqual({ ok: true, host: "myvercel.app" })
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
    expect(texts[1]).toContain("acme-git-main-team.vercel.app looks like a Vercel preview")
    expect(texts[1]).toContain("acme.vercel.app")
    // A text field has no "It isn't live yet" option: ESC is the way (review-2 P3-5).
    expect(texts[1]).toContain("or press ESC if it isn't live yet.")
    expect(texts[1]).not.toContain('choose "It isn')
    expect(texts[1]).toMatch(/Your live site's address \(for example acme\.com\):$/)
    expect(said).toHaveLength(2)
    // The last refusal has no field after it: no ESC advice.
    expect(said[1]).not.toContain("ESC")
  })

  it("review-2 P3-7: an invalid single-ask answer is re-asked ONCE, and the text question carries the reason", async () => {
    const asked: Array<{ kind: string; payload: { question?: string } }> = []
    const answers: unknown[] = ["acme-a1b2c3d4e-team.vercel.app", "acme.com"]
    const ctx = { ask: (async (kind: string, payload: { question?: string }) => {
      asked.push({ kind, payload })
      return answers.shift()
    }) as never }
    const said: string[] = []
    expect(await askProductionHost(ctx, [], (text) => said.push(text))).toBe("acme.com")
    const texts = asked.filter((entry) => entry.kind === "text").map((entry) => entry.payload.question ?? "")
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("acme-a1b2c3d4e-team.vercel.app looks like a Vercel preview")
    expect(texts[0]).toContain("or press ESC if it isn't live yet.")
    expect(texts[0]).toMatch(/Your live site's address \(for example acme\.com\):$/)
    expect(said).toEqual([expect.stringContaining("acme-a1b2c3d4e-team.vercel.app looks like a Vercel preview")])
    // NEGATIVE: only ONE re-ask after an invalid single answer; a second refusal is "not live yet".
    const twice: unknown[] = ["nope", "still nope", "acme.com"]
    expect(await askProductionHost({ ask: (async () => twice.shift()) as never }, [], () => undefined)).toBeNull()
    expect(twice).toEqual(["acme.com"])
  })

  it("a production alias typed after a refusal is the host", async () => {
    const answers: unknown[] = ["__type__", "acme-a1b2c3d4e-team.vercel.app", "https://acme.vercel.app/"]
    const ctx = { ask: (async () => answers.shift()) as never }
    expect(await askProductionHost(ctx, [], () => undefined)).toBe("acme.vercel.app")
  })
})
