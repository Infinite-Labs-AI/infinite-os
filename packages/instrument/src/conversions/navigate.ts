// `window.infiniteTrackThenNavigate(event, hrefOrAnchor, name, props?)` — record a click, THEN leave.
//
// Source: the GA4 download bridge, infinite-site `.github/scripts/inject-analytics.cjs` L503-536 @
// 9f65b47, with the destination taken from the caller instead of a hard-coded `/download`.
//
// WHY IT EXISTS. A same-tab link unloads the page in the same turn it is clicked, and the GA4 request
// for that click is cut off with no error anywhere: the conversion is simply never counted. gtag's
// `event_callback` tells us when the hit is out, so the helper holds the navigation until then.
//
// THE RULES, ported from infinite.fast (each was an incident there) — plus who OWNS the navigation:
//   - THE BROWSER GOES only on an unprevented click whose `<a>`/`<area>` (the anchor passed as the target,
//     or the event's `currentTarget`) points at this destination. Then a new-tab or modified click, or
//     `target="_blank"`, is left entirely to the browser (L518), and an unheld click is left alone.
//   - OTHERWISE THE HELPER OWNS IT: a `<button>` (a string target with a click), an anchor whose href is
//     somewhere else, a click the site already prevented, or a programmatic call with no event. A
//     button's default action is not a navigation, so leaving it "to the browser" is a dead CTA on every
//     page where GA4 did not start (an adopted gtag, a preview, consent no, before hydration). The helper
//     prevents the default (a submit button must not race it) and goes itself: at once when nothing is
//     held, or at the callback / backstop when GA4 holds it. Modifier keys do not apply to an owned
//     navigation (a button has no new-tab gesture); a `target="_blank"` anchor opens in a new tab.
//   - An already-prevented click on an ANCHOR passed as the target (a delegated listener running after a
//     router took the click) is left alone entirely, as infinite.fast did (L516).
//   - `preventDefault` to HOLD a click ONLY when GA4 actually STARTED (L516). Here that is the marker the
//     managed GA4 snippet sets after its preview guard passes (`window.__infiniteGa4Lane`), never
//     `typeof gtag`: an adopted gtag stub with no loader (a guarded preview, a consent-mode site) has a
//     `gtag` function that never calls back, and would hold every click for a full second (F15).
//   - `event_callback: follow` plus `event_timeout: 1000` (L530), and a `setTimeout(follow, 1000)`
//     backstop (L532): the visitor never waits more than one second for analytics.
//   - Follow ONCE (L519-524): a callback that fires twice, or the backstop after the callback, cannot
//     navigate twice.
//   - PostHog gets the same event name; it has no delivery callback, so it never holds a click.
//   - Consent, the optional gate and the OAuth-return rule are `infiniteMayTrack` (`./track.ts`). When
//     they say no, nothing is sent and the navigation happens exactly as if no tool were present.
//
// Plain ES5 source, free of backticks, `${` and `</`; assembled by `./globals.ts`.
import { GA4_LANE_MARKER } from "../providers/ga4.js"

/** The longest a click is held for analytics, in ms (event_timeout and the backstop). */
export const NAVIGATION_BUDGET_MS = 1000

/** The anchor test both forms use: does the browser's own default action already go to `destination`? */
export function browserFollowsSource(): string {
  return [
    "function infiniteBrowserFollows(event, target, destination) {",
    "  if (!event || event.defaultPrevented) return false;",
    "  function anchorTo(element) {",
    "    if (!element || typeof element !== 'object' || typeof element.tagName !== 'string' || !/^(a|area)$/i.test(element.tagName)) return false;",
    "    if (typeof element.href !== 'string' || element.href.length === 0) return false;",
    "    try { return new URL(element.href, location.href).href === destination.href; } catch (_error) { return false; }",
    "  }",
    "  // The handler sits on the anchor itself.",
    "  if (anchorTo(event.currentTarget)) return true;",
    "  // A delegated listener passed the anchor: the browser follows it only if the click landed inside it.",
    "  if (!anchorTo(target)) return false;",
    "  try {",
    "    var clicked = event.target;",
    "    return !!clicked && (clicked === target || (typeof target.contains === 'function' && target.contains(clicked) === true));",
    "  } catch (_error) { return false; }",
    "}"
  ].join("\n")
}

export function trackThenNavigateSource(): string {
  return [
    browserFollowsSource(),
    "window.infiniteTrackThenNavigate = function (event, target, name, props) {",
    "  var destination = null;",
    "  try {",
    "    var href = typeof target === 'string' ? target : target && typeof target.href === 'string' ? target.href : '';",
    "    destination = new URL(href, location.href);",
    "    if (destination.protocol !== 'https:' && destination.protocol !== 'http:') return;",
    "  } catch (_error) { return; }",
    "  var targetIsElement = !!(target && typeof target === 'object' && typeof target.tagName === 'string');",
    "  if (event && event.defaultPrevented && targetIsElement) return;",
    "  var opensElsewhere = false;",
    "  try { opensElsewhere = !!(target && typeof target === 'object' && typeof target.getAttribute === 'function' && target.getAttribute('target') === '_blank'); } catch (_error) {}",
    "  var browserGoes = infiniteBrowserFollows(event, target, destination);",
    "  var followed = false;",
    "  function follow() {",
    "    if (followed) return;",
    "    followed = true;",
    "    try {",
    "      if (opensElsewhere && !browserGoes) window.open(destination.href, '_blank', 'noopener');",
    "      else location.assign(destination.href);",
    "    } catch (_error) {}",
    "  }",
    "  // Nothing held: the browser goes by itself, or the helper goes now.",
    "  function leave() {",
    "    if (browserGoes) return;",
    "    try { if (event && typeof event.preventDefault === 'function' && !event.defaultPrevented) event.preventDefault(); } catch (_error) {}",
    "    follow();",
    "  }",
    "  var sameTab = browserGoes",
    "    ? (event.button === 0 || event.button === undefined) && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !opensElsewhere",
    "    : !opensElsewhere;",
    "  try {",
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name) || !infiniteMayTrack()) { leave(); return; }",
    "    var clean = infiniteCleanProps(props);",
    "    try { if (window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture(name, infiniteCopy(clean)); } catch (_error) {}",
    `    var lane = window.${GA4_LANE_MARKER};`,
    "    var started = !!(lane && typeof lane.id === 'string') && typeof window.gtag === 'function';",
    "    if (!started) {",
    "      // GA4 did not start here (or is not ours): send what we can, hold nothing.",
    "      try { if (typeof window.gtag === 'function') window.gtag('event', name, infiniteCopy(clean)); } catch (_error) {}",
    "      leave();",
    "      return;",
    "    }",
    "    var params = infiniteCopy(clean);",
    "    params.send_to = lane.id;",
    "    if (sameTab) {",
    "      params.event_callback = follow;",
    `      params.event_timeout = ${NAVIGATION_BUDGET_MS};`,
    "      if (event && typeof event.preventDefault === 'function') event.preventDefault();",
    "    }",
    "    try { window.gtag('event', name, params); } catch (_error) { if (sameTab) follow(); else leave(); return; }",
    `    if (sameTab) setTimeout(follow, ${NAVIGATION_BUDGET_MS});`,
    "    else leave();",
    "  } catch (_error) {",
    "    if (!browserGoes || (event && event.defaultPrevented)) follow();",
    "  }",
    "};"
  ].join("\n")
}
