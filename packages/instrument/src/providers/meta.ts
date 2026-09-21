import type { ProviderAdapter, SupportedFramework } from "../types.js"
import { isHtmlInjectedFramework } from "../types.js"
import { jsLiteral, validateMetaPixelId } from "./validate.js"

/**
 * The Meta (Facebook) browser Pixel. OPT-IN via `--meta-pixel-id` — it is not added
 * unless a pixel id is supplied.
 *
 * This is the standard `fbevents.js` bootstrap plus an `init` and a `PageView`. It is
 * the browser half of a Meta signal; it pairs with Infinite's server-side Conversions
 * API (CAPI) dispatch, which reads the `_fbp` / `_fbc` cookies the pixel drops to lift
 * event match quality and deduplicates browser + server events by shared event_id.
 *
 * Automatic Configuration is turned OFF (`fbq('set', 'autoConfig', 'false', id)` BEFORE
 * `init` — Meta only honours it in that order). With it on, the pixel sends button clicks
 * and page metadata to Meta on its own, which contradicts the installer's no-DOM-text
 * posture. The provider is otherwise Meta's own native snippet, unchanged.
 *
 * MANUAL ADVANCED MATCHING — `--meta-advanced-matching on`, DEFAULT OFF.
 *
 * Meta has two Advanced Matching modes and only one of them is ours to offer:
 *   - AUTOMATIC: the pixel scrapes the page's form fields itself. It is part of Automatic
 *     Configuration, which the line above switches off. We do not turn it on, here or ever:
 *     this tag runs on the CUSTOMER's site, and letting Meta harvest their visitors' inputs
 *     is not a decision we get to make for them. DO NOT enable autoConfig to "improve match
 *     quality" — the option below is the alternative, and it is unaffected by the opt-out.
 *   - MANUAL: the site hands Meta values it already holds. That is what this installs.
 *
 * OFF UNLESS THE CUSTOMER ASKS, for the same reason the autoConfig opt-out exists. Sending a
 * visitor's contact details — even hashed — from their pages is their call, not ours, so the
 * artifact flag is absent by default and the accessor simply does not exist on the page.
 *
 * WHEN ON, the snippet defines `window.infiniteMetaAdvancedMatch({ email, externalId })`. It
 * NEVER runs by itself and NEVER reads the DOM: the customer's own code calls it at the moment
 * it knows who the visitor is (after their sign-up or checkout completes), which is also the
 * moment their consent rules have been applied. The contract, deliberately singular:
 *
 *   RAW IN, ALWAYS. The accessor takes plain values and is the only thing that hashes them —
 *   `em` is sha256(trim + lowercase(email)), `external_id` is sha256(trim(id)), lowercase hex,
 *   exactly once, per Meta's documented normalisation. An input that is ALREADY a 64-character
 *   hex digest is REFUSED rather than hashed again, so "sometimes hashed" — the way
 *   double-hashing ships — cannot happen. A double-hashed or wrongly-normalised value is
 *   indistinguishable at Meta from a digest of noise: it matches nothing and pulls the score
 *   DOWN. Nothing raw is ever transmitted, and a value that is not a digest never reaches fbq.
 *
 * Two fields only. Meta matches on more, but a field whose normalisation we have not
 * implemented correctly is worse than an absent one, so phone/name/city are deliberately not
 * accepted yet rather than accepted and mis-normalised.
 */
export const metaProviderAdapter: ProviderAdapter = {
  id: "meta",
  displayName: "Meta Pixel",
  envKeys() {
    // The pixel id is public and inlined directly into the snippet; no env var to record.
    return []
  },
  plan(framework, artifact) {
    const pixelId =
      artifact && typeof artifact === "object" && "pixelId" in artifact ? artifact.pixelId : undefined
    // Absent means OFF. Only an explicit `true` on the artifact installs the accessor, so a
    // malformed or partially-coerced artifact can never switch a customer's visitors on.
    const advancedMatching =
      artifact && typeof artifact === "object" && "advancedMatching" in artifact
        ? (artifact as { advancedMatching?: unknown }).advancedMatching === true
        : false

    const pixelError = validateMetaPixelId(pixelId)
    if (pixelError) {
      return { assumptions: [], blockers: [pixelError], instructions: [] }
    }

    const snippet = buildMetaPixelSnippet(pixelId!, { advancedMatching })
    return {
      assumptions: [
        "Meta wiring will use only the public pixelId artifact.",
        advancedMatching
          ? "Manual Advanced Matching is ON: the page will define window.infiniteMetaAdvancedMatch, which hashes the raw email / external id YOUR code passes it. It never reads the page and never runs on its own."
          : "Manual Advanced Matching is OFF (default): the pixel sends no visitor contact details. Turn it on with --meta-advanced-matching on."
      ],
      blockers: [],
      instructions: [
        {
          path: frameworkInstructionPath(framework),
          action: isHtmlInjectedFramework(framework) ? "modify" : "create",
          description: isHtmlInjectedFramework(framework)
            ? "Inject the Meta Pixel bootstrap into index.html."
            : "Add the Meta Pixel bootstrap to the managed analytics module.",
          provider: "meta",
          snippet: isHtmlInjectedFramework(framework) ? wrapHtmlSnippet(snippet) : snippet
        }
      ]
    }
  }
}

