/**
 * Strict validation + script-safe embedding for the PUBLIC analytics artifacts that get
 * written into a founder's source code.
 *
 * Once infinite-tag ships as a public CLI, these values arrive as user-supplied
 * flags (`--ga4-measurement-id`, `--posthog-project-key`, `--posthog-api-host`, …) or via
 * `--artifact-file`. A malformed or hostile value must be REJECTED as a plan blocker, never
 * interpolated raw into the founder's JS/HTML. Validation is the primary defense; the
 * embedding helpers are belt-and-suspenders so even a validation gap cannot break out of a
 * string literal or `</script>` block.
 */

// GA4/gtag measurement-style IDs: G-XXXX (GA4), and the other prefixes the gtag loader
// accepts (GT- google tag, AW- ads, UA- legacy, DC- floodlight). Alphanumerics + hyphens
// only — no quotes, angle brackets, slashes or whitespace can pass. At least one
// alphanumeric is required in the body so all-hyphen bodies like `G-----` are rejected.
const MEASUREMENT_ID = /^(?:G|GT|AW|UA|DC)-(?=[A-Za-z0-9-]*[A-Za-z0-9])[A-Za-z0-9-]{4,}$/
// PostHog public project keys look like `phc_<base62>`. The `phc_` prefix + an
// alphanumeric-only charset is the security guarantee; we don't gate on length.
const POSTHOG_PROJECT_KEY = /^phc_[A-Za-z0-9]+$/
// X/Twitter pixel ids + event-tag ids: alphanumerics, hyphens and underscores
// (real event tags look like `tw-<pixel>-<event>`). The charset is what keeps a value
// from breaking out of a string literal or `</script>`.
const X_ID = /^[A-Za-z0-9_-]{2,}$/

export function validateGa4MeasurementId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "GA4 requires a public measurementId before planning can continue."
  }
  if (!MEASUREMENT_ID.test(value)) {
    return `GA4 measurementId ${JSON.stringify(value)} is not a valid Measurement ID (expected e.g. G-XXXXXXXXXX).`
  }
  return null
}

export function validatePosthogProjectKey(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "PostHog requires a public projectKey before planning can continue."
  }
  if (!POSTHOG_PROJECT_KEY.test(value)) {
    return `PostHog projectKey ${JSON.stringify(value)} is not a valid public project key (expected phc_...).`
  }
  return null
}

/** Validates the PostHog apiHost and returns its clean host (preserving path, no credentials/query/hash). */
export function normalizePosthogApiHost(value: unknown): { origin: string } | { error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: "PostHog requires a public apiHost before planning can continue." }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { error: `PostHog apiHost ${JSON.stringify(value)} is not a valid URL.` }
  }
  if (url.protocol !== "https:") {
    return { error: `PostHog apiHost must be an https URL (got ${JSON.stringify(value)}).` }
  }
  if (url.username || url.password) {
    return { error: "PostHog apiHost must not contain embedded credentials." }
  }
  // Preserve the pathname so reverse-proxy configs like https://app.example.com/ingest work
  // correctly. Strip any trailing slash, query string, and fragment — those must never ride
  // along into the snippet.
  const pathname = url.pathname.replace(/\/$/, "")
  return { origin: url.origin + pathname }
}

export function validateXPixelId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "X requires a public pixelId before planning can continue."
  }
  if (!X_ID.test(value)) {
    return `X pixelId ${JSON.stringify(value)} is not a valid pixel id.`
  }
  return null
}

export function validateXEventTagIds(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return "X requires at least one public eventTagId before planning can continue."
  }
  for (const id of value) {
    if (typeof id !== "string" || !X_ID.test(id)) {
      return `X eventTagId ${JSON.stringify(id)} is not a valid event tag id.`
    }
  }
  return null
}

/**
 * Serialize a value as a JS literal that is safe to inline inside a `<script>` block.
 * JSON.stringify handles quotes/backslashes/newlines; we additionally escape `<` (stops a
 * value from closing the script element via `</script>`) and the raw line terminators
 * U+2028 / U+2029 (legal in HTML/JSON but illegal mid JS string literal). Code points are
 * compared numerically so the source stays ASCII-only.
 */
export function jsLiteral(value: unknown): string {
  const json = JSON.stringify(value) ?? "undefined"
  let out = ""
  for (const ch of json) {
    const code = ch.charCodeAt(0)
    if (ch === "<" || code === 0x2028 || code === 0x2029) {
      out += "\\u" + code.toString(16).padStart(4, "0")
    } else {
      out += ch
    }
  }
  return out
}

/** Safe value for a URL query parameter such as the GA4 loader's `?id=...`. */
export function urlQueryValue(value: string): string {
  return encodeURIComponent(value)
}
