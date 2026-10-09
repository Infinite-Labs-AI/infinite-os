// `window.infiniteTrack(name, props?, { gate?, destinations?, metaEventName? })` — one named browser
// event to the safe destinations that are live on this page (§3j.6). `destinations: ["meta"]` (a list) sends to
// exactly the tools named, so an agent adds ONLY the tools a call site is missing (review P0-5 / P1-7).
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
//   - Meta ViewContent / AddToCart carry Meta's content keys and nothing else (content_ids, content_name,
//     content_type "product", contents [{ id, quantity, item_price }], value, currency), with the currency the
//     caller passed or the site's own (baked in from the plan); a value never goes without a currency.
//   - Infinite's ledger gets the event name only (`site_click` cta_id + cta_location): the cloud's browser ingest
//     rejects any other key on a click (review P0-3).
//   - Meta server-twin conversions (Purchase, Lead, CompleteRegistration, StartTrial, Subscribe and
//     server-reported InitiateCheckout) are NEVER fired here. They go server first, then through
//     `infiniteMetaMirror` with the id the server returned. Browser-only Meta events such as AddToCart,
//     ViewContent and explicit custom CTA events carry NO eventID.
//   - A browser-only Meta event that finds no `fbq` yet (the site's own, often consent-gated, pixel starts in the
//     app shell's effect, which runs AFTER a page component's effect) is held for at most 10 s and sent once when
//     the site's pixel exists AND the call-time check says yes at that moment. Never sent after a refusal, never
//     on a silenced preview pixel, and `fbq` is never created by the tag.
//
// Plain ES5 source, free of backticks, `${` and `</`. These fragments are assembled into one helper
// script by `./globals.ts`, which supplies `infiniteConsentAllows` and `infiniteUnsafeText`.
import { GA4_LANE_MARKER } from "../providers/ga4.js"
import { INFINITE_CONSENT_EVENT } from "../providers/meta-browser/consent.js"

/** The event-name rule every helper applies. */
export const INFINITE_EVENT_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** At most this many properties ride on one event. */
export const INFINITE_MAX_PROPS = 16

/** ISO 4217, as Meta and GA4 take it. */
export const INFINITE_CURRENCY_PATTERN = /^[A-Z]{3}$/

/** The facts the helper script bakes in. Both come from the approved plan's artifacts, never from the page. */
export interface HelperCoreOptions {
  /**
   * The site's currency (ISO 4217): the default for a product event whose caller passes none. Meta and GA4 both need
   * a currency beside a value, so a value is never sent without one: with neither a passed nor a site currency, the
   * product event goes out with its products and no value.
   */
  currency?: string | null
  /** The chosen Meta pixel: the `/tr` request a navigation waits for must be this pixel's. Absent = any pixel's. */
  metaPixelId?: string | null
}

/**
 * The shared private functions every helper uses: the name rule, the property bounds, the OAuth-return
 * check and the call-time permission check.
 */
