// §3y.1: the production host, decided ONCE per run and read by every consumer through `resolveProductionHost`.
//
// Precedence (DECISIONS §1.1):
//   1. keys `infinite.productionHosts[0]` (Infinite's site source);
//   2. hosting `vercel.productionDomains[0]` (Infinite's Vercel connection);
//   3. `state.site.productionHost` (an earlier answer in this run);
//   4. `--production-host <host>`;
//   5. else ONE ask in `before`. Repo hints only pre-fill that ask; they never answer it.
//
// Honesty rules: a host from the repo is a CANDIDATE the user confirms (never a guess shipped silently); a
// platform host (any `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, a bare platform domain, localhost…) is never
// accepted; `.env*` files are never read for this.
//
// Production must be the site's OWN domain (founder ruling, 2026-10-03: "we shouldnt accept vercel.app sites lol, only
// custom domain sites"). Every `*.vercel.app` host is refused as the production host — a project's production alias
// (`<project>.vercel.app`, `<project>-<team>.vercel.app`) as much as a branch alias or a deployment URL — and so is a
// bare platform domain (`vercel.app`, `netlify.app`, `pages.dev`, `github.io`). The host ask never offers one, the
// flag refuses one, and no claim or guard exemption is ever built from one. Previews are unchanged: the rehearsal
// still runs on the PR's Vercel preview.
import { join } from "node:path"

import { ASK_CANCELLED, ASK_TIMEOUT } from "./contracts/asks.js"
import type { TagHosting, TagKeys } from "./contracts/bridge.js"
import type { WizardContext, WizardFs } from "./contracts/deps.js"
import { HOST_DENY_V1, normalizeHost } from "./contracts/host-deny.js"
import type { SiteState } from "./contracts/state.js"

/** A DNS name with a TLD (the same rule the link card's hint and the cloud's `hosts` check apply). */
export const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const HOST_ASK_QUESTION = "Which address is your live site? The wizard tests it without sending anything, and Infinite collects only there."
export const HOST_TEXT_QUESTION = "Your live site's address (for example acme.com):"
export const HOST_TYPE_VALUE = "__type__"
export const HOST_NONE_VALUE = "__none__"

export const VERCEL_APP_SUFFIX = ".vercel.app"

/**
 * GitHub Pages' platform domain. Never the site's own domain, so never a production host — bare or as a
 * `<user>.github.io` default — but NOT on the §3h.9 guard list (the preview guard's list is unchanged).
 */
const GITHUB_PAGES_DOMAIN = "github.io"

/**
 * Platform domains that are nobody's site, refused as a production host even bare (review-2 P3-2): the §3h.9 platform
 * suffixes without their dot, and `github.io`.
 */
export const BARE_PLATFORM_HOSTS: readonly string[] = Object.freeze(["vercel.app", "netlify.app", "pages.dev", GITHUB_PAGES_DOMAIN])

/** True for a host the §3h.9 deny list matches: a preview, a local address, or ANY `*.vercel.app` (a production alias included). */
export function isDenyListedHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return HOST_DENY_V1.deny.exact.includes(normalized) || HOST_DENY_V1.deny.suffix.some((suffix) => normalized.endsWith(suffix))
}

/**
 * True for a host that can never be the production host (founder ruling 2026-10-03: only the site's own domain):
 * every deny-listed host (§3h.9), every bare platform domain (`BARE_PLATFORM_HOSTS`) and every `*.github.io`.
 * `acme.vercel.app`, `acme-git-main-team.vercel.app`, `acme-a1b2c3d4e-team.vercel.app`, `vercel.app`, `*.netlify.app`,
 * `*.pages.dev`, `github.io`, `acme.github.io` and localhost all are; `acme.com` is not.
 */
export function isPreviewShapedHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return isDenyListedHost(normalized) || BARE_PLATFORM_HOSTS.includes(normalized) || normalized.endsWith(`.${GITHUB_PAGES_DOMAIN}`)
}

