// `window.infiniteTrackThenNavigate(event, hrefOrAnchor, name, props?, { destinations?, gate?, metaEventName? })` —
// record a click, THEN leave.
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
//     managed GA4 snippet sets after its preview guard passes (`window.__infiniteGa4Lane`), or — for the site's
//     OWN (adopted) GA4 — gtag.js itself having loaded (`window.google_tag_manager`), never `typeof gtag`: an
//     adopted gtag stub with no loader (a guarded preview, a consent-mode site) has a `gtag` function that never
//     calls back, and would hold every click for a full second (F15). Live run 4 (Codex F5): with only the
//     marker, an adopted GA4 was never waited for, so a conversion followed by a navigation could be lost.
//   - `event_callback: follow` plus `event_timeout: 1000` (L530), and a `setTimeout(follow, 1000)`
//     backstop (L532): the visitor never waits more than one second for analytics.
//   - Follow ONCE (L519-524): a callback that fires twice, or the backstop after the callback, cannot
//     navigate twice.
//   - PostHog and Infinite get the same event name; they have no delivery callback, so they never
//     hold a click.
//   - Browser-only Meta events (AddToCart, ViewContent, explicit custom CTA events) carry no
//     eventID. When the helper owns or holds a same-tab navigation, it waits for that event's `/tr`
//     request or a 400 ms budget, ported from infinite.fast's mirror wait (and the reference store's
//     `trackMetaEventBeforeLeaving`).
//   - `destinations` (review P1-7) picks the tools, exactly as `infiniteTrack` does: `["meta"]` sends Meta's
//     AddToCart alone (the Buy button that already sends GA4 add_to_cart) and still waits for its `/tr` request; a
//     tool left out is never sent to and never held for.
//   - ONE NAVIGATION AT A TIME (the reference store's `createMetaLeave`): once the helper holds or performs a same-tab
//     navigation, a second click sends nothing and goes nowhere until the page leaves, a 3 s grace passes (a failed
//     navigation never leaves a dead button), or the browser restores the page from the back/forward cache
//     (`pageshow` with `persisted`).
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

/** After this, a held click that did not leave the page works again, so a failed navigation never leaves a dead button. */
export const NAVIGATION_GRACE_MS = 3000

export function trackThenNavigateSource(): string {
  return [
    browserFollowsSource(),
    "// One navigation at a time (the reference store's Buy guard): a second click while the first is on its way sends",
    "// nothing and goes nowhere, so an item is never added twice. Released after a grace period, and when the browser",
    "// restores this page from the back/forward cache mid-leave.",
    "var infiniteLeaving = false, infiniteLeavingTimer = 0;",
    "function infiniteReleaseLeaving() {",
    "  infiniteLeaving = false;",
    "  try { clearTimeout(infiniteLeavingTimer); } catch (_error) {}",
    "}",
    "function infiniteHoldLeaving() {",
    "  infiniteLeaving = true;",
    "  try { clearTimeout(infiniteLeavingTimer); } catch (_error) {}",
    `  infiniteLeavingTimer = setTimeout(infiniteReleaseLeaving, ${NAVIGATION_GRACE_MS});`,
    "}",
    "try { window.addEventListener('pageshow', function (pageEvent) { if (pageEvent && pageEvent.persisted) infiniteReleaseLeaving(); }); } catch (_error) {}",
    "window.infiniteTrackThenNavigate = function (event, target, name, props, options) {",
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
    "  var sameTab = browserGoes",
    "    ? (event.button === 0 || event.button === undefined) && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !opensElsewhere",
    "    : !opensElsewhere;",
    "  function stopBrowser() {",
    "    try { if (event && typeof event.preventDefault === 'function' && !event.defaultPrevented) event.preventDefault(); } catch (_error) {}",
    "  }",
    "  if (sameTab && infiniteLeaving) {",
    "    // Already on its way: no second event, and the browser must not leave before the first one is out.",
    "    stopBrowser();",
    "    return;",
    "  }",
    "  var followed = false;",
    "  function follow() {",
    "    if (followed) return;",
    "    followed = true;",
    "    try {",
    "      if (opensElsewhere && !browserGoes) window.open(destination.href, '_blank', 'noopener');",
    "      else location.assign(destination.href);",
    "    } catch (_error) {}",
    "  }",
    "  // The helper owns this same-tab navigation from here on (it prevented the browser's own).",
    "  function own() {",
    "    stopBrowser();",
    "    if (sameTab) infiniteHoldLeaving();",
    "  }",
    "  // Nothing held: the browser goes by itself, or the helper goes now.",
    "  function leave() {",
    "    if (browserGoes) return;",
    "    own();",
    "    follow();",
    "  }",
    "  try {",
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name) || !infiniteMayTrack(options)) { leave(); return; }",
    "    var clean = infiniteCleanProps(props);",
    "    try { if (infiniteDestinationAllowed(options, 'posthog', true) && window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture(name, infiniteCopy(clean)); } catch (_error) {}",
    "    infiniteRecordEvent(name, options);",
    "    var ga4Wanted = infiniteDestinationAllowed(options, 'ga4', true) && typeof window.gtag === 'function';",
    `    var lane = window.${GA4_LANE_MARKER};`,
    "    var ours = !!(lane && typeof lane.id === 'string');",
    "    // R4-5: the site's OWN GA4 started too once gtag.js itself loaded (it defines google_tag_manager); a stub with no",
    "    // loader (a guarded preview, consent not given) never calls back, so it still holds nothing (F15).",
    "    var loaded = !!(window.google_tag_manager && typeof window.google_tag_manager === 'object');",
    "    var started = ga4Wanted && (ours || loaded);",
    "    var metaResult = infiniteSendMetaBrowserEvent(name, clean, options, sameTab);",
    "    if (!started) {",
    "      // GA4 is not holding the click: send what we can, and hold only for a browser-only Meta request.",
    "      try { if (ga4Wanted) window.gtag('event', name, infiniteGa4Props(name, clean)); } catch (_error) {}",
    "      if (sameTab && metaResult.wait) {",
    "        own();",
    "        metaResult.wait.then(follow, follow);",
    "      } else leave();",
    "      return;",
    "    }",
    "    var params = infiniteGa4Props(name, clean);",
    "    if (ours) params.send_to = lane.id;",
    "    if (sameTab) {",
    "      params.event_callback = metaResult.wait ? function () { metaResult.wait.then(follow, follow); } : follow;",
    `      params.event_timeout = ${NAVIGATION_BUDGET_MS};`,
    "      own();",
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
