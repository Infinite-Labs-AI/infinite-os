// Meta's automatic events (Automatic Configuration) and the managed-snippet census, as PURE
// functions over page bytes — so the static setup check runs them on the repo today and a later
// live check / doctor can run the same functions on the bytes a production page serves.
//
// Ported from infinite-site @ 9f65b47:
//   • `scripts/verify-live-analytics.mjs` L265-283 `checkMetaAutoConfigOptOut`, with its cases from
//     `.github/scripts/test-verify-live-analytics.mjs` (opt-in fails, missing fails, after-init fails;
//     `false` and `"false"` are the same opt-out because fbevents reads only `true`/`"true"` as
//     opt-in);
//   • `.github/scripts/test-inject-analytics.mjs` L88-135, the census written after the 849ccf1
//     near-miss (a merge nearly stripped the Meta helpers): exactly one bootstrap `fbq('init')` per
//     pixel, at most one capture, at most one matching accessor, capture before init.
//
// THREE STATES PLUS INFO, by who installed the pixel (founder decision 10):
//   • a pixel infinite-tag installed (MANAGED) without the opt-out before init is a PROBLEM — it is
//     our own code and it is wrong;
//   • a pixel the site already had (ADOPTED) with automatic events on is INFO — a later plan line
//     with a measured count, never an automatic edit;
//   • when the bytes cannot settle it (a computed pixel id, an autoConfig call whose arguments are not
//     literals, a pixel that is never initialised here) the answer is UNDETERMINED, which never
//     counts as a pass.
import { extractMetaPixelIds } from "../../meta-live/config-probe.js"
import { META_CLICK_ID_ACCESSOR } from "./click-id.js"

export type MetaPixelOrigin = "managed" | "adopted"

export type MetaAutoConfigReason =
  /** `fbq('set','autoConfig',false|'false',id)` is queued before `init`. Automatic events are off. */
  | "opted_out_before_init"
  /** `fbq('set','autoConfig',true|'true',id)`: automatic events explicitly on. */
  | "opted_in"
  /** No opt-out for this pixel: automatic events are ON by Meta's default. */
  | "opt_out_missing"
  /** The opt-out exists but is queued after `init`, which Meta ignores. */
  | "opt_out_after_init"
  /** The pixel id is not a plain digit string, so its calls cannot be matched. */
  | "invalid_pixel_id"
  /** No literal `fbq('init', id)` for this pixel in these bytes. */
  | "pixel_not_initialised"
  /** An autoConfig call exists whose arguments are not literals, so its effect cannot be read. */
  | "autoconfig_unreadable"
  /** The only opt-out for this pixel sits inside a comment, so it may not run at all. */
  | "opt_out_commented"

export interface MetaAutoConfigVerdict {
  pixelId: string
  origin: MetaPixelOrigin
  state: "ok" | "problem" | "info" | "undetermined"
  reason: MetaAutoConfigReason
}

const SET_AUTOCONFIG = String.raw`fbq\(\s*["']set["']\s*,\s*["']autoConfig["']`
const LITERAL_AUTOCONFIG = new RegExp(
  String.raw`${SET_AUTOCONFIG}\s*,\s*(?:true|false|["'](?:true|false)["'])\s*,\s*["'][0-9]+["']\s*\)`,
  "g"
)

/**
 * Is Meta's automatic-events collection switched off for `pixelId` in these bytes, and in time?
 * Mirrors infinite.fast's rule order: an opt-in anywhere wins, then a missing opt-out, then order.
 */
