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
// preview-shaped host (`*.vercel.app`, `*.netlify.app`, `*.pages.dev`, localhost…) is never accepted, so the
// preview guard and the production host can never disagree; `.env*` files are never read for this.
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

/** True for a host the §3h.9 deny list silences (a preview or a local address). */
export function isPreviewShapedHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return HOST_DENY_V1.deny.exact.includes(normalized) || HOST_DENY_V1.deny.suffix.some((suffix) => normalized.endsWith(suffix))
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

/** The line a refused typed address gets (DECISIONS §1.1 copy). */
export function hostRefusalLine(refusal: { reason: "not_host" | "preview"; shown: string }): string {
  return refusal.reason === "not_host"
    ? `! ${refusal.shown} isn't a domain name`
    : `! ${refusal.shown} is a preview-style address (Vercel, Netlify, Cloudflare Pages); Infinite collects only on your own domain. Add one in your host, or choose "It isn't live yet".`
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

/**
 * The host ask (DECISIONS §1.1): up to 3 repo candidates, "Type another address", "It isn't live yet". A typed
 * address is validated; a refused one is said and asked once more, then treated as "not live yet". Returns the
 * chosen host, or null for "not live yet" (ESC and a timeout read the same: never a guess).
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
  if (answer !== HOST_TYPE_VALUE) {
    const parsed = parseHostInput(String(answer))
    if (parsed.ok) return parsed.host
    say(hostRefusalLine(parsed), "warn")
    return null
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const typed = await ctx.ask("text", { question: HOST_TEXT_QUESTION, maxLength: 253 })
    if (typed === ASK_CANCELLED || typed === ASK_TIMEOUT) return null
    const parsed = parseHostInput(String(typed))
    if (parsed.ok) return parsed.host
    say(hostRefusalLine(parsed), "warn")
  }
  return null
}

/** The `before` sub lines for a decided host (each within the 120-character sub-status). */
export function hostDecidedLines(host: string | null, source: SiteState["source"] | null): string[] {
  if (host === null) return ["No live site yet: the live test, Infinite's tag and the proof wait for a domain.", "Run npx infinite-tag --production-host <domain> later."]
  return [`✓ Live site: ${host} (${source === "flag" ? "--production-host" : source === "answer" ? "you said" : "from Infinite"})`]
}
