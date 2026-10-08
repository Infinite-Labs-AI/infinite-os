// The job table's static (S) checks that verify an AGENT's edit (review I1 P1-5): jobs 1, 2, 3, 8, 9, 12 and 14.
// Before these existed a claim on those jobs could never be checked, so the item stayed `claimed` forever and
// its unverified code still shipped in the PR.
//
// Every check here reads the item's OWN files (its allowlist, repo-root relative) after the turn, never the
// agent's claim, and gives exactly ONE result per check id (the state machine reads one result per check):
//   pass         — the wizard found the edit it needs, in the right place, with the right values;
//   problem      — the edit is missing, misplaced, or does what the rules forbid (the reason says which);
//   undetermined — the wizard cannot tell from source (a computed value, a missing run fact); never a pass.
// Comments and string literals never count as code (`maskCommentsAndStrings`), and a crash is undetermined.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, normalize, isAbsolute } from "node:path"

import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { buildManagedRewritePairs, hasExactNextConfigRewrites, parseVercelConfig } from "../frameworks/vercel-config.js"
import { lineNumberAt } from "../harness/scan.js"
import { detectAuth } from "../jobs/detectors/auth.js"
import { detectCspOwners } from "../jobs/detectors/csp-owner.js"
import { detectConversionSuccessPaths, detectOutcomes, isServerFile } from "../jobs/detectors/outcomes.js"
import { matchingBracket } from "../setup-checks/code-view.js"
import { boundConversionNames } from "../jobs/plan-data.js"
import { capturesPageviewManually, META_STANDARD_EVENTS, POSTHOG_HISTORY_DEFAULTS_FROM, posthogApiHostUnset } from "../jobs/detectors/adopted-tags.js"
import { POSTHOG_DEFAULTS_CURRENT } from "../install/improve.js"
import { readPosthogOptionValue, type PosthogOptionValue } from "../inspect.js"
import { isRelativePath } from "./posthog-hosts.js"
import type { RepoSnapshot } from "../jobs/repo-files.js"
import type { ManagedProxySpec as ProxyInput } from "../frameworks/vercel-config.js"
import type { ChecklistItem, CheckContext, CheckFn, CheckResult, CheckRunner } from "../wizard/contracts/jobs.js"
import type { TestExpect, TestTool } from "../wizard/contracts/test-engine.js"
import { runCensus } from "./census.js"
import { analyzeCsp, cspNeeds, parseCspPolicies } from "./live/csp.js"
import { checkResult, isolated } from "./result.js"
import { callsOf, literalString, splitTopLevelArgs, topLevelProps, type Call } from "./source-calls.js"
import { adMatchFindings, canonicalEvent, doubleCountFindings, metaEventIdFindings, outcomeHas, outcomesIn, piiFindings, promiseFindings, valueFindings, type CommerceCheckInput, type CommerceFinding, type OutcomeCall } from "./commerce-static.js"
import type { EventInventory, InventoryTool as CommerceTool } from "./commerce-inventory.js"
import { COMMERCE_EVENTS_TARGET } from "../scan/event-inventory.js"

/** The tool a browser commerce item (`<job>:commerce_events`) adds its events to. */
const COMMERCE_ITEM_TOOL: Readonly<Partial<Record<string, CommerceTool>>> = { meta_improve: "meta", ga4_improve: "ga4", posthog_improve: "posthog" }
const TOOL_NAME: Readonly<Record<CommerceTool, string>> = { meta: "Meta", ga4: "GA4", posthog: "PostHog", infinite: "Infinite" }
import { loadRepoSnapshot } from "../jobs/repo-files.js"

export { callsOf, topLevelProps } from "./source-calls.js"
import { GA4_PAGE_CHANGE_SCRIPT, META_PAGE_CHANGE_SCRIPT, pastedInPlace } from "../jobs/briefs.js"
import { readPosthogConfigs, stripSensitivePosthogAddition } from "../setup-checks/posthog-config.js"

/** The check ids this module registers (the job table's S checks that had no implementation). */
export const JOB_STATIC_CHECK_IDS = [
  "server_lane_mount_order",
  "rescan_app_found",
  "next_rewrites_exact",
  "outcome_after_success",
  "track_after_success",
  "outcome_declared",
  "event_id_stable",
  "no_pii_in_outcome",
  "identify_on_auth_success",
  "reset_on_every_signout",
  "csp_hosts",
  "pr_checks_pass",
  // LF4 close round 2 (P1-1): each job target's own proof that its change is in the code.
  "conversion_tracked",
  "meta_mirror_wired",
  "posthog_improve_applied",
  "spa_page_view_applied",
  "ga4_id_applied",
  // Review r3 "static checks / prove": the plan's event × tool promises, the money and match data on outcomes, and
  // no second send of an event a tool already gets (`commerce-static.ts`).
  "commerce_promises_met",
  "outcome_ad_match",
  "outcome_value_currency",
  "no_double_count",
  "meta_event_id_from_server"
] as const
export type JobStaticCheckId = (typeof JOB_STATIC_CHECK_IDS)[number]

/** What the run knows that the item does not carry (wired from the run's hand-off files in `deps.ts`). */
export interface JobStaticRunContext {
  /** The site's production hosts (CSP needs are checked against the first). */
  productionHosts?: readonly string[]
  /** The connections' public ids (which tools a CSP must allow). */
  expect?: TestExpect
  /** The conversion names the user approved in the plan. */
  conversionNames?: readonly string[]
  posthogSensitivePaths?: readonly string[]
  /** Legacy input, ignored. Policy content is never checked. */
  privacyText?: string | null
  /** Legacy input, ignored by policy checks (which are retired). */
  newTools?: readonly TestTool[]
  /** The same-origin rewrites the run's managed install relies on (Infinite's collect path, PostHog's /ingest). */
  proxy?: ProxyInput
  /** The scan's event × tool inventory: what the site sends each tool, and what the plan promised to add. */
  eventInventory?: EventInventory | null
  /** Meta gets this site's conversions (connected in Infinite, or the site runs a pixel); absent = assume it does. */
  metaInUse?: boolean
}

export interface JobStaticDeps {
  /** The repo root (an input's `root` is used when absent). */
  root?: string
  run?: () => JobStaticRunContext | undefined
  /** A file as it was at the base commit (repo-relative): text, null = absent there, undefined = unreadable. */
  readBaseFile?: (root: string, file: string) => string | null | undefined
}

