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

// THE CAMPAIGN RULE (live-fix-3 review P1-2). A campaign value (utm_*) is not free text a site's code wrote: ad
// platforms fill it with their own object ids (`utm_content={{ad.id}}` is a 15–18 digit Meta id) and marketers put
// dates in campaign names (`spring_2026_10_03`). `infiniteUnsafeText`'s "seven digits, two adjacent" shape drops all of
// those, so Infinite lost every Meta ad id it is meant to attribute by. This rule drops what is personal and keeps
// what is an id or a date:
//   - a click id or a URL (as `infiniteUnsafeText`);
//   - an email;
//   - a PHONE-FORMATTED run: a `+` before the digits, or spaces, parentheses or dashes between digit groups, with 7–15
//     digits in all (E.164's longest is 15), unless the run is a date (`2026-10-03`, `03-10-2026`);
//   - 10 or 11 bare digits (a national number written without separators).
// A pure digit run of any other length is kept (ad, ad set and campaign ids are 15+ digits). The cloud's ingest
// (`campaignValueCarriesPii`, 1bu-1 `src/lib/analytics/ingest.ts`) carries the same shape tests, so the door and the
// tag agree. Same serialization rules as above: plain ES5, no closure, no backticks.

/** True when a campaign value carries a click id, a URL, an email or a phone-formatted number (decoded up to 4×). */
export function infiniteUnsafeCampaign(value: unknown): boolean {
  if (typeof value !== "string") return true
  var decoded = value
  for (var pass = 0; pass <= 4; pass += 1) {
    if (/(^|[/?&#\s])(gclid|fbclid|msclkid|ttclid)=/i.test(decoded) || /https?:\/\//i.test(decoded) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(decoded)) return true
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.trim())) {
      var runs = decoded.match(/\+?[0-9(][0-9\s()-]*[0-9]/g) || []
      for (var index = 0; index < runs.length; index += 1) {
        var run = runs[index].trim()
        var digits = run.replace(/[^0-9]/g, "")
        var separated = /[\s()-]/.test(run)
        var date = /^(19|20)[0-9]{2}([\s-])[0-9]{1,2}\2[0-9]{1,2}$/.test(run) || /^[0-9]{1,2}([\s-])[0-9]{1,2}\1(19|20)[0-9]{2}$/.test(run)
        if (digits.length >= 7 && digits.length <= 15 && (run.charAt(0) === "+" || separated) && !date) return true
        if (!separated && run.charAt(0) !== "+" && (digits.length === 10 || digits.length === 11)) return true
      }
    }
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

/** The browser source of `infiniteUnsafeCampaign` (a function declaration of that name). */
export const UNSAFE_CAMPAIGN_SOURCE: string = infiniteUnsafeCampaign.toString()
