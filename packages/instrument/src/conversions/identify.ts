// `window.infiniteIdentify(id)` and `window.infiniteReset()` — join and split a person's PostHog
// history (§3j.6, agent job 9).
//
// Source: `identifyUser`, infinite-site `get-started/index.html` L308-314 @ 9f65b47 (PostHog only, after
// consent). infinite.fast accepts only its own profile UUIDs; a customer's site has its own id scheme,
// so the rule is generalised to "any stable id that is not personal data":
//   - a string of 1-128 characters with no whitespace;
//   - never email-shaped (an `@` anywhere): an email is personal data, not an id;
//   - never a URL (`://`) or a query fragment (`=`, `?`, `&`).
// Anything else is refused and nothing is sent. The scrubber's phone rule is deliberately NOT applied:
// a numeric account id (`10293847`) is the commonest id there is, and it is indistinguishable from a
// run of phone digits.
//
// PostHog `identify` only. GA4 `user_id` is NOT set: infinite.fast never sets it, and GA4's user-id
// policy is a separate decision (scout S5 open question 4). Meta identity goes only through
// `window.infiniteMetaAdvancedMatch`.
//
// Consent is checked at call time, as for every helper, and the OAuth-return rule applies too: PostHog's
// `$identify` event carries the current URL, so call it once the return URL is cleaned.
//
// `infiniteReset()` is PostHog `reset()` behind an existence check, for a sign-out. It needs no consent:
// forgetting a person is always allowed. infinite.fast has no sign-out, so this has no exemplar test;
// `conversions.test.ts` covers it, including the page with no PostHog at all.
//
// Plain ES5 source, free of backticks, `${` and `</`; assembled by `./globals.ts`.

/** The longest id `infiniteIdentify` accepts. */
export const INFINITE_IDENTIFY_MAX_LENGTH = 128

export function identifySource(): string {
  return [
    "window.infiniteIdentify = function (id) {",
    "  try {",
    `    if (typeof id !== 'string' || id.length === 0 || id.length > ${INFINITE_IDENTIFY_MAX_LENGTH}) return false;`,
    "    if (/[\\s@=?&]/.test(id) || id.indexOf('://') !== -1) return false;",
    "    if (!infiniteMayTrack()) return false;",
    "    if (!window.posthog || typeof window.posthog.identify !== 'function') return false;",
    "    window.posthog.identify(id);",
    "    return true;",
    "  } catch (_error) { return false; }",
    "};",
    "window.infiniteReset = function () {",
    "  try {",
    "    if (!window.posthog || typeof window.posthog.reset !== 'function') return false;",
    "    window.posthog.reset();",
    "    return true;",
    "  } catch (_error) { return false; }",
    "};"
  ].join("\n")
}