interface JobInput {
  item: Pick<ChecklistItem, "id" | "jobId" | "allow" | "trigger" | "inventory">
  root: string
  appRoot: string
}

// ---------------------------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------------------------

function jobInput(input: unknown, deps: JobStaticDeps): JobInput {
  if (!input || typeof input !== "object") throw new TypeError("the check input must be an object")
  const record = input as Record<string, unknown>
  const item = record.item as JobInput["item"] | undefined
  if (!item || typeof item !== "object" || !item.allow) throw new TypeError("a job check needs the item")
  const root = deps.root ?? (typeof record.root === "string" ? record.root : null)
  if (!root) throw new TypeError("a job check needs the repo root")
  const appRoot = typeof record.appRoot === "string" && record.appRoot !== "" ? record.appRoot : "."
  return { item, root, appRoot: isAbsolute(appRoot) ? "." : appRoot }
}

/** The item's files (allowlist + creatable, no globs), repo-relative, that exist now, with their text. */
function itemFiles(input: JobInput): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of [...input.item.allow.files, ...input.item.allow.create]) {
    if (raw.includes("*")) continue
    const file = normalize(raw)
    if (isAbsolute(file) || file.startsWith("..")) continue
    const path = join(input.root, file)
    if (!existsSync(path)) continue
    try {
      out.set(file, readFileSync(path, "utf8"))
    } catch {
      // unreadable: not a file the check can grade
    }
  }
  return out
}

function snapshotOf(files: ReadonlyMap<string, string>, appRoot: string): RepoSnapshot {
  return { appRoot, files, packages: [], truncated: false }
}

function itemTarget(item: Pick<ChecklistItem, "id">): string {
  const index = item.id.indexOf(":")
  return index < 0 ? "" : item.id.slice(index + 1)
}

/** True when `index` is inside a `catch (…) { … }` block of the masked text. */
function insideCatch(masked: string, index: number): boolean {
  for (const match of masked.slice(0, index).matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 0
    const open = (match.index ?? 0) + match[0].length - 1
    let closed = false
    for (let cursor = open; cursor < index; cursor += 1) {
      if (masked[cursor] === "{") depth += 1
      else if (masked[cursor] === "}") {
        depth -= 1
        if (depth === 0) {
          closed = true
          break
        }
      }
    }
    if (!closed) return true
  }
  return false
}

const files = (list: readonly string[]): string => list.slice(0, 4).join(", ") + (list.length > 4 ? ", …" : "")

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

