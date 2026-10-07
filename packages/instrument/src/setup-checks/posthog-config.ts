// Check 6 — the site's own (adopted) PostHog config, read across EVERY file that starts PostHog.
//
// `detectPosthogConfig` (inspect.ts) reads only the FIRST file with PostHog evidence and does not skip
// managed files (scout S5 fact 23); this check reads every adopted init, managed bytes excluded (those
// are infinite-tag's own and are tested where they are emitted).
//
// What it reports (never an edit — decision 4: an adopted provider changes only through a plan line):
//   • options that cannot be read (passed as a variable)        → undetermined;
//   • sends straight to a PostHog host (no first-party proxy)   → info (ad blockers drop it);
//   • no SPA page views on a client-routed app                  → info;
//   • the region differs from the connected project's           → problem (only when an expectation is given);
// and, for job 3's `posthog_config` check, `posthogConfigDrift(before, after)`: autocapture or session
// replay changed by an edit → problem, unless a D17 sensitive-pages line was approved.
import { readPosthogOption } from "../inspect.js"
import { posthogRegion } from "../checks/posthog-hosts.js"
import { sensitivePosthogOptions } from "../install/posthog-sensitive.js"
import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { lexicalStates } from "../lexical-states.js"

import { codeView, groupFindings, isHtmlFile, sourceUnits, unitLine } from "./code-view.js"
import {
  posthogNotProxiedMessage,
  posthogPrivacyChangedMessage,
  posthogRegionMismatchMessage,
  posthogSpaPageviewsMessage,
  posthogUnreadableMessage
} from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

export const POSTHOG_OPTION_KEYS = ["api_host", "ui_host", "defaults", "capture_pageview", "autocapture", "disable_session_recording"] as const
export type PosthogOptionKey = (typeof POSTHOG_OPTION_KEYS)[number]

export interface PosthogConfigRead {
  file: string
  line: number
  managed: boolean
  /** False when the options are a variable / expression: nothing below can be trusted. */
  readable: boolean
  options: Partial<Record<PosthogOptionKey, string>>
  /** The literal object, retained for exact checks of approved additions and overriding spreads. */
  optionsSource?: string
}

const INIT = /\bposthog\.init\s*\(/g
const PROVIDER = /<PostHogProvider\b/g

/** Every PostHog init (and `<PostHogProvider options={{…}}>`) in the app, managed ones flagged. */
export function readPosthogConfigs(files: ReadonlyMap<string, string>): PosthogConfigRead[] {
  const reads: PosthogConfigRead[] = []
  for (const unit of sourceUnits(files)) {
    const code = codeView(unit.file, unit.text)
    for (const match of code.matchAll(INIT)) {
      const start = (match.index ?? 0) + match[0].length
      const optionsAt = secondArgumentStart(code, start)
      const readable = optionsAt !== -1 && code[optionsAt] === "{"
      reads.push({
        file: unit.file,
        line: unitLine(unit, match.index ?? 0),
        managed: unit.managed,
        readable,
        options: readable ? readOptions(unit.text.slice(optionsAt, objectEnd(code, optionsAt))) : {},
        ...(readable ? { optionsSource: unit.text.slice(optionsAt, objectEnd(code, optionsAt)) } : {})
      })
    }
    for (const match of code.matchAll(PROVIDER)) {
      const tagEnd = code.indexOf(">", match.index ?? 0)
      const tag = code.slice(match.index ?? 0, tagEnd === -1 ? undefined : tagEnd)
      const optionsMatch = /\boptions\s*=\s*\{/.exec(tag)
      if (!optionsMatch) continue
      const braceAt = (match.index ?? 0) + optionsMatch.index + optionsMatch[0].length
      const readable = code[skipSpace(code, braceAt)] === "{"
      const objectAt = skipSpace(code, braceAt)
      reads.push({
        file: unit.file,
        line: unitLine(unit, match.index ?? 0),
        managed: unit.managed,
        readable,
        options: readable ? readOptions(unit.text.slice(objectAt, objectEnd(code, objectAt))) : {},
        ...(readable ? { optionsSource: unit.text.slice(objectAt, objectEnd(code, objectAt)) } : {})
      })
    }
  }
  return reads
}

function skipSpace(text: string, index: number): number {
  let at = index
  while (at < text.length && /\s/.test(text[at] as string)) at += 1
  return at
}

/** Start of the call's second argument (after the first top-level comma), or -1. */
function secondArgumentStart(code: string, from: number): number {
  let depth = 0
  let quote: string | null = null
  for (let index = from; index < code.length; index += 1) {
    const char = code[index] as string
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "(" || char === "{" || char === "[") depth += 1
    else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) return -1
      depth -= 1
    } else if (char === "," && depth === 0) return skipSpace(code, index + 1)
  }
  return -1
}

