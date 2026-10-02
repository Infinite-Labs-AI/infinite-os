// The campaign patterns, defined ONCE.
//
// infinite.fast states them in `scripts/lib/campaign-capture.cjs` L18-19 @ 9f65b47, and open infinite-os
// PR #95 states the byte-identical rules for the runtime page view (`ad_id` / `adset_id` / `campaign_id`
// digits, `utm_placement` token). The browser functions in `./capture.ts` ship through
// `Function.prototype.toString()` and cannot import, so they carry literal copies; `attribution.test.ts`
// pins every copy to these constants.

/** Meta's ad, ad set and campaign ids on a landing URL: 1-32 digits and nothing else. */
export const META_AD_ID_PATTERN = /^[0-9]{1,32}$/

/** Meta's `utm_placement`: a bounded token. */
export const META_PLACEMENT_PATTERN = /^[A-Za-z0-9_]{1,64}$/

/** A click id smuggled into a campaign value or a path (`utm_term=foo gclid=SECRET`). */
export const CLICK_ID_CONTAMINATION_PATTERN = /(^|[/?&#\s])(?:gclid|fbclid|msclkid|ttclid)=/i

/** One DNS label; a referrer host is two or more of them. */
export const HOST_LABEL_SOURCE = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"

/** The first-touch campaign record, in the tab (sessionStorage) and the cookie. */
export const CAMPAIGN_KEY = "infinite_landing_attribution_v1"

/** The browser cookie lives 7 days; the server-set cookie 180 days (infinite.fast's values). */
export const BROWSER_CAMPAIGN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60
export const SERVER_CAMPAIGN_COOKIE_MAX_AGE = 180 * 24 * 60 * 60

/** The encoded cookie value's inclusive byte ceiling; a larger record is skipped whole, never cut. */
export const CAMPAIGN_COOKIE_VALUE_MAX_BYTES = 3800

/** The UTM keys a campaign record carries. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const

/** The click ids a campaign record notes by PRESENCE only (`has_gclid: true`), never by value. */
export const CLICK_ID_KEYS = ["gclid", "fbclid", "msclkid", "ttclid"] as const