export function helperCoreSource(options: HelperCoreOptions = {}): string {
  const currency = typeof options.currency === "string" && INFINITE_CURRENCY_PATTERN.test(options.currency) ? options.currency : null
  const pixel = typeof options.metaPixelId === "string" && /^[0-9]{15,16}$/.test(options.metaPixelId) ? options.metaPixelId : null
  return [
    `var INFINITE_SITE_CURRENCY = ${JSON.stringify(currency)};`,
    `var INFINITE_META_PIXEL = ${JSON.stringify(pixel)};`,
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
    "}",
    "function infiniteFirstString(source, keys) {",
    "  for (var index = 0; index < keys.length; index += 1) {",
    "    var value = source[keys[index]];",
    "    if (typeof value === 'string' && value.length > 0) return value;",
    "  }",
    "  return null;",
    "}",
    "function infiniteNumber(source, key) {",
    "  var value = source[key];",
    "  return typeof value === 'number' && isFinite(value) ? value : null;",
    "}",
    "function infiniteCommerceItem(clean) {",
    "  var id = infiniteFirstString(clean, ['item_id', 'product_id', 'sku', 'content_id']);",
    "  if (!id) return null;",
    "  var quantity = infiniteNumber(clean, 'quantity');",
    "  if (quantity === null || quantity <= 0) quantity = 1;",
    "  var price = infiniteNumber(clean, 'price');",
    "  if (price === null) price = infiniteNumber(clean, 'item_price');",
    "  var name = infiniteFirstString(clean, ['item_name', 'product_name', 'content_name']);",
    "  return { id: id, name: name, price: price, quantity: quantity };",
    "}",
    "function infiniteCommerceEvent(name) {",
    "  var lower = String(name).toLowerCase();",
    "  return lower === 'add_to_cart' || lower === 'addtocart' || lower === 'view_content' || lower === 'viewcontent' || lower === 'view_item' || lower === 'begin_checkout' || lower === 'initiate_checkout' || lower === 'checkout';",
    "}",
    "// The currency a product event carries: the caller's (ISO 4217, any case), else the site's.",
    "function infiniteCurrency(clean) {",
    "  var passed = typeof clean.currency === 'string' ? clean.currency.toUpperCase() : '';",
    "  if (/^[A-Z]{3}$/.test(passed)) return passed;",
    "  return INFINITE_SITE_CURRENCY;",
    "}",
    "// The money a product event carries: the caller's value, else price x quantity; null when neither is known.",
    "function infiniteValue(clean, item) {",
    "  var value = infiniteNumber(clean, 'value');",
    "  if (value !== null) return value;",
    "  return item && item.price !== null ? item.price * item.quantity : null;",
    "}",
    "function infiniteGa4Props(name, clean) {",
    "  var params = infiniteCopy(clean);",
    "  var item = infiniteCommerceEvent(name) ? infiniteCommerceItem(clean) : null;",
    "  if (item) {",
    "    var ga4Item = { item_id: item.id, quantity: item.quantity };",
    "    if (item.name) ga4Item.item_name = item.name;",
    "    if (item.price !== null) ga4Item.price = item.price;",
    "    params.items = [ga4Item];",
    "  }",
    "  if (infiniteCommerceEvent(name)) {",
    "    // GA4 ignores a value without a currency: a value rides only beside one, never alone.",
    "    var ga4Value = infiniteValue(clean, item), ga4Currency = infiniteCurrency(clean);",
    "    delete params.value;",
    "    delete params.currency;",
    "    if (ga4Value !== null && ga4Currency !== null) { params.value = ga4Value; params.currency = ga4Currency; }",
    "  }",
    "  return params;",
    "}",
    "// Meta ViewContent / AddToCart carry EXACTLY Meta's content keys, and nothing the caller passed under any other",
    "// name: content_ids, content_name, content_type 'product', contents [{ id, quantity, item_price }], value and",
    "// currency. A value goes only beside a currency. Never an eventID: a browser-only event has no server twin.",
    "function infiniteMetaProps(metaName, clean) {",
    "  if (metaName !== 'AddToCart' && metaName !== 'ViewContent') return infiniteCopy(clean);",
    "  var params = {};",
    "  var item = infiniteCommerceItem(clean);",
    "  if (item) {",
    "    params.content_ids = [item.id];",
    "    if (item.name) params.content_name = item.name;",
    "    params.content_type = 'product';",
    "    var metaItem = { id: item.id, quantity: item.quantity };",
    "    if (item.price !== null) metaItem.item_price = item.price;",
    "    params.contents = [metaItem];",
    "  }",
    "  var value = infiniteValue(clean, item), currency = infiniteCurrency(clean);",
    "  if (value !== null && currency !== null) { params.value = value; params.currency = currency; }",
    "  return params;",
    "}",
    "// destinations names the tools to send to. A list sends to exactly those (['meta'] = Meta only); an object turns",
    "// single tools off ({ ga4: false }) or a custom Meta event on ({ meta: true }). Absent = every live tool.",
    "function infiniteDestinationAllowed(options, tool, defaultValue) {",
    "  var destinations = options && typeof options === 'object' ? (options.destinations || options.tools) : null;",
    "  if (!destinations || typeof destinations !== 'object') return defaultValue;",
    "  if (Object.prototype.toString.call(destinations) === '[object Array]') return destinations.indexOf(tool) !== -1;",
    "  if (!Object.prototype.hasOwnProperty.call(destinations, tool)) return defaultValue;",
    "  return destinations[tool] !== false;",
    "}",
    "function infiniteDestinationNamed(options, tool) {",
    "  var destinations = options && typeof options === 'object' ? (options.destinations || options.tools) : null;",
    "  if (!destinations || typeof destinations !== 'object') return false;",
    "  if (Object.prototype.toString.call(destinations) === '[object Array]') return destinations.indexOf(tool) !== -1;",
    "  return destinations[tool] === true;",
    "}",
    "var INFINITE_META_SERVER_TWIN = { Purchase: true, Lead: true, CompleteRegistration: true, StartTrial: true, Subscribe: true, InitiateCheckout: true };",
    "var INFINITE_META_SERVER_TWIN_NAME = { purchase: true, lead: true, sign_up: true, signup: true, complete_registration: true, start_trial: true, trial: true, subscribe: true, begin_checkout: true, initiate_checkout: true, checkout: true };",
    "function infiniteMetaBrowserEvent(name, options) {",
    "  var explicit = options && typeof options === 'object' ? options.metaEventName : null;",
    "  if (typeof explicit === 'string' && INFINITE_EVENT_NAME.test(explicit)) {",
    "    if (INFINITE_META_SERVER_TWIN[explicit]) return null;",
    "    if (explicit === 'AddToCart' || explicit === 'ViewContent') return { method: 'track', name: explicit };",
    "    return { method: 'trackCustom', name: explicit };",
    "  }",
    "  var lower = String(name).toLowerCase();",
    "  if (lower === 'add_to_cart' || lower === 'addtocart') return { method: 'track', name: 'AddToCart' };",
    "  if (lower === 'view_content' || lower === 'viewcontent' || lower === 'view_item') return { method: 'track', name: 'ViewContent' };",
    "  if (INFINITE_META_SERVER_TWIN_NAME[lower]) return null;",
    "  if (infiniteDestinationNamed(options, 'meta')) return { method: 'trackCustom', name: name };",
    "  return null;",
    "}",
    "function infiniteIsMetaRequest(resource, eventName) {",
    "  try {",
    "    var url = new URL(String(resource));",
    "    if (url.hostname !== 'facebook.com' && url.hostname.slice(-13) !== '.facebook.com') return false;",
    "    if (url.pathname.indexOf('/tr') !== 0) return false;",
    "    if (INFINITE_META_PIXEL !== null && url.searchParams.get('id') !== INFINITE_META_PIXEL) return false;",
    "    return url.searchParams.get('ev') === eventName;",
    "  } catch (_error) { return false; }",
    "}",
    "function infiniteMetaWaiter(eventName, budgetMs) {",
    "  var timeout = typeof budgetMs === 'number' && budgetMs >= 0 && budgetMs <= 400 ? budgetMs : 400;",
    "  var release = function () {};",
    "  var promise = new Promise(function (resolve) {",
    "    var settled = false, observer = null, timer = 0;",
    "    release = function () {",
    "      if (settled) return;",
    "      settled = true;",
    "      clearTimeout(timer);",
    "      try { if (observer) observer.disconnect(); } catch (_error) {}",
    "      resolve();",
    "    };",
    "    try {",
    "      if (typeof PerformanceObserver === 'function') {",
    "        observer = new PerformanceObserver(function (list) {",
    "          var entries = list.getEntries();",
    "          for (var index = 0; index < entries.length; index += 1) if (infiniteIsMetaRequest(entries[index].name, eventName)) release();",
    "        });",
    "        observer.observe({ type: 'resource' });",
    "      }",
    "    } catch (_error) { observer = null; }",
    "    timer = setTimeout(release, timeout);",
    "  });",
    "  return { promise: promise, release: release };",
    "}",
    "// The site's own Meta pixel can start AFTER the call: a page component's effect runs before the app shell's effect",
    "// that starts the site's (often consent-gated) pixel, so a ViewContent sent on page load found no fbq and was lost.",
    "// A browser-only Meta event that finds no fbq is HELD instead: checked every INFINITE_META_POLL_MS, for at most",
    "// INFINITE_META_HOLD_MS, at most INFINITE_META_HOLD_MAX at a time. It goes ONCE, when the site's own fbq exists and",
    "// the same check a call makes (the tag's consent hook, so in follow mode 'the site's pixels are running'; the",
    "// caller's gate; no OAuth return) says yes at that moment. A refusal meanwhile drops every held event, a silenced",
    "// preview pixel drops them, and a pixel that never starts lets them expire. fbq is never created or stubbed here.",
    "var INFINITE_META_HOLD_MS = 10000, INFINITE_META_POLL_MS = 200, INFINITE_META_HOLD_MAX = 20;",
    "var infiniteMetaHeld = [], infiniteMetaPolling = false, infiniteMetaRefusalHeard = false;",
    "function infiniteFlushHeldMeta() {",
    "  var pending = infiniteMetaHeld, now = Date.now(), pixel = window.fbq;",
    "  infiniteMetaHeld = [];",
    "  for (var index = 0; index < pending.length; index += 1) {",
    "    var held = pending[index];",
    "    if (typeof pixel === 'function') {",
    "      if (pixel.__infiniteSilenced === true) continue;",
    "      var allowed = false;",
    "      try { allowed = infiniteMayTrack(held.options); } catch (_error) { allowed = false; }",
    "      if (allowed) {",
    "        try { pixel(held.method, held.name, held.params); } catch (_error) {}",
    "        continue;",
    "      }",
    "    }",
    "    if (now - held.at < INFINITE_META_HOLD_MS) infiniteMetaHeld.push(held);",
    "  }",
    "  infiniteMetaPolling = infiniteMetaHeld.length > 0;",
    "  if (infiniteMetaPolling) setTimeout(infiniteFlushHeldMeta, INFINITE_META_POLL_MS);",
    "}",
    "function infiniteHoldMeta(meta, clean, options) {",
    "  if (infiniteMetaHeld.length >= INFINITE_META_HOLD_MAX) return false;",
    "  infiniteMetaHeld.push({ method: meta.method, name: meta.name, params: infiniteMetaProps(meta.name, clean), options: options, at: Date.now() });",
    "  if (!infiniteMetaRefusalHeard) {",
    "    infiniteMetaRefusalHeard = true;",
    "    try {",
    `      window.addEventListener('${INFINITE_CONSENT_EVENT}', function (event) {`,
    "        if (event && event.detail && event.detail.granted === false) infiniteMetaHeld = [];",
    "      });",
    "    } catch (_error) {}",
    "  }",
    "  if (!infiniteMetaPolling) {",
    "    infiniteMetaPolling = true;",
    "    setTimeout(infiniteFlushHeldMeta, INFINITE_META_POLL_MS);",
    "  }",
    "  return true;",
    "}",
    "// A call the tag's consent hook said no to: the only no that can still turn into a yes is 'the site's own pixels",
    "// have not started yet' (follow mode, before the app shell's effect), so Meta's send is held for the site's pixel",
    "// and re-checked when it starts. A pixel that is already running means the visitor's no is real: nothing is held.",
    "function infiniteHoldMetaUntilAllowed(name, clean, options) {",
    "  try {",
    "    if (typeof window.fbq === 'function') return;",
    "    if (options && typeof options.gate === 'function') { if (options.gate() !== true) return; }",
    "    if (infiniteOauthReturn() || !infiniteDestinationAllowed(options, 'meta', true)) return;",
    "    var meta = infiniteMetaBrowserEvent(name, options);",
    "    if (meta) infiniteHoldMeta(meta, clean, options);",
    "  } catch (_error) {}",
    "}",
    "function infiniteSendMetaBrowserEvent(name, clean, options, wait) {",
    "  if (!infiniteDestinationAllowed(options, 'meta', true)) return { sent: false, wait: null };",
    "  var meta = infiniteMetaBrowserEvent(name, options);",
    "  if (!meta) return { sent: false, wait: null };",
    "  var budget = options && typeof options === 'object' ? options.budgetMs : undefined;",
    "  if (typeof window.fbq !== 'function') {",
    "    // Held for the site's pixel. A caller about to leave waits no longer than it would for a sent event.",
    "    if (!infiniteHoldMeta(meta, clean, options)) return { sent: false, wait: null };",
    "    return { sent: false, wait: wait ? infiniteMetaWaiter(meta.name, budget).promise : null };",
    "  }",
    "  if (window.fbq.__infiniteSilenced === true) return { sent: false, wait: null };",
    "  var watcher = wait ? infiniteMetaWaiter(meta.name, budget) : null;",
    "  try { window.fbq(meta.method, meta.name, infiniteMetaProps(meta.name, clean)); } catch (_error) { if (watcher) watcher.release(); return { sent: false, wait: null }; }",
    "  return { sent: true, wait: watcher ? watcher.promise : null };",
    "}",
    "// Infinite's ledger gets the event NAME only: its browser ingest accepts no product or money keys on a click",
    "// (review P0-3). Money reaches Infinite from the server lane.",
    "function infiniteRecordEvent(name, options) {",
    "  if (!infiniteDestinationAllowed(options, 'infinite', true)) return false;",
    "  try {",
    "    var record = window.__infiniteRecordEvent;",
    "    return typeof record === 'function' && record(name) === true;",
    "  } catch (_error) { return false; }",
    "}",
    "// The 'visitor allowed tracking' signal a page passes to its own API routes (ad_match=1 / adMatch: true), so its",
    "// server attaches Meta match data. The tag's own decision, live; false wherever the tag is not running.",
    "window.infiniteAdMatchAllowed = function () {",
    "  try {",
    "    var allowed = window.__infiniteAdMatchAllowed;",
    "    return typeof allowed === 'function' && allowed() === true;",
    "  } catch (_error) { return false; }",
    "};"
  ].join("\n")
}

