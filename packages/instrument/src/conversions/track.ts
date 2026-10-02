// `window.infiniteTrack(name, props?, { gate? })` — one named event to PostHog and GA4 (§3j.6).
//
// Source: `track()` in infinite-site `get-started/index.html` L296-307 and the CTA intent snippet in
// `.github/scripts/inject-analytics.cjs` L577-595 @ 9f65b47, generalised for customer sites (decisions 9
// and 13: the SITE'S OWN CODE calls the helper; the runtime forwards nothing).
//
// RULES, each from an infinite.fast incident or a standing ruling:
//   - The name is a bounded token (`/^[A-Za-z0-9_-]{1,64}$/`, the rule at inject L528/L588). Anything
//     else sends nothing.
//   - Properties are bounded: at most 16, keys `/^[A-Za-z0-9_]{1,40}$/` (GA4's parameter-name limit),
//     values a finite number, a boolean, or a string of at most 100 characters that passes the scrubber
//     (`./scrub.ts`). A value that fails is DROPPED, never rewritten. Nothing else is ever attached.
//   - Consent is re-checked at CALL time (the Infinite hook for the site's consent mode, see
//     `providers/meta-browser/consent.ts`), so a revocation a moment ago is honoured; an optional
//     `gate` function (the site's own check) must also return true.
//   - Nothing is sent while an OAuth return is in the URL (`code` AND `state`, or `error` /
//     `error_code`): the providers enrich every event with the current URL, and an authorization code
//     must never reach them (get-started `reportStep` L391-398). A promo `?code=` alone is not an OAuth
//     return and is not suppressed.
//   - Each provider is reached behind its own existence check and try/catch, so a missing or broken
//     tool can never throw into the site's code.
//   - NEVER `fbq`. A click is intent, not a conversion; Meta conversions come from the server, and the
//     browser twin only through `infiniteMetaMirror` with the id the server returned.
//
// Plain ES5 source, free of backticks, `${` and `</`. These fragments are assembled into one helper
// script by `./globals.ts`, which supplies `infiniteConsentAllows` and `infiniteUnsafeText`.
import { GA4_LANE_MARKER } from "../providers/ga4.js"

/** The event-name rule every helper applies. */
export const INFINITE_EVENT_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** At most this many properties ride on one event. */
export const INFINITE_MAX_PROPS = 16

/**
 * The shared private functions every helper uses: the name rule, the property bounds, the OAuth-return
 * check and the call-time permission check.
 */
export function helperCoreSource(): string {
  return [
    "var INFINITE_EVENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;",
    "var INFINITE_PROP_KEY = /^[A-Za-z0-9_]{1,40}$/;",
    `var INFINITE_MAX_PROPS = ${INFINITE_MAX_PROPS};`,
    "function infiniteCleanProps(props) {",
    "  var clean = {}, count = 0;",
    "  if (!props || typeof props !== 'object') return clean;",
    "  for (var key in props) {",
    "    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;",
    "    if (count >= INFINITE_MAX_PROPS) break;",
    "    if (!INFINITE_PROP_KEY.test(key) || key === 'send_to' || key === 'event_callback' || key === 'event_timeout') continue;",
    "    var value = props[key];",
    "    if (typeof value === 'number') { if (!isFinite(value)) continue; }",
    "    else if (typeof value === 'string') { if (value.length === 0 || value.length > 100 || infiniteUnsafeText(value)) continue; }",
    "    else if (typeof value !== 'boolean') continue;",
    "    clean[key] = value;",
    "    count += 1;",
    "  }",
    "  return clean;",
    "}",
    "function infiniteOauthReturn() {",
    "  try {",
    "    var params = new URLSearchParams(location.search || '');",
    "    return (params.has('code') && params.has('state')) || params.has('error') || params.has('error_code');",
    "  } catch (_error) { return true; }",
    "}",
    "function infiniteMayTrack(options) {",
    "  if (!infiniteConsentAllows()) return false;",
    "  if (options && typeof options.gate === 'function') {",
    "    try { if (options.gate() !== true) return false; } catch (_error) { return false; }",
    "  }",
    "  return !infiniteOauthReturn();",
    "}",
    "function infiniteCopy(source) {",
    "  var copy = {};",
    "  for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) copy[key] = source[key];",
    "  return copy;",
    "}"
  ].join("\n")
}

/** `window.infiniteTrack`. Returns true when at least one tool accepted the event. */
export function trackSource(): string {
  return [
    "window.infiniteTrack = function (name, props, options) {",
    "  try {",
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name) || !infiniteMayTrack(options)) return false;",
    "    var clean = infiniteCleanProps(props), sent = false;",
    "    try {",
    "      if (window.posthog && typeof window.posthog.capture === 'function') { window.posthog.capture(name, infiniteCopy(clean)); sent = true; }",
    "    } catch (_error) {}",
    "    try {",
    "      if (typeof window.gtag === 'function') {",
    "        var params = infiniteCopy(clean);",
    `        var lane = window.${GA4_LANE_MARKER};`,
    "        if (lane && typeof lane.id === 'string') params.send_to = lane.id;",
    "        window.gtag('event', name, params);",
    "        sent = true;",
    "      }",
    "    } catch (_error) {}",
    "    return sent;",
    "  } catch (_error) { return false; }",
    "};"
  ].join("\n")
}
