// The unsafe-text scrubber, ported from infinite.fast.
//
// Source: `captureContainsUnsafeText`, infinite-site `get-started/index.html` L589-602 @ 9f65b47, with its
// cases from `.github/scripts/test-get-started-page.mjs` (the friction-lane block around L1663).
//
// It answers ONE question: could this short string carry something that must never reach an analytics
// tool — a click id, an email, a URL, or a phone-shaped run of digits? It decodes up to four times,
// because a value can arrive percent-encoded more than once (`person%2540example.test` is an email two
// decodes down), and a value still encoded after four decodes is treated as unsafe rather than trusted.
//
// NEW USE (skeptic G6): infinite.fast applies it to campaign capture (utm values and the landing path)
// only. infinite-tag also applies it to the PROPERTIES the site's code passes to the managed helpers
// (`infiniteTrack` and friends) and to the attribution tab copy at write time. A property that fails is
// DROPPED, never rewritten: a half-cleaned value is still a leak.
//
// SERIALIZED INTO PAGES. `infiniteUnsafeText` is written as plain ES5 with no closure and no module
// reference, so `Function.prototype.toString()` of it is the exact browser source (the same seam the
// Infinite runtime and infinite.fast's campaign capture use). It must stay free of backticks, `${` and
// `</`; `scrub.test.ts` executes the serialized text, not this function.

/** True when the value could carry a click id, an email, a URL or a phone number (decoded up to 4×). */
export function infiniteUnsafeText(value: unknown): boolean {
  if (typeof value !== "string") return true
  var decoded = value
  for (var pass = 0; pass <= 4; pass += 1) {
    var digits = decoded.replace(/[^0-9]/g, "")
    var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.trim())
    if (
      /(^|[/?&#\s])(gclid|fbclid|msclkid|ttclid)=/i.test(decoded) ||
      /[^\s@]+@[^\s@]+\.[^\s@]+/.test(decoded) ||
      /https?:\/\//i.test(decoded) ||
      (digits.length >= 7 && /[0-9][\s().-]{0,2}[0-9]/.test(decoded) && !uuid)
    )
      return true
    if (decoded.indexOf("%") === -1) return false
    if (pass === 4) return true
    try {
      decoded = decodeURIComponent(decoded)
    } catch (_error) {
      return true
    }
  }
  return true
}

/** The browser source of `infiniteUnsafeText` (a function declaration of that name). */
export const UNSAFE_TEXT_SOURCE: string = infiniteUnsafeText.toString()