/** The platform a refused host belongs to, for the refusal line (null: a local address). */
function platformOf(host: string): { name: string; where: string } | null {
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`)
  if (is("vercel.app")) return { name: "Vercel", where: "in Vercel" }
  if (is("netlify.app")) return { name: "Netlify", where: "in Netlify" }
  if (is("pages.dev")) return { name: "Cloudflare Pages", where: "in Cloudflare Pages" }
  if (is(GITHUB_PAGES_DOMAIN)) return { name: "GitHub Pages", where: "in your repo's Pages settings" }
  return null
}

/**
 * A typed or flagged address as a host: a bare host, or an https URL (its hostname). `not_host` for anything that
 * is not a DNS name; `preview` for a preview-shaped one.
 */
export function parseHostInput(raw: string): { ok: true; host: string } | { ok: false; reason: "not_host" | "preview"; shown: string } {
  const trimmed = raw.trim()
  let candidate = trimmed
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      candidate = new URL(trimmed).hostname
    } catch {
      return { ok: false, reason: "not_host", shown: trimmed.slice(0, 80) }
    }
  } else {
    candidate = trimmed.replace(/\/.*$/, "")
  }
  const host = normalizeHost(candidate)
  if (!HOST_PATTERN.test(host)) return { ok: false, reason: "not_host", shown: (host || trimmed).slice(0, 80) }
  if (isPreviewShapedHost(host)) return { ok: false, reason: "preview", shown: host }
  return { ok: true, host }
}

/**
 * The line a refused typed address gets (DECISIONS §1.1 copy, founder ruling 2026-10-03). `then` names what the user
 * can do next: `reask` (a text field follows: they can type their own domain, and ESC is "it isn't live yet" — a text
 * field has no such option, review-2 P3-5), or `final` (no further ask: the flag, or the last refusal).
 */
export function hostRefusalLine(refusal: { reason: "not_host" | "preview"; shown: string }, then: "reask" | "final" = "reask"): string {
  if (refusal.reason === "not_host") return `! ${refusal.shown} isn't a domain name${then === "reask" ? " (press ESC if it isn't live yet)" : ""}`
  const platform = platformOf(normalizeHost(refusal.shown))
  const tail = then === "reask" ? " Or type your own domain now (ESC if it has none yet)." : ""
  if (platform === null) return `! Infinite needs your site's own domain. ${refusal.shown} is a local address, not your live site.${tail}`
  return `! Infinite needs your site's own domain. ${refusal.shown} is a ${platform.name} address — add a custom domain ${platform.where}, then run npx infinite-tag again.${tail}`
}

export interface ResolvedHost {
  host: string | null
  source: SiteState["source"] | null
  /** True when a later step must not ask again (a known host, or an earlier answer — even "not live yet"). */
  decided: boolean
}

/** §3y.1 precedence: Infinite first, then this run's earlier answer, then the flag. `decided:false` = ask. */
export function resolveProductionHost(input: {
  keys?: Pick<TagKeys, "infinite"> | null
  hosting?: TagHosting | null
  site?: SiteState | null
  flag?: string | null
}): ResolvedHost {
  const fromKeys = input.keys?.infinite.productionHosts[0]
  if (fromKeys) return { host: normalizeHost(fromKeys), source: "infinite", decided: true }
  const fromHosting = input.hosting?.vercel?.productionDomains[0]
  if (fromHosting) return { host: normalizeHost(fromHosting), source: "infinite", decided: true }
  if (input.site?.productionHost) return { host: normalizeHost(input.site.productionHost), source: input.site.source, decided: true }
  if (input.flag) {
    const parsed = parseHostInput(input.flag)
    if (parsed.ok) return { host: parsed.host, source: "flag", decided: true }
  }
  // An earlier "it isn't live yet" (null host) is decided: the same run never asks again.
  if (input.site) return { host: null, source: input.site.source, decided: true }
  return { host: null, source: null, decided: false }
}

