// The consent hook the managed Meta browser helpers share.
//
// THIS IS NOT A CONSENT GATE AND NOT A BANNER. Infinite never adds, changes or checks a cookie
// banner; it records `consent_mode` and nothing else. infinite.fast wraps every Meta byte in its own
// `__infiniteConsentGate`, which is part of its banner and is deliberately NOT ported here. What the
// helpers take instead is an OPTIONAL hook: by default they run whenever the pixel itself runs, and
// the one built-in hook reads the decision the Infinite runtime already records.
//
// WHY A COPY OF THE RUNTIME'S RULE. `runtime/infinite-browser.ts` decides consent in `hasConsent()`,
// but the runtime ships through `Function.prototype.toString()` and exposes nothing but the handoff
// accessor, so a helper cannot call it. The rule below is the same three lines, in the same order:
//   1. an explicit decision the visitor made on this site (`infinite_analytics_consent` in
//      localStorage, written by the runtime only after a real gesture) wins, in either direction;
//   2. otherwise a DNT / GPC signal means no;
//   3. otherwise `not_required` means yes and `required` means no.
// It reads only what the runtime has already PERSISTED. The runtime's in-memory decision (used when
// storage is unavailable) is invisible here, so a helper can only ever be stricter than the runtime,
// never looser. Exposing the runtime's own check is the open question in the builder note.

/** How a managed Meta helper decides whether it may act. */
export type MetaBrowserGate =
  /** Runs whenever the pixel runs. The pixel itself is not consent-gated by infinite-tag. */
  | { kind: "none" }
  /** Follows the Infinite runtime's recorded consent decision for this consent mode. */
  | { kind: "infinite-consent"; mode: "required" | "not_required" }

/** The localStorage key the runtime writes its decision under, in both consent modes. */
export const INFINITE_CONSENT_STORAGE_KEY = "infinite_analytics_consent"

/** The event the site's own consent UI dispatches; the runtime persists the decision it carries. */
export const INFINITE_CONSENT_EVENT = "infinite:analytics-consent-change"

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
  return [
    "function infiniteConsentAllows() {",
    "  var decision = null;",
    `  try { decision = localStorage.getItem("${INFINITE_CONSENT_STORAGE_KEY}"); } catch (_error) { decision = null; }`,
    '  if (decision === "granted") return true;',
    '  if (decision === "denied") return false;',
    "  try {",
    '    if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true) return false;',
    "  } catch (_error) { return false; }",
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
