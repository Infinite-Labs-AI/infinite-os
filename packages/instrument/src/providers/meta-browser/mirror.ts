// `window.infiniteMetaMirror(metaEventName, metaEventId, { wait?, identity?, budgetMs?, gate? })` — the
// browser twin of a Meta server event, fired ONLY on the server's instruction (decisions 11 and 18, §3j.6).
//
// Sources, both infinite.fast @ 9f65b47:
//   - `mirrorRegistration`, `get-started/index.html` L366-389 (the identity wait and the 400 ms budget,
//     with the doctrine at L315-365);
//   - `mirrorLead`, `_agent_artifacts/infinite-capability-workspace/growth.js` L185-222 (waiting for THIS
//     event's `/tr` request to complete before the page leaves, through Resource Timing).
//
// THE CONTRACT. The site's server reports a conversion with `reportInfiniteOutcome`, and Infinite's 202
// answers `{ metaEventId, metaEventName }`. A non-empty `metaEventId` is a positive INSTRUCTION: "the cloud
// is sending THIS conversion to Meta under exactly this id — mirror it". `null` (or absent, an older
// cloud) means "nothing is being sent — stay quiet". The page never builds an id (there is no fallback),
// so the browser event can never drift from the server's dedup key. Meta's dedup is SUBTRACTIVE: it drops
// a later duplicate of an (event_name, event_id) pair it already saw, and never one browser event against
// another, so a mirror with no server twin would be COUNTED as a real conversion. That is why `null`
// means silence, not "fire anyway".
//
// THE RULES:
//   - Fires only on a non-empty string `metaEventId`, only when `fbq` exists (the pixel ran: consent,
//     preview guard and blockers all allowed it), and ONCE per id (decision 18: assume Meta does not merge
//     two browser events with one id). Two different ids on one SPA page mirror twice.
//   - Only `Lead`, `CompleteRegistration`, `StartTrial`, `Subscribe` and server-confirmed
//     `InitiateCheckout` (decision 16 + 2026-10-08 correction). `Purchase` is REFUSED: a purchase
//     reaches Meta from the payment webhook only, never as a browser event.
//   - The id is used VERBATIM as `eventID`. Custom data is empty: no value, no contact data, never `ph`.
//   - It fires on the INSTALLED pixel only (§3z.10, B16): the managed helper bakes the chosen pixel id (the
//     keys step's choice = the relay's binding) and calls `fbq('trackSingle', <pixel>, name, {}, {eventID})`,
//     so a page with several pixels never sends a conversion to one the relay does not pair. With no baked
//     pixel the mirror fires NOTHING.
//   - `identity` ({ email, externalId }) is handed to `window.infiniteMetaAdvancedMatch` when the site
//     opted into Manual Advanced Matching; the hashing lives there and nowhere else.
//   - ALWAYS returns a Promise and NEVER rejects. The caller awaits it before navigating. The budget
//     (default and maximum 400 ms) bounds the whole thing — the identity hash AND, with
//     `wait: "request"` (the default), the `/tr` request completing — because the visitor's next page
//     must never wait on Meta. A long landing URL makes fbevents send a hidden-form POST to `/tr/` with no
//     query; that request cannot be recognised, so the budget releases the page at 400 ms, never earlier.
//   - Consent: the Infinite hook for the site's consent mode at call time, plus the optional `gate`.
//
// Plain ES5 source, free of backticks, `${` and `</`, folded into the managed helper script.
import { consentAllowsSource, type MetaBrowserGate } from "./consent.js"

/** The global the mirror defines. */
export const META_MIRROR_GLOBAL = "infiniteMetaMirror"

/** The Meta standard events a browser twin may carry (decision 16). `Purchase` is server-only. */
export const META_MIRROR_EVENTS = ["Lead", "CompleteRegistration", "StartTrial", "Subscribe", "InitiateCheckout"] as const

/** The default AND the longest a mirror holds the page, in ms. */
export const META_MIRROR_BUDGET_MS = 400

export interface MetaMirrorScriptOptions {
  /** The consent hook. infinite-tag always passes the Infinite hook for the site's consent mode. */
  gate?: MetaBrowserGate
  /** The chosen pixel (15–16 digits), baked in. Absent or invalid → the mirror fires nothing (B16). */
  pixelId?: string | null
}

const PIXEL_ID = /^[0-9]{15,16}$/

