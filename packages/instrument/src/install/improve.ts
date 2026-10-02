// Decision 4: improve EXISTING (adopted) tags in place, never reinstall them.
//
// Two halves:
//   1. Detection → `ImproveLine[]`: what could be better about each adopted PostHog / GA4 / Meta tag,
//      read from the repo's own bytes (and the connection's ids). Each becomes ONE plan line; nothing
//      here edits anything, and an adopted provider is never moved into the install set.
//   2. The deterministic CODE edits (`owner: "code"`), run only for APPROVED lines:
//        • the PostHog `/ingest` proxy rewrite in `vercel.json` for an adopted static/Vite site
//          (the rewrite only; pointing the customer's `api_host` at it is agent job 3);
//        • the `_fbc` capture-only block beside an adopted pixel in an HTML page (D15: never
//          host-guarded; the bytes are O5's / Phase 1's `buildMetaClickIdCaptureScript`);
//        • D10: the literal `fbq('set','autoConfig',false,'<id>')` before the adopted `init`.
//      Every edit is recorded as an exact, reversible EditRecord (§3e.6).
//   D17 on a MANAGED PostHog is not an edit here: it is the `sensitivePaths` artifact option O5's
//   managed bytes read (`withSensitivePaths`).
//
// A REDUCTION (one init, one config per id, removing a hand-written gtag) is never an improve line:
// it is only `remove_duplicate` → job 6 (R2-10).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveVercelJsonContents, VERCEL_CONFIG_FILE } from "../frameworks/vercel-config.js"
import { writeFileAtomic } from "../frameworks/shared.js"
import { readPosthogOption } from "../inspect.js"
import { buildMetaClickIdCaptureScript, META_CLICK_ID_ACCESSOR } from "../providers/meta-browser/click-id.js"
import { checkMetaAutoConfigOptOut, type MetaAutoConfigVerdict } from "../providers/meta-browser/autoconfig.js"
import type { DetectedProviderEvidence } from "../harness/inspect.js"
import type { ImproveLine, ImproveLineKind, PosthogProxySpec, ProviderId } from "../types.js"
import { DEFAULT_POSTHOG_PROXY_PATH } from "../workspace-artifacts.js"
import type { TagKeys } from "../wizard/contracts/bridge.js"

import { makeEditRecord, type EditRecord } from "./edits.js"
import type { WizardInstallArtifacts } from "./keys-adapter.js"

/** The PostHog `defaults` date new installs get (port row 19). An adopted older one is a bump line. */
export const POSTHOG_DEFAULTS_CURRENT = "2026-01-30"
/** The first `defaults` date whose SPA page views are history-based (posthog-js). */
const POSTHOG_DEFAULTS_HISTORY = "2025-05-24"

/** The marker on the capture-only block the wizard adds beside an adopted pixel (never "Managed by Infinite": the page stays the customer's). */
export const CAPTURE_BLOCK_MARKER = "<!-- infinite-tag:improve capture_beside_adopted_pixel -->"

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

export interface AdoptedPosthogFact {
  file: string
  line: number
  key: string | null
  apiHost: string | null
  uiHost: string | null
  capturePageview: string | null
  defaults: string | null
  guarded: boolean
}

export interface AdoptedGa4Fact {
  file: string
  line: number
  key: string | null
  via: "snippet" | "gtm"
  guarded: boolean
}

export interface AdoptedMetaFact {
  file: string
  line: number
  pixelId: string | null
  /** The pixel lives in an .html page (the capture block can be inserted by code). */
  html: boolean
  /** A `_fbc` capture already runs on that page. */
  captureNearby: boolean
  guarded: boolean
  autoConfig: MetaAutoConfigVerdict | null
}

export interface AdoptedFacts {
  posthog: AdoptedPosthogFact[]
  ga4: AdoptedGa4Fact[]
  meta: AdoptedMetaFact[]
}

function readAppFile(appRootAbsolute: string, file: string): string | null {
  try {
    return readFileSync(join(appRootAbsolute, file), "utf8")
  } catch {
    return null
  }
}

