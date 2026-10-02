// Check 9 — Meta event ids and click-fired conversions (decisions 11 and 18, the "never" list).
//
// Incident guarded (PORT-PLAN §4, 22d08d4, "phantom CompleteRegistrations"): the page minted its own
// event id and fired the browser event whether or not the server had sent one, so Meta counted sign-ups
// that never happened and could not merge the real ones with their server twins. The rule since D11:
// the browser fires a Meta conversion ONLY with the `metaEventId` the server returned, and stays silent
// when it is null. So:
//   • an `eventID` (or an `event_id` next to `fbq`) whose value is BUILT in the page — a string or
//     template literal, a concatenation, `Date.now()`, `crypto.randomUUID()`, `uuid()`, `Math.random()`
//     → problem;
//   • one that comes from `metaEventId` → fine;
//   • any other variable → undetermined (source cannot tell where it came from);
//   • `fbq('track', <standard conversion>)` inside a click handler → problem: a click is not a
//     conversion (it fires before validation / payment), and Meta then optimises ads for clicks.
// Server files are out of scope for the event-id rule (page-built only); managed bytes are infinite-tag's
// own helpers and are tested where they are emitted.
//
// The detectors are pure and exported: the post-turn gate (`checks/turn-gate.ts`) runs the same rules
// over an agent's added lines.
import { codeView, isServerFile, matchingBracket, sourceUnits, unitLine } from "./code-view.js"
import { metaEventIdPageBuiltMessage, metaEventIdUndeterminedMessage, metaStandardOnClickMessage } from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

/** Meta standard events that are CONVERSIONS (never fired from a click). Funnel steps are not listed. */
export const META_STANDARD_CONVERSIONS = [
  "Purchase",
  "Lead",
  "CompleteRegistration",
  "StartTrial",
  "Subscribe",
  "SubmitApplication",
  "Schedule",
  "Contact"
] as const

export interface EventIdHit {
  offset: number
  verdict: "built" | "variable"
}

const EVENT_ID_KEY = /\beventID\s*:\s*([^,}\n]+)|\{\s*eventID\s*\}|\bevent_id\s*:\s*([^,}\n]+)/g
const BUILT = /[`'"+]|\bDate\.now\b|randomUUID|\buuid\w*\s*\(|Math\.random|\bcrypto\.|new Date\b|\$\{/

/** Page-built or untraceable Meta event ids in `code` (comments already blanked). */
export function findEventIdHits(code: string): EventIdHit[] {
  const hits: EventIdHit[] = []
  for (const match of code.matchAll(EVENT_ID_KEY)) {
    const offset = match.index ?? 0
    const isSnake = match[0].startsWith("event_id")
    // `event_id` is generic; it is Meta's only next to an fbq call.
    if (isSnake && !/\bfbq\s*\(/.test(code.slice(Math.max(0, offset - 300), offset + 50))) continue
    const value = (match[1] ?? match[2] ?? "eventID").trim()
    if (/\bmetaEventId\b/.test(value)) continue
    hits.push({ offset, verdict: BUILT.test(value) ? "built" : "variable" })
  }
  return hits
}

const STANDARD_TRACK = new RegExp(String.raw`\bfbq\s*\(\s*["']track["']\s*,\s*["'](${META_STANDARD_CONVERSIONS.join("|")})["']`, "g")
/** Where a click handler starts, and how its body is bounded. */
const CLICK_HANDLER_STARTS: ReadonlyArray<{ pattern: RegExp; body: "brace" | "attribute" | "call" }> = [
  { pattern: /\bonClick\s*=\s*\{/g, body: "brace" },
  { pattern: /\bonclick\s*=\s*["']/gi, body: "attribute" },
  { pattern: /\baddEventListener\s*\(\s*["']click["']/g, body: "call" },
  { pattern: /\.on\s*\(\s*["']click["']/g, body: "call" },
  { pattern: /\.click\s*\(\s*(?:function\b|\()/g, body: "call" }
]

/** Regions of `code` that are click-handler bodies: [start, end) offsets. */
export function clickHandlerRegions(code: string): Array<[number, number]> {
  const regions: Array<[number, number]> = []
  for (const { pattern, body } of CLICK_HANDLER_STARTS) {
    for (const match of code.matchAll(pattern)) {
      const start = match.index ?? 0
      const last = start + match[0].length - 1
      let end: number
      if (body === "attribute") end = code.indexOf(code[last] as string, last + 1)
      else if (body === "brace") end = matchingBracket(code, last)
      else end = matchingBracket(code, start + match[0].indexOf("("))
      regions.push([start, end === -1 ? code.length : end])
    }
  }
  return regions
}

export interface StandardOnClickHit {
  offset: number
  event: string
}

export function findStandardOnClick(code: string): StandardOnClickHit[] {
  const regions = clickHandlerRegions(code)
  const hits: StandardOnClickHit[] = []
  for (const match of code.matchAll(STANDARD_TRACK)) {
    const offset = match.index ?? 0
    if (regions.some(([start, end]) => offset > start && offset < end)) hits.push({ offset, event: match[1] as string })
  }
  return hits
}

export function checkMetaEventId(input: { files: ReadonlyMap<string, string> }): SetupCheckResult {
  const findings: SetupFinding[] = []
  for (const unit of sourceUnits(input.files)) {
    if (unit.managed) continue
    const code = codeView(unit.file, unit.text)
    if (!/\bfbq\s*\(|\beventID\b/.test(code)) continue
    if (!isServerFile(unit.file)) {
      for (const hit of findEventIdHits(code)) {
        const line = unitLine(unit, hit.offset)
        findings.push(
          hit.verdict === "built"
            ? {
                check: "meta_event_id",
                code: "INF_SETUP_META_EVENT_ID_PAGE_BUILT",
                state: "problem",
                confidence: "certain",
                file: unit.file,
                line,
                message: metaEventIdPageBuiltMessage({ file: unit.file, line })
              }
            : {
                check: "meta_event_id",
                code: "INF_SETUP_META_EVENT_ID_UNDETERMINED",
                state: "undetermined",
                confidence: "likely",
                file: unit.file,
                line,
                message: metaEventIdUndeterminedMessage({ file: unit.file, line })
              }
        )
      }
    }
    for (const hit of findStandardOnClick(code)) {
      const line = unitLine(unit, hit.offset)
      findings.push({
        check: "meta_event_id",
        code: "INF_SETUP_META_STANDARD_ON_CLICK",
        state: "problem",
        confidence: "certain",
        file: unit.file,
        line,
        message: metaStandardOnClickMessage({ file: unit.file, line, event: hit.event })
      })
    }
  }
  return { check: "meta_event_id", state: worstState(findings), findings }
}
