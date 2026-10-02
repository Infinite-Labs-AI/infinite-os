// §3f.9 The post-turn gate (`turnGate`): deterministic rules over ONE agent turn's added lines, run
// after EVERY agent turn (and on a nested `--resume`) BEFORE any build or T0 runs anything.
//
// Why it exists (R2-03, §3a.9 item 5): between turns the wizard EXECUTES agent-written code — the build
// check evaluates `next.config.*` and page modules, T0 runs the site's JS. A prompt-injected agent could
// plant code that runs then, while no agent child is alive. The build and T0 are sandboxed (O6), and
// this gate refuses the obvious channels before they ever run. Each hit is a `problem` with file:line;
// O3's fence reverts the hunk and blocks the job.
//
// Two rule sets:
//   • EXECUTION SAFETY (R2-03): new `child_process`, `net`/`tls`, `dgram`, `worker_threads`,
//     `http(s).request|get`; absolute-URL `fetch` / `axios` / `XMLHttpRequest` in build-time files;
//     `eval(`, `new Function(`, `require(` of a computed string; and the literals `.growth-os`,
//     `Application Support/Infinite`, `127.0.0.1`, `localhost:` ANYWHERE.
//   • THE NEVER-LIST (R2-20, the brief's Meta rules): a write to `_fbp`; `ph` inside `fbq(` / Advanced
//     Matching / `adMatch`; `autoConfig` true, or a removed `autoConfig … false` opt-out; a provider-id
//     literal that is not one of the connection's ids; `test_event_code` (it is NOT protection); a
//     page-built `eventID` / `event_id`; `fbq('track', <standard conversion>)` in a click handler.
//
// Incident guarded (PORT-PLAN §4, 22d08d4 "phantom CompleteRegistrations"): an event id built in the
// page — refused at the turn, not found after deploy. And the 9fcbefa default-id leak: a provider id
// literal that is not the connection's is refused.
import type { CheckContext, CheckResult, TurnDiff } from "../wizard/contracts/jobs.js"
import { codeView, isServerFile, matchingBracket } from "../setup-checks/code-view.js"
import { findEventIdHits, findStandardOnClick } from "../setup-checks/meta-event-id.js"

import { checkResult } from "./result.js"

export const TURN_GATE_CHECK_ID = "turn_gate" as const

export const TURN_GATE_RULES = {
  child_process: "starts a child process",
  net: "opens a raw network socket (net/tls)",
  dgram: "opens a UDP socket (dgram)",
  worker_threads: "starts a worker thread",
  http_request: "makes an HTTP request with node:http(s)",
  build_time_fetch: "fetches an absolute URL from a build-time file",
  eval: "calls eval(",
  new_function: "builds code with new Function(",
  computed_require: "requires a computed module path",
  secret_path_literal: "names a secret store path (.growth-os / Application Support/Infinite)",
  loopback_literal: "names a loopback address (127.0.0.1 / localhost:)",
  fbp_write: "writes Meta's _fbp cookie (never synthesise _fbp)",
  ph_in_meta: "sends a phone number (ph) to Meta",
  autoconfig_on: "turns Meta's automatic configuration on",
  autoconfig_opt_out_removed: "removes the autoConfig false opt-out",
  foreign_provider_id: "adds a provider id that is not the connection's",
  test_event_code: "uses test_event_code (it is not protection)",
  page_built_event_id: "builds a Meta event id in the page (use the server's metaEventId)",
  standard_on_click: "fires a standard Meta conversion from a click handler"
} as const
export type TurnGateRule = keyof typeof TURN_GATE_RULES

export interface TurnGateHit {
  rule: TurnGateRule
  file: string
  /** New-file line for an added line; OLD-file line for `autoconfig_opt_out_removed`. */
  line: number
}

export interface TurnGateOptions {
  /** The connection's public ids (GA4 stream ids, PostHog key, Meta pixel ids). */
  connectionIds: readonly string[]
  /** The file's content AFTER the turn, for rules that need context (click handlers, fbq calls). */
  readFile?: (path: string) => string | null
}

const BUILD_TIME_FILE = /(?:^|\/)(?:(?:next|vite|postcss|tailwind)\.config\.[cm]?[jt]s|vercel\.json|middleware\.[jt]s)$|(?:^|\/)scripts\//

const moduleLoad = (name: string) =>
  new RegExp(String.raw`(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](?:node:)?(?:${name})(?:/[\w/]*)?["']`)