// ---------------------------------------------------------------------------------------------
// Repo candidates (read-only; they only pre-fill the ask)
// ---------------------------------------------------------------------------------------------

export type HostCandidateSource =
  | "cname"
  | "next_metadata_base"
  | "next_sitemap"
  | "robots_sitemap"
  | "html_canonical"
  | "package_homepage"
  | "github_homepage"

export interface HostCandidate {
  host: string
  source: HostCandidateSource
  /** Repo-relative file the hint came from; null for the GitHub repo's homepage. */
  file: string | null
}

/** The most of one hint file that is read (hints sit near the top of these files). */
const HINT_READ_LIMIT = 256 * 1024

function hostOfUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return normalizeHost(url.hostname)
  } catch {
    return null
  }
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) return match[1]
  }
  return null
}

/**
 * Every repo hint at the live address, deduped, in the DECISIONS §1.1 order. A preview-shaped or malformed one is
 * dropped. Files only (bounded); `homepageUrl` is the GitHub repo's homepage from the existing `gh repo view`.
 */
export async function repoHostCandidates(
  root: string,
  appRoot: string,
  fs: Pick<WizardFs, "readText">,
  repo: { homepageUrl?: string | null } | null = null
): Promise<HostCandidate[]> {
  const app = appRoot === "." || appRoot === "" ? "" : appRoot
  const rel = (file: string) => (app ? `${app}/${file}` : file)
  const read = async (relative: string): Promise<string | null> => {
    const text = await fs.readText(join(root, relative)).catch(() => null)
    return text === null ? null : text.slice(0, HINT_READ_LIMIT)
  }
  const out: HostCandidate[] = []
  const push = (host: string | null, source: HostCandidateSource, file: string | null) => {
    if (!host) return
    const normalized = normalizeHost(host)
    if (!HOST_PATTERN.test(normalized) || isPreviewShapedHost(normalized)) return
    if (out.some((entry) => entry.host === normalized)) return
    out.push({ host: normalized, source, file })
  }

  // cname
  for (const file of [rel("public/CNAME"), rel("CNAME"), "CNAME"]) {
    const text = await read(file)
    const line = text?.split(/\r?\n/, 1)[0]?.trim()
    if (line) {
      push(line, "cname", file)
      break
    }
  }
  // next_metadata_base
  for (const dir of ["app", "src/app"]) {
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      const file = rel(`${dir}/layout.${ext}`)
      const text = await read(file)
      const url = text ? firstMatch(text, [/metadataBase\s*:\s*new\s+URL\(\s*["'`](https?:\/\/[^"'`\s]+)["'`]/]) : null
      if (url) push(hostOfUrl(url), "next_metadata_base", file)
    }
  }
  // next_sitemap
  for (const ext of ["js", "cjs", "mjs", "ts"]) {
    const file = rel(`next-sitemap.config.${ext}`)
    const text = await read(file)
    const url = text ? firstMatch(text, [/siteUrl\s*:\s*["'`](https?:\/\/[^"'`\s]+)["'`]/]) : null
    if (url) push(hostOfUrl(url), "next_sitemap", file)
  }
  // robots_sitemap
  {
    const file = rel("public/robots.txt")
    const text = await read(file)
    const url = text ? firstMatch(text, [/^\s*Sitemap:\s*(https?:\/\/\S+)/im]) : null
    if (url) push(hostOfUrl(url), "robots_sitemap", file)
  }
  // html_canonical (a static or Vite site's index.html)
  {
    const file = rel("index.html")
    const text = await read(file)
    const url = text
      ? firstMatch(text, [
          /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["'](https?:\/\/[^"']+)["']/i,
          /<link\b[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*\brel=["']canonical["']/i,
          /<meta\b[^>]*\bproperty=["']og:url["'][^>]*\bcontent=["'](https?:\/\/[^"']+)["']/i,
          /<meta\b[^>]*\bcontent=["'](https?:\/\/[^"']+)["'][^>]*\bproperty=["']og:url["']/i
        ])
      : null
    if (url) push(hostOfUrl(url), "html_canonical", file)
  }
  // package_homepage
  {
    const file = rel("package.json")
    const text = await read(file)
    if (text) {
      try {
        const homepage = (JSON.parse(text) as { homepage?: unknown }).homepage
        if (typeof homepage === "string") push(hostOfUrl(homepage), "package_homepage", file)
      } catch {
        // Not JSON: no hint.
      }
    }
  }
  // github_homepage
  if (repo?.homepageUrl) push(hostOfUrl(repo.homepageUrl), "github_homepage", null)
  return out
}

// ---------------------------------------------------------------------------------------------
// The ONE ask (step `before`)
// ---------------------------------------------------------------------------------------------

export function candidateLabel(candidate: HostCandidate): string {
  return `${candidate.host}  (from ${candidate.file ?? "your GitHub repo"})`
}

/** The re-asked text question: the refusal's reason first, so the user sees why (R2-3: it went to a hidden sub line). */
export function hostReaskQuestion(refusalLine: string): string {
  return `${refusalLine.replace(/^! /, "")} ${HOST_TEXT_QUESTION}`
}

/**
 * The host ask (DECISIONS §1.1): up to 3 repo candidates, "Type another address", "It isn't live yet". A typed
 * address is validated; a refused one is said and asked once more, then treated as "not live yet". Returns the
 * chosen host, or null for "not live yet" (ESC and a timeout read the same: never a guess). The default is the first
 * candidate; a platform address (`*.vercel.app`, …) is never a candidate (`repoHostCandidates` drops it).
 */
export async function askProductionHost(
  ctx: Pick<WizardContext, "ask">,
  candidates: readonly HostCandidate[],
  say: (text: string, tone: "warn" | "info") => void
): Promise<string | null> {
  const shown = candidates.slice(0, 3)
  const answer = await ctx.ask("single", {
    question: HOST_ASK_QUESTION,
    options: [
      ...shown.map((candidate) => ({ label: candidateLabel(candidate), value: candidate.host })),
      { label: "Type another address", value: HOST_TYPE_VALUE },
      { label: "It isn't live yet", value: HOST_NONE_VALUE }
    ],
    default: shown[0]?.host ?? HOST_TYPE_VALUE
  })
  if (answer === ASK_CANCELLED || answer === ASK_TIMEOUT || answer === HOST_NONE_VALUE) return null
  let question = HOST_TEXT_QUESTION
  let attempts = 2
  if (answer !== HOST_TYPE_VALUE) {
    const parsed = parseHostInput(String(answer))
    if (parsed.ok) return parsed.host
    const line = hostRefusalLine(parsed, "reask")
    say(line, "warn")
    question = hostReaskQuestion(line)
    attempts = 1
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const typed = await ctx.ask("text", { question, maxLength: 253 })
    if (typed === ASK_CANCELLED || typed === ASK_TIMEOUT) return null
    const parsed = parseHostInput(String(typed))
    if (parsed.ok) return parsed.host
    const last = attempt === attempts - 1
    const line = hostRefusalLine(parsed, last ? "final" : "reask")
    say(line, "warn")
    question = hostReaskQuestion(line)
  }
  return null
}

/** The `before` sub lines for a decided host (each within the 120-character sub-status). */
export function hostDecidedLines(host: string | null, source: SiteState["source"] | null): string[] {
  if (host === null) return ["No live site yet: the live test, Infinite's tag and the proof wait for a domain.", "Run npx infinite-tag --production-host <domain> later."]
  return [`✓ Live site: ${host} (${source === "flag" ? "--production-host" : source === "answer" ? "you said" : "from Infinite"})`]
}
