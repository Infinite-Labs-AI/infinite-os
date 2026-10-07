// The consent hook the managed Meta browser helpers share.
//
// THIS IS NOT A CONSENT GATE AND NOT A BANNER. Infinite never adds, changes or checks a cookie
// banner. It records this run's `consent_mode` and accepts the owner's explicit yes/no signal. infinite.fast wraps every Meta byte in its own
// `__infiniteConsentGate`, which is part of its banner and is deliberately NOT ported here. What the
// helpers take instead is an OPTIONAL hook: by default they run whenever the pixel itself runs, and
// the one built-in hook reads Infinite's decision, not an arbitrary site's banner state.
//
// TWO STRENGTHS (`privacySignal`): the Meta helpers and the campaign capture treat DNT/GPC without a
// grant as no; the GA4/PostHog conversion helpers do not, because GA4's and PostHog's own page views do
// not either, and a conversion dropped for a GPC browser whose page view still counted would read as a
// funnel problem. Both honour the visitor's recorded decision and required mode.
//
// THE RUNTIME'S OWN CHECK FIRST. `runtime/infinite-browser.ts` decides consent in `hasConsent()` and,
// on a verified production host, exposes it as `window.__infiniteConsentAllowed()` (the Phase-1
// open question, closed by the wizard build). When that accessor exists the hook asks it, so the
// helpers see exactly what the runtime sees: its in-memory decision when storage is blocked, and the
// configured storage key under `required` mode.
//
// WHERE THE RUNTIME DOES NOT RUN (a preview host, a site with no Infinite source) the hook falls back to
// the same three lines, in the same order, over what the runtime would have PERSISTED:
//   1. an explicit decision the visitor made on this site (`infinite_analytics_consent` in
//      localStorage, written after a recent gesture by the runtime or the capture-only listener) wins;
//   2. otherwise a DNT / GPC signal means no;
//   3. otherwise `not_required` means yes and `required` means no.
// The fallback can only ever be stricter than the runtime, never looser.

/** How a managed Meta helper decides whether it may act. */
export type MetaBrowserGate =
  /** Runs whenever the pixel runs. The pixel itself is not consent-gated by infinite-tag. */
  | { kind: "none" }
  /**
   * Follows the Infinite runtime's recorded consent decision for this consent mode. `privacySignal`:
   * "blocks" (default) = DNT/GPC without a grant means no (the Meta helpers, the campaign capture);
   * "ignored" = only the recorded decision and the consent mode decide (the GA4/PostHog conversion
   * helpers, whose providers' own page views do not follow DNT/GPC either — a stricter helper would
   * skew conversion rates by browser).
   */
  | { kind: "infinite-consent"; mode: "required" | "not_required"; privacySignal?: "blocks" | "ignored" }

/** The localStorage key the runtime writes its decision under, in both consent modes. */
export const INFINITE_CONSENT_STORAGE_KEY = "infinite_analytics_consent"

/**
 * The runtime's own consent check, exposed on verified production hosts. Every managed helper asks it
 * first. The name is mirrored in `runtime/infinite-browser.ts`, which cannot import it (it ships through
 * `Function.prototype.toString()`); `infinite-browser.test.ts` pins the two together.
 */
export const INFINITE_CONSENT_ACCESSOR = "__infiniteConsentAllowed"

/** The event the site's own consent UI dispatches; the runtime persists the decision it carries. */
export const INFINITE_CONSENT_EVENT = "infinite:analytics-consent-change"

/** The capture can be installed without Infinite's tag. Only our own decision key is written. */
export function captureConsentDecisionSource(gate: MetaBrowserGate): string {
  if (gate.kind === "none") return ""
  return [
    "var lastConsentGestureAt = 0;",
    "function recordConsentGesture() { lastConsentGestureAt = Date.now(); }",
    "try {",
    'document.addEventListener("pointerdown", recordConsentGesture, true);',
    'document.addEventListener("keydown", recordConsentGesture, true);',
    `window.addEventListener("${INFINITE_CONSENT_EVENT}", function () {`,
    "  var event = arguments[0];",
    // Infinite owns the decision whenever its runtime is present, including its in-memory fallback.
    `  if (typeof window.${INFINITE_CONSENT_ACCESSOR} === "function") return;`,
    "  if (!lastConsentGestureAt || Date.now() - lastConsentGestureAt > 10000) return;",
    '  if (!event || !event.detail || typeof event.detail.granted !== "boolean") return;',
    `  try { localStorage.setItem("${INFINITE_CONSENT_STORAGE_KEY}", event.detail.granted ? "granted" : "denied"); } catch (_error) {}`,
    "});",
    "} catch (_error) {}"
  ].join("\n")
}

/**
 * Browser source for `function infiniteConsentAllows()` under the given gate. Plain ES5 with no
 * backticks, no `${` and no `</`, so it can sit in an HTML `<script>` and in the Next module's
 * string literal alike.
 */
export function consentAllowsSource(gate: MetaBrowserGate): string {
  if (gate.kind === "none") {
    return "function infiniteConsentAllows() { return true; }"
  }
  const fallback = gate.mode === "not_required" ? "true" : "false"
  const ignoreSignal = gate.privacySignal === "ignored"
  return [
    "function infiniteConsentAllows() {",
    "  try {",
    `    if (typeof window.${INFINITE_CONSENT_ACCESSOR} === "function") return window.${INFINITE_CONSENT_ACCESSOR}(${ignoreSignal ? "{ privacySignal: false }" : ""}) === true;`,
    "  } catch (_error) { return false; }",
    "  var decision = null;",
    `  try { decision = localStorage.getItem("${INFINITE_CONSENT_STORAGE_KEY}"); } catch (_error) { decision = null; }`,
    '  if (decision === "granted") return true;',
    '  if (decision === "denied") return false;',
    ...(ignoreSignal
      ? []
      : [
          "  try {",
          '    if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true) return false;',
          "  } catch (_error) { return false; }"
        ]),
    `  return ${fallback};`,
    "}"
  ].join("\n")
}

/**
 * Browser source for `function infiniteConsentGate(start)`: runs `start` once, now or after a later
 * grant. Under the Infinite hook a grant is noticed through the runtime's consent event and then
 * re-read from storage a tick later — so only a decision the runtime accepted (gesture-checked) and
 * persisted can open it, and the order in which the two listeners run does not matter.
 */
export function consentGateSource(gate: MetaBrowserGate): string {
  if (gate.kind === "none") {
    return "function infiniteConsentGate(start) { start(); }"
  }
  return [
    "function infiniteConsentGate(start) {",
    "  if (infiniteConsentAllows()) { start(); return; }",
    "  var started = false;",
    "  try {",
    `    window.addEventListener("${INFINITE_CONSENT_EVENT}", function () {`,
    "      setTimeout(function () {",
    "        if (started || !infiniteConsentAllows()) return;",
    "        started = true;",
    "        start();",
    "      }, 0);",
    "    });",
    "  } catch (_error) {}",
    "}"
  ].join("\n")
}
