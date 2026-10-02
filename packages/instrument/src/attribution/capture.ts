// First-touch campaign attribution in the browser — ported from infinite.fast.
//
// Sources @ 9f65b47:
//   - `scripts/lib/campaign-capture.cjs`: `campaignMetadata` (L3-21), `projectCampaignCookie` (L23-41),
//     `campaignWireMetadata` (L43-67). Ported VERBATIM below, because each is serialized into the page
//     with `Function.prototype.toString()` exactly as infinite.fast does, and the server cookie
//     (`./cookie.ts`) runs the same functions, so the browser and server records cannot drift.
//   - The landing script, `.github/scripts/inject-analytics.cjs` L195-258.
//
// WHAT IT RECORDS, on the visitor's FIRST landing in a tab:
//   - the five UTM values (printable ASCII, trimmed, at most 128 characters);
//   - whether gclid / fbclid / msclkid / ttclid were present — PRESENCE only, never the value;
//   - the landing path, the referrer HOST (never its path or query, and never the site's own host),
//     Meta's ad / ad set / campaign ids and placement when they are well-formed, and the minute it was
//     captured.
// It is FIRST TOUCH: an existing record is never overwritten (internal navigation must not erase the
// entry campaign), and a cookie is never renewed.
//
// TWO COPIES, written independently (a blocked cookie jar must not cost the tab record, and a full tab
// must not stop campaign recovery):
//   - the TAB copy (sessionStorage) for this visit;
//   - a 7-day COOKIE, only when at least one usable UTM survives the contamination filter, so a visitor
//     who returns in a new tab to convert is still credited. An unusable first visit (blank,
//     non-printable or click-id-contaminated UTMs) never occupies the first-touch cookie slot.
//
// GENERALISED FOR CUSTOMER SITES:
//   - BOTH copies are FILTERED AT WRITE TIME with the same contamination filter plus the scrubber
//     (`../conversions/scrub.ts`): a UTM or landing path that could carry a click id, an email, a URL or
//     a phone number is stored as "". infinite.fast wrote its tab copy unfiltered (skeptic G11) and only
//     filtered later, at each reader; a customer site has readers infinite-tag never sees, and a cookie
//     goes to the site's server (and its logs) on every request for days. The cookie's "usable" test runs
//     AFTER the scrub, so a landing whose only campaign value was personal writes no cookie.
//   - The capture follows the site's consent hook (`providers/meta-browser/consent.ts`), the same gate
//     as the `_fbc` capture: infinite.fast captures campaign labels regardless of consent because its own
//     banner governs its own site; on a customer's site, writing a first-party record for a visitor who
//     said no would be infinite-tag overriding that choice.
//   - `window.infiniteCampaign()` returns the WIRE form the site's code passes to its own server (and on
//     to `reportInfiniteOutcome`): `campaignProvenance` (tab / cookie / none), `browserContext` (facebook
//     app / instagram app / other in-app / browser), the validated Meta ids, and the safe UTM values.
//
// DELIBERATELY NOT HERE: the consent gate and banner (inject L260-292, L388-501); the build-time
// verified-host binding (L11-37) — customers get the deny-list preview guard instead.
import { UNSAFE_TEXT_SOURCE } from "../conversions/scrub.js"
import { consentAllowsSource, consentGateSource, type MetaBrowserGate } from "../providers/meta-browser/consent.js"
import {
  BROWSER_CAMPAIGN_COOKIE_MAX_AGE,
  CAMPAIGN_COOKIE_VALUE_MAX_BYTES,
  CAMPAIGN_KEY
} from "./patterns.js"

/* eslint-disable no-var */
type Loose = any // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CampaignMetadata {
  referrer_host: string
  meta_ad_id: string
  meta_adset_id: string
  meta_campaign_id: string
  meta_placement: string
  captured_at: string
}