/**
 * `window.infiniteTrack`. Returns true when at least one tool's function ACCEPTED the call. That is not
 * "sent": on a silenced preview PostHog's methods only queue in memory and gtag only pushes to a
 * dataLayer nothing reads, so it returns true while nothing leaves the page. Proof of delivery is the
 * wizard's receipts, never this value.
 */
export function trackSource(): string {
  return [
    "window.infiniteTrack = function (name, props, options) {",
    "  try {",
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name)) return false;",
    "    if (!infiniteMayTrack(options)) { infiniteHoldMetaUntilAllowed(name, infiniteCleanProps(props), options); return false; }",
    "    var clean = infiniteCleanProps(props), sent = false;",
    "    try {",
    "      if (infiniteDestinationAllowed(options, 'posthog', true) && window.posthog && typeof window.posthog.capture === 'function') { window.posthog.capture(name, infiniteCopy(clean)); sent = true; }",
    "    } catch (_error) {}",
    "    try {",
    "      if (infiniteDestinationAllowed(options, 'ga4', true) && typeof window.gtag === 'function') {",
    "        var params = infiniteGa4Props(name, clean);",
    `        var lane = window.${GA4_LANE_MARKER};`,
    "        if (lane && typeof lane.id === 'string') params.send_to = lane.id;",
    "        window.gtag('event', name, params);",
    "        sent = true;",
    "      }",
    "    } catch (_error) {}",
    "    if (infiniteRecordEvent(name, options)) sent = true;",
    "    if (infiniteSendMetaBrowserEvent(name, clean, options, false).sent) sent = true;",
    "    return sent;",
    "  } catch (_error) { return false; }",
    "};"
  ].join("\n")
}

