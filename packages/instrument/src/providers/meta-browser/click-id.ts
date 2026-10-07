// Meta's click id (`_fbc`), captured on the LANDING page — ported from infinite.fast.
//
// Source: infinite-site `scripts/lib/meta-click-id.mjs` @ 9f65b47, with its tests
// (`.github/scripts/test-meta-click-id.mjs`) and the RFC 6265bis cookie-jar fixture
// (`.github/scripts/fixtures/browser-cookie-jar.mjs`) ported alongside into `click-id.test.ts`
// (the cookie jar lives at the top of that file). Every rule below was fixed after a real incident on
// infinite.fast; read them before changing a character.
//
// WHY THIS EXISTS. `_fbc` is `fb.<subdomainIndex>.<creationMs>.<fbclid>` — the strongest match
// parameter a conversion can carry, because it ties the conversion to ONE ad click. Meta's pixel
// writes it on page load, but it cannot when the pixel never runs: an ad blocker, ITP, or a Traffic
// Permissions block in Events Manager. The `fbclid` exists in the URL only
// on the LANDING hit, so a click id not saved there is lost for good — and the server conversion
// that still fires for that visitor reaches Meta unattributable, so the ad looks like it failed.
// Meta: "Capture cookies early... Ideally retrieve _fbp and _fbc when loading your landing page."
//
// LOAD-BEARING RULES (each one breaks matching outright if violated):
//   1. LAST CLICK WINS. When this page's URL carries an fbclid that the newest stored `_fbc` does not
//      already describe, it is a new click and replaces the stored value (Meta's own pixel does the
//      same). A reload of the same landing URL is the same click: nothing is rewritten and the
//      original creation time stands. With no fbclid on the URL nothing is ever written.
//   2. ONE COOKIE, IN META'S SCOPE. Meta keeps `_fbc` on the registrable domain. A second `_fbc` on
//      a narrower scope (host-only, or `www.acme.com` beside `acme.com`) is a DIFFERENT cookie; the
//      browser lists the older one first. The cookie is written on the shortest domain the browser
//      accepts, found by writing and reading back (so a public suffix such as `vercel.app` or
//      `co.uk` is refused without a suffix list), and localhost/IP hosts fall back to host-only.
//   3. NO SHADOWS. fbevents reads the FIRST-listed `_fbc` and re-saves it into its own Domain
//      cookie, so a reader that picks the newest value cannot rescue a visitor while an older copy
//      sits on a narrower scope. On a new click the capture therefore retires the host-only copy and
//      — only when a duplicate is still visible after the write — any copy on a domain narrower than
//      the one it wrote. infinite.fast only ever had its own host-only copy to retire (it is an
//      apex); a customer's site can also carry one from a hand-written or tag-manager writer on
//      `www`. Nothing is tidied on a page without a new click: by then Meta's own cookie already
//      holds the shadowing value, so a clean-up would recover nothing.
//   4. CASE-SENSITIVE, BYTE FOR BYTE. The fbclid is never lowercased, trimmed, decoded further or
//      otherwise normalised (URLSearchParams decodes once, which is what Meta expects).
//   5. THE INDEX NAMES THE DOMAIN THE COOKIE IS DEFINED ON: `acme.com` = 1 (also on `www.acme.com`,
//      because the cookie lives on `acme.com`), `acme.co.uk` = 2, a host-only cookie on `localhost`
//      = 0. Computed from the domain actually written, at every write — infinite.fast hard-coded 1
//      at its host-only fallback, which is only right on its own apex.
//   6. `creationMs` is when the click was first observed — now, at landing — in MILLISECONDS.
//
// THE ACCESSOR. `window.infiniteMetaClickId()` returns the newest stored click, or — when the click
// on THIS page's URL could not be stored (cookies blocked or silently dropped) — that click in Meta's
// format, built with index 1. That value describes no cookie, and Meta's own guidance for a value
// that is not saved as a cookie is "use the value 1". Returns "" when there is nothing honest to
// return; never a placeholder. It never writes. Under a consent hook it returns "" whenever the hook
// says no, re-checked on every call.
//
// DELIBERATELY NOT HERE:
//   - No `_fbp` synthesis: `_fbp` is a random browser id derived from nothing; inventing one is
//     fabricating data.
//   - No raw `fbclid` at rest anywhere but `_fbc`: no localStorage, no sessionStorage, no analytics
//     payload, no query-string forwarding.
//   - No host guard (founder decision 15): it writes one first-party cookie and sends nothing, and
//     previews must still be able to test it.
//   - No banner and no consent gate of its own: see `./consent.ts`.
import { captureConsentDecisionSource, consentAllowsSource, consentGateSource, type MetaBrowserGate } from "./consent.js"

