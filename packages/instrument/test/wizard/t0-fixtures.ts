// Test fixtures for lane O6's T0 engine: page bytes in the SHAPE lane O5 will emit (the deny-list host
// guard, the server-instructed Meta mirror, the click helper, first-touch attribution, the D17 PostHog
// options), built from today's real provider snippets where they exist. Until integration (I1) the T0
// suite runs against these; at I1 the same scenarios run against O5's real bytes. Every fixture is ES5,
// zero-dependency, and carries only fake ids. Test helpers live outside `src/` so the build never ships
// them (BUILD-PLAN §0).
import { getProviderAdapter } from "../../src/providers/index.js"
import { buildManagedHtmlBlock } from "../../src/frameworks/managed-html.js"
import type { WorkspaceInstallArtifacts } from "../../src/types.js"
import { HOST_DENY_V1 } from "../../src/wizard/contracts/host-deny.js"
import type { T0PageSource } from "../../src/t0/protocol.js"

export const FAKE = {
  host: "acme-store.com",
  ga4: "G-FAKE00001",
  posthogKey: "phc_FAKEtestProjectKeyNotReal000",
  posthogHost: "https://us.i.posthog.com",
  pixel: "1234567890123456",
  siteSourceKey: "site_FAKEacmeStoreSourceKey",
  runId: "7f3c2a91-b0de-4c03-9a00-000000000001"
} as const

export function fakeArtifacts(consentMode: "required" | "not_required" = "not_required"): WorkspaceInstallArtifacts {
  return {
    productionHosts: [FAKE.host],
    infinite: { siteSourceKey: FAKE.siteSourceKey, consentMode, collectPath: "/infinite/ledger", productionHosts: [FAKE.host] } as WorkspaceInstallArtifacts["infinite"],
    ga4: { measurementId: FAKE.ga4 },
    posthog: { projectKey: FAKE.posthogKey, apiHost: FAKE.posthogHost },
    meta: { pixelId: FAKE.pixel }
  }
}

/** A provider's static-html snippet body (the `<script>` wrapper removed), exactly as the installer writes it. */
export function snippetBody(provider: "ga4" | "posthog" | "meta" | "infinite", artifacts: WorkspaceInstallArtifacts): string {
  const plan = getProviderAdapter(provider).plan("static-html", artifacts[provider], { artifacts })
  if (plan.blockers.length) throw new Error(`${provider}: ${plan.blockers.join("; ")}`)
  return plan.instructions[0]!.snippet.trim()
}

function unwrap(snippet: string): string {
  return snippet.replace(/^<script[^>]*>\n?/, "").replace(/\n?<\/script>$/, "")
}

/** The §3h.9 deny-list guard as an ES5 boolean expression (exempt first), the shape O5's builder emits. */
export function hostGuardExpression(exempt: readonly string[]): string {
  const exact = JSON.stringify(HOST_DENY_V1.deny.exact)
  const suffix = JSON.stringify(HOST_DENY_V1.deny.suffix)
  return [
    "(function(){",
    "var h=String(location.hostname||'').replace(/^\\s+|\\s+$/g,'').toLowerCase();",
    "if(h.charAt(h.length-1)==='.')h=h.slice(0,-1);",
    `if(${JSON.stringify(exempt.map((host) => host.toLowerCase()))}.indexOf(h)!==-1)return true;`,
    `if(${exact}.indexOf(h)!==-1)return false;`,
    `var s=${suffix};for(var i=0;i<s.length;i++){if(h.length>s[i].length&&h.slice(-s[i].length)===s[i])return false;}`,
    "return true;",
    "})()"
  ].join("")
}

/** The managed block with GA4 / PostHog init / the Meta bootstrap behind the guard (each its own IIFE). */
export function guardedPage(exempt: readonly string[] = [FAKE.host], bodyHtml = ""): T0PageSource {
  const artifacts = fakeArtifacts()
  const guard = hostGuardExpression(exempt)
  const ga4 = `(function(){ if (!${guard}) return;\n${unwrap(snippetBody("ga4", artifacts))}\n})();`
  const posthogLines = unwrap(snippetBody("posthog", artifacts)).split("\n")
  const posthog = `${posthogLines[0]}\n(function(){ if (!${guard}) return;\n${posthogLines.slice(1).join("\n")}\n})();`
  const meta = unwrap(snippetBody("meta", artifacts))
  const split = meta.indexOf("!function(f,b,e,v,n,t,s)")
  const metaGuarded = `${meta.slice(0, split)}\n(function(){ if (!${guard}) return;\n${meta.slice(split)}\n})();`
  const infinite = snippetBody("infinite", artifacts)
  const block = buildManagedHtmlBlock([`<script>${ga4}</script>`, `<script>${posthog}</script>`, `<script>${metaGuarded}</script>`, infinite])
  return { html: `<!doctype html><html><head>${block}</head><body>${bodyHtml}</body></html>` }
}