const HASHED = /\b(?:createHash|sha256|sha-256|hash\w*|digest)\b/i
/** An id that changes on every call: a retry would count twice (or every outcome would dedupe into one). */
const UNSTABLE_ID = /(?:\bDate\s*\.\s*now|\bMath\s*\.\s*random|\brandomUUID|\buuid(?:v4)?|\bv4|\bnanoid|\bcuid2?|\bperformance\s*\.\s*now|\bnew\s+Date)\s*\(/

/** Every outcome report in the job's files: the generic reporters and the Stripe / lead recipe reporters alike. */
function outcomeCalls(scope: ReadonlyMap<string, string>): OutcomeCall[] {
  return [...scope].flatMap(([file, text]) => outcomesIn(file, text))
}

function noOutcomeCall(checkId: JobStaticCheckId, scope: ReadonlyMap<string, string>, ctx: CheckContext): CheckResult {
  return { ...checkResult(checkId, "problem", "S", ctx, { reason: `no report to Infinite (reportInfiniteOutcome, reportStripeCheckoutPurchase, reportStripeCheckoutStarted or reportInfiniteLead) in ${files([...scope.keys()]) || "the job's files"}` }), absent: true }
}

const TRACK_CALLS = ["infiniteTrack", "infiniteTrackThenNavigate"] as const
/** A line that is a link, a button or a click handler (the conversion's intent, never its success). */
const CTA_LINE = /<\s*(?:a|Link|button)\b|\bonClick\s*=|(?<![.\w$])href\s*=/
const NAVIGATION_CALL = /\b(?:router\s*\.\s*(?:push|replace)|(?:window\s*\.\s*)?location\s*\.\s*(?:assign|replace)|redirect)\s*\(|\b(?:window\s*\.\s*)?location\s*\.\s*href\s*=/

/** The conversion name a track call sends: `infiniteTrack("x")`'s first argument, else any plain string argument. */
function trackedName(call: Pick<Call, "name" | "args">): string | null {
  const parts = splitTopLevelArgs(call.args)
  if (call.name === "infiniteTrack") return parts[0] !== undefined ? literalString(parts[0]) : null
  for (const part of parts) {
    const value = literalString(part)
    if (value !== null && /^[a-z][a-z0-9_]*$/.test(value)) return value
  }
  return null
}

/**
 * The success branch that starts on `line`: an `if (…)`'s consequent (a `{…}` block, or one statement up to its
 * `;` / line end / `else`); for a navigation-only success point, the code from the first `await` to the end of that
 * line. Offsets into the file's text; null when the line holds neither.
 */
function successRegion(text: string, line: number): { start: number; end: number } | null {
  const masked = maskCommentsAndStrings(text, true)
  const lineStart = text.split("\n").slice(0, line - 1).reduce((sum, entry) => sum + entry.length + 1, 0)
  const lineEnd = text.indexOf("\n", lineStart) === -1 ? text.length : text.indexOf("\n", lineStart)
  const condition = /\bif\s*\(/.exec(masked.slice(lineStart, lineEnd))
  if (condition) {
    const open = lineStart + condition.index + condition[0].length - 1
    const close = matchingBracket(masked, open)
    if (close < 0) return null
    let cursor = close + 1
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor += 1
    if (masked[cursor] === "{") {
      const end = matchingBracket(masked, cursor)
      return end < 0 ? null : { start: cursor, end }
    }
    const rest = masked.slice(cursor)
    const stop = rest.search(/;|\n|\belse\b/)
    return { start: cursor, end: stop < 0 ? masked.length : cursor + stop }
  }
  const awaited = masked.slice(0, lineEnd).search(/\bawait\b/)
  return awaited < 0 ? null : { start: awaited, end: lineEnd }
}

/** ONE result for a commerce rule: its first problem (with how many more), else its first unknown, else a pass. */
function commerceResult(checkId: JobStaticCheckId, ctx: CheckContext, findings: readonly CommerceFinding[], passReason: string): CheckResult {
  const problems = findings.filter((finding) => finding.state === "problem")
  const chosen = problems[0] ?? findings.find((finding) => finding.state === "undetermined")
  if (!chosen) return checkResult(checkId, "pass", "S", ctx, { reason: passReason })
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more: ${problems.slice(1, 3).map((finding) => finding.message).join(" ")})` : ""
  return checkResult(checkId, chosen.state, "S", ctx, {
    reason: `${chosen.message}${chosen.state === "problem" ? more : ""}`,
    ...(chosen.file ? { evidence: [{ file: chosen.file, line: chosen.line ?? 1 }] } : {})
  })
}

export function jobStaticCheckFunctions(deps: JobStaticDeps): Record<JobStaticCheckId, CheckFn> {
  const run = (checkId: JobStaticCheckId, body: (input: JobInput, ctx: CheckContext) => CheckResult): CheckFn =>
    (input, ctx) => isolated(checkId, "S", ctx, async () => [body(jobInput(input, deps), ctx)])
  const context = (): JobStaticRunContext => deps.run?.() ?? {}
  const result = (checkId: JobStaticCheckId, ctx: CheckContext, state: CheckResult["state"], reason: string, file?: string, line?: number) =>
    checkResult(checkId, state, "S", ctx, { reason, ...(file ? { evidence: [{ file, line: line ?? 1 }] } : {}) })
  /** The commerce input with each file's text before this run (none when any base read fails). */
  const withBase = (input: JobInput, commerce: CommerceCheckInput): CommerceCheckInput => {
    const base = new Map<string, string | null>()
    for (const file of commerce.files.keys()) {
      const text = (deps.readBaseFile ?? gitShowFile)(input.root, file)
      if (text === undefined) return commerce
      base.set(file, text)
    }
    return { ...commerce, base }
  }
  /** LF4 close round 2 (P2-2): a problem that is the job's change MISSING from the code (`CheckResult.absent`). */
  const missing = (checkId: JobStaticCheckId, ctx: CheckContext, reason: string, file?: string, line?: number): CheckResult => ({
    ...result(checkId, ctx, "problem", reason, file, line),
    absent: true
  })

  return {
    spa_page_view_applied: run("spa_page_view_applied", (input, ctx) => {
      const tool = input.item.jobId === "ga4_improve" ? "ga4" : "meta"
      const script = tool === "ga4" ? GA4_PAGE_CHANGE_SCRIPT : META_PAGE_CHANGE_SCRIPT
      const ids = context().expect?.ga4 ?? []
      if (tool === "ga4" && ids.length === 0) return result("spa_page_view_applied", ctx, "undetermined", "the connected GA4 measurement ids are not known")
      for (const [file, text] of itemFiles(input)) {
        const placements = tool === "ga4" ? ids.map(measurementId => ({ kind: "after_ga4_config" as const, measurementId })) : [{ kind: "after_meta_pageview" as const }]
        if (placements.some(placement => pastedInPlace(text, { file, text: script, placement }))) {
          return result("spa_page_view_applied", ctx, "pass", `the supplied ${tool === "ga4" ? "GA4" : "Meta"} page-change subscription is immediately after its initial page-view statement`, file)
        }
      }
      return missing("spa_page_view_applied", ctx, "the supplied page-change subscription is not in its prescribed place")
    }),
    ga4_id_applied: run("ga4_id_applied", (input, ctx) => {
      const ids = context().expect?.ga4
      if (!ids?.length) return result("ga4_id_applied", ctx, "undetermined", "the connected GA4 measurement ids are not known")
      const files = new Set(itemFiles(input).keys())
      const entries = runCensus({ root: input.root, appRoot: input.appRoot }).entries.filter(entry => entry.tool === "ga4" && entry.kind !== "gtm" && entry.owner === "adopted" && files.has(entry.file))
      if (entries.length === 0) return missing("ga4_id_applied", ctx, "no adopted GA4 config in the job's files")
      if (entries.some(entry => entry.id === null)) return result("ga4_id_applied", ctx, "undetermined", "an adopted GA4 id is not a readable literal")
      if (entries.some(entry => !ids.includes(entry.id!))) return missing("ga4_id_applied", ctx, "the adopted GA4 id does not match the connected measurement id")
      return result("ga4_id_applied", ctx, "pass", "every adopted GA4 config in the job's files uses a connected measurement id")
    }),
    // Job 1: the lane is mounted before the routes (a Node server), or wraps the exported middleware (Next).
    server_lane_mount_order: run("server_lane_mount_order", (input, ctx) => {
      const scope = itemFiles(input)
      const entries = [...scope].filter(([file]) => !/(?:^|\/)lib\/infinite-(?:server-lane|outcome)\.[cm]?[jt]s$/.test(file))
      if (entries.length === 0) return missing("server_lane_mount_order", ctx, "the server entry or middleware file is gone")
      for (const [file, text] of entries) {
        const masked = maskCommentsAndStrings(text, true)
        const isMiddleware = /(?:^|\/)(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/.test(file)
        if (isMiddleware) {
          const wraps = /export\s+default\s+withInfiniteServerLane\s*\(|export\s+const\s+(?:middleware|proxy)\s*=\s*withInfiniteServerLane\s*\(/.test(masked)
          if (!wraps) {
            return masked.includes("withInfiniteServerLane")
              ? result("server_lane_mount_order", ctx, "undetermined", `${file} uses withInfiniteServerLane, but not as the exported middleware the wizard can read`, file)
              : missing("server_lane_mount_order", ctx, `${file} does not wrap its middleware in withInfiniteServerLane`, file)
          }
          continue
        }
        const mount = /\.\s*use\s*\(\s*infiniteServerLane\s*\(/.exec(masked)
        if (!mount) return missing("server_lane_mount_order", ctx, `${file} does not mount infiniteServerLane() (app.use(infiniteServerLane()))`, file)
        const route = /\.\s*(?:get|post|put|patch|delete|all|route|register|static)\s*\(|\.\s*use\s*\(\s*(?!infiniteServerLane\b)|\bexpress\s*\.\s*static\s*\(|\.\s*listen\s*\(/.exec(masked)
        if (route && route.index < mount.index) {
          return result("server_lane_mount_order", ctx, "problem", `${file} mounts the lane after a route or static handler (line ${lineNumberAt(text, route.index)}); HTML served before it is never counted`, file, lineNumberAt(text, mount.index))
        }
      }
      return result("server_lane_mount_order", ctx, "pass", "the server lane is mounted before every route")
    }),

    // Job 2: the managed tag is in the real app shell (the census finds it in one of the job's files).
    rescan_app_found: run("rescan_app_found", (input, ctx) => {
      const allowed = new Set([...input.item.allow.files, ...input.item.allow.create].map((file) => normalize(file)))
      const census = runCensus({ root: input.root, appRoot: input.appRoot })
      const managed = census.entries.filter((entry) => entry.owner === "managed" && allowed.has(normalize(entry.file)))
      if (managed.length > 0) return result("rescan_app_found", ctx, "pass", `the managed tag is in ${managed[0]!.file}`, managed[0]!.file, managed[0]!.line)
      const scope = itemFiles(input)
      const mounted = [...scope].find(([, text]) => /(?:infinite-analytics(?:-client)?|InfiniteAnalyticsClient)\b/.test(maskCommentsAndStrings(text, false)))
      if (mounted) return result("rescan_app_found", ctx, "pass", `${mounted[0]} mounts the managed analytics module`, mounted[0])
      return missing("rescan_app_found", ctx, `the managed tag is not in any of the job's files (${files([...allowed])})`)
    }),

    // Jobs 2/3: the exact same-origin rewrites the managed install relies on are in the app's config.
    next_rewrites_exact: run("next_rewrites_exact", (input, ctx) => {
      const proxy = context().proxy
      const needed: ProxyInput = input.item.jobId === "posthog_improve" ? { posthog: proxy?.posthog } : { infinite: proxy?.infinite }
      if (!needed.posthog && !needed.infinite) return result("next_rewrites_exact", ctx, "undetermined", "the run's expected rewrites are not known (no connection read), so they could not be compared")
      const pairs = buildManagedRewritePairs(needed)
      const prefix = input.appRoot === "." ? "" : `${input.appRoot}/`
      for (const name of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
        const path = join(input.root, prefix, name)
        if (!existsSync(path)) continue
        if (hasExactNextConfigRewrites(readFileSync(path, "utf8"), needed)) return result("next_rewrites_exact", ctx, "pass", `${prefix}${name} has every rewrite exactly`, `${prefix}${name}`)
      }
      const vercel = join(input.root, prefix, "vercel.json")
      if (existsSync(vercel)) {
        try {
          const rewrites = (parseVercelConfig(readFileSync(vercel, "utf8")).rewrites ?? []) as Array<{ source?: unknown; destination?: unknown }>
          if (pairs.every((pair) => rewrites.some((entry) => entry.source === pair.source && entry.destination === pair.destination))) {
            return result("next_rewrites_exact", ctx, "pass", `${prefix}vercel.json has every rewrite exactly`, `${prefix}vercel.json`)
          }
        } catch {
          // not JSON: it has no rewrite the wizard can read
        }
      }
      return missing("next_rewrites_exact", ctx, `missing rewrite(s): ${pairs.map((pair) => `${pair.source} to ${pair.destination}`).join("; ")}`)
    }),

    // Job 8: the outcome is reported AFTER the success point, never before it or from an error branch.
    outcome_after_success: run("outcome_after_success", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("outcome_after_success", scope, ctx)
      const target = itemTarget(input.item)
      // A checkout start becomes real when the payment session exists: its success point is the session creation.
      const triggers: Array<{ file: string; line: number; detail: string }> =
        target === "begin_checkout"
          ? [...scope].flatMap(([file, text]) =>
              [...maskCommentsAndStrings(text, true).matchAll(/\.\s*checkout\s*\.\s*sessions\s*\.\s*create\s*\(/g)].map((match) => ({ file, line: lineNumberAt(text, match.index ?? 0), detail: "checkout session creation" }))
            )
          : detectOutcomes(snapshotOf(scope, input.appRoot)).filter((finding) => finding.conversionType === target || target === "")
      for (const { file, call } of calls) {
        const masked = maskCommentsAndStrings(scope.get(file)!, true)
        if (insideCatch(masked, call.index)) return result("outcome_after_success", ctx, "problem", `${file}:${call.line} reports the outcome from an error branch`, file, call.line)
      }
      if (triggers.length === 0) return result("outcome_after_success", ctx, "undetermined", "the success point the job was seeded from is no longer recognisable, so the order could not be checked")
      for (const trigger of triggers) {
        const after = calls.some(({ file, call }) => file === trigger.file && call.line > trigger.line)
        const elsewhere = calls.some(({ file }) => file !== trigger.file)
        if (!after && !elsewhere) {
          return result("outcome_after_success", ctx, "problem", `${trigger.file}: the outcome is reported before the success point (line ${trigger.line}), so a failed ${trigger.detail} would still count`, trigger.file, trigger.line)
        }
      }
      return result("outcome_after_success", ctx, "pass", "the outcome is reported after the success point")
    }),

    // §3x.3 (B3) Job 10, outcome conversions: `infiniteTrack(<approved name>)` (or `infiniteTrackThenNavigate(…,
    // <approved name>)`) sits INSIDE the success branch the job was seeded from, before its navigation; never on the
    // link or button that leads to the form (that click is intent, recorded by the runtime as such).
    track_after_success: run("track_after_success", (input, ctx) => {
      const target = itemTarget(input.item)
      const approved = context().conversionNames
      if (!approved) return result("track_after_success", ctx, "undetermined", "the approved conversion names are not known, so the call could not be compared")
      const names = boundConversionNames(target, [...approved])
      if (names.length === 0) return result("track_after_success", ctx, "undetermined", `no approved conversion name is bound to ${target}`)
      const scope = itemFiles(input)
      const calls = [...scope].flatMap(([file, text]) =>
        callsOf(text, TRACK_CALLS)
          .filter((call) => trackedName(call) !== null && names.includes(trackedName(call)!))
          .map((call) => ({ ...call, file }))
      )
      if (calls.length === 0) return missing("track_after_success", ctx, `no infiniteTrack(${JSON.stringify(names[0])}) in ${files([...scope.keys()]) || "the job's files"}`)
      for (const call of calls) {
        const lineText = scope.get(call.file)!.split("\n")[call.line - 1] ?? ""
        if (CTA_LINE.test(lineText)) {
          return result("track_after_success", ctx, "problem", `${call.file}:${call.line} sends the ${target} from the link or button that leads to the form, not from its success`, call.file, call.line)
        }
      }
      const successes = detectConversionSuccessPaths(snapshotOf(scope, input.appRoot)).filter((finding) => finding.conversionType === target)
      if (successes.length === 0) return result("track_after_success", ctx, "undetermined", "the success point the job was seeded from is no longer recognisable, so the call's place could not be checked")
      for (const success of successes) {
        const text = scope.get(success.file)!
        const region = successRegion(text, success.line)
        if (!region) continue
        const masked = maskCommentsAndStrings(text, true)
        const navigation = new RegExp(NAVIGATION_CALL.source, "g")
        navigation.lastIndex = region.start
        const nav = navigation.exec(masked)
        const navAt = nav && nav.index < region.end ? nav.index : null
        const inside = calls.find(
          (call) => call.file === success.file && call.index >= region.start && call.index < region.end && (navAt === null || call.name === "infiniteTrackThenNavigate" || call.index < navAt)
        )
        if (inside) return result("track_after_success", ctx, "pass", `${inside.file}:${inside.line} sends the ${target} after it succeeds`, inside.file, inside.line)
      }
      const first = successes[0]!
      return result("track_after_success", ctx, "problem", `the ${target} is not sent inside its success branch (${first.file}:${first.line}), before the navigation`, first.file, first.line)
    }),

    // Job 8: the outcome's `type` is one of the conversion names the user approved for this job.
    outcome_declared: run("outcome_declared", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("outcome_declared", scope, ctx)
      const approved = context().conversionNames
      if (!approved) return result("outcome_declared", ctx, "undetermined", "the approved conversion names are not known, so the outcome name could not be compared")
      const bound = boundConversionNames(itemTarget(input.item), [...approved])
      // A job's files may hold another conversion's report too (the checkout route reports begin_checkout and saves
      // what the purchase webhook reads): only the reports of THIS job's conversion are graded, and at least one must be.
      const own = calls.filter((outcome) => outcome.type === null || bound.includes(outcome.type) || canonicalEvent(outcome.type) === canonicalEvent(itemTarget(input.item)))
      if (own.length === 0) {
        const other = calls.find((outcome) => outcome.type !== null)!
        return result("outcome_declared", ctx, "problem", `${other.file}:${other.call.line} reports "${other.type}", which is not an approved conversion name for this job (${bound.join(", ") || "none"})`, other.file, other.call.line)
      }
      // Another conversion's report in the same file is fine only under a name the user approved for it.
      const stray = calls.find((outcome) => !own.includes(outcome) && outcome.type !== null && !approved.includes(outcome.type))
      if (stray) return result("outcome_declared", ctx, "problem", `${stray.file}:${stray.call.line} reports "${stray.type}", which is not an approved conversion name`, stray.file, stray.call.line)
      for (const outcome of own) {
        const { file, call } = outcome
        if (outcome.props === null) return result("outcome_declared", ctx, "undetermined", `${file}:${call.line} passes a value the wizard cannot read as an object`, file, call.line)
        if (outcome.type === null) {
          return outcome.props.has("type")
            ? result("outcome_declared", ctx, "undetermined", `${file}:${call.line} computes the outcome name, so it could not be compared with the approved names`, file, call.line)
            : result("outcome_declared", ctx, "problem", `${file}:${call.line} reports an outcome with no type`, file, call.line)
        }
        if (!bound.includes(outcome.type)) {
          return result("outcome_declared", ctx, "problem", `${file}:${call.line} reports "${outcome.type}", which is not an approved conversion name for this job (${bound.join(", ") || "none"})`, file, call.line)
        }
        if (!outcomeHas(outcome, "path")) {
          return result("outcome_declared", ctx, "problem", `${file}:${call.line} reports an outcome with no top-level path; Meta relay needs path for event_source_url`, file, call.line)
        }
      }
      return result("outcome_declared", ctx, "pass", "every outcome uses an approved conversion name and carries a path")
    }),

    // Job 8: every outcome carries a stable eventId (an order / row / account id), never a random or a constant.
    event_id_stable: run("event_id_stable", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("event_id_stable", scope, ctx)
      for (const outcome of calls) {
        const { file, call } = outcome
        // A recipe reporter keys the outcome itself (the Stripe session id, one id per person for a lead).
        if (outcome.reporter.builtIn.has("eventId")) continue
        const props = outcome.props
        if (props === null) return result("event_id_stable", ctx, "undetermined", `${file}:${call.line} passes a value the wizard cannot read as an object`, file, call.line)
        const id = props.get("eventId")
        if (id === undefined) return result("event_id_stable", ctx, "problem", `${file}:${call.line} has no eventId, so a retry counts twice`, file, call.line)
        if (UNSTABLE_ID.test(maskCommentsAndStrings(id, false))) return result("event_id_stable", ctx, "problem", `${file}:${call.line} builds the eventId from a random value or the time, so a retry counts twice`, file, call.line)
        if (literalString(id) !== null) return result("event_id_stable", ctx, "problem", `${file}:${call.line} uses a constant eventId, so every outcome after the first is dropped as a duplicate`, file, call.line)
      }
      return result("event_id_stable", ctx, "pass", "every outcome carries a stable eventId")
    }),

    // Job 8: no raw email, phone, name or address reaches an outcome's request body or the Stripe metadata (match data
    // only as digests; never a phone in any form). Review r3: what a nested call RECEIVES (`withPerson({ email })`) is
    // not what the request carries, so only what reaches the body is read (`commerce-static.ts` `piiFindings`).
    no_pii_in_outcome: run("no_pii_in_outcome", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("no_pii_in_outcome", scope, ctx)
      return commerceResult("no_pii_in_outcome", ctx, piiFindings({ files: scope }), "no personal data in any outcome or Stripe metadata")
    }),

    // Review r3: every event × tool cell the plan promised has its code somewhere in the app (Meta ViewContent /
    // AddToCart from the page, the server events through reportInfiniteOutcome, GA4 / PostHog / Infinite sends). An
    // item whose target is one event checks that event; any other item checks them all.
    commerce_promises_met: run("commerce_promises_met", (input, ctx) => {
      const run = context()
      if (!run.eventInventory) return result("commerce_promises_met", ctx, "undetermined", "the plan's event list is not known, so what it promised each tool could not be compared with the code")
      const files = loadRepoSnapshot(input.root, input.appRoot).files
      const target = itemTarget(input.item)
      // A browser commerce item (`<tool>_improve:commerce_events`) answers for ITS tool and the events it carries; an
      // item named for one event, for that event; anything else, for every promise.
      const tool = target === COMMERCE_EVENTS_TARGET ? COMMERCE_ITEM_TOOL[input.item.jobId] : undefined
      const events = tool ? new Set((input.item.inventory ?? []).map((entry) => canonicalEvent(entry.event)).filter((event) => event !== null)) : null
      const findings = (promiseFindings({ files, inventory: run.eventInventory }, canonicalEvent(target)) ?? []).filter(
        (finding) => !tool || (finding.tool === tool && (events === null || events.size === 0 || (finding.event !== undefined && events.has(finding.event))))
      )
      return commerceResult("commerce_promises_met", ctx, findings, tool ? `every event the plan promised ${TOOL_NAME[tool]} is sent` : "every event the plan promised is sent to its tools")
    }),

    // Review r3: an outcome Meta gets from the server carries the match data (adMatch).
    outcome_ad_match: run("outcome_ad_match", (input, ctx) => {
      const run = context()
      return commerceResult("outcome_ad_match", ctx, adMatchFindings({ files: itemFiles(input), ...(run.metaInUse !== undefined ? { metaInUse: run.metaInUse } : {}) }), "every server conversion for Meta carries match data")
    }),

    // Review r3: a purchase outcome carries its value and its currency.
    outcome_value_currency: run("outcome_value_currency", (input, ctx) =>
      commerceResult("outcome_value_currency", ctx, valueFindings({ files: itemFiles(input) }), "every purchase carries its value and currency")
    ),

    // Review r3 (P0-5): a send the turn added to a tool that already gets that event from the site (a second GA4
    // purchase beside the site's own) counts it twice. The site's sends come from the inventory and the code before.
    no_double_count: run("no_double_count", (input, ctx) => {
      const commerce = withBase(input, { files: itemFiles(input), inventory: context().eventInventory ?? null })
      const findings = doubleCountFindings(commerce)
      if (findings === null) return result("no_double_count", ctx, "undetermined", "the code before this run could not be read, so new sends could not be told apart from the site's own")
      return commerceResult("no_double_count", ctx, findings, "no event is sent twice to one tool")
    }),

    // Review r3: a browser Meta event carries only the event id the server got back, or none.
    meta_event_id_from_server: run("meta_event_id_from_server", (input, ctx) =>
      commerceResult("meta_event_id_from_server", ctx, metaEventIdFindings(withBase(input, { files: itemFiles(input) })), "no browser Meta event carries an event id made in the page")
    ),

    // Job 9: an account id (never an email or a constant) is identified once the login is verified.
    identify_on_auth_success: run("identify_on_auth_success", (input, ctx) => {
      const scope = itemFiles(input)
      const auth = detectAuth(snapshotOf(scope, input.appRoot))
      const calls = [...scope].flatMap(([file, text]) => callsOf(text, ["infiniteIdentify"]).map((call) => ({ ...call, file })))
      if (calls.length === 0) return missing("identify_on_auth_success", ctx, `no infiniteIdentify call in ${files([...scope.keys()])}`)
      for (const call of calls) {
        const arg = call.args.trim()
        if (arg === "" || literalString(arg) !== null) return result("identify_on_auth_success", ctx, "problem", `${call.file}:${call.line} identifies with a constant, so every visitor becomes one person`, call.file, call.line)
        if (/email|@/i.test(arg) && !HASHED.test(arg)) return result("identify_on_auth_success", ctx, "problem", `${call.file}:${call.line} identifies with an email; use the account id`, call.file, call.line)
        const login = auth.login.find((finding) => finding.file === call.file)
        if (login && call.line < login.line) return result("identify_on_auth_success", ctx, "problem", `${call.file}:${call.line} identifies before the login is verified (line ${login.line})`, call.file, call.line)
        if (insideCatch(maskCommentsAndStrings(scope.get(call.file)!, true), call.index)) {
          return result("identify_on_auth_success", ctx, "problem", `${call.file}:${call.line} identifies in an error branch`, call.file, call.line)
        }
      }
      return result("identify_on_auth_success", ctx, "pass", "the account id is identified after a verified login")
    }),

    // Job 9: every sign-out resets the visitor (a client-side sign-out in its own file; a server-only one in a client file of the job).
    reset_on_every_signout: run("reset_on_every_signout", (input, ctx) => {
      const scope = itemFiles(input)
      const auth = detectAuth(snapshotOf(scope, input.appRoot))
      const resets = new Set([...scope].filter(([, text]) => callsOf(text, ["infiniteReset"]).length > 0).map(([file]) => file))
      if (auth.logout.length === 0) return result("reset_on_every_signout", ctx, "pass", "no sign-out in the job's files to reset in")
      const clientReset = [...resets].some((file) => !isServerFile(file, scope.get(file) ?? ""))
      const missing = auth.logout.filter((finding) => {
        if (resets.has(finding.file)) return false
        return !(isServerFile(finding.file, scope.get(finding.file) ?? "") && clientReset)
      })
      if (missing.length > 0) return result("reset_on_every_signout", ctx, "problem", `no infiniteReset in the sign-out at ${files(missing.map((finding) => `${finding.file}:${finding.line}`))}`, missing[0]!.file, missing[0]!.line)
      return result("reset_on_every_signout", ctx, "pass", "every sign-out resets the visitor")
    }),

    // Job 12: the policy in the owner file allows exactly what the tools need, with no `*` and no new 'unsafe-inline'.
    csp_hosts: run("csp_hosts", (input, ctx) => {
      const scope = itemFiles(input)
      const run = context()
      const host = run.productionHosts?.[0]
      if (!run.expect || !host) return result("csp_hosts", ctx, "undetermined", "the run's tools or production host are not known, so the policy could not be checked")
      const owners = detectCspOwners(snapshotOf(scope, input.appRoot)).filter((owner) => owner.style === "hosts")
      const owner = owners[0]
      if (!owner) return result("csp_hosts", ctx, "undetermined", "no host-list content security policy the wizard can read in the job's file")
      const policy = staticPolicyText(scope.get(owner.file)!)
      if (policy === null) return result("csp_hosts", ctx, "undetermined", `${owner.file} builds its policy in a way the wizard cannot read statically`, owner.file, owner.line)
      const origin = `https://${host}`
      const analysis = analyzeCsp(policy, null, [], cspNeeds(run.expect, origin), origin)
      if (analysis.missing.length > 0) {
        return result("csp_hosts", ctx, "problem", `${owner.file} still blocks ${analysis.missing.map((row) => `${row.host} (${row.directive})`).join(", ")}`, owner.file, owner.line)
      }
      const base = (deps.readBaseFile ?? gitShowFile)(input.root, owner.file)
      const basePolicy = base ? staticPolicyText(base) : null
      const sources = (text: string | null) => parseCspPolicies(text).flatMap((entry) => [...entry.values()].flat().map((source) => source.toLowerCase()))
      const now = sources(policy)
      const before = sources(basePolicy)
      if (now.includes("*") && !before.includes("*")) return result("csp_hosts", ctx, "problem", `${owner.file} now allows * (any host)`, owner.file, owner.line)
      if (now.includes("'unsafe-inline'") && !before.includes("'unsafe-inline'")) {
        return base === undefined
          ? result("csp_hosts", ctx, "undetermined", `${owner.file} allows 'unsafe-inline' and the policy before this run could not be read`, owner.file, owner.line)
          : result("csp_hosts", ctx, "problem", `${owner.file} adds a new 'unsafe-inline'`, owner.file, owner.line)
      }
      return result("csp_hosts", ctx, "pass", `${owner.file} allows every tool's hosts and nothing broader`, owner.file, owner.line)
    }),

    // LF4 close round 2 (P1-1) Job 10, click conversions: `infiniteTrack(<approved name>)` (or
    // `infiniteTrackThenNavigate(…, <approved name>)`) is called in the job's files. The click conversion's other local
    // check (no click-fired standard Meta event) passes on code with nothing of the job in it, so it could never tick it.
    conversion_tracked: run("conversion_tracked", (input, ctx) => {
      const target = itemTarget(input.item)
      const approved = context().conversionNames
      if (!approved) return result("conversion_tracked", ctx, "undetermined", "the approved conversion names are not known, so the call could not be compared")
      const names = boundConversionNames(target, [...approved])
      if (names.length === 0) return result("conversion_tracked", ctx, "undetermined", `no approved conversion name is bound to ${target}`)
      const scope = itemFiles(input)
      for (const [file, text] of scope) {
        const call = callsOf(text, TRACK_CALLS).find((candidate) => trackedName(candidate) !== null && names.includes(trackedName(candidate)!))
        if (call) return result("conversion_tracked", ctx, "pass", `${file}:${call.line} sends the ${target} conversion (${trackedName(call)})`, file, call.line)
      }
      return missing("conversion_tracked", ctx, `no infiniteTrack(${JSON.stringify(names[0])}) in ${files([...scope.keys()]) || "the job's files"}`)
    }),

    // LF4 close round 2 (P1-1) Job 5, the mirror: the job's files call `infiniteMetaMirror(…)` and no longer fire a
    // standard Meta event straight from the browser. The mirror's event-id check passes on a page with no Meta event at
    // all, so it could never tick it.
    meta_mirror_wired: run("meta_mirror_wired", (input, ctx) => {
      const scope = itemFiles(input)
      const direct = new RegExp(`\\bfbq\\s*\\(\\s*["'\`]track["'\`]\\s*,\\s*["'\`](${META_STANDARD_EVENTS.join("|")})["'\`]`, "g")
      let mirrored: { file: string; line: number } | null = null
      for (const [file, text] of scope) {
        const masked = maskCommentsAndStrings(text, false)
        for (const match of masked.matchAll(direct)) {
          return result("meta_mirror_wired", ctx, "problem", `${file}:${lineNumberAt(text, match.index ?? 0)} still fires ${match[1]} straight from the browser, not through infiniteMetaMirror`, file, lineNumberAt(text, match.index ?? 0))
        }
        const call = callsOf(text, ["infiniteMetaMirror"])[0]
        if (call && mirrored === null) mirrored = { file, line: call.line }
      }
      if (mirrored === null) return missing("meta_mirror_wired", ctx, `no infiniteMetaMirror call in ${files([...scope.keys()]) || "the job's files"}`)
      return result("meta_mirror_wired", ctx, "pass", `${mirrored.file}:${mirrored.line} sends the browser conversion through infiniteMetaMirror`, mirrored.file, mirrored.line)
    }),

    // LF4 close round 2 (P1-1) Job 3: the target's own setting is in every adopted posthog.init of the job's files —
    // proxy: api_host is a same-origin LITERAL (a path such as "/ingest", or a URL on the site's production host);
    // history_change: page changes are counted (capture_pageview 'history_change', a defaults date that does it, or a
    // hand-written $pageview); defaults: the current defaults date. `posthog_config` passes on an untouched config,
    // so it could never tick the job. Live-fix 4 final round (P1): a value that is not a literal (PostHog's documented
    // `import.meta.env.VITE_PUBLIC_POSTHOG_HOST` / `process.env.NEXT_PUBLIC_POSTHOG_HOST`, any identifier or call) is
    // read for what it is: the wizard cannot read where it sends, so it is undetermined, never "goes through the site"
    // and never "not in the code".
    posthog_improve_applied: run("posthog_improve_applied", (input, ctx) => {
      const target = itemTarget(input.item)
      const scope = itemFiles(input)
      if (target === "sensitive_pages") {
        const paths = context().posthogSensitivePaths
        if (!paths?.length) return result("posthog_improve_applied", ctx, "undetermined", "the approved sensitive paths are not available")
        const inits = readPosthogConfigs(scope).filter(read => !read.managed)
        if (!inits.length) return missing("posthog_improve_applied", ctx, "no adopted PostHog init in the job's files")
        if (inits.some(read => !read.readable || !read.optionsSource)) return result("posthog_improve_applied", ctx, "undetermined", "the adopted PostHog options are not a readable literal object")
        if (inits.some(read => stripSensitivePosthogAddition(read.optionsSource!, paths) === null)) return missing("posthog_improve_applied", ctx, "the exact restrictive sensitive-page addition is not last in every adopted PostHog options object")
        return result("posthog_improve_applied", ctx, "pass", `the approved addition turns replay and autocapture off on ${paths.join(", ")} and descendants without enabling collection elsewhere`)
      }
      const inits = [...scope].filter(([, text]) => /\bposthog\s*\.\s*init\s*\(/.test(maskCommentsAndStrings(text, false)))
      if (inits.length === 0) return result("posthog_improve_applied", ctx, "undetermined", `no posthog.init in ${files([...scope.keys()]) || "the job's files"}, so the setting cannot be read`)
      const manualPageview = capturesPageviewManually(snapshotOf(scope, input.appRoot))
      const hosts = (context().productionHosts ?? []).map((host) => host.toLowerCase())
      const unreadable: CheckResult[] = []
      const unread = (reason: string, file: string) => {
        unreadable.push(result("posthog_improve_applied", ctx, "undetermined", reason, file))
      }
      const dateAtLeast = (value: PosthogOptionValue | undefined, from: string) => value?.kind === "literal" && /^\d{4}-\d{2}-\d{2}$/.test(value.value) && value.value >= from
      for (const [file, text] of inits) {
        const option = (key: string) => readPosthogOptionValue(text, key)
        if (target === "proxy") {
          const apiHost = option("api_host")
          if (apiHost === undefined || (apiHost.kind === "literal" && posthogApiHostUnset(apiHost.value))) {
            return missing("posthog_improve_applied", ctx, `${file}: api_host is unset, so PostHog still sends straight to PostHog`, file)
          }
          if (apiHost.kind === "expression") {
            unread(`${file}: api_host is ${apiHost.text}, a value set outside the code, so the wizard cannot read where PostHog sends`, file)
            continue
          }
          const value = apiHost.value
          if (/posthog\.com/i.test(value)) return missing("posthog_improve_applied", ctx, `${file}: api_host is ${value}, so PostHog still sends straight to PostHog`, file)
          if (isRelativePath(value)) continue
          let host: string | null = null
          try {
            host = new URL(value).hostname.toLowerCase()
          } catch {
            host = null
          }
          if (host === null) {
            unread(`${file}: api_host is ${value}, which is neither a path on the site nor a URL, so the wizard cannot read where PostHog sends`, file)
            continue
          }
          if (hosts.length === 0) {
            unread(`${file}: api_host is ${value} and the site's production host is not known, so the wizard cannot tell whether it is the site's own`, file)
            continue
          }
          if (!hosts.includes(host)) {
            unread(`${file}: api_host is ${value}, not the site's own host (${hosts[0]}), so the wizard cannot tell whether it goes through the site`, file)
            continue
          }
        } else if (target === "history_change") {
          const capture = option("capture_pageview")
          const defaults = option("defaults")
          const counts = (capture?.kind === "literal" && capture.value === "history_change") || manualPageview || dateAtLeast(defaults, POSTHOG_HISTORY_DEFAULTS_FROM)
          if (counts) continue
          const computed = [capture?.kind === "expression" ? `capture_pageview is ${capture.text}` : null, defaults?.kind === "expression" ? `defaults is ${defaults.text}` : null].filter(Boolean)
          if (computed.length > 0) {
            unread(`${file}: ${computed.join(" and ")}, a value set outside the code, so the wizard cannot read whether page changes are counted`, file)
            continue
          }
          return missing("posthog_improve_applied", ctx, `${file}: PostHog still counts only the first page (no capture_pageview: 'history_change')`, file)
        } else if (target === "defaults") {
          const defaults = option("defaults")
          if (defaults?.kind === "expression") {
            unread(`${file}: defaults is ${defaults.text}, a value set outside the code, so the wizard cannot read the defaults date`, file)
            continue
          }
          if (!dateAtLeast(defaults, POSTHOG_DEFAULTS_CURRENT)) return missing("posthog_improve_applied", ctx, `${file}: defaults is ${defaults?.value ?? "unset"}, not ${POSTHOG_DEFAULTS_CURRENT}`, file)
        } else {
          return result("posthog_improve_applied", ctx, "undetermined", `the wizard cannot read the ${target} change from the PostHog config`, file)
        }
      }
      if (unreadable.length > 0) return unreadable[0]!
      return result("posthog_improve_applied", ctx, "pass", `${target === "proxy" ? "api_host is on the site's own origin" : target === "history_change" ? "page changes are counted" : `defaults is ${POSTHOG_DEFAULTS_CURRENT}`} in ${files(inits.map(([file]) => file))}`)
    }),

    // Job 16: the review step reads the PR's required checks on the pushed fix (`review.ts`), never here.
    pr_checks_pass: run("pr_checks_pass", (_input, ctx) =>
      result("pr_checks_pass", ctx, "undetermined", "the PR's required checks are read by the review step after the fix is pushed")
    )
  }
}