const LINE_RULES: ReadonlyArray<{ rule: TurnGateRule; pattern: RegExp; on: "code" | "raw"; buildTimeOnly?: boolean }> = [
  { rule: "child_process", pattern: moduleLoad("child_process"), on: "code" },
  { rule: "net", pattern: moduleLoad("net|tls"), on: "code" },
  { rule: "dgram", pattern: moduleLoad("dgram"), on: "code" },
  { rule: "worker_threads", pattern: moduleLoad("worker_threads"), on: "code" },
  { rule: "http_request", pattern: moduleLoad("https?|http2"), on: "code" },
  { rule: "http_request", pattern: /\bhttps?\s*\.\s*(?:request|get)\s*\(/, on: "code" },
  { rule: "build_time_fetch", pattern: /\bfetch\s*\(\s*[`'"]https?:\/\//, on: "code", buildTimeOnly: true },
  { rule: "build_time_fetch", pattern: /\baxios(?:\s*\.\s*\w+)?\s*\(\s*[`'"]https?:\/\//, on: "code", buildTimeOnly: true },
  { rule: "build_time_fetch", pattern: /\bXMLHttpRequest\b/, on: "code", buildTimeOnly: true },
  { rule: "eval", pattern: /(?<![\w$.])eval\s*\(/, on: "code" },
  { rule: "new_function", pattern: /\bnew\s+Function\s*\(/, on: "code" },
  { rule: "computed_require", pattern: /\brequire\s*\(\s*(?!["'][^"'`$]*["']\s*\))/, on: "code" },
  { rule: "secret_path_literal", pattern: /\.growth-os|Application Support\/Infinite/, on: "raw" },
  { rule: "loopback_literal", pattern: /127\.0\.0\.1|localhost:/, on: "raw" },
  { rule: "autoconfig_on", pattern: /fbq\s*\(\s*["']set["']\s*,\s*["']autoConfig["']\s*,\s*(?:true|["']true["'])/, on: "code" },
  { rule: "test_event_code", pattern: /\btest_event_code\b|\btestEventCode\b/, on: "raw" }
]

const FBP_WRITE = [/document\.cookie\s*=.*_fbp/, /\.set\s*\(\s*["'`]_fbp["'`]/, /["'`]_fbp=/, /setCookie\s*\(\s*["'`]_fbp/i, /\b_fbp\s*=\s*["'`]fb\./]
const OPT_OUT = /fbq\s*\(\s*["']set["']\s*,\s*["']autoConfig["']\s*,\s*(?:false|["']false["'])\s*,\s*["'](\d+)["']\s*\)/
const PROVIDER_ID_LITERALS: RegExp[] = [
  /["'`](G-[A-Z0-9]{4,})["'`]/g,
  /["'`](phc_[A-Za-z0-9_]{10,})["'`]/g,
  /\bfbq\s*\(\s*["']init["']\s*,\s*["'](\d{15,16})["']/g,
  /\b(?:pixelId|pixel_id|metaPixelId)\s*[:=]\s*["'`](\d{15,16})["'`]/g
]
const META_MATCH_TRIGGER = /\bfbq\s*\(|\badMatch\b|\b(?:infiniteMetaAdvancedMatch|__infiniteMetaMatch|advancedMatching|AdvancedMatch)\b/g
const PH_KEY = /(?:^|[{,\s])["']?ph["']?\s*:/

/** Strip line and block comments from ONE line (a URL's `://` is not a comment). */
function codeOfLine(text: string): string {
  return text.replace(/\/\*.*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/, "$1")
}

/** Contiguous added lines, as hunks of text with their first line number. */
function hunksOf(added: ReadonlyArray<{ line: number; text: string }>): Array<{ start: number; text: string; lines: number[] }> {
  const sorted = [...added].sort((a, b) => a.line - b.line)
  const hunks: Array<{ start: number; text: string; lines: number[] }> = []
  for (const entry of sorted) {
    const last = hunks[hunks.length - 1]
    if (last && entry.line === (last.lines[last.lines.length - 1] as number) + 1) {
      last.text += `\n${entry.text}`
      last.lines.push(entry.line)
    } else hunks.push({ start: entry.line, text: entry.text, lines: [entry.line] })
  }
  return hunks
}

function lineAt(text: string, offset: number): number {
  let line = 0
  for (let index = 0; index < offset && index < text.length; index += 1) if (text.charCodeAt(index) === 10) line += 1
  return line
}

/** Contextual rules over a text whose first line is `startLine`; keeps hits on added lines only. */
function contextualHits(file: string, text: string, startLine: number, addedLines: ReadonlySet<number>): TurnGateHit[] {
  const code = codeView(file, text)
  const hits: TurnGateHit[] = []
  const push = (rule: TurnGateRule, offset: number) => {
    const line = startLine + lineAt(code, offset)
    if (addedLines.has(line) && !hits.some((hit) => hit.rule === rule && hit.line === line)) hits.push({ rule, file, line })
  }
  for (const hit of findStandardOnClick(code)) push("standard_on_click", hit.offset)
  if (!isServerFile(file)) for (const hit of findEventIdHits(code)) push("page_built_event_id", hit.offset)
  for (const match of code.matchAll(META_MATCH_TRIGGER)) {
    const at = match.index ?? 0
    const open = code.slice(at).search(/[({]/)
    if (open === -1 || open > 40) continue
    const end = matchingBracket(code, at + open)
    const region = code.slice(at, end === -1 ? code.length : end + 1)
    const ph = PH_KEY.exec(region)
    if (ph) push("ph_in_meta", at + ph.index + (ph[0].length - ph[0].trimStart().length))
  }
  return hits
}

/** Every rule hit in one turn's diff. Pure. */
export function scanTurnDiff(diff: TurnDiff, options: TurnGateOptions): TurnGateHit[] {
  const allowed = new Set(options.connectionIds)
  const hits: TurnGateHit[] = []
  const add = (hit: TurnGateHit) => {
    if (!hits.some((other) => other.rule === hit.rule && other.file === hit.file && other.line === hit.line)) hits.push(hit)
  }
  for (const file of diff.files) {
    const buildTime = BUILD_TIME_FILE.test(file.path)
    for (const { line, text } of file.added) {
      const code = codeOfLine(text)
      for (const { rule, pattern, on, buildTimeOnly } of LINE_RULES) {
        if (buildTimeOnly && !buildTime) continue
        if (pattern.test(on === "raw" ? text : code)) add({ rule, file: file.path, line })
      }
      if (/_fbp/.test(code) && FBP_WRITE.some((pattern) => pattern.test(code))) add({ rule: "fbp_write", file: file.path, line })
      for (const pattern of PROVIDER_ID_LITERALS) {
        for (const match of code.matchAll(pattern)) {
          if (!allowed.has(match[1] as string)) add({ rule: "foreign_provider_id", file: file.path, line })
        }
      }
    }
    // A removed opt-out with no equivalent added back for the same pixel.
    for (const { line, text } of file.removed) {
      const optOut = OPT_OUT.exec(codeOfLine(text))
      if (!optOut) continue
      const restored = file.added.some((entry) => {
        const again = OPT_OUT.exec(codeOfLine(entry.text))
        return again !== null && again[1] === optOut[1]
      })
      if (!restored) add({ rule: "autoconfig_opt_out_removed", file: file.path, line })
    }
    // Rules that need the surrounding code.
    if (file.added.length === 0) continue
    const addedLines = new Set(file.added.map((entry) => entry.line))
    const full = options.readFile?.(file.path) ?? null
    if (full !== null) {
      for (const hit of contextualHits(file.path, full, 1, addedLines)) add(hit)
    } else {
      for (const hunk of hunksOf(file.added)) for (const hit of contextualHits(file.path, hunk.text, hunk.start, addedLines)) add(hit)
    }
  }
  return hits
}

/** §3e.7 `turnGate(diff, {connectionIds})` as `CheckResult[]`: one problem per hit, or one pass. */
export function turnGate(diff: TurnDiff, options: TurnGateOptions, ctx: Pick<CheckContext, "runId" | "now">): CheckResult[] {
  const hits = scanTurnDiff(diff, options)
  if (hits.length === 0) {
    const lines = diff.files.reduce((sum, file) => sum + file.added.length, 0)
    return [checkResult(TURN_GATE_CHECK_ID, "pass", "S", ctx, { reason: `${lines} added line${lines === 1 ? "" : "s"} checked: nothing executable or forbidden` })]
  }
  return hits.map((hit) =>
    checkResult(TURN_GATE_CHECK_ID, "problem", "S", ctx, {
      reason: `${hit.rule}: the edit ${TURN_GATE_RULES[hit.rule]}`,
      evidence: [{ file: hit.file, line: hit.line }]
    })
  )
}