/**
 * `window.infiniteTrackBeforeLeaving(name, props?, options?)`: the same sends as `infiniteTrack`, and a promise that
 * settles once they are safe from a full page load (P1-A, the reference store's `trackMetaEventBeforeLeaving`): Meta's
 * `/tr` request for this event was seen (at most 400 ms), and GA4's hit is out when GA4 started on this page (at most
 * 1 s). It settles at once when nothing needs waiting for, and never rejects. The site's own helper returns it, so a
 * caller that leaves with a full page load waits for it (`infiniteLeaveAfter`); a caller that routes on the client
 * ignores it.
 */
export function trackBeforeLeavingSource(): string {
  return [
    "window.infiniteTrackBeforeLeaving = function (name, props, options) {",
    "  var waits = [];",
    "  try {",
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name)) return Promise.resolve();",
    "    // Not allowed yet: Meta's send may be held for the site's pixel, and the caller does not wait for it.",
    "    if (!infiniteMayTrack(options)) { infiniteHoldMetaUntilAllowed(name, infiniteCleanProps(props), options); return Promise.resolve(); }",
    "    var clean = infiniteCleanProps(props);",
    "    try { if (infiniteDestinationAllowed(options, 'posthog', true) && window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture(name, infiniteCopy(clean)); } catch (_error) {}",
    "    infiniteRecordEvent(name, options);",
    "    if (infiniteDestinationAllowed(options, 'ga4', true) && typeof window.gtag === 'function') {",
    "      var params = infiniteGa4Props(name, clean);",
    `      var lane = window.${GA4_LANE_MARKER};`,
    "      var ours = !!(lane && typeof lane.id === 'string');",
    "      if (ours) params.send_to = lane.id;",
    "      // Only a GA4 that really started calls back (an adopted stub with no loader never does: F15).",
    "      if (ours || !!(window.google_tag_manager && typeof window.google_tag_manager === 'object')) {",
    "        waits.push(new Promise(function (resolve) {",
    "          params.event_callback = resolve;",
    "          params.event_timeout = 1000;",
    "          setTimeout(resolve, 1000);",
    "        }));",
    "      }",
    "      try { window.gtag('event', name, params); } catch (_error) {}",
    "    }",
    "    var meta = infiniteSendMetaBrowserEvent(name, clean, options, true);",
    "    if (meta.wait) waits.push(meta.wait);",
    "  } catch (_error) {}",
    "  return Promise.all(waits).then(function () {}, function () {});",
    "};"
  ].join("\n")
}
