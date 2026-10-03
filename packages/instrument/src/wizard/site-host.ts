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
// preview-shaped host (a Vercel branch or deployment URL, `*.netlify.app`, `*.pages.dev`, localhost…) is never
// accepted; `.env*` files are never read for this.
//
// Live run 2 (R2-3 of the round): real customers often serve production on their Vercel project's alias
// `<project>.vercel.app`. That ONE host is accepted when the user names it (an answer, a picked candidate or
// `--production-host`) and it has no preview shape. Vercel's preview shapes stay refused: a branch alias
// (`<project>-git-<branch>-<team>.vercel.app`) and a deployment URL (`<project>-<9-char hash>-<team>.vercel.app`).
// The GitHub "Production" deployment's URL (always a deployment URL) names the project, so the wizard offers
// candidates (review-2 P2-3: `vercel.app` names are global, so `<project>.vercel.app` is this project's only when
// the name was free — it is offered as a GUESS, never pre-selected, next to `<project>-<team>.vercel.app`, which the
// deployment URL's own team labels name). The preview guard exempts exactly the accepted host (exempt first, D3),
// so every other `*.vercel.app` stays silent.
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
 * True for a host the §3h.9 deny list matches (a preview, a local address, or any `*.vercel.app`), or a bare platform
 * domain the list's suffixes name (`vercel.app`, `netlify.app`, `pages.dev`: review-2 P3-2 — nobody's site, never
 * provable).
 */
export function isDenyListedHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return (
    HOST_DENY_V1.deny.exact.includes(normalized) ||
    HOST_DENY_V1.deny.suffix.some((suffix) => normalized.endsWith(suffix) || normalized === suffix.slice(1))
  )
}

/** One `<label>.vercel.app` label, or null for any other host (incl. a nested `a.b.vercel.app`). */
function vercelLabel(host: string): string | null {
  const normalized = normalizeHost(host)
  if (!normalized.endsWith(VERCEL_APP_SUFFIX)) return null
  const label = normalized.slice(0, -VERCEL_APP_SUFFIX.length)
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null
}

/**
 * Vercel's deployment-URL label: `<project>-<hash>-<team>`, the hash being 9 lowercase letters/digits with at least
 * one digit, between the project and the team. Returns the project part, or null when the label has no such shape.
 * The LAST hash-shaped segment is the hash (a team slug never holds a 9-character segment with a digit in practice).
 */
export function vercelDeploymentProject(label: string): string | null {
  return vercelDeploymentParts(label)?.project ?? null
}

/** Vercel's deployment hash segment: 9 lowercase letters/digits with at least one digit. */
const VERCEL_DEPLOYMENT_HASH = /^(?=[a-z0-9]*\d)[a-z0-9]{9}$/

/**
 * A Vercel PREVIEW shape: a branch alias (any `-git-`), a deployment URL (a label segment after the first that is the
 * 9-character hash with a digit), or a nested / malformed `*.vercel.app`. The SAME rule as 1bu-1's
 * `isVercelProductionAliasShape` (`src/lib/analytics/wizard/host-deny.ts`): the tag and the cloud classify one host
 * the same way. Fail closed: a team slug that looks like a hash is refused too (such a site uses its own domain).
 */
export function isVercelPreviewShape(host: string): boolean {
  const normalized = normalizeHost(host)
  if (!normalized.endsWith(VERCEL_APP_SUFFIX)) return false
  const label = vercelLabel(normalized)
  if (label === null) return true
  return label.includes("-git-") || label.split("-").slice(1).some((segment) => VERCEL_DEPLOYMENT_HASH.test(segment))
}

/** A `*.vercel.app` host that can be a project's production alias: one label and no preview shape. */
export function isVercelProductionAliasShape(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized.endsWith(VERCEL_APP_SUFFIX) && !isVercelPreviewShape(normalized)
}

/**
 * True for a host that can never be the production host: deny-listed (§3h.9) and NOT a Vercel production alias
 * shape. `acme.vercel.app` is not preview-shaped; `acme-git-main-team.vercel.app`, `acme-a1b2c3d4e-team.vercel.app`,
 * `*.netlify.app`, `*.pages.dev` and localhost are.
 */
export function isPreviewShapedHost(host: string): boolean {
  return isDenyListedHost(host) && !isVercelProductionAliasShape(host)
}

/** The labels of a deployment URL label `<project>-<hash>-<team>`: the project and the team parts, or null. */
function vercelDeploymentParts(label: string): { project: string; team: string | null } | null {
  const parts = label.split("-")
  for (let index = parts.length - 2; index >= 1; index -= 1) {
    if (VERCEL_DEPLOYMENT_HASH.test(parts[index]!)) {
      const team = parts.slice(index + 1).join("-")
      return { project: parts.slice(0, index).join("-"), team: team === "" ? null : team }
    }
  }
  return null
}

/** Where a Vercel alias candidate comes from (review-2 P2-3: both are DERIVED from names, so neither is a fact). */
export type VercelAliasCandidateSource = "vercel_team_alias" | "vercel_project_guess"