/** The CSP text a file sets: its string literals that carry directives, joined; helmet's camelCase arrays too. */
export function staticPolicyText(text: string): string | null {
  const commentsMasked = maskCommentsAndStrings(text, false)
  const literals = [...commentsMasked.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2]!).filter((value) => !value.includes("${"))
  const directives = literals.filter((value) => /\b(?:default|script|connect|img|style|font|frame|object|base|form)-src\b|\bdefault-src\b/i.test(value))
  if (directives.length > 0) return directives.join("; ").replace(/\s+/g, " ")
  // helmet: `directives: { scriptSrc: ["'self'", "https://…"], … }`
  const helmet = [...commentsMasked.matchAll(/\b([a-z]+Src)\s*:\s*\[([^\]]*)\]/g)]
  if (helmet.length === 0) return null
  return helmet
    .map((match) => {
      const directive = match[1]!.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      const sources = [...match[2]!.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((source) => source[2]!)
      return `${directive} ${sources.join(" ")}`
    })
    .join("; ")
}

/** `git show HEAD:<file>` (repo-relative): text, null = not in HEAD, undefined = no repo or no HEAD. */
function gitShowFile(root: string, file: string): string | null | undefined {
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 })
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD"])
  } catch {
    return undefined
  }
  try {
    return git(["show", `HEAD:${file}`])
  } catch {
    return null
  }
}

/** Register every job-table S check on a runner. */
export function registerJobStaticChecks(runner: Pick<CheckRunner, "register">, deps: JobStaticDeps): void {
  for (const [checkId, fn] of Object.entries(jobStaticCheckFunctions(deps))) runner.register(checkId, fn)
}