function frameworkInstructionPath(framework: SupportedFramework): string {
  switch (framework) {
    case "static-html":
    case "vite-react":
      return "index.html"
    case "next-app-router":
    case "next-pages-router":
      return "lib/infinite-analytics.ts"
  }
}

/** The global the customer's own code calls. Stable, documented, and only defined when opted in. */
export const META_ADVANCED_MATCHING_ACCESSOR = "infiniteMetaAdvancedMatch"

export function buildMetaPixelSnippet(
  pixelId: string,
  options: { advancedMatching?: boolean } = {}
): string {
  return [
    "!function(f,b,e,v,n,t,s)",
    "{if(f.fbq)return;n=f.fbq=function(){n.callMethod?",
    "n.callMethod.apply(n,arguments):n.queue.push(arguments)};",
    "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';",
    "n.queue=[];t=b.createElement(e);t.async=!0;",
    "t.src=v;s=b.getElementsByTagName(e)[0];",
    "s.parentNode.insertBefore(t,s)}(window, document,'script',",
    "'https://connect.facebook.net/en_US/fbevents.js');",
    `fbq('set', 'autoConfig', 'false', ${jsLiteral(pixelId)});`,
    `fbq('init', ${jsLiteral(pixelId)});`,
    "fbq('track', 'PageView');",
    ...(options.advancedMatching === true ? [buildMetaAdvancedMatchingSnippet(pixelId)] : [])
  ].join("\n")
}

/**
 * Manual Advanced Matching, as an accessor the CUSTOMER calls — never a scraper, never a timer.
 *
 * Emitted only when the customer opted in. Read the contract on `metaProviderAdapter` above
 * before changing a character of this: every rule in it fails SILENTLY in production, because a
 * digest built from the wrong normalisation, or hashed twice, is accepted by Meta and matches
 * nobody. The emitted source must also stay free of backticks and `${` — for Next it is folded
 * into a String.raw template — and free of a literal `</script>`.
 */
function buildMetaAdvancedMatchingSnippet(pixelId: string): string {
  return [
    "(function () {",
    "  var HEX64 = /^[a-f0-9]{64}$/;",
    "  var EMAIL = /^[^@\\s]+@[^@\\s]+$/;",
    "  function hex(buffer) {",
    "    var bytes = new Uint8Array(buffer), out = '', i = 0;",
    "    for (; i < bytes.length; i += 1) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);",
    "    return out;",
    "  }",
    "  // Returns '' rather than a partial digest when WebCrypto is unavailable (an insecure",
    "  // origin) or fails. One match signal fewer is honest; a wrong one is not.",
    "  function sha256(value) {",
    "    try {",
    "      var subtle = typeof crypto !== 'undefined' && crypto ? crypto.subtle : null;",
    "      if (!subtle || typeof TextEncoder !== 'function') return Promise.resolve('');",
    "      return Promise.resolve(subtle.digest('SHA-256', new TextEncoder().encode(value)))",
    "        .then(hex, function () { return ''; });",
    "    } catch (e) { return Promise.resolve(''); }",
    "  }",
    "  // RAW VALUES ONLY. This is the one hasher; an already-hashed input is refused, not rehashed.",
    "  // Resolves true when identity was attached, false when there was nothing honest to attach.",
    `  window.${META_ADVANCED_MATCHING_ACCESSOR} = function (identity) {`,
    "    return Promise.resolve().then(function () {",
    "      if (typeof window.fbq !== 'function') return false;",
    "      var source = identity || {};",
    "      var email = typeof source.email === 'string' ? source.email.trim().toLowerCase() : '';",
    "      var externalId = typeof source.externalId === 'string' ? source.externalId.trim() : '';",
    "      if (!EMAIL.test(email) || HEX64.test(email)) email = '';",
    "      if (!externalId || HEX64.test(externalId)) externalId = '';",
    "      if (!email && !externalId) return false;",
    "      return Promise.all([email ? sha256(email) : '', externalId ? sha256(externalId) : ''])",
    "        .then(function (d) {",
    "          var userData = {};",
    "          if (HEX64.test(d[0])) userData.em = d[0];",
    "          if (HEX64.test(d[1])) userData.external_id = d[1];",
    "          if (!userData.em && !userData.external_id) return false;",
    `          window.fbq('init', ${jsLiteral(pixelId)}, userData);`,
    "          return true;",
    "        });",
    "    }).catch(function () { return false; });",
    "  };",
    "})();"
  ].join("\n")
}

export function wrapHtmlSnippet(source: string): string {
  return ["<script>", source, "</script>"].join("\n")
}
