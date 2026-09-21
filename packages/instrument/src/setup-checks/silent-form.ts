// Check 2 — a form that submits and emits nothing.
//
// The defect: a done-for-you lead form that posted, redirected to a thank-you page, and fired no
// conversion event at any point. Nothing was broken enough to notice. The receipt lanes cannot see
// it, by construction: they ask a backend whether an event arrived, and a form that never tries to
// send one is indistinguishable from a form nobody filled in.
//
// THIS IS THE CHECK MOST LIKELY TO CRY WOLF, so it is built to under-report on purpose:
//
//   1. It requires a POSITIVE lead signal — an `type="email"` input, or a lead word in the form's
//      own id/name/class/action. Absence of an exclusion is never enough; a site is full of forms.
//   2. It applies an exclusion list for the kinds of form that legitimately are NOT conversions:
//      search, filter/sort/locale, login and account recovery, newsletter, comments, cart. A GET
//      form is excluded outright — a GET form is a query, not a submission.
//   3. If the file calls an analytics API directly (fbq / gtag / posthog.capture / dataLayer.push /
//      a track() call), the answer is `undetermined`, not `problem`. A hand-written handler we
//      cannot attribute to this form is exactly the case where a confident accusation is wrong.
//   4. Everything it does report is `likely`, rendered as "Worth checking", and says in the same
//      breath what would make it wrong.
//
// PRIVACY: only tag names and attribute NAMES are read. `type="email"` is a structural attribute,
// not a value; no field's contents are read, and no identifier or action path is ever emitted — a
// finding carries a file, a line, and the two clause-length reasons it fired.
import { formRegions, hasAttributeName, literalAttributeValue } from "./markup.js"
import { formUndeterminedMessage, silentFormMessage } from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

/** Form kinds that legitimately emit nothing. Matched against the form's OWN identity tokens. */
export const NOT_A_CONVERSION = new RegExp(
  [
    "search", "filter", "sort", "locale", "language", "currency", "translate",
    "login", "log-in", "signin", "sign-in", "logout", "password", "forgot", "reset",
    "otp", "2fa", "mfa", "verify", "auth",
    "newsletter", "subscribe", "unsubscribe", "rss",
    "comment", "reply", "review", "rating",
    "cart", "quantity", "coupon", "promo", "checkout",
    "settings", "preference", "profile", "account", "billing", "address"
  ].join("|"),
  "i"
)

/** Words that make a form a plausible lead capture. One of these, or an email input, is required. */
export const LEAD_FORM = new RegExp(
  [
    "contact", "lead", "demo", "quote", "apply", "application", "book", "booking",
    "enquir", "inquir", "request", "waitlist", "wait-list", "signup", "sign-up",
    "register", "registration", "get-?started", "onboard", "trial", "consult",
    "audit", "estimate", "intake", "join"
  ].join("|"),
  "i"
)

/** A hand-rolled analytics call. Its presence downgrades a finding to `undetermined`. */
export const DIRECT_ANALYTICS_CALL =
  /\bfbq\s*\(|\bgtag\s*\(|\bposthog\s*\.\s*capture\s*\(|\bdataLayer\s*\.\s*push\s*\(|\btrack(?:Event|Conversion)?\s*\(/

/** The form's own structural identity, for classification only. Never emitted in a finding. */
function identityTokens(openingTag: string): string {
  return ["id", "name", "class", "className", "action", "data-testid", "data-form", "aria-label"]
    .map((attribute) => literalAttributeValue(openingTag, attribute) ?? "")
    .join(" ")
}

/** How this form submits, in a clause the customer reads back. Null when it has no submit path. */
function submitPath(openingTag: string, inner: string): string | null {
  if (hasAttributeName(openingTag, "onSubmit")) return "it has an onSubmit handler"
  if (/<input[^>]*\btype\s*=\s*["']submit["']/i.test(inner)) return "it has a submit input"
  if (/<button[^>]*\btype\s*=\s*["']submit["']/i.test(inner)) return "it has a type=submit button"
  if (/<button\b/i.test(inner) && !/<button[^>]*\btype\s*=\s*["']button["']/i.test(inner)) {
    return "it has a button that defaults to type=submit"
  }
  if (literalAttributeValue(openingTag, "action")) return "it posts to an action url"
  return null
}

export interface SilentFormInput {
  files: ReadonlyMap<string, string>
}

export function checkSilentForms(input: SilentFormInput): SetupCheckResult {
  const findings: SetupFinding[] = []

  for (const [file, contents] of input.files) {
    const fileCallsAnalytics = DIRECT_ANALYTICS_CALL.test(contents)
    for (const region of formRegions(contents)) {
      if (!region.closed) continue
      const { openingTag } = region.site
      const identity = identityTokens(openingTag)

      const method = literalAttributeValue(openingTag, "method")
      if (method && method.toLowerCase() === "get") continue
      if (NOT_A_CONVERSION.test(identity)) continue
      if (/\btype\s*=\s*["'](?:password|search)["']/i.test(region.inner)) continue
      if (/\brole\s*=\s*["']search["']/i.test(openingTag)) continue

      const hasEmailInput = /<input[^>]*\btype\s*=\s*["']email["']/i.test(region.inner)
      const namedLead = LEAD_FORM.test(identity)
      if (!hasEmailInput && !namedLead) continue

      const submitVia = submitPath(openingTag, region.inner)
      if (!submitVia) continue

      const marked =
        hasAttributeName(openingTag, "data-conversion") ||
        hasAttributeName(openingTag, "data-analytics-cta-id") ||
        /\bdata-conversion\b|\bdata-analytics-cta-id\b/.test(region.inner)
      if (marked) continue

      if (fileCallsAnalytics) {
        findings.push({
          check: "silent_form",
          code: "INF_SETUP_FORM_UNDETERMINED",
          state: "undetermined",
          confidence: "likely",
          file,
          line: region.site.line,
          message: formUndeterminedMessage({ file, line: region.site.line })
        })
        continue
      }

      findings.push({
        check: "silent_form",
        code: "INF_SETUP_FORM_NO_CONVERSION",
        state: "problem",
        confidence: "likely",
        file,
        line: region.site.line,
        message: silentFormMessage({
          file,
          line: region.site.line,
          submitVia,
          leadSignal: hasEmailInput ? "it collects an email address" : "its own name says so"
        })
      })
    }
  }

  return { check: "silent_form", state: worstState(findings), findings }
}