export function buildMetaMirrorScript(options: MetaMirrorScriptOptions = {}): string {
  const gate = options.gate ?? { kind: "none" }
  const pixel = typeof options.pixelId === "string" && PIXEL_ID.test(options.pixelId) ? options.pixelId : null
  return [
    "(function () {",
    `  if (typeof window.${META_MIRROR_GLOBAL} === "function") return;`,
    ...consentAllowsSource(gate)
      .split("\n")
      .map((line) => `  ${line}`),
    `  var ALLOWED = ${JSON.stringify(META_MIRROR_EVENTS)};`,
    `  var BUDGET_MS = ${META_MIRROR_BUDGET_MS};`,
    `  var PIXEL = ${JSON.stringify(pixel)};`,
    "  var mirrored = {};",
    "  // THIS event's request: facebook.com (or a subdomain), path /tr, ev and eid both matching.",
    "  function isThisRequest(resource, eventName, eventId) {",
    "    try {",
    "      var url = new URL(String(resource));",
    "      if (url.hostname !== 'facebook.com' && url.hostname.slice(-13) !== '.facebook.com') return false;",
    "      if (url.pathname.indexOf('/tr') !== 0) return false;",
    "      return url.searchParams.get('ev') === eventName && url.searchParams.get('eid') === eventId && url.searchParams.get('id') === PIXEL;",
    "    } catch (_error) { return false; }",
    "  }",
    `  window.${META_MIRROR_GLOBAL} = function (metaEventName, metaEventId, options) {`,
    "    var nothing = Promise.resolve();",
    "    try {",
    "      var opts = options || {};",
    "      if (typeof metaEventId !== 'string' || metaEventId.length === 0) return nothing;",
    "      // No pixel was baked in: there is no installed pixel the relay pairs with, so nothing is mirrored.",
    "      if (PIXEL === null) return nothing;",
    "      if (typeof metaEventName !== 'string' || ALLOWED.indexOf(metaEventName) === -1) return nothing;",
    "      if (!infiniteConsentAllows()) return nothing;",
    "      if (typeof opts.gate === 'function') {",
    "        try { if (opts.gate() !== true) return nothing; } catch (_error) { return nothing; }",
    "      }",
    "      // No pixel, or the inert stand-in a silenced host (a preview) gets: nothing to mirror.",
    "      if (typeof window.fbq !== 'function' || window.fbq.__infiniteSilenced === true) return nothing;",
    "      if (Object.prototype.hasOwnProperty.call(mirrored, metaEventId)) return nothing;",
    "      mirrored[metaEventId] = true;",
    "      var budgetMs = typeof opts.budgetMs === 'number' && opts.budgetMs >= 0 && opts.budgetMs <= BUDGET_MS ? opts.budgetMs : BUDGET_MS;",
    "      var waitForRequest = opts.wait !== 'none';",
    "      return new Promise(function (resolve) {",
    "        var settled = false, fired = false, observer = null, budget = 0;",
    "        function release() {",
    "          if (settled) return;",
    "          settled = true;",
    "          clearTimeout(budget);",
    "          try { if (observer) observer.disconnect(); } catch (_error) {}",
    "          resolve();",
    "        }",
    "        function fire() {",
    "          if (fired) return;",
    "          fired = true;",
    "          // Registered BEFORE the call, so the report of a fast request cannot be missed.",
    "          if (waitForRequest && !settled) {",
    "            try {",
    "              if (typeof PerformanceObserver === 'function') {",
    "                observer = new PerformanceObserver(function (list) {",
    "                  var entries = list.getEntries();",
    "                  for (var index = 0; index < entries.length; index += 1) {",
    "                    if (isThisRequest(entries[index].name, metaEventName, metaEventId)) release();",
    "                  }",
    "                });",
    "                observer.observe({ type: 'resource' });",
    "              }",
    "            } catch (_error) { observer = null; }",
    "          }",
    "          try { window.fbq('trackSingle', PIXEL, metaEventName, {}, { eventID: metaEventId }); } catch (_error) { release(); return; }",
    "          if (!waitForRequest) release();",
    "        }",
    "        budget = setTimeout(function () { fire(); release(); }, budgetMs);",
    "        var match = window.infiniteMetaAdvancedMatch;",
    "        if (opts.identity && typeof match === 'function') {",
    "          try { Promise.resolve(match(opts.identity)).then(fire, fire); } catch (_error) { fire(); }",
    "        } else {",
    "          fire();",
    "        }",
    "      });",
    "    } catch (_error) { return nothing; }",
    "  };",
    "})();"
  ].join("\n")
}