/** The global the capture defines. One per page; the census checks it. */
export const META_CLICK_ID_ACCESSOR = "infiniteMetaClickId"

/** 90 days, Meta's own `_fbc` lifetime. */
export const META_CLICK_ID_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

export interface MetaClickIdCaptureOptions {
  /**
   * Default `{ kind: "none" }`: no consent check at all. infinite-tag never emits that default —
   * `providers/meta.ts` always passes the Infinite consent hook for the site's consent mode, so a
   * visitor's recorded "no" and DNT/GPC are honoured exactly as infinite.fast honours them.
   */
  gate?: MetaBrowserGate
}

/**
 * The capture as plain browser source, without a `<script>` wrapper, so tests run the real thing in
 * a vm. ES5, and free of backticks, `${` and `</`, so it folds into an HTML `<script>` and into the
 * Next module's string literal unchanged.
 */
export function buildMetaClickIdCaptureScript(options: MetaClickIdCaptureOptions = {}): string {
  const gate = options.gate ?? { kind: "none" }
  return [
    "(function () {",
    `  if (typeof window.${META_CLICK_ID_ACCESSOR} === "function") return;`,
    "  // Meta's documented shapes. FB_COOKIE is the rule the whole pipeline accepts; FBCLID bounds",
    "  // the payload segment. A value failing either is never written and never returned.",
    "  var FB_COOKIE = /^fb\\.[0-9]{1,2}\\.[0-9]{1,20}\\.[A-Za-z0-9_%.-]{1,512}$/;",
    "  var FBCLID = /^[A-Za-z0-9_%.-]{1,400}$/;",
    `  var MAX_AGE = ${META_CLICK_ID_MAX_AGE_SECONDS};`,
    ...indent(captureConsentDecisionSource(gate)),
    ...indent(consentAllowsSource(gate, gate.kind === "infinite-consent")),
    ...indent(consentGateSource(gate)),
    "  // EVERY _fbc the browser exposes, in its order. usableOnly drops values Meta would reject.",
    "  function storedFbcs(usableOnly) {",
    "    var found = [];",
    "    try {",
    '      var parts = String(document.cookie || "").split(";");',
    "      for (var index = 0; index < parts.length; index += 1) {",
    '        var part = parts[index].replace(/^\\s+/, "");',
    '        if (part.indexOf("_fbc=") !== 0) continue;',
    "        var value = part.slice(5);",
    "        if (!usableOnly || FB_COOKIE.test(value)) found.push(value);",
    "      }",
    "    } catch (_error) {}",
    "    return found;",
    "  }",
    "  // The newest click by the creation time Meta's format carries, never the first-listed one.",
    "  function newestStored() {",
    "    var values = storedFbcs(true);",
    '    var newest = "";',
    "    for (var index = 0; index < values.length; index += 1) {",
    '      if (!newest || Number(values[index].split(".")[2]) > Number(newest.split(".")[2])) newest = values[index];',
    "    }",
    "    return newest;",
    "  }",
    "  // Case-sensitive and untouched: no toLowerCase, no trim, no further decoding.",
    "  function urlFbclid() {",
    "    try {",
    '      var value = new URLSearchParams(location.search || "").get("fbclid") || "";',
    '      return FBCLID.test(value) ? value : "";',
    "    } catch (_error) {",
    '      return "";',
    "    }",
    "  }",
    "  // The fbclid on THIS page's URL when the newest stored value does not already describe it.",
    "  function newClick() {",
    "    var fbclid = urlFbclid();",
    '    if (!fbclid) return "";',
    "    var stored = newestStored();",
    "    if (!stored) return fbclid;",
    '    var storedClick = stored.split(".").slice(3).join(".");',
    '    return storedClick === fbclid || storedClick.indexOf(fbclid + ".") === 0 ? "" : fbclid;',
    "  }",
    "  function format(index, fbclid) {",
    '    return "fb." + String(index) + "." + String(Date.now()) + "." + fbclid;',
    "  }",
    "  // Rule 5: the index of the domain a cookie is defined on ('com' = 0, 'acme.com' = 1).",
    "  function domainIndex(domain) {",
    '    return String(domain).split(".").length - 1;',
    "  }",
    "  function hostName() {",
    "    try {",
    '      return String(location.hostname || "").toLowerCase().replace(/\\.$/, "");',
    "    } catch (_error) {",
    '      return "";',
    "    }",
    "  }",
    "  // Rule 2: the domains a Domain cookie could live on, shortest first. None for a bare",
    "  // hostname or a literal IP.",
    "  function cookieDomains() {",
    "    var host = hostName();",
    '    if (!host || host.indexOf(".") === -1 || /^[0-9.]+$/.test(host) || host.indexOf(":") !== -1) return [];',
    '    var labels = host.split(".");',
    "    var domains = [];",
    '    for (var size = 2; size <= labels.length; size += 1) domains.push(labels.slice(labels.length - size).join("."));',
    "    return domains;",
    "  }",
    '  var ownedFbcValue = "", ownedFbcDomain = "";',
    ...(gate.kind === "infinite-consent" ? [
      '  try { window.addEventListener("infinite:analytics-consent-change", function () {',
      "    var event = arguments[0];",
      "    if (!event || !event.detail || event.detail.granted !== false) return;",
      "    try {",
      "      var visibleFbcs = storedFbcs(false);",
      "      if (ownedFbcValue && visibleFbcs.length === 1 && visibleFbcs[0] === ownedFbcValue) {",
      '        document.cookie = "_fbc=;path=/;max-age=0;samesite=Lax" + (ownedFbcDomain ? ";domain=" + ownedFbcDomain : "") + (location.protocol === "https:" ? ";secure" : "");',
      "      }",
      "    } catch (_error) {}",
      '    ownedFbcValue = ""; ownedFbcDomain = "";',
      "  }); } catch (_error) {}"
    ] : []),
    `  window.${META_CLICK_ID_ACCESSOR} = function () {`,
    '    if (!infiniteConsentAllows()) return "";',
    "    var fresh = newClick();",
    "    return fresh ? format(1, fresh) : newestStored();",
    "  };",
    "  infiniteConsentGate(function () {",
    "    try {",
    "      var fbclid = newClick();",
    "      if (!fbclid) return;",
    '      var secure = location.protocol === "https:" ? ";secure" : "";',
    '      var attributes = ";path=/;max-age=" + MAX_AGE + ";samesite=Lax" + secure;',
    "      // Rule 3: retire a host-only copy. Without a Domain attribute this deletes only the",
    "      // host-only cookie and never touches Meta's Domain cookie.",
    "      if (storedFbcs(false).length) {",
    '        document.cookie = "_fbc=;path=/;max-age=0;samesite=Lax" + secure;',
    "      }",
    "      var domains = cookieDomains();",
    "      for (var index = 0; index < domains.length; index += 1) {",
    "        var value = format(domainIndex(domains[index]), fbclid);",
    '        document.cookie = "_fbc=" + value + ";domain=" + domains[index] + attributes;',
    "        if (storedFbcs(true).indexOf(value) === -1) continue;",
    "        ownedFbcValue = value; ownedFbcDomain = domains[index];",
    "        // Rule 3 on a subdomain: a copy on a NARROWER domain than the one just written",
    "        // (www.acme.com beside acme.com) would still be listed first if it is older.",
    "        if (storedFbcs(false).length > 1) {",
    "          for (var narrower = index + 1; narrower < domains.length; narrower += 1) {",
    '            document.cookie = "_fbc=;domain=" + domains[narrower] + ";path=/;max-age=0;samesite=Lax" + secure;',
    "          }",
    "        }",
    "        return;",
    "      }",
    "      // No Domain cookie was accepted (localhost, an IP): host-only, indexed by the host itself.",
    '      var hostValue = format(domainIndex(hostName()), fbclid);',
    '      document.cookie = "_fbc=" + hostValue + attributes;',
    '      if (storedFbcs(false).indexOf(hostValue) !== -1) { ownedFbcValue = hostValue; ownedFbcDomain = ""; }',
    "    } catch (_error) {}",
    "  });",
    "})();"
  ].join("\n")
}

/** The same capture in a strict TypeScript module with an imperative adopted pixel. */
export function buildMetaClickIdCaptureTypescript(options: MetaClickIdCaptureOptions = {}): string {
  return buildMetaClickIdCaptureScript(options)
    .replace("(function () {", "(function () {\n  if (typeof globalThis.window === \"undefined\") return;\n  const window: any = globalThis.window;\n  const navigator: any = globalThis.navigator;")
    .replace("function infiniteConsentGate(start)", "function infiniteConsentGate(start: () => void)")
    .replace("function storedFbcs(usableOnly)", "function storedFbcs(usableOnly: boolean)")
    .replace("function format(index, fbclid)", "function format(index: number, fbclid: string)")
    .replace("function domainIndex(domain)", "function domainIndex(domain: string)")
}

/** The browser capture as a top-level JS module statement, safe to import during SSR. */
export function buildMetaClickIdCaptureJavascript(options: MetaClickIdCaptureOptions = {}): string {
  return buildMetaClickIdCaptureScript(options).replace("(function () {", "(function () {\n  if (typeof window === \"undefined\") return;")
}

function indent(source: string): string[] {
  return source.split("\n").map((line) => `  ${line}`)
}
