// `window.infiniteTrackThenNavigate(event, hrefOrAnchor, name, props?)` — record a click, THEN leave.
//
// Source: the GA4 download bridge, infinite-site `.github/scripts/inject-analytics.cjs` L503-536 @
// 9f65b47, with the destination taken from the caller instead of a hard-coded `/download`.
//
// WHY IT EXISTS. A same-tab link unloads the page in the same turn it is clicked, and the GA4 request
// for that click is cut off with no error anywhere: the conversion is simply never counted. gtag's
// `event_callback` tells us when the hit is out, so the helper holds the navigation until then.
//
// THE RULES, ported verbatim (each was an infinite.fast incident):
//   - Only a same-tab, unmodified left click is held (L518). A new-tab or modified click, or
//     `target="_blank"`, is left entirely to the browser: the page does not unload.
//   - `preventDefault` ONLY when GA4 actually STARTED (L516). Here that is the marker the managed GA4
//     snippet sets after its preview guard passes (`window.__infiniteGa4Lane`), never `typeof gtag`: an
//     adopted gtag stub with no loader (a guarded preview, a consent-mode site) has a `gtag` function
//     that never calls back, and would hold every click for a full second (F15, the dead button).
//   - `event_callback: follow` plus `event_timeout: 1000` (L530), and a `setTimeout(follow, 1000)`
//     backstop (L532): the visitor never waits more than one second for analytics.
//   - Follow ONCE (L519-524): a callback that fires twice, or the backstop after the callback, cannot
//     navigate twice.
//   - With no tags at all, nothing throws and the link still works: the browser's own navigation
//     (nothing was prevented), or — for a programmatic call with no event — `location.assign` now.
//   - PostHog gets the same event name; it has no delivery callback, so it never holds a click.
//   - Consent, the optional gate and the OAuth-return rule are `infiniteMayTrack` (`./track.ts`). When
//     they say no, the navigation is untouched and nothing is sent.
//
// Plain ES5 source, free of backticks, `${` and `</`; assembled by `./globals.ts`.
import { GA4_LANE_MARKER } from "../providers/ga4.js"

/** The longest a click is held for analytics, in ms (event_timeout and the backstop). */
export const NAVIGATION_BUDGET_MS = 1000

export function trackThenNavigateSource(): string {
  return [
    "window.infiniteTrackThenNavigate = function (event, target, name, props) {",
    "  var destination = null;",
    "  try {",
    "    var href = typeof target === 'string' ? target : target && typeof target.href === 'string' ? target.href : '';",
    "    destination = new URL(href, location.href);",
    "    if (destination.protocol !== 'https:' && destination.protocol !== 'http:') return;",
    "  } catch (_error) { return; }",
    "  if (event && event.defaultPrevented) return;",
    "  var followed = false;",
    "  function follow() {",
    "    if (followed) return;",
    "    followed = true;",
    "    try { location.assign(destination.href); } catch (_error) {}",
    "  }",
    "  try {",
    "    var opensElsewhere = !!(target && typeof target === 'object' && typeof target.getAttribute === 'function' && target.getAttribute('target') === '_blank');",
    "    var sameTab = !event || ((event.button === 0 || event.button === undefined) && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !opensElsewhere);",
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name) || !infiniteMayTrack()) { if (!event) follow(); return; }",
    "    var clean = infiniteCleanProps(props);",
    "    try { if (window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture(name, infiniteCopy(clean)); } catch (_error) {}",
    `    var lane = window.${GA4_LANE_MARKER};`,
    "    var started = !!(lane && typeof lane.id === 'string') && typeof window.gtag === 'function';",
    "    if (!started) {",
    "      // GA4 did not start here (or is not ours): send what we can, hold nothing.",
    "      try { if (typeof window.gtag === 'function') window.gtag('event', name, infiniteCopy(clean)); } catch (_error) {}",
    "      if (!event) follow();",
    "      return;",
    "    }",
    "    var params = infiniteCopy(clean);",
    "    params.send_to = lane.id;",
    "    if (sameTab) {",
    "      params.event_callback = follow;",
    `      params.event_timeout = ${NAVIGATION_BUDGET_MS};`,
    "      if (event && typeof event.preventDefault === 'function') event.preventDefault();",
    "    }",
    "    try { window.gtag('event', name, params); } catch (_error) { if (sameTab) follow(); return; }",
    `    if (sameTab) setTimeout(follow, ${NAVIGATION_BUDGET_MS});`,
    "  } catch (_error) {",
    "    if (!event || event.defaultPrevented) follow();",
    "  }",
    "};"
  ].join("\n")
}
