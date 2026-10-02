import { resolveArtifactHostGuard, wrapGuardedSnippet, type HostGuardSpec } from "../host-guard.js"
import type { InstallInstruction, ProviderAdapter, SupportedFramework } from "../types.js"
import { isHtmlInjectedFramework } from "../types.js"
import { jsLiteral, urlQueryValue, validateGa4MeasurementId } from "./validate.js"

/**
 * The marker the managed GA4 snippet sets once it has STARTED (its preview guard passed and it queued
 * `config`): `window.__infiniteGa4Lane = { id: "G-…" }`. The navigation helper holds a click only when
 * this is set — never on `typeof gtag`, because an adopted gtag stub with no loader never calls back
 * (`src/conversions/navigate.ts`).
 */
export const GA4_LANE_MARKER = "__infiniteGa4Lane"

function frameworkEnvKeys(framework: SupportedFramework): string[] {
  switch (framework) {
    case "next-app-router":
    case "next-pages-router":
      return ["NEXT_PUBLIC_GA4_MEASUREMENT_ID"]
    // Vite bakes the resolved id into the injected index.html <script> at install time — no env var.
    case "vite-react":
    case "static-html":
      return []
  }
}

export const ga4ProviderAdapter: ProviderAdapter = {
  id: "ga4",
  displayName: "GA4",
  envKeys(framework) {
    return frameworkEnvKeys(framework)
  },
  plan(framework, artifact, context) {
    const measurementId =
      artifact && typeof artifact === "object" && "measurementId" in artifact
        ? artifact.measurementId
        : undefined

    const invalid = validateGa4MeasurementId(measurementId)
    if (invalid) {
      return { assumptions: [], blockers: [invalid], instructions: [] }
    }
    const guard = resolveArtifactHostGuard(context?.artifacts ?? {})
    if (guard.error) {
      return { assumptions: [], blockers: [guard.error], instructions: [] }
    }

    const instructions: InstallInstruction[] = [
      {
        path: frameworkInstructionPath(framework),
        action: isHtmlInjectedFramework(framework) ? "modify" : "create",
        description: isHtmlInjectedFramework(framework)
          ? "Inject the GA4 public loader and gtag bootstrap into index.html."
          : "Add the GA4 public loader and gtag bootstrap to the managed analytics module.",
        provider: "ga4",
        snippet: isHtmlInjectedFramework(framework)
          ? buildHtmlSnippet(measurementId!, guard.spec)
          : buildGa4BootstrapSnippet(measurementId!, guard.spec)
      }
    ]

    return {
      assumptions: [
        "GA4 wiring will use only the public measurementId artifact.",
        ...(guard.spec
          ? [
              "GA4 starts only on your production hosts and any host that is not a preview or a laptop: previews (*.vercel.app, *.netlify.app, *.pages.dev) and localhost send nothing."
            ]
          : [])
      ],
      blockers: [],
      instructions
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

// FULL NATIVE bootstrap (0.6.0): Google's own gtag.js snippet — the loader, the dataLayer, `gtag('js')`
// and `gtag('config', ID)` with GA4's DEFAULT send_page_view (true) and enhanced measurement untouched.
// A provider is never reduced WITHOUT a plan line the user approved. The Infinite runtime forwards
// nothing into GA4 and never gates it on the Infinite consent signal — consent for GA4 (Consent Mode) is
// the site's own, exactly as with a hand-pasted snippet; conversions reach GA4 because the site's own
// code calls the managed helpers (decisions 9 and 13).
//
// THE PREVIEW GUARD (decision 3), when the plan carries one: the WHOLE snippet sits inside one IIFE
// behind the guard, `window.gtag` definition included, exactly like infinite.fast (inject L375). A
// defined-but-never-loaded gtag on a preview would make every helper think GA4 was there.
//
// THE LANE MARKER (`GA4_LANE_MARKER`) is set last, once `config` is queued: the one signal the
// navigation helper trusts that GA4 actually started.
export function buildGa4BootstrapSnippet(measurementId: string, guard?: HostGuardSpec): string {
  const body = [
    "window.dataLayer = window.dataLayer || [];",
    "window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};",
    "(function(){",
    "  var script = document.createElement('script');",
    "  script.async = true;",
    `  script.src = "https://www.googletagmanager.com/gtag/js?id=${urlQueryValue(measurementId)}";`,
    "  document.head.appendChild(script);",
    "})();",
    "window.gtag('js', new Date());",
    `window.gtag('config', ${jsLiteral(measurementId)});`,
    `window.${GA4_LANE_MARKER} = { id: ${jsLiteral(measurementId)} };`
  ].join("\n")
  return guard ? wrapGuardedSnippet(body, guard) : body
}

function buildHtmlSnippet(measurementId: string, guard?: HostGuardSpec): string {
  return ["<script>", buildGa4BootstrapSnippet(measurementId, guard), "</script>"].join("\n")
}
