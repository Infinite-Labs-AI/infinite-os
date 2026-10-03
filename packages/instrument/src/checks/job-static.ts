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
import { detectOutcomes, isServerFile } from "../jobs/detectors/outcomes.js"
import { PRIVACY_TOOL_NAMES } from "../jobs/detectors/privacy-page.js"
import { boundConversionNames } from "../jobs/plan-data.js"
import type { RepoSnapshot } from "../jobs/repo-files.js"
import type { ManagedProxySpec as ProxyInput } from "../frameworks/vercel-config.js"
import type { ChecklistItem, CheckContext, CheckFn, CheckResult, CheckRunner } from "../wizard/contracts/jobs.js"
import type { TestExpect, TestTool } from "../wizard/contracts/test-engine.js"
import { runCensus } from "./census.js"
import { analyzeCsp, cspNeeds, parseCspPolicies } from "./live/csp.js"
import { checkResult, isolated } from "./result.js"
import { escapeRegExp } from "../text-escape.js"

/** The check ids this module registers (the job table's S checks that had no implementation). */
export const JOB_STATIC_CHECK_IDS = [
  "server_lane_mount_order",
  "rescan_app_found",
  "next_rewrites_exact",
  "outcome_after_success",
  "outcome_declared",
  "event_id_stable",
  "no_pii_in_outcome",
  "identify_on_auth_success",
  "reset_on_every_signout",
  "csp_hosts",
  "privacy_names_installed_tools",
  "pr_checks_pass"
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
  /** The approved privacy paragraph, verbatim (null = none approved). */
  privacyText?: string | null
  /** The tools this run newly installs (the privacy page must name each). */
  newTools?: readonly TestTool[]
  /** The same-origin rewrites the run's managed install relies on (Infinite's collect path, PostHog's /ingest). */
  proxy?: ProxyInput
}

export interface JobStaticDeps {
  /** The repo root (an input's `root` is used when absent). */
  root?: string
  run?: () => JobStaticRunContext | undefined
  /** A file as it was at the base commit (repo-relative): text, null = absent there, undefined = unreadable. */
  readBaseFile?: (root: string, file: string) => string | null | undefined
}