function objectEnd(code: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let index = open; index < code.length; index += 1) {
    const char = code[index] as string
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return code.length
}

function readOptions(objectText: string): Partial<Record<PosthogOptionKey, string>> {
  const options: Partial<Record<PosthogOptionKey, string>> = {}
  for (const key of POSTHOG_OPTION_KEYS) {
    const value = readPosthogOption(objectText, key)
    if (value !== undefined) options[key] = value
  }
  return options
}

/** PostHog's own defaults bundle with history-change page views starts at 2025-05-24. */
function spaPageviewsOn(options: Partial<Record<PosthogOptionKey, string>>): boolean {
  if (options.capture_pageview === "history_change") return true
  if (options.capture_pageview === "false") return true // the site captures page views itself
  const defaults = options.defaults
  return typeof defaults === "string" && /^\d{4}-\d{2}-\d{2}$/.test(defaults) && defaults >= "2025-05-24"
}

export interface PosthogConfigInput {
  files: ReadonlyMap<string, string>
  /** The connected project's `apiHost` (keys verb). Absent in the harness: no region verdict then. */
  expectedApiHost?: string
}

export function checkPosthogConfig(input: PosthogConfigInput): SetupCheckResult {
  const findings: SetupFinding[] = []
  for (const read of readPosthogConfigs(input.files)) {
    if (read.managed) continue
    const base = { check: "posthog_config" as const, file: read.file, line: read.line }
    if (!read.readable) {
      findings.push({ ...base, code: "INF_SETUP_POSTHOG_CONFIG_UNREADABLE", state: "undetermined", confidence: "certain", message: posthogUnreadableMessage(read) })
      continue
    }
    const apiHost = read.options.api_host
    const relative = apiHost !== undefined && apiHost.startsWith("/") && !apiHost.startsWith("//")
    if (!relative) {
      const served = apiHost ?? "https://us.i.posthog.com (PostHog's default)"
      findings.push({ ...base, code: "INF_SETUP_POSTHOG_NOT_PROXIED", state: "info", confidence: "likely", message: posthogNotProxiedMessage({ ...read, apiHost: served }) })
      if (input.expectedApiHost && !input.expectedApiHost.startsWith("/")) {
        const servedRegion = posthogRegion(apiHost ?? "https://us.i.posthog.com")
        const expectedRegion = posthogRegion(input.expectedApiHost)
        if (servedRegion !== "other" && expectedRegion !== "other" && servedRegion !== expectedRegion) {
          findings.push({
            ...base,
            code: "INF_SETUP_POSTHOG_REGION_MISMATCH",
            state: "problem",
            confidence: "certain",
            message: posthogRegionMismatchMessage({ ...read, served: apiHost ?? "https://us.i.posthog.com", expected: input.expectedApiHost })
          })
        }
      }
    }
    if (!isHtmlFile(read.file) && !spaPageviewsOn(read.options)) {
      findings.push({ ...base, code: "INF_SETUP_POSTHOG_SPA_PAGEVIEWS", state: "info", confidence: "likely", message: posthogSpaPageviewsMessage(read) })
    }
  }
  const grouped = groupFindings(findings, (finding) => finding.code)
  return { check: "posthog_config", state: worstState(grouped), findings: grouped }
}