/** Offset of the 1-based `line`'s start. */
function lineOffset(contents: string, line: number): number {
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = contents.indexOf("\n", offset)
    if (next < 0) return contents.length
    offset = next + 1
  }
  return offset
}

/**
 * Whether the adopted init sits behind a host check that runs BEFORE it in the same file. A static
 * heuristic biased to "not guarded" (which only ever proposes a line the user can decline).
 */
function guardedBefore(contents: string, offset: number): boolean {
  const before = contents.slice(0, offset)
  return /location\.host(?:name)?\b|__infiniteHostAllowed|infiniteHostAllowed/.test(before)
}

const clean = (value: string | undefined): string | null => (value === undefined ? null : value)

/** The adopted (customer-owned) PostHog / GA4 / Meta tags, read from the repo with file:line evidence. */
export function detectAdoptedFacts(appRootAbsolute: string, detected: readonly DetectedProviderEvidence[]): AdoptedFacts {
  const facts: AdoptedFacts = { posthog: [], ga4: [], meta: [] }
  for (const entry of detected) {
    const contents = readAppFile(appRootAbsolute, entry.file)
    if (contents === null) continue
    const offset = lineOffset(contents, entry.line)
    const guarded = guardedBefore(contents, offset)
    if (entry.provider === "posthog") {
      facts.posthog.push({
        file: entry.file,
        line: entry.line,
        key: entry.key ?? null,
        apiHost: clean(readPosthogOption(contents, "api_host")),
        uiHost: clean(readPosthogOption(contents, "ui_host")),
        capturePageview: clean(readPosthogOption(contents, "capture_pageview")),
        defaults: clean(readPosthogOption(contents, "defaults")),
        guarded
      })
    } else if (entry.provider === "ga4") {
      facts.ga4.push({ file: entry.file, line: entry.line, key: entry.key ?? null, via: entry.via, guarded })
    } else if (entry.provider === "meta") {
      const pixelId = entry.key ?? null
      facts.meta.push({
        file: entry.file,
        line: entry.line,
        pixelId,
        html: /\.html?$/.test(entry.file),
        captureNearby: contents.includes(META_CLICK_ID_ACCESSOR) || /document\.cookie[^;\n]*_fbc|["']_fbc=/.test(contents),
        guarded,
        autoConfig: pixelId ? checkMetaAutoConfigOptOut(contents, pixelId, "adopted") : null
      })
    }
  }
  return facts
}

// ---------------------------------------------------------------------------------------------
// Improve lines
// ---------------------------------------------------------------------------------------------

export interface ImproveLinesContext {
  framework: string
  keys: TagKeys
  /** D17 sensitive paths the detector found (O6), e.g. `/account`, `/checkout`. */
  sensitivePaths: readonly string[]
}

const lineId = (kind: ImproveLineKind, provider: ProviderId, target: string): string => `${kind}:${provider}:${target}`

const isRelativeApiHost = (value: string | null): boolean => value !== null && value.startsWith("/")

const PROVIDER_NAME: Record<ProviderId, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", x: "X", meta: "Meta" }

function previewGuardLine(provider: ProviderId, evidence: { file: string; line: number }): ImproveLine {
  return {
    id: lineId("preview_guard_adopted", provider, "init"),
    kind: "preview_guard_adopted",
    provider,
    target: "init",
    text:
      provider === "meta"
        ? "Meta: keep preview sites silent. Your existing pixel also fires on previews; its start (init + first PageView) gets the preview check. The ad-click capture keeps running, and production always fires."
        : `${PROVIDER_NAME[provider]}: keep preview sites silent. Your existing tag also fires on previews; its start gets the preview check. Production always fires.`,
    owner: "agent",
    evidence
  }
}

/**
 * One line per improvement, deterministic for the same input. ADOPTED providers only (a provider this
 * run installs gets its improvements in the managed bytes, with no line).
 */
export function improveLinesFor(facts: AdoptedFacts, ctx: ImproveLinesContext): ImproveLine[] {
  const lines: ImproveLine[] = []
  const htmlFramework = ctx.framework === "static-html" || ctx.framework === "vite-react"

  const posthog = facts.posthog[0]
  if (posthog) {
    const evidence = { file: posthog.file, line: posthog.line }
    if (!isRelativeApiHost(posthog.apiHost)) {
      lines.push({
        id: lineId("improve_additive", "posthog", "proxy"),
        kind: "improve_additive",
        provider: "posthog",
        target: "proxy",
        text: `PostHog: send events through your own domain (${DEFAULT_POSTHOG_PROXY_PATH}) so ad blockers do not drop them. Changes your existing PostHog's api_host${htmlFramework ? " and adds the rewrite to vercel.json" : " and the rewrite"}.`,
        owner: htmlFramework ? "code" : "agent",
        evidence
      })
    }
    const historyDefaults = posthog.defaults !== null && posthog.defaults.replace(/['"]/g, "") >= POSTHOG_DEFAULTS_HISTORY
    if (posthog.capturePageview?.replace(/['"]/g, "") !== "history_change" && !historyDefaults) {
      lines.push({
        id: lineId("improve_additive", "posthog", "history_change"),
        kind: "improve_additive",
        provider: "posthog",
        target: "history_change",
        text: "PostHog: count page changes in your single-page app (capture_pageview: 'history_change'). Changes your existing PostHog setup.",
        owner: "agent",
        evidence
      })
    }
    if (posthog.defaults === null || posthog.defaults.replace(/['"]/g, "") < POSTHOG_DEFAULTS_CURRENT) {
      lines.push({
        id: lineId("posthog_defaults_bump_adopted", "posthog", "defaults"),
        kind: "posthog_defaults_bump_adopted",
        provider: "posthog",
        target: "defaults",
        text: `PostHog: move your existing setup to defaults '${POSTHOG_DEFAULTS_CURRENT}'. This changes how PostHog measures; the report marks it "measurement changed", never growth.`,
        owner: "agent",
        evidence
      })
    }
    if (ctx.sensitivePaths.length > 0) {
      lines.push({
        id: lineId("sensitive_pages", "posthog", "replay_autocapture"),
        kind: "sensitive_pages",
        provider: "posthog",
        target: "replay_autocapture",
        text: `PostHog: turn session replay and autocapture off on sensitive pages (${ctx.sensitivePaths.join(", ")}) in your existing setup.`,
        owner: "agent",
        evidence
      })
    }
    if (!posthog.guarded) lines.push(previewGuardLine("posthog", evidence))
  }

  const connectionGa4 = new Set(ctx.keys.ga4.status === "connected" ? ctx.keys.ga4.streams.map((stream) => stream.measurementId) : [])
  const ga4 = facts.ga4.find((fact) => fact.via === "snippet")
  if (ga4) {
    const evidence = { file: ga4.file, line: ga4.line }
    if (ga4.key && connectionGa4.size > 0 && !connectionGa4.has(ga4.key)) {
      const target = [...connectionGa4][0]!
      lines.push({
        id: lineId("improve_additive", "ga4", "id"),
        kind: "improve_additive",
        provider: "ga4",
        target: "id",
        text: `GA4: your site sends ${ga4.key}, but your Infinite connection is ${connectionGa4.size === 1 ? target : `one of ${[...connectionGa4].join(", ")}`}. Change the existing tag's id to match.`,
        owner: "agent",
        evidence
      })
    }
    if (!ga4.guarded) lines.push(previewGuardLine("ga4", evidence))
  }

  const meta = facts.meta[0]
  if (meta) {
    const evidence = { file: meta.file, line: meta.line }
    if (!meta.captureNearby) {
      lines.push({
        id: lineId("capture_beside_adopted_pixel", "meta", "capture"),
        kind: "capture_beside_adopted_pixel",
        provider: "meta",
        target: "capture",
        text: "Meta: save the ad-click id (_fbc) on landing pages beside your existing pixel, so conversions can be matched to the ad. Adds a small script; your pixel itself is unchanged.",
        owner: meta.html ? "code" : "agent",
        evidence
      })
    }
    if (meta.autoConfig?.reason === "opt_out_missing" && meta.pixelId) {
      lines.push({
        id: lineId("autoconfig_off_adopted", "meta", "autoconfig"),
        kind: "autoconfig_off_adopted",
        provider: "meta",
        target: "autoconfig",
        text: `Meta: turn off automatic events on your existing pixel ${meta.pixelId} (one line before its init). They send button clicks and page data you did not choose.`,
        owner: "code",
        evidence
      })
    }
    if (!meta.guarded) lines.push(previewGuardLine("meta", evidence))
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// Code edits (approved lines only)
// ---------------------------------------------------------------------------------------------

export interface ImproveEditInput {
  root: string
  /** Repo-root-relative app root. */
  appRoot: string
  framework: string
  line: ImproveLine
  keys: TagKeys
  /** The plan's consent answer: the capture block uses the same Infinite consent hook as managed Meta. */
  consentMode: "required" | "not_required"
  runId: string
  /** Disambiguates two records of one file in one run. */
  seq?: number
}

export type ImproveEditResult =
  | { ok: true; record: EditRecord | null }
  | { ok: false; reason: string }

const repoRelative = (appRoot: string, file: string): string => (appRoot === "." ? file : `${appRoot}/${file}`)

/** The proxy upstreams from the connection's region; an unconnected PostHog only when its own api_host names the region. */
function proxySpecFor(keys: TagKeys, adoptedApiHost: string | null): PosthogProxySpec | null {
  const region =
    keys.posthog.status === "connected" && (keys.posthog.region === "us" || keys.posthog.region === "eu")
      ? keys.posthog.region
      : adoptedApiHost && /(^|\/\/)eu\.i\.posthog\.com/.test(adoptedApiHost)
        ? "eu"
        : adoptedApiHost && /(^|\/\/)us\.i\.posthog\.com/.test(adoptedApiHost)
          ? "us"
          : null
  if (!region) return null
  return {
    path: DEFAULT_POSTHOG_PROXY_PATH,
    ingestHost: `https://${region}.i.posthog.com`,
    assetsHost: `https://${region}-assets.i.posthog.com`
  }
}

function writeWithRecord(input: ImproveEditInput, file: string, before: string | null, after: string): ImproveEditResult {
  if (before === after) return { ok: true, record: null }
  writeFileAtomic(join(input.root, file), after)
  return {
    ok: true,
    record: makeEditRecord({ file, before, after, jobId: null, planLineId: input.line.id, by: "wizard", runId: input.runId, seq: input.seq })
  }
}

/** Applies ONE approved code-owned improve line. Anything else is refused with the reason. */
export function applyImproveEdit(input: ImproveEditInput): ImproveEditResult {
  const { line } = input
  if (line.owner !== "code") return { ok: false, reason: `${line.id} is an agent job, not a code edit` }
  const appRootAbsolute = input.appRoot === "." ? input.root : join(input.root, input.appRoot)

  if (line.kind === "improve_additive" && line.provider === "posthog" && line.target === "proxy") {
    if (input.framework !== "static-html" && input.framework !== "vite-react") {
      return { ok: false, reason: "the vercel.json proxy is for static and Vite sites; other frameworks get it from the agent (job 3)" }
    }
    const evidenceContents = line.evidence ? readAppFile(appRootAbsolute, line.evidence.file) : null
    const proxy = proxySpecFor(input.keys, evidenceContents ? clean(readPosthogOption(evidenceContents, "api_host")) : null)
    if (!proxy) return { ok: false, reason: "PostHog's region is unknown (connect PostHog in Infinite); the proxy is not guessed" }
    const file = repoRelative(input.appRoot, VERCEL_CONFIG_FILE)
    const path = join(input.root, file)
    const before = existsSync(path) ? readFileSync(path, "utf8") : null
    let after: string
    try {
      after = resolveVercelJsonContents(appRootAbsolute, proxy)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return writeWithRecord(input, file, before, after)
  }

  if (line.kind === "capture_beside_adopted_pixel" && line.provider === "meta") {
    if (!line.evidence || !/\.html?$/.test(line.evidence.file)) return { ok: false, reason: "the capture block is inserted by code only into an .html page" }
    const file = repoRelative(input.appRoot, line.evidence.file)
    const before = readAppFile(appRootAbsolute, line.evidence.file)
    if (before === null) return { ok: false, reason: `${file} is unreadable` }
    if (before.includes(CAPTURE_BLOCK_MARKER) || before.includes(META_CLICK_ID_ACCESSOR)) return { ok: true, record: null }
    const init = before.search(/fbq\s*\(\s*["']init["']|connect\.facebook\.net\/[^"']*fbevents\.js/)
    if (init < 0) return { ok: false, reason: `no pixel bootstrap found in ${file}` }
    const scriptStart = before.lastIndexOf("<script", init)
    if (scriptStart < 0) return { ok: false, reason: `the pixel in ${file} is not in a <script> tag` }
    const lineStart = before.lastIndexOf("\n", scriptStart - 1) + 1
    const indent = /^[ \t]*/.exec(before.slice(lineStart, scriptStart))?.[0] ?? ""
    const capture = buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: input.consentMode } })
    const block = `${CAPTURE_BLOCK_MARKER}\n${indent}<script>\n${capture}\n${indent}</script>\n${indent}`
    const after = before.slice(0, scriptStart) + block + before.slice(scriptStart)
    return writeWithRecord(input, file, before, after)
  }

  if (line.kind === "autoconfig_off_adopted" && line.provider === "meta") {
    if (!line.evidence) return { ok: false, reason: "no evidence for the adopted pixel" }
    const file = repoRelative(input.appRoot, line.evidence.file)
    const before = readAppFile(appRootAbsolute, line.evidence.file)
    if (before === null) return { ok: false, reason: `${file} is unreadable` }
    const pixel = /fbq\s*\(\s*["']init["']\s*,\s*["'](\d{15,16})["']/.exec(before)
    if (!pixel) return { ok: false, reason: `no literal fbq('init', '<id>') in ${file}` }
    const pixelId = pixel[1]!
    const inits = before.match(new RegExp(String.raw`fbq\s*\(\s*["']init["']\s*,\s*["']${pixelId}["']`, "g")) ?? []
    if (inits.length !== 1) return { ok: false, reason: `${file} initialises pixel ${pixelId} ${inits.length} times; the opt-out is left to job 6` }
    const verdict = checkMetaAutoConfigOptOut(before, pixelId, "adopted")
    if (verdict.reason === "opted_out_before_init") return { ok: true, record: null }
    if (verdict.reason !== "opt_out_missing") return { ok: false, reason: `automatic events on ${pixelId}: ${verdict.reason}; not changed by code` }
    const at = pixel.index
    const lineStart = before.lastIndexOf("\n", at - 1) + 1
    const indent = /^[ \t]*/.exec(before.slice(lineStart, at))?.[0] ?? ""
    const prefix = before.slice(lineStart, at).trim() === "" ? "" : "\n" + indent
    const insertion = `fbq('set', 'autoConfig', false, '${pixelId}');${prefix === "" ? `\n${indent}` : " "}`
    const after = before.slice(0, at) + insertion + before.slice(at)
    return writeWithRecord(input, file, before, after)
  }

  return { ok: false, reason: `${line.id} has no code edit` }
}

/** D17 on a MANAGED PostHog: the managed init turns replay + autocapture off on these paths (O5's bytes). */
export function withSensitivePaths(artifacts: WizardInstallArtifacts, paths: readonly string[]): WizardInstallArtifacts {
  if (!artifacts.posthog || paths.length === 0) return artifacts
  return { ...artifacts, posthog: { ...artifacts.posthog, sensitivePaths: [...paths] } }
}