export function checkMetaAutoConfigOptOut(
  source: string,
  pixelId: string,
  origin: MetaPixelOrigin
): MetaAutoConfigVerdict {
  const verdict = (state: MetaAutoConfigVerdict["state"], reason: MetaAutoConfigReason): MetaAutoConfigVerdict => ({
    pixelId,
    origin,
    state,
    reason
  })
  if (!/^[0-9]{1,24}$/.test(pixelId)) return verdict("undetermined", "invalid_pixel_id")
  const optOut = new RegExp(String.raw`${SET_AUTOCONFIG}\s*,\s*(?:false|["']false["'])\s*,\s*["']${pixelId}["']\s*\)`, "g")
  const optIn = new RegExp(String.raw`${SET_AUTOCONFIG}\s*,\s*(?:true|["']true["'])\s*,\s*["']${pixelId}["']\s*\)`)
  const bad = origin === "managed" ? "problem" : "info"

  if (optIn.test(source)) return verdict(bad, "opted_in")
  const allCalls = source.match(new RegExp(SET_AUTOCONFIG, "g"))?.length ?? 0
  const literalCalls = source.match(LITERAL_AUTOCONFIG)?.length ?? 0
  // These are static bytes, not a running page: an opt-out inside a comment never runs. Only an
  // opt-out outside every comment counts; one that exists only inside a comment cannot settle it.
  const optOutMatches = [...source.matchAll(optOut)]
  const liveOptOut = optOutMatches.find((match) => !insideComment(source, match.index))
  if (!liveOptOut) {
    if (optOutMatches.length > 0) return verdict("undetermined", "opt_out_commented")
    // A call we cannot read might be this pixel's opt-out; that is "cannot tell", never "missing".
    if (allCalls > literalCalls) return verdict("undetermined", "autoconfig_unreadable")
    return verdict(bad, "opt_out_missing")
  }
  const initIndex = source.search(new RegExp(String.raw`fbq\(\s*["']init["']\s*,\s*["']${pixelId}["']`))
  if (initIndex === -1) return verdict("undetermined", "pixel_not_initialised")
  if (liveOptOut.index > initIndex) return verdict(bad, "opt_out_after_init")
  return verdict("ok", "opted_out_before_init")
}

/**
 * Does `index` sit inside a comment? A heuristic over raw bytes, deliberately biased so that a wrong
 * answer can only turn a pass into "undetermined", never the reverse:
 *   • a JS line comment: `//` earlier on the same line, except a URL's `://`;
 *   • a JS block comment: the nearest `/*` before it is not yet closed;
 *   • an HTML comment: the nearest `<!--` before it is not yet closed.
 */
function insideComment(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1
  if (/(^|[^:])\/\//.test(source.slice(lineStart, index))) return true
  const before = source.slice(0, index)
  if (before.lastIndexOf("/*") > before.lastIndexOf("*/")) return true
  if (before.lastIndexOf("<!--") > before.lastIndexOf("-->")) return true
  return false
}

export type MetaCensusIssueCode =
  /** A pixel's bootstrap `fbq('init', id)` appears zero or several times in one managed snippet. */
  | "init_count"
  /** More than one `_fbc` capture in one managed snippet. */
  | "capture_count"
  /** More than one Manual Advanced Matching accessor in one managed snippet. */
  | "matching_count"
  /** The capture runs after the pixel's init, so fbevents can read `_fbc` before it is written. */
  | "capture_after_init"

export interface MetaCensusIssue {
  code: MetaCensusIssueCode
  pixelId?: string
  count?: number
}

/**
 * The census over ONE managed snippet (one page's managed block, or the Next module's bootstrap).
 * Empty means every count and order holds. Only for code infinite-tag wrote: an adopted page may
 * legitimately be shaped differently.
 */
export function censusManagedMetaSnippet(source: string): MetaCensusIssue[] {
  const issues: MetaCensusIssue[] = []
  const captures = countOf(source, new RegExp(String.raw`window\.${META_CLICK_ID_ACCESSOR}\s*=\s*function`, "g"))
  const matchers = countOf(source, /window\.infiniteMetaAdvancedMatch\s*=\s*function/g)
  if (captures > 1) issues.push({ code: "capture_count", count: captures })
  if (matchers > 1) issues.push({ code: "matching_count", count: matchers })
  const captureAt = source.search(new RegExp(String.raw`window\.${META_CLICK_ID_ACCESSOR}\s*=\s*function`))
  for (const pixelId of extractMetaPixelIds(source)) {
    // The BOOTSTRAP init: id only. The matching re-init carries user data and is counted apart.
    const bootstrap = new RegExp(String.raw`fbq\(\s*["']init["']\s*,\s*["']${pixelId}["']\s*\)`, "g")
    const inits = countOf(source, bootstrap)
    if (inits !== 1) issues.push({ code: "init_count", pixelId, count: inits })
    const initAt = source.search(new RegExp(String.raw`fbq\(\s*["']init["']\s*,\s*["']${pixelId}["']\s*\)`))
    if (captureAt !== -1 && initAt !== -1 && captureAt > initAt) {
      issues.push({ code: "capture_after_init", pixelId })
    }
  }
  return issues
}

function countOf(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0
}
