import type { InstallInstruction, ProviderAdapter, SupportedFramework } from "../types.js"
import { jsLiteral, urlQueryValue, validateGa4MeasurementId } from "./validate.js"

function frameworkEnvKeys(framework: SupportedFramework): string[] {
  switch (framework) {
    case "next-app-router":
    case "next-pages-router":
      return ["NEXT_PUBLIC_GA4_MEASUREMENT_ID"]
    case "vite-react":
      return ["VITE_GA4_MEASUREMENT_ID"]
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
  plan(framework, artifact) {
    const measurementId =
      artifact && typeof artifact === "object" && "measurementId" in artifact
        ? artifact.measurementId
        : undefined

    const invalid = validateGa4MeasurementId(measurementId)
    if (invalid) {
      return { assumptions: [], blockers: [invalid], instructions: [] }
    }

    const instructions: InstallInstruction[] = [
      {
        path: frameworkInstructionPath(framework),
        action: framework === "static-html" ? "modify" : "create",
        description:
          framework === "static-html"
            ? "Inject the GA4 public loader and gtag bootstrap into index.html."
            : "Add the GA4 public loader and gtag bootstrap to the managed analytics module.",
        provider: "ga4",
        snippet:
          framework === "static-html"
            ? buildHtmlSnippet(measurementId!)
            : buildBootstrapSnippet(measurementId!)
      }
    ]

    return {
      assumptions: ["GA4 wiring will use only the public measurementId artifact."],
      blockers: [],
      instructions
    }
  }
}

function frameworkInstructionPath(framework: SupportedFramework): string {
  switch (framework) {
    case "static-html":
      return "index.html"
    case "vite-react":
      return "src/lib/infinite-analytics.ts"
    case "next-app-router":
    case "next-pages-router":
      return "lib/infinite-analytics.ts"
  }
}

function buildBootstrapSnippet(measurementId: string): string {
  return [
    "window.dataLayer = window.dataLayer || [];",
    "function gtag(){window.dataLayer.push(arguments);}",
    "gtag('js', new Date());",
    `gtag('config', ${jsLiteral(measurementId)});`
  ].join("\n")
}

function buildHtmlSnippet(measurementId: string): string {
  return [
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${urlQueryValue(measurementId)}"></script>`,
    "<script>",
    buildBootstrapSnippet(measurementId),
    "</script>"
  ].join("\n")
}
