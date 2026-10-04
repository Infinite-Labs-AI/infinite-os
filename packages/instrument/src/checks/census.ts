// The provider census (lane O6): every place the site's code starts an analytics tool, per file and
// provider, WITHOUT dedupe (the existing `providerInstallEvidence` dedupes on purpose; a duplicate is
// exactly what the census is for). It reads code; it never runs it.
//
// What it counts: `gtag('config', id)`, `posthog.init(key, …)` and `<PostHogProvider apiKey>`,
// `fbq('init', id)`, Tag Manager containers, `<GoogleAnalytics gaId>` (@next/third-parties) and
// `ReactGA.initialize(id)`, plus Infinite's MANAGED blocks (the HTML `<!-- infinite:start -->` block, the
// managed runtime `<script data-infinite-runtime="managed">`, and the Next managed module's decoded
// `bootstrapSource`) as one `managed_block` entry per tool and id.
//
// `envSourcedIds` (R1-28): every provider id read from an env var (`process.env.NEXT_PUBLIC_*`,
// `import.meta.env.VITE_*`, directly, through one local constant, or interpolated into an inline script),
// with its file:line. The grader turns a silent env-sourced tool on a preview build into
// `undetermined (env_dependent)`, and O9's env-targets check flags a provider id set on Preview or
// Development ("the sandbox held the real pixel" incident).
//
// Incidents guarded (wf5-PORT-PLAN §4): "Merge nearly stripped the Meta helpers (849ccf1)" — the census
// counts exactly one `fbq('init')` per pixel per page; "Sandbox held production pixel credentials" —
// `envSourcedIds`; duplicates (two `gtag('config')` for one id, managed + adopted for one tool).
//
// Paths are REPO-ROOT relative (monorepo-safe, §3e.2), so `apps/web/app/layout.tsx`.
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { isManagedInfiniteFile } from "../frameworks/managed-files.js"
import { MANAGED_HTML_END, MANAGED_HTML_START } from "../frameworks/managed-html.js"
import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { htmlScripts } from "../html-scripts.js"
import { walkProviderScanFiles } from "../inspect.js"
import type { CensusEntry, CensusResult, CheckResult, EnvSourcedId, Evidence } from "../wizard/contracts/jobs.js"
import type { TestTool } from "../wizard/contracts/test-engine.js"
import { decodeNextBootstrap } from "../t0/next-bootstrap.js"
import { escapeRegExp } from "../text-escape.js"
import { lexicalStates } from "../lexical-states.js"

type Tool = CensusEntry["tool"]


function lineAt(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i += 1) if (source.charCodeAt(i) === 10) line += 1
  return line
}

const ENV_REFERENCE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]|import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/

/** The first argument of a call starting at `open` (index of `(`), up to the top-level `,` or `)`. */
function firstArgument(source: string, open: number): string {
  let depth = 0
  let quote = ""
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i]!
    if (quote) {
      if (ch === "\\") {
        i += 1
        continue
      }
      if (ch === quote) quote = ""
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch
    else if (ch === "(" || ch === "[" || ch === "{") depth += 1
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return source.slice(open + 1, i).trim()
      depth -= 1
    } else if (ch === "," && depth === 0) return source.slice(open + 1, i).trim()
  }
  return source.slice(open + 1).trim()
}

interface ResolvedId {
  id: string | null
  envName: string | null
}

/**
 * Resolve an id argument: a literal, an env reference (also inside a template literal), or ONE level of a
 * local `const NAME = …` in the same file. Anything else is computed: id null, not env-sourced.
 */