/**
 * Job 3's guard (`posthog_config`): an edit must leave autocapture and session replay exactly as they
 * were, except the exact appended restrictive options from an approved sensitive-pages line.
 * Approval never permits turning either option on, changing the fallback, or adding another spread.
 */
export function posthogConfigDrift(
  before: readonly PosthogConfigRead[],
  after: readonly PosthogConfigRead[],
  options: { sensitivePagesApproved?: boolean; sensitivePaths?: readonly string[] } = {}
): SetupFinding[] {
  const findings: SetupFinding[] = []
  const occurrence = new Map<string, number>()
  for (const previous of before.filter((read) => !read.managed && read.readable)) {
    const index = occurrence.get(previous.file) ?? 0
    occurrence.set(previous.file, index + 1)
    const next = after.filter((read) => read.file === previous.file && !read.managed)[index]
    if (!next) continue
    if (previous.optionsSource && next.optionsSource) {
      const was = privacyMembers(previous.optionsSource)
      if (was === privacyMembers(next.optionsSource)) continue
      const stripped = stripSensitivePosthogAddition(next.optionsSource, options.sensitivePaths ?? [])
      const now = privacyMembers(stripped ?? next.optionsSource)
      if (was !== now) findings.push({
        check: "posthog_config", code: "INF_SETUP_POSTHOG_PRIVACY_CHANGED", state: "problem", confidence: "certain",
        file: next.file, line: next.line,
        message: "The PostHog privacy options changed beyond the approved restrictive addition. Keep existing options and append only the supplied replay/autocapture OFF options on the approved paths."
      })
      continue
    }
    for (const option of ["autocapture", "disable_session_recording"] as const) {
      const was = previous.options[option] ?? "(PostHog's default)"
      const now = next.readable ? (next.options[option] ?? "(PostHog's default)") : "(unreadable)"
      if (was === now) continue
      findings.push({
        check: "posthog_config",
        code: "INF_SETUP_POSTHOG_PRIVACY_CHANGED",
        state: "problem",
        confidence: "certain",
        file: next.file,
        line: next.line,
        message: posthogPrivacyChangedMessage({ file: next.file, option, before: was, after: now })
      })
    }
  }
  return findings
}

/** Remove formatting outside strings; paths and other literal values remain exact. */
function compactCode(source: string): string {
  const states = lexicalStates(source)
  return source.split("").filter((char, index) => states[index] !== 3 && !(states[index] === 0 && /\s/.test(char))).join("")
}

function objectMembers(source: string): string[] {
  const masked = maskCommentsAndStrings(source, true)
  let depth = 0
  let start = masked.indexOf("{") + 1
  const members: string[] = []
  for (let index = start; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === "{" || char === "[" || char === "(") depth += 1
    else if (char === "}" && depth === 0) { members.push(source.slice(start, index)); break }
    else if (char === "}" || char === "]" || char === ")") depth -= 1
    else if (char === "," && depth === 0) { members.push(source.slice(start, index)); start = index + 1 }
  }
  return members.map(member => member.trim()).filter(Boolean)
}

/** Keep every unknown member too: spreads, computed keys, getters and shorthand can override privacy. */
function privacyMembers(source: string): string {
  return objectMembers(source).map(compactCode).filter(member => !/^["']?(?:api_host|ui_host|defaults|capture_pageview)["']?:/.test(member)).join(",")
}

/** The accepted edit is the emitted addition, last in the object. No customer configuration runs. */
export function stripSensitivePosthogAddition(source: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const members = objectMembers(source)
  const last = members.at(-1)
  if (!last) return null
  const existing = `{${members.slice(0, -1).join(",")}}`
  const expected = sensitivePosthogOptions(`posthog.init('key', ${existing})`, paths)
  const both = sensitivePosthogOptions(undefined, paths)!
  if (![expected, both].some(paste => paste && compactCode(last) === compactCode(paste).replace(/,$/, ""))) return null
  return existing
}