/** campaign-capture.cjs L3-21, verbatim. Referrer host (not own), Meta ids, minute-precision time. */
export function campaignMetadata(search: string, referrer: string, ownHosts: string[], now: number): CampaignMetadata {
  var params = new URLSearchParams(search || "")
  function token(name: string, pattern: RegExp) {
    var value = params.get(name) || ""
    var match = value.match(pattern)
    return match && match[0] === value ? value : ""
  }
  var host = ""
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/\.$/, "")
    var label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if (
      host.length > 253 ||
      !new RegExp("^" + label + "(?:\\." + label + ")+$").test(host) ||
      ownHosts.some(function (own) {
        return own.toLowerCase().replace(/\.$/, "") === host
      })
    )
      host = ""
  } catch (_error) {
    host = ""
  }
  return {
    referrer_host: host,
    meta_ad_id: token("ad_id", /^[0-9]{1,32}$/),
    meta_adset_id: token("adset_id", /^[0-9]{1,32}$/),
    meta_campaign_id: token("campaign_id", /^[0-9]{1,32}$/),
    meta_placement: token("utm_placement", /^[A-Za-z0-9_]{1,64}$/),
    captured_at: new Date(Math.floor(now / 60000) * 60000).toISOString()
  }
}

/** campaign-capture.cjs L23-41, verbatim. The cookie record, or null without a usable UTM. */
export function projectCampaignCookie(payload: Loose, params: URLSearchParams, version: number): Loose {
  function contaminated(value: string) {
    var pattern = /(^|[/?&#\s])(?:gclid|fbclid|msclkid|ttclid)=/i
    if (pattern.test(value)) return true
    try {
      return pattern.test(decodeURIComponent(value))
    } catch (_error) {
      return false
    }
  }
  var record = JSON.parse(JSON.stringify(payload))
  var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]
  var usable = false
  for (var index = 0; index < keys.length; index++) {
    var key = keys[index]!
    if (contaminated(params.get(key) || "") || contaminated(record[key])) record[key] = ""
    if (record[key]) usable = true
  }
  if (!/^\/[^?#]*$/.test(record.landing_path) || contaminated(record.landing_path)) record.landing_path = ""
  if (!usable) return null
  record.v = version
  return record
}

export interface CampaignWireMetadata {
  campaignProvenance: "tab" | "cookie" | "none"
  browserContext: "facebook_app" | "instagram_app" | "other_in_app" | "browser" | "unknown"
  referrerHost?: string
  metaAdId?: string
  metaAdsetId?: string
  metaCampaignId?: string
  metaPlacement?: string
  campaignCapturedAt?: string
}

/** campaign-capture.cjs L43-67, verbatim. The validated wire form of a stored record. */
export function campaignWireMetadata(source: Loose, provenance: string, userAgent: unknown): CampaignWireMetadata {
  source = source && typeof source === "object" ? source : {}
  var result: Loose = {
    campaignProvenance: provenance === "tab" || provenance === "cookie" ? provenance : "none",
    browserContext: "unknown"
  }
  if (typeof userAgent === "string")
    result.browserContext = /FBAN|FBAV|FB_IAB/i.test(userAgent)
      ? "facebook_app"
      : /Instagram/i.test(userAgent)
        ? "instagram_app"
        : /; wv\)|Line\/|TikTok|Snapchat|LinkedInApp|Twitter/i.test(userAgent)
          ? "other_in_app"
          : "browser"
  var host = typeof source.referrer_host === "string" ? source.referrer_host.trim().toLowerCase().replace(/\.$/, "") : ""
  var label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
  if (host.length <= 253 && new RegExp("^" + label + "(?:\\." + label + ")+$").test(host)) result.referrerHost = host
  var fields: Loose = {
    meta_ad_id: "metaAdId",
    meta_adset_id: "metaAdsetId",
    meta_campaign_id: "metaCampaignId",
    meta_placement: "metaPlacement"
  }
  for (var key in fields) {
    var value = source[key]
    if (typeof value !== "string") continue
    var match = value.match(key === "meta_placement" ? /^[A-Za-z0-9_]{1,64}$/ : /^[0-9]{1,32}$/)
    if (match && match[0] === value) result[fields[key]] = value
  }
  var captured = source.captured_at
  if (typeof captured === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(captured)) {
    var time = Date.parse(captured)
    if (Number.isFinite(time)) {
      var normalized = new Date(time).toISOString()
      if (normalized.slice(0, 19) === captured.slice(0, 19)) result.campaignCapturedAt = normalized
    }
  }
  return result
}

/**
 * NEW (G11): the tab copy, filtered at WRITE time. Every UTM and the landing path that could carry a
 * click id (contamination filter) or personal data (`infiniteUnsafeText`) is stored as "". Needs
 * `infiniteUnsafeText` in scope (the landing script declares it; `./cookie.ts` passes the TS function).
 */
export function filterTabRecord(payload: Loose, unsafe: (value: unknown) => boolean): Loose {
  var record = JSON.parse(JSON.stringify(payload))
  var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "landing_path"]
  var pattern = /(^|[/?&#\s])(?:gclid|fbclid|msclkid|ttclid)=/i
  for (var index = 0; index < keys.length; index++) {
    var key = keys[index]!
    var value = typeof record[key] === "string" ? record[key] : ""
    var decoded = value
    try {
      decoded = decodeURIComponent(value)
    } catch (_error) {
      decoded = value
    }
    if (value && (pattern.test(value) || pattern.test(decoded) || unsafe(value))) record[key] = ""
  }
  return record
}

/** The global the landing script defines. */
export const CAMPAIGN_ACCESSOR = "infiniteCampaign"

export interface LandingAttributionOptions {
  /** The site's own hosts: a referrer on one of them is internal, not a campaign source. */
  ownHosts: string[]
  /** The consent hook (infinite-tag passes the Infinite hook for the site's consent mode). */
  gate?: MetaBrowserGate
}

function source(fn: (...args: never[]) => unknown): string {
  return fn.toString()
}

/**
 * The landing script: first-touch capture (tab + cookie) and `window.infiniteCampaign()`. Plain browser
 * source, free of backticks, `${` and `</` (asserted by the test that executes it).
 */
export function buildLandingAttributionScript(options: LandingAttributionOptions): string {
  const gate = options.gate ?? { kind: "none" }
  const ownHosts = [...new Set(options.ownHosts.map((host) => host.trim().toLowerCase().replace(/\.$/, "")))]
  return [
    "(function () {",
    `  if (typeof window.${CAMPAIGN_ACCESSOR} === "function") return;`,
    `  var KEY = ${JSON.stringify(CAMPAIGN_KEY)};`,
    `  var COOKIE_MAX_AGE = ${BROWSER_CAMPAIGN_COOKIE_MAX_AGE};`,
    `  var COOKIE_VALUE_MAX_BYTES = ${CAMPAIGN_COOKIE_VALUE_MAX_BYTES};`,
    `  var OWN_HOSTS = ${JSON.stringify(ownHosts)};`,
    `  var captureMetadata = ${source(campaignMetadata)};`,
    `  var cookieProjection = ${source(projectCampaignCookie)};`,
    `  var wireMetadata = ${source(campaignWireMetadata)};`,
    `  var tabProjection = ${source(filterTabRecord)};`,
    `  ${UNSAFE_TEXT_SOURCE}`,
    consentAllowsSource(gate),
    consentGateSource(gate),
    "  function cleanValue(value) {",
    '    if (typeof value !== "string") return "";',
    '    return value.replace(/[^\\x20-\\x7E]/g, "").trim().slice(0, 128);',
    "  }",
    "  function hasValue(params, name) {",
    "    var value = params.get(name);",
    '    return typeof value === "string" && value.length > 0;',
    "  }",
    "  function cookieRaw() {",
    "    try {",
    '      var parts = String(document.cookie || "").split(";");',
    "      for (var index = 0; index < parts.length; index += 1) {",
    "        var part = parts[index].replace(/^\\s+/, \"\");",
    '        if (part.indexOf(KEY + "=") === 0) return part.slice(KEY.length + 1);',
    "      }",
    "    } catch (_error) {}",
    "    return null;",
    "  }",
    "  function parsed(raw, decode) {",
    "    try {",
    "      var value = JSON.parse(decode ? decodeURIComponent(raw) : raw);",
    '      return value && typeof value === "object" ? value : null;',
    "    } catch (_error) { return null; }",
    "  }",
    "  // The wire form for the site's own server: provenance, browser context, validated ids, safe UTMs.",
    `  window.${CAMPAIGN_ACCESSOR} = function () {`,
    "    var userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;",
    "    if (!infiniteConsentAllows()) return wireMetadata({}, 'none', userAgent);",
    "    var record = null, provenance = 'none';",
    "    try { var tab = sessionStorage.getItem(KEY); if (tab) { record = parsed(tab, false); provenance = record ? 'tab' : 'none'; } } catch (_error) {}",
    "    if (!record) { var raw = cookieRaw(); if (raw) { record = parsed(raw, true); provenance = record ? 'cookie' : 'none'; } }",
    "    var result = wireMetadata(record || {}, provenance, userAgent);",
    "    if (record) {",
    "      var names = { utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_term: 'utmTerm', utm_content: 'utmContent', landing_path: 'landingPath' };",
    "      for (var key in names) {",
    "        var value = record[key];",
    "        if (typeof value === 'string' && value && value.length <= 128 && !infiniteUnsafeText(value)) result[names[key]] = value;",
    "      }",
    "    }",
    "    return result;",
    "  };",
    "  infiniteConsentGate(function () {",
    "    var params, payload;",
    "    try {",
    '      params = new URLSearchParams(location.search || "");',
    "      payload = {",
    '        utm_source: cleanValue(params.get("utm_source") || ""),',
    '        utm_medium: cleanValue(params.get("utm_medium") || ""),',
    '        utm_campaign: cleanValue(params.get("utm_campaign") || ""),',
    '        utm_term: cleanValue(params.get("utm_term") || ""),',
    '        utm_content: cleanValue(params.get("utm_content") || ""),',
    '        has_gclid: hasValue(params, "gclid"),',
    '        has_fbclid: hasValue(params, "fbclid"),',
    '        has_msclkid: hasValue(params, "msclkid"),',
    '        has_ttclid: hasValue(params, "ttclid"),',
    '        landing_path: location.pathname || "/"',
    "      };",
    '      var metadata = captureMetadata(location.search || "", document.referrer || "", OWN_HOSTS, Date.now());',
    "      for (var field in metadata) payload[field] = metadata[field];",
    "    } catch (_error) { return; }",
    "    // Independent writes: a blocked cookie jar must not cost the tab record, and blocked or",
    "    // already-populated tab storage must not prevent campaign recovery.",
    "    try {",
    "      if (cookieRaw() === null) {",
    "        // The cookie is scrubbed exactly like the tab copy (an email or phone number in a UTM is",
    "        // blanked), THEN projected, so a landing whose only campaign value was personal claims no slot.",
    "        var cookieRecord = cookieProjection(tabProjection(payload, infiniteUnsafeText), params, 1);",
    "        var encoded = encodeURIComponent(JSON.stringify(cookieRecord));",
    "        // Only usable, sanitized campaign evidence may claim the first-touch cookie slot. Oversize",
    "        // records are skipped whole; a field is never truncated and a cookie never renewed.",
    "        if (cookieRecord && encoded.length <= COOKIE_VALUE_MAX_BYTES) {",
    '          document.cookie = KEY + "=" + encoded + ";path=/;max-age=" + COOKIE_MAX_AGE',
    '            + ";samesite=Lax" + (location.protocol === "https:" ? ";secure" : "");',
    "        }",
    "      }",
    "    } catch (_error) {}",
    "    try {",
    "      if (!sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, JSON.stringify(tabProjection(payload, infiniteUnsafeText)));",
    "    } catch (_error) {}",
    "  });",
    "})();"
  ].join("\n")
}