function resolveIdExpression(expression: string, fileSource: string, depth = 0): ResolvedId {
  const text = expression.replace(/^\{|\}$/g, "").trim()
  const literal = /^(['"`])([^'"`$]*)\1$/.exec(text)
  if (literal) return { id: literal[2] || null, envName: null }
  const env = ENV_REFERENCE.exec(text)
  if (env) return { id: null, envName: env[1] ?? env[2] ?? env[3] ?? null }
  const identifier = /^([A-Za-z_$][\w$]*)(?:\s*(?:!|as\s+string))?$/.exec(text)
  if (identifier && depth === 0) {
    const name = escapeRegExp(identifier[1]!)
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(fileSource)
    if (declaration) return resolveIdExpression(declaration[1]!.trim(), fileSource, depth + 1)
  }
  return { id: null, envName: null }
}

interface Hit {
  tool: Tool
  kind: CensusEntry["kind"]
  id: string | null
  envName: string | null
  offset: number
}

const CALLS: Array<{ tool: Tool; kind: CensusEntry["kind"]; pattern: RegExp; argAfter: "first" | "second" }> = [
  { tool: "ga4", kind: "gtag_config", pattern: /\b(?:window\.)?gtag\s*\(\s*(['"])config\1\s*,/g, argAfter: "second" },
  { tool: "posthog", kind: "posthog_init", pattern: /\b(?:window\.)?posthog\s*\.\s*init\s*\(/g, argAfter: "first" },
  { tool: "meta", kind: "fbq_init", pattern: /\b(?:window\.)?fbq\s*\(\s*(['"])init\1\s*,/g, argAfter: "second" },
  { tool: "ga4", kind: "react_ga", pattern: /\bReactGA\s*\.\s*initialize\s*\(/g, argAfter: "first" }
]

/** Provider starts in one stretch of JS (offsets relative to `code`, which is comment-masked). */
function scanJs(code: string, states: Uint8Array, fileSource: string, base: number): Hit[] {
  const hits: Hit[] = []
  for (const call of CALLS) {
    for (const match of code.matchAll(call.pattern)) {
      const at = match.index
      // A call written inside a quoted string is an example, not an install; inside a template literal
      // it is usually an inline <Script> body, which runs.
      if (states[base + at] === 1 || states[base + at] === 3) continue
      let argument: string
      if (call.argAfter === "first") argument = firstArgument(code, at + match[0].length - 1)
      else {
        const start = at + match[0].length
        argument = firstArgument(code, start - 1)
      }
      const resolved = resolveIdExpression(argument, fileSource)
      hits.push({ tool: call.tool, kind: call.kind, id: resolved.id, envName: resolved.envName, offset: base + at })
    }
  }
  // JSX components that start a provider with the key as a prop.
  for (const match of code.matchAll(/<GoogleAnalytics\b([^>]*)>/g)) {
    const prop = /\bgaId\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(match[1] ?? "")
    if (!prop) continue
    const resolved = resolveIdExpression(prop[1]!.replace(/^"|"$/g, "'"), fileSource)
    hits.push({ tool: "ga4", kind: "next_google_analytics", id: resolved.id, envName: resolved.envName, offset: base + match.index })
  }
  for (const match of code.matchAll(/<PostHogProvider\b([^>]*)>/g)) {
    const prop = /\bapiKey\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(match[1] ?? "")
    if (!prop) continue
    const resolved = resolveIdExpression(prop[1]!.replace(/^"|"$/g, "'"), fileSource)
    hits.push({ tool: "posthog", kind: "posthog_init", id: resolved.id, envName: resolved.envName, offset: base + match.index })
  }
  for (const match of code.matchAll(/<GoogleTagManager\b([^>]*)>/g)) {
    const prop = /\bgtmId\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(match[1] ?? "")
    const resolved = prop ? resolveIdExpression(prop[1]!.replace(/^"|"$/g, "'"), fileSource) : { id: null, envName: null }
    hits.push({ tool: "ga4", kind: "gtm", id: resolved.id, envName: resolved.envName, offset: base + match.index })
  }
  if (/googletagmanager\.com\/gtm\.js/.test(code)) {
    for (const match of code.matchAll(/['"](GTM-[A-Z0-9]+)['"]/g)) {
      if (states[base + match.index] === 3) continue
      hits.push({ tool: "ga4", kind: "gtm", id: match[1]!, envName: null, offset: base + match.index })
    }
  }
  return hits
}

/** Provider ids inside MANAGED bytes, one per tool and id (the AM accessor's re-init is not a second start). */
function scanManaged(source: string): Array<{ tool: Tool; id: string | null; offset: number }> {
  const out: Array<{ tool: Tool; id: string | null; offset: number }> = []
  const add = (tool: Tool, id: string | null, offset: number) => {
    if (!out.some((entry) => entry.tool === tool && entry.id === id)) out.push({ tool, id, offset })
  }
  for (const match of source.matchAll(/\bgtag\s*\(\s*['"]config['"]\s*,\s*"?(G-[A-Z0-9]+)"?/g)) add("ga4", match[1]!, match.index)
  for (const match of source.matchAll(/\bposthog\.init\s*\(\s*"(phc_[A-Za-z0-9_]+)"/g)) add("posthog", match[1]!, match.index)
  for (const match of source.matchAll(/\bfbq\s*\(\s*'init'\s*,\s*"(\d{15,16})"\s*\)/g)) add("meta", match[1]!, match.index)
  for (const match of source.matchAll(/\btwq\s*\(\s*['"]config['"]\s*,\s*"([A-Za-z0-9]+)"/g)) add("x", match[1]!, match.index)
  for (const match of source.matchAll(/"siteSourceKey":"(site_[A-Za-z0-9_-]+)"/g)) add("infinite", match[1]!, match.index)
  return out
}

export interface CensusOptions {
  /** Absolute repo root. */
  root: string
  /** The app root, absolute or relative to `root`. */
  appRoot: string
}

/** Run the census over the app root (the same bounded walk `inspect` uses). */
export function runCensus(options: CensusOptions): CensusResult {
  const root = resolve(options.root)
  const appRoot = resolve(root, options.appRoot)
  const entries: CensusEntry[] = []
  const envSourcedIds: EnvSourcedId[] = []
  const identifyCalls: Evidence[] = []
  const resetCalls: Evidence[] = []
  for (const file of walkProviderScanFiles(appRoot)) {
    let source: string
    try {
      source = readFileSync(join(appRoot, file), "utf8")
    } catch {
      continue
    }
    const repoPath = relative(root, join(appRoot, file)).split("\\").join("/")
    const html = /\.html?$/i.test(file)
    if (!html && isManagedInfiniteFile(source)) {
      const decoded = decodeNextBootstrap(source)
      if (decoded.ok)
        for (const entry of scanManaged(decoded.source)) entries.push({ tool: entry.tool, kind: "managed_block", id: entry.id, file: repoPath, line: decoded.line, owner: "managed" })
      continue
    }
    const managedRanges: Array<[number, number]> = []
    if (html) {
      const start = source.indexOf(MANAGED_HTML_START)
      const end = start === -1 ? -1 : source.indexOf(MANAGED_HTML_END, start)
      if (start !== -1 && end !== -1) {
        managedRanges.push([start, end + MANAGED_HTML_END.length])
        for (const entry of scanManaged(source.slice(start, end)))
          entries.push({ tool: entry.tool, kind: "managed_block", id: entry.id, file: repoPath, line: lineAt(source, start + entry.offset), owner: "managed" })
      }
      for (const script of htmlScripts(source, true)) {
        if (script.attributes.get("data-infinite-runtime") !== "managed") continue
        if (managedRanges.some(([from, to]) => script.start >= from && script.start < to)) continue
        managedRanges.push([script.start, script.end])
        for (const entry of scanManaged(source.slice(script.start, script.end)))
          entries.push({ tool: entry.tool, kind: "managed_block", id: entry.id, file: repoPath, line: lineAt(source, script.start), owner: "managed" })
      }
    }
    const inManaged = (offset: number) => managedRanges.some(([from, to]) => offset >= from && offset < to)
    const regions: Array<[number, number]> = html ? htmlScripts(source, true).map((script) => [script.bodyStart, script.bodyEnd]) : [[0, source.length]]
    for (const [from, to] of regions) {
      if (inManaged(from)) continue
      const slice = source.slice(from, to)
      const code = maskCommentsAndStrings(slice, false)
      const states = lexicalStates(slice)
      const shifted = new Uint8Array(source.length)
      shifted.set(states, from)
      for (const hit of scanJs(code, shifted, slice, from)) {
        if (inManaged(hit.offset)) continue
        const line = lineAt(source, hit.offset)
        entries.push({ tool: hit.tool, kind: hit.kind, id: hit.id, file: repoPath, line, owner: "adopted" })
        if (hit.envName && hit.tool !== "x") envSourcedIds.push({ tool: hit.tool as TestTool, envName: hit.envName, file: repoPath, line })
      }
      for (const match of code.matchAll(/\b(?:posthog\s*\.\s*identify|infiniteIdentify)\s*\(/g)) {
        if (states[match.index] !== 0) continue
        identifyCalls.push({ file: repoPath, line: lineAt(source, from + match.index) })
      }
      for (const match of code.matchAll(/\b(?:posthog\s*\.\s*reset|infiniteReset)\s*\(/g)) {
        if (states[match.index] !== 0) continue
        resetCalls.push({ file: repoPath, line: lineAt(source, from + match.index) })
      }
    }
  }
  return { entries, envSourcedIds, identify: { identifyCalls, resetCalls } }
}

// ---- the S checks the job table names on the census ------------------------------------------

const ROUTE_PAGE = /(?:^|\/)(?:app\/(?:.*\/)?page|pages\/(?!_app\b|_document\b)[^.]+)\.(?:tsx|jsx|ts|js|mjs)$/
const APP_LAYOUT = /^(.*(?:^|\/)app(?:\/.*)?)\/layout\.(?:tsx|jsx|ts|js|mjs)$/

function dirOf(file: string): string {
  const at = file.lastIndexOf("/")
  return at === -1 ? "" : file.slice(0, at)
}

/** `dir` is `ancestor` or inside it. */
function within(dir: string, ancestor: string): boolean {
  return dir === ancestor || dir.startsWith(`${ancestor}/`)
}

/**
 * Group entries into pages. An HTML file and a Next route page are pages. A Next app-router `layout.*`
 * runs only on the pages of ITS segment subtree (route groups included: `app/(marketing)/layout.tsx`
 * never runs beside `app/(app)/layout.tsx`, review O6-R16); every other non-page file (`_app`, shared
 * modules, the managed module) is the SHELL that runs on every page. Each layout also stands for "a page
 * under it", so two layouts in one chain are caught even when no page file starts a tool. With no page
 * and no layout, the shell is the one page.
 */
export function censusPages(entries: readonly CensusEntry[]): Array<{ page: string; entries: CensusEntry[] }> {
  const isPage = (file: string) => /\.html?$/i.test(file) || ROUTE_PAGE.test(file)
  const layoutDir = (file: string) => APP_LAYOUT.exec(file)?.[1] ?? null
  const shell = entries.filter((entry) => !isPage(entry.file) && layoutDir(entry.file) === null)
  const layouts = entries.filter((entry) => layoutDir(entry.file) !== null)
  const layoutsOver = (dir: string) => layouts.filter((entry) => within(dir, layoutDir(entry.file)!))
  const pages = [...new Set(entries.filter((entry) => isPage(entry.file)).map((entry) => entry.file))]
  const layoutFiles = [...new Set(layouts.map((entry) => entry.file))]
  const units = [
    ...pages.map((page) => ({ page, entries: [...shell, ...layoutsOver(dirOf(page)), ...entries.filter((entry) => entry.file === page)] })),
    ...layoutFiles.map((layout) => ({ page: `${layoutDir(layout)}/ (any page under ${layout})`, entries: [...shell, ...layoutsOver(layoutDir(layout)!)] }))
  ]
  if (units.length === 0) return [{ page: "(app shell)", entries: shell }]
  return units
}

function checkResult(checkId: string, state: CheckResult["state"], code: string | null, detail: string, evidence: Evidence[], ctx: { runId: string | null; now(): Date }): CheckResult {
  return {
    checkId,
    state,
    reason: code ? `${code} — ${detail}` : detail,
    ...(evidence.length ? { evidence } : {}),
    tier: "S",
    at: ctx.now().toISOString(),
    runId: ctx.runId
  }
}

function duplicatesFor(census: CensusResult, tool: Tool): { messages: string[]; evidence: Evidence[] } {
  const messages: string[] = []
  const evidence: Array<{ file: string; line: number }> = []
  // The same starts seen from several pages (a root layout duplicate is on every page) are said once.
  const said = new Set<string>()
  const seenEvidence = new Set<string>()
  const say = (kind: string, list: readonly CensusEntry[], message: string) => {
    const key = `${kind}|${list.map((entry) => `${entry.file}:${entry.line}`).sort().join(",")}`
    if (said.has(key)) return
    said.add(key)
    messages.push(message)
    for (const entry of list) {
      const at = `${entry.file}:${entry.line}`
      if (seenEvidence.has(at)) continue
      seenEvidence.add(at)
      evidence.push({ file: entry.file, line: entry.line })
    }
  }
  for (const page of censusPages(census.entries)) {
    const starts = page.entries.filter((entry) => entry.tool === tool && entry.kind !== "gtm")
    const byId = new Map<string, CensusEntry[]>()
    for (const entry of starts) {
      const key = entry.id ?? "(computed id)"
      byId.set(key, [...(byId.get(key) ?? []), entry])
    }
    for (const [id, list] of byId) {
      if (list.length < 2) continue
      say(`dup:${id}`, list, `${page.page}: ${id} starts ${list.length} times (${list.map((entry) => `${entry.file}:${entry.line}`).join(", ")})`)
    }
    const owners = new Set(starts.map((entry) => entry.owner))
    if (owners.size > 1) say("owners", starts, `${page.page}: Infinite's managed block AND the site's own code both start ${tool}`)
  }
  evidence.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { messages, evidence }
}

/**
 * The census S checks: `census_ga4_config_once`, `census_posthog_init_once`, `census_meta_init_once`
 * (one start per id per page, and never managed + adopted for one tool), and `census_one_per_tool`
 * (all three, plus the X and Infinite managed blocks).
 */
export function censusChecks(census: CensusResult, ctx: { runId: string | null; now(): Date }): CheckResult[] {
  const out: CheckResult[] = []
  const all: string[] = []
  const allEvidence: Evidence[] = []
  for (const [checkId, tool, label] of [
    ["census_ga4_config_once", "ga4", "GA4"],
    ["census_posthog_init_once", "posthog", "PostHog"],
    ["census_meta_init_once", "meta", "the Meta pixel"]
  ] as const) {
    const { messages, evidence } = duplicatesFor(census, tool)
    all.push(...messages)
    allEvidence.push(...evidence)
    out.push(
      messages.length
        ? checkResult(checkId, "problem", "duplicate_start", messages.join("; "), evidence, ctx)
        : checkResult(checkId, "pass", null, `${label} starts at most once per page`, [], ctx)
    )
  }
  for (const tool of ["x", "infinite"] as const) {
    const { messages, evidence } = duplicatesFor(census, tool)
    all.push(...messages)
    allEvidence.push(...evidence)
  }
  out.push(
    all.length
      ? checkResult("census_one_per_tool", "problem", "duplicate_start", all.join("; "), allEvidence, ctx)
      : checkResult("census_one_per_tool", "pass", null, "every tool starts once per page", [], ctx)
  )
  return out
}

/**
 * The tools the census sees started anywhere (for the grader's `installedTools`). A GTM container is NOT
 * a GA4 install (review O6-R17): what it holds is not readable statically (it may hold only a Meta tag),
 * so a GTM-only site does not claim GA4 — see `censusViaTagManager`, which the report shows instead.
 */
export function censusInstalledTools(census: CensusResult): TestTool[] {
  const tools = new Set<TestTool>()
  for (const entry of census.entries) if (entry.tool !== "x" && entry.kind !== "gtm") tools.add(entry.tool)
  return (["infinite", "ga4", "posthog", "meta"] as const).filter((tool) => tools.has(tool))
}

/** Whether a Google Tag Manager container is on the site (its contents need runtime evidence, §3i.2 `via_tag_manager`). */
export function censusViaTagManager(census: CensusResult): boolean {
  return census.entries.some((entry) => entry.kind === "gtm")
}