interface JobInput {
  item: Pick<ChecklistItem, "id" | "jobId" | "allow" | "trigger">
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

/** One call: where it starts, its argument text (original and masked) and its 1-based line. */
interface Call {
  name: string
  index: number
  line: number
  args: string
  maskedArgs: string
  end: number
}

/** Every call of `names` that is code (not a comment or a string), with its balanced argument list. */
export function callsOf(text: string, names: readonly string[]): Call[] {
  const masked = maskCommentsAndStrings(text, true)
  const commentsOnly = maskCommentsAndStrings(text, false)
  const pattern = new RegExp(`(?<![\\w$])(?:window\\s*\\.\\s*)?(${names.map(escapeRegExp).join("|")})\\s*\\(`, "g")
  const out: Call[] = []
  for (const match of masked.matchAll(pattern)) {
    const index = match.index ?? 0
    if (commentsOnly.slice(index, index + match[0].length) !== text.slice(index, index + match[0].length)) continue
    const open = index + match[0].length - 1
    let depth = 0
    let end = -1
    for (let cursor = open; cursor < masked.length; cursor += 1) {
      const ch = masked[cursor]
      if (ch === "(" || ch === "{" || ch === "[") depth += 1
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    if (end < 0) continue
    out.push({ name: match[1]!, index, line: lineNumberAt(text, index), args: text.slice(open + 1, end), maskedArgs: masked.slice(open + 1, end), end })
  }
  return out
}

/** The first object literal's top-level properties in an argument list: key → value text (original). */
export function topLevelProps(call: Pick<Call, "args" | "maskedArgs">): Map<string, string> | null {
  const start = call.maskedArgs.indexOf("{")
  if (start < 0 || call.maskedArgs.slice(0, start).trim() !== "") return null
  const props = new Map<string, string>()
  let depth = 0
  let segmentStart = start + 1
  const flush = (end: number) => {
    const masked = call.maskedArgs.slice(segmentStart, end)
    const original = call.args.slice(segmentStart, end)
    const offset = segmentStart
    segmentStart = end + 1
    if (masked.trim() === "") return
    if (/^\s*\.\.\./.test(masked)) {
      props.set(`...${props.size}`, original.trim())
      return
    }
    const quoted = /^\s*(["'])([A-Za-z_$][\w$]*)\1\s*:/.exec(original)
    const named = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(masked)
    const key = quoted?.[2] ?? named?.[1] ?? null
    if (key !== null) {
      const colon = call.maskedArgs.indexOf(":", offset + (quoted ? quoted[0].length - 1 : named![0].length - 1))
      props.set(key, call.args.slice(colon + 1, end).trim())
      return
    }
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(masked)
    if (shorthand) props.set(shorthand[1]!, shorthand[1]!)
  }
  for (let cursor = start; cursor < call.maskedArgs.length; cursor += 1) {
    const ch = call.maskedArgs[cursor]
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1
      if (depth === 0) {
        flush(cursor)
        break
      }
    } else if (ch === "," && depth === 1) flush(cursor)
  }
  return props
}

/** A plain string literal's value (`"x"`, `'x'`, or a template with no `${…}`), else null. */
function literalString(value: string): string | null {
  const trimmed = value.trim()
  const match = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(trimmed)
  if (!match) return null
  if (match[1] === "`" && match[2]!.includes("${")) return null
  return match[2]!
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

const OUTCOME_CALLS = ["reportInfiniteOutcome", "postInfiniteOutcome"] as const
/** An id that changes on every call: a retry would count twice (or every outcome would dedupe into one). */
const UNSTABLE_ID = /(?:\bDate\s*\.\s*now|\bMath\s*\.\s*random|\brandomUUID|\buuid(?:v4)?|\bv4|\bnanoid|\bcuid2?|\bperformance\s*\.\s*now|\bnew\s+Date)\s*\(/
const PII_KEYS = /(?<![\w$])(?:email|e_mail|emailAddress|email_address|phone|phoneNumber|phone_number|ph|first_?name|last_?name|full_?name|firstName|lastName|fullName|address|street)\s*:/i
const PII_VALUES = /\.\s*(?:email|emailAddress|email_address|phone|phoneNumber|phone_number)\b|(?<![\w$.])(?:email|phone|phoneNumber)(?![\w$])/
const HASHED = /\b(?:createHash|sha256|sha-256|hash\w*|digest)\b/i

function outcomeCalls(scope: ReadonlyMap<string, string>): Array<Call & { file: string }> {
  return [...scope].flatMap(([file, text]) => callsOf(text, OUTCOME_CALLS).map((call) => ({ ...call, file })))
}

function noOutcomeCall(checkId: JobStaticCheckId, scope: ReadonlyMap<string, string>, ctx: CheckContext): CheckResult {
  return checkResult(checkId, "problem", "S", ctx, { reason: `no reportInfiniteOutcome call in ${files([...scope.keys()]) || "the job's files"}` })
}

export function jobStaticCheckFunctions(deps: JobStaticDeps): Record<JobStaticCheckId, CheckFn> {
  const run = (checkId: JobStaticCheckId, body: (input: JobInput, ctx: CheckContext) => CheckResult): CheckFn =>
    (input, ctx) => isolated(checkId, "S", ctx, async () => [body(jobInput(input, deps), ctx)])
  const context = (): JobStaticRunContext => deps.run?.() ?? {}
  const result = (checkId: JobStaticCheckId, ctx: CheckContext, state: CheckResult["state"], reason: string, file?: string, line?: number) =>
    checkResult(checkId, state, "S", ctx, { reason, ...(file ? { evidence: [{ file, line: line ?? 1 }] } : {}) })

  return {
    // Job 1: the lane is mounted before the routes (a Node server), or wraps the exported middleware (Next).
    server_lane_mount_order: run("server_lane_mount_order", (input, ctx) => {
      const scope = itemFiles(input)
      const entries = [...scope].filter(([file]) => !/(?:^|\/)lib\/infinite-(?:server-lane|outcome)\.[cm]?[jt]s$/.test(file))
      if (entries.length === 0) return result("server_lane_mount_order", ctx, "problem", "the server entry or middleware file is gone")
      for (const [file, text] of entries) {
        const masked = maskCommentsAndStrings(text, true)
        const isMiddleware = /(?:^|\/)(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/.test(file)
        if (isMiddleware) {
          const wraps = /export\s+default\s+withInfiniteServerLane\s*\(|export\s+const\s+(?:middleware|proxy)\s*=\s*withInfiniteServerLane\s*\(/.test(masked)
          if (!wraps) {
            return masked.includes("withInfiniteServerLane")
              ? result("server_lane_mount_order", ctx, "undetermined", `${file} uses withInfiniteServerLane, but not as the exported middleware the wizard can read`, file)
              : result("server_lane_mount_order", ctx, "problem", `${file} does not wrap its middleware in withInfiniteServerLane`, file)
          }
          continue
        }
        const mount = /\.\s*use\s*\(\s*infiniteServerLane\s*\(/.exec(masked)
        if (!mount) return result("server_lane_mount_order", ctx, "problem", `${file} does not mount infiniteServerLane() (app.use(infiniteServerLane()))`, file)
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
      return result("rescan_app_found", ctx, "problem", `the managed tag is not in any of the job's files (${files([...allowed])})`)
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
      return result("next_rewrites_exact", ctx, "problem", `missing rewrite(s): ${pairs.map((pair) => `${pair.source} to ${pair.destination}`).join("; ")}`)
    }),

    // Job 8: the outcome is reported AFTER the success point, never before it or from an error branch.
    outcome_after_success: run("outcome_after_success", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("outcome_after_success", scope, ctx)
      const triggers = detectOutcomes(snapshotOf(scope, input.appRoot)).filter((finding) => finding.conversionType === itemTarget(input.item) || itemTarget(input.item) === "")
      for (const call of calls) {
        const masked = maskCommentsAndStrings(scope.get(call.file)!, true)
        if (insideCatch(masked, call.index)) return result("outcome_after_success", ctx, "problem", `${call.file}:${call.line} reports the outcome from an error branch`, call.file, call.line)
      }
      if (triggers.length === 0) return result("outcome_after_success", ctx, "undetermined", "the success point the job was seeded from is no longer recognisable, so the order could not be checked")
      for (const trigger of triggers) {
        const after = calls.some((call) => call.file === trigger.file && call.line > trigger.line)
        const elsewhere = calls.some((call) => call.file !== trigger.file)
        if (!after && !elsewhere) {
          return result("outcome_after_success", ctx, "problem", `${trigger.file}: the outcome is reported before the success point (line ${trigger.line}), so a failed ${trigger.detail} would still count`, trigger.file, trigger.line)
        }
      }
      return result("outcome_after_success", ctx, "pass", "the outcome is reported after the success point")
    }),

    // Job 8: the outcome's `type` is one of the conversion names the user approved for this job.
    outcome_declared: run("outcome_declared", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("outcome_declared", scope, ctx)
      const approved = context().conversionNames
      if (!approved) return result("outcome_declared", ctx, "undetermined", "the approved conversion names are not known, so the outcome name could not be compared")
      const bound = boundConversionNames(itemTarget(input.item), [...approved])
      for (const call of calls) {
        const type = topLevelProps(call)?.get("type")
        if (type === undefined) return result("outcome_declared", ctx, "problem", `${call.file}:${call.line} reports an outcome with no type`, call.file, call.line)
        const literal = literalString(type)
        if (literal === null) return result("outcome_declared", ctx, "undetermined", `${call.file}:${call.line} computes the outcome name, so it could not be compared with the approved names`, call.file, call.line)
        if (!bound.includes(literal)) {
          return result("outcome_declared", ctx, "problem", `${call.file}:${call.line} reports "${literal}", which is not an approved conversion name for this job (${bound.join(", ") || "none"})`, call.file, call.line)
        }
      }
      return result("outcome_declared", ctx, "pass", "every outcome uses an approved conversion name")
    }),

    // Job 8: every outcome carries a stable eventId (an order / row / account id), never a random or a constant.
    event_id_stable: run("event_id_stable", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("event_id_stable", scope, ctx)
      for (const call of calls) {
        const props = topLevelProps(call)
        if (props === null) return result("event_id_stable", ctx, "undetermined", `${call.file}:${call.line} passes a value the wizard cannot read as an object`, call.file, call.line)
        const id = props.get("eventId")
        if (id === undefined) return result("event_id_stable", ctx, "problem", `${call.file}:${call.line} has no eventId, so a retry counts twice`, call.file, call.line)
        if (UNSTABLE_ID.test(maskCommentsAndStrings(id, false))) return result("event_id_stable", ctx, "problem", `${call.file}:${call.line} builds the eventId from a random value or the time, so a retry counts twice`, call.file, call.line)
        if (literalString(id) !== null) return result("event_id_stable", ctx, "problem", `${call.file}:${call.line} uses a constant eventId, so every outcome after the first is dropped as a duplicate`, call.file, call.line)
      }
      return result("event_id_stable", ctx, "pass", "every outcome carries a stable eventId")
    }),

    // Job 8: no raw email, phone or name in an outcome (an ad-match `em` only as a hash; never `ph`).
    no_pii_in_outcome: run("no_pii_in_outcome", (input, ctx) => {
      const scope = itemFiles(input)
      const calls = outcomeCalls(scope)
      if (calls.length === 0) return noOutcomeCall("no_pii_in_outcome", scope, ctx)
      for (const call of calls) {
        if (PII_KEYS.test(call.maskedArgs)) return result("no_pii_in_outcome", ctx, "problem", `${call.file}:${call.line} sends a personal-data field in the outcome`, call.file, call.line)
        for (const match of call.maskedArgs.matchAll(/(?<![\w$])em\s*:/g)) {
          const value = call.args.slice((match.index ?? 0) + match[0].length).split(/[,}\n]/)[0] ?? ""
          if (!HASHED.test(value)) return result("no_pii_in_outcome", ctx, "problem", `${call.file}:${call.line} sends em unhashed (only a sha256 hex of the email may leave the server)`, call.file, call.line)
        }
        const props = topLevelProps(call)
        for (const [key, value] of props ?? []) {
          if (key === "adMatch") continue
          if (PII_VALUES.test(maskCommentsAndStrings(value, true)) && !HASHED.test(value)) {
            return result("no_pii_in_outcome", ctx, "problem", `${call.file}:${call.line} puts an email or phone in "${key}"`, call.file, call.line)
          }
        }
      }
      return result("no_pii_in_outcome", ctx, "pass", "no personal data in any outcome")
    }),

    // Job 9: an account id (never an email or a constant) is identified once the login is verified.
    identify_on_auth_success: run("identify_on_auth_success", (input, ctx) => {
      const scope = itemFiles(input)
      const auth = detectAuth(snapshotOf(scope, input.appRoot))
      const calls = [...scope].flatMap(([file, text]) => callsOf(text, ["infiniteIdentify"]).map((call) => ({ ...call, file })))
      if (calls.length === 0) return result("identify_on_auth_success", ctx, "problem", `no infiniteIdentify call in ${files([...scope.keys()])}`)
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

    // Job 14: the privacy page names every newly installed tool, and carries the approved paragraph verbatim.
    privacy_names_installed_tools: run("privacy_names_installed_tools", (input, ctx) => {
      const scope = itemFiles(input)
      const page = [...scope][0]
      if (!page) return result("privacy_names_installed_tools", ctx, "problem", "the privacy page is gone")
      const [file, text] = page
      const visible = text.replace(/<[^>]*>/g, " ").replace(/[{}"'`]/g, " ").replace(/\s+/g, " ").toLowerCase()
      const run = context()
      if (run.privacyText) {
        const wanted = run.privacyText.replace(/[{}"'`]/g, " ").replace(/\s+/g, " ").trim().toLowerCase()
        if (!visible.includes(wanted)) return result("privacy_names_installed_tools", ctx, "problem", `${file} does not carry the approved paragraph verbatim`, file)
      }
      if (!run.newTools) return result("privacy_names_installed_tools", ctx, "undetermined", "the tools this run installs are not known", file)
      const unnamed = run.newTools.filter((tool) => !PRIVACY_TOOL_NAMES[tool].test(text))
      if (unnamed.length > 0) return result("privacy_names_installed_tools", ctx, "problem", `${file} does not name ${unnamed.join(", ")}`, file)
      return result("privacy_names_installed_tools", ctx, "pass", `${file} names every tool this run installs`, file)
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