/** The server-instructed Meta mirror (§3j.6), ported from infinite-site get-started `mirrorRegistration` + growth.js `mirrorLead`. */
export const MIRROR_FIXTURE = `(function(){
  var ALLOWED = { Lead: 1, CompleteRegistration: 1, StartTrial: 1, Subscribe: 1 };
  var fired = {};
  window.infiniteMetaMirror = function (name, metaEventId, options) {
    options = options || {};
    var budget = typeof options.budgetMs === "number" ? options.budgetMs : 400;
    return new Promise(function (resolve) {
      try {
        if (!ALLOWED[name] || typeof metaEventId !== "string" || !metaEventId || fired[metaEventId] || typeof window.fbq !== "function") { resolve(); return; }
        fired[metaEventId] = true;
        var done = false, observer = null, timer = null;
        function finish() { if (done) return; done = true; if (observer) observer.disconnect(); if (timer) clearTimeout(timer); resolve(); }
        if (options.wait !== "none" && typeof PerformanceObserver === "function") {
          observer = new PerformanceObserver(function (list) {
            var entries = list.getEntries();
            for (var i = 0; i < entries.length; i++) {
              var u; try { u = new URL(entries[i].name); } catch (e) { continue; }
              if (/(^|\\.)facebook\\.com$/.test(u.hostname) && /^\\/tr\\/?$/.test(u.pathname) && u.searchParams.get("ev") === name && u.searchParams.get("eid") === metaEventId) { finish(); return; }
            }
          });
          observer.observe({ type: "resource" });
        }
        window.fbq("track", name, {}, { eventID: metaEventId });
        if (options.wait === "none") { finish(); return; }
        timer = setTimeout(finish, budget);
      } catch (e) { resolve(); }
    });
  };
})();`

/** A broken mirror: fires on ANY id, null included, and never waits (the phantom-conversion bug). */
export const BROKEN_MIRROR_FIXTURE = `window.infiniteMetaMirror = function (name, metaEventId) { window.fbq("track", name, {}, { eventID: metaEventId }); return Promise.resolve(); };`

/** The click helper (§3j.6 `infiniteTrackThenNavigate`), ported from infinite-site's GA4 download bridge. */
export const CTA_FIXTURE = `document.addEventListener("click", function (event) {
  var a = event.target && event.target.closest ? event.target.closest("a[data-infinite-conversion]") : null;
  if (!a || event.button !== 0 || event.metaKey || event.ctrlKey || a.getAttribute("target") === "_blank") return;
  var name = a.getAttribute("data-infinite-conversion");
  try { if (window.posthog && typeof window.posthog.capture === "function") window.posthog.capture(name); } catch (e) {}
  if (typeof window.gtag !== "function") return;
  event.preventDefault();
  var href = a.href, followed = false;
  function follow() { if (followed) return; followed = true; location.assign(href); }
  window.gtag("event", name, { event_callback: follow, event_timeout: 1000 });
  setTimeout(follow, 1000);
});`

/** A dead CTA: holds the click for GA4's callback with no backstop (the F15 "dead button" bug). */
export const DEAD_CTA_FIXTURE = `document.addEventListener("click", function (event) {
  var a = event.target && event.target.closest ? event.target.closest("a[data-infinite-conversion]") : null;
  if (!a) return;
  event.preventDefault();
  var href = a.href;
  if (typeof window.gtag === "function") window.gtag("event", "sign_up", { event_callback: function () { location.assign(href); } });
});`

/** First-touch attribution in a first-party cookie (the shape O5's attribution module writes). */
export const ATTRIBUTION_FIXTURE = `(function(){
  var p = new URLSearchParams(location.search), c = p.get("utm_campaign");
  if (c && document.cookie.indexOf("infinite_first_touch=") === -1)
    document.cookie = "infinite_first_touch=" + encodeURIComponent(JSON.stringify({ utm_campaign: c, utm_source: p.get("utm_source") })) + ";path=/;max-age=604800;samesite=lax";
})();`

/** D17: PostHog init with replay and autocapture off on sensitive paths, PostHog's defaults elsewhere. */
export function sensitivePosthogSnippet(sensitive: readonly string[]): string {
  const stub = unwrap(snippetBody("posthog", fakeArtifacts())).split("\n")[0]
  return `${stub}
(function(){
  var sensitive = ${JSON.stringify(sensitive)};
  var path = location.pathname.replace(/\\/+$/, "") || "/";
  var options = { api_host: ${JSON.stringify(FAKE.posthogHost)}, defaults: "2026-01-30" };
  for (var i = 0; i < sensitive.length; i++) if (path === sensitive[i] || path.indexOf(sensitive[i] + "/") === 0) { options.disable_session_recording = true; options.autocapture = false; }
  posthog.init(${JSON.stringify(FAKE.posthogKey)}, options);
})();`
}

export function page(head: string, body = ""): T0PageSource {
  return { html: `<!doctype html><html><head>${head}</head><body>${body}</body></html>` }
}