/**
 * The production aliases a GitHub "Production" deployment URL suggests. Vercel writes the deployment URL
 * (`<project>-<hash>-<team>.vercel.app`) as `environment_url`, never the alias, so the alias can only be derived:
 *   - `<project>-<team>.vercel.app` (`vercel_team_alias`): the labels after the hash are the team's, so this name is
 *     the team's own;
 *   - `<project>.vercel.app` (`vercel_project_guess`): `vercel.app` names are GLOBAL, so this is the project's only
 *     when nobody else held the name — it can be another team's site.
 * A monorepo's environment `Production – <project>` names the project (a guess only; no team). Empty when neither
 * tells. Every candidate has the production-alias shape.
 */
export function vercelProductionAliasesFrom(
  environmentUrl: string | null,
  environment: string | null = null
): Array<{ host: string; source: VercelAliasCandidateSource }> {
  const named = environment ? /^production\s*[–-]\s*([a-z0-9][a-z0-9._-]*)$/i.exec(environment.trim())?.[1] : undefined
  let project: string | null = named ? named.toLowerCase().replace(/[._]/g, "-") : null
  let team: string | null = null
  if (environmentUrl) {
    let hostname: string | null
    try {
      hostname = new URL(environmentUrl).hostname
    } catch {
      hostname = null
    }
    const label = hostname ? vercelLabel(hostname) : null
    const parts = label ? vercelDeploymentParts(label) : null
    if (parts && (project === null || parts.project === project)) {
      project = parts.project
      team = parts.team
    }
  }
  if (!project) return []
  const out: Array<{ host: string; source: VercelAliasCandidateSource }> = []
  const push = (host: string, source: VercelAliasCandidateSource) => {
    if (HOST_PATTERN.test(host) && isVercelProductionAliasShape(host) && !out.some((entry) => entry.host === host)) out.push({ host, source })
  }
  if (team) push(`${project}-${team}${VERCEL_APP_SUFFIX}`, "vercel_team_alias")
  push(`${project}${VERCEL_APP_SUFFIX}`, "vercel_project_guess")
  return out
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
 * The line a refused typed address gets (DECISIONS §1.1 copy). `then` names what the user can do next: `reask` (a
 * text field follows: ESC is "it isn't live yet" — a text field has no such option, review-2 P3-5), or `final` (no
 * further ask: the flag, or the last refusal). A Vercel preview is said to LOOK like one (the shape rule is a
 * heuristic, review-2 P3-1) and points at the project's own address, never a name-derived host stated as a fact.
 */
export function hostRefusalLine(refusal: { reason: "not_host" | "preview"; shown: string }, then: "reask" | "final" = "reask"): string {
  const tail = then === "reask" ? ", or press ESC if it isn't live yet." : "."
  if (refusal.reason === "not_host") return `! ${refusal.shown} isn't a domain name${then === "reask" ? " (press ESC if it isn't live yet)" : ""}`
  if (refusal.shown === VERCEL_APP_SUFFIX.slice(1) || refusal.shown.endsWith(VERCEL_APP_SUFFIX)) {
    const label = vercelLabel(refusal.shown)
    const parts = label ? (label.includes("-git-") ? { project: label.slice(0, label.indexOf("-git-")), team: null } : vercelDeploymentParts(label)) : null
    const example = parts ? (parts.team ? `${parts.project}-${parts.team}${VERCEL_APP_SUFFIX}` : `${parts.project}${VERCEL_APP_SUFFIX}`) : `<project>${VERCEL_APP_SUFFIX}`
    return `! ${refusal.shown} looks like a Vercel preview. Use your domain or your project's address in Vercel › Domains (e.g. ${example})${tail}`
  }
  return `! ${refusal.shown} is a preview-style address (Netlify, Cloudflare Pages or a local address); Infinite collects only on your live address. Add your domain in your host${tail}`
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
  | VercelAliasCandidateSource

export interface HostCandidate {
  host: string
  source: HostCandidateSource
  /** Repo-relative file the hint came from; null for the GitHub repo's homepage and the Vercel alias guesses. */
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
  repo: { homepageUrl?: string | null; vercelAliases?: ReadonlyArray<{ host: string; source: VercelAliasCandidateSource }> } | null = null
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
  // The aliases the repo's newest successful GitHub "Production" deployment suggests (derived, so last; a repo file
  // naming the same host keeps its own, corroborated, entry).
  for (const alias of repo?.vercelAliases ?? []) push(alias.host, alias.source, null)
  return out
}

// ---------------------------------------------------------------------------------------------
// The ONE ask (step `before`)
// ---------------------------------------------------------------------------------------------

/** A candidate derived from a name only (never a fact about this site): it is labelled a guess and never the default. */
export function isDerivedCandidate(candidate: HostCandidate): boolean {
  return candidate.source === "vercel_team_alias" || candidate.source === "vercel_project_guess"
}

export function candidateLabel(candidate: HostCandidate): string {
  if (candidate.source === "vercel_team_alias") return `${candidate.host}  (a guess: your Vercel team's address for this project)`
  if (candidate.source === "vercel_project_guess") return `${candidate.host}  (a guess: Vercel names it after the project; it may be another team's)`
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
 * candidate a repo file or the GitHub repo names; a name-derived Vercel guess is never pre-selected (review-2 P2-3).
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
    default: shown.find((candidate) => !isDerivedCandidate(candidate))?.host ?? HOST_TYPE_VALUE
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
