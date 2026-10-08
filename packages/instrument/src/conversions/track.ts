// `window.infiniteTrack(name, props?, { gate?, destinations?, metaEventName? })` — one named browser
// event to the safe destinations that are live on this page (§3j.6).
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
//   - Meta server-twin conversions (Purchase, Lead, CompleteRegistration, StartTrial, Subscribe and
//     server-reported InitiateCheckout) are NEVER fired here. They go server first, then through
//     `infiniteMetaMirror` with the id the server returned. Browser-only Meta events such as AddToCart,
//     ViewContent and explicit custom CTA events carry NO eventID.
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
    "function infiniteGa4Props(name, clean) {",
    "  var params = infiniteCopy(clean);",
    "  var item = infiniteCommerceEvent(name) ? infiniteCommerceItem(clean) : null;",
    "  if (item) {",
    "    var ga4Item = { item_id: item.id, quantity: item.quantity };",
    "    if (item.name) ga4Item.item_name = item.name;",
    "    if (item.price !== null) ga4Item.price = item.price;",
    "    params.items = [ga4Item];",
    "    if (params.value === undefined && item.price !== null) params.value = item.price * item.quantity;",
    "  }",
    "  return params;",
    "}",
    "function infiniteMetaProps(metaName, clean) {",
    "  var params = infiniteCopy(clean);",
    "  if (metaName !== 'AddToCart' && metaName !== 'ViewContent') return params;",
    "  var item = infiniteCommerceItem(clean);",
    "  if (!item) return params;",
    "  params.content_ids = [item.id];",
    "  params.content_type = 'product';",
    "  var metaItem = { id: item.id, quantity: item.quantity };",
    "  if (item.price !== null) metaItem.item_price = item.price;",
    "  params.contents = [metaItem];",
    "  if (item.name) params.content_name = item.name;",
    "  if (params.value === undefined && item.price !== null) params.value = item.price * item.quantity;",
    "  return params;",
    "}",
    "function infiniteDestinationAllowed(options, tool, defaultValue) {",
    "  var destinations = options && typeof options === 'object' ? (options.destinations || options.tools) : null;",
    "  if (!destinations || typeof destinations !== 'object') return defaultValue;",
    "  if (!Object.prototype.hasOwnProperty.call(destinations, tool)) return defaultValue;",
    "  return destinations[tool] !== false;",
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
    "  var destinations = options && typeof options === 'object' ? (options.destinations || options.tools) : null;",
    "  if (destinations && typeof destinations === 'object' && destinations.meta === true) return { method: 'trackCustom', name: name };",
    "  return null;",
    "}",
    "function infiniteIsMetaRequest(resource, eventName) {",
    "  try {",
    "    var url = new URL(String(resource));",
    "    if (url.hostname !== 'facebook.com' && url.hostname.slice(-13) !== '.facebook.com') return false;",
    "    if (url.pathname.indexOf('/tr') !== 0) return false;",
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
    "function infiniteSendMetaBrowserEvent(name, clean, options, wait) {",
    "  if (!infiniteDestinationAllowed(options, 'meta', true)) return { sent: false, wait: null };",
    "  var meta = infiniteMetaBrowserEvent(name, options);",
    "  if (!meta || typeof window.fbq !== 'function' || window.fbq.__infiniteSilenced === true) return { sent: false, wait: null };",
    "  var watcher = wait ? infiniteMetaWaiter(meta.name, options && typeof options === 'object' ? options.budgetMs : undefined) : null;",
    "  try { window.fbq(meta.method, meta.name, infiniteMetaProps(meta.name, clean)); } catch (_error) { if (watcher) watcher.release(); return { sent: false, wait: null }; }",
    "  return { sent: true, wait: watcher ? watcher.promise : null };",
    "}",
    "function infiniteRecordEvent(name, clean, options) {",
    "  if (!infiniteDestinationAllowed(options, 'infinite', true)) return false;",
    "  try {",
    "    var record = window.__infiniteRecordEvent;",
    "    return typeof record === 'function' && record(name, infiniteCopy(clean)) === true;",
    "  } catch (_error) { return false; }",
    "}"
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
    "    if (typeof name !== 'string' || !INFINITE_EVENT_NAME.test(name) || !infiniteMayTrack(options)) return false;",
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
    "    if (infiniteRecordEvent(name, clean, options)) sent = true;",
    "    if (infiniteSendMetaBrowserEvent(name, clean, options, false).sent) sent = true;",
    "    return sent;",
    "  } catch (_error) { return false; }",
    "};"
  ].join("\n")
}
