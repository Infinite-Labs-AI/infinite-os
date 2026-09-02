import { renderInfiniteBrowserTag } from "../runtime/infinite-browser.js"
import { DEFAULT_INFINITE_COLLECT_PATH, resolveInfiniteApiOrigin } from "../workspace-artifacts.js"
import type {
  InfiniteBrowserConfig,
  InfinitePublicArtifact,
  InstallInstruction,
  ProviderAdapter,
  SupportedFramework
} from "../types.js"
import {
  normalizeInfiniteCollectPath,
  normalizeInfiniteDownloadDestinationPath,
  normalizeInfiniteProductionHosts,
  validateInfiniteSiteSourceKey
} from "./validate.js"

export const infiniteProviderAdapter: ProviderAdapter = {
  id: "infinite",
  displayName: "Infinite",
  envKeys() {
    return []
  },
  plan(framework, artifact, context) {
    const infinite = artifact as InfinitePublicArtifact | undefined
    const consentMode = infinite?.consentMode
    // 0.6.0: NO mirror mode. The Infinite runtime emits only to Infinite; GA4 / PostHog install as
    // fully native, independent providers (their own page views, their own consent) — `context` is
    // no longer consulted for provider coupling.

    const blockers: string[] = []
    let collectPath: string = DEFAULT_INFINITE_COLLECT_PATH
    let downloadDestinationPath: string | undefined
    let productionHosts: string[] = []
    const configuredProductionHosts =
      context?.artifacts.productionHosts ?? infinite?.productionHosts
    if (infinite) {
      if (consentMode === undefined) {
        blockers.push(
          "Choose how Infinite first-party analytics handles consent: pass --infinite-consent-mode required and wire the external consent signal, or pass --infinite-consent-mode not-required to collect without consent (DNT/GPC still suppress collection)."
        )
      }
      const keyError = validateInfiniteSiteSourceKey(infinite.siteSourceKey)
      if (keyError) blockers.push(keyError)
      const normalizedPath = normalizeInfiniteCollectPath(infinite.collectPath)
      if ("error" in normalizedPath) blockers.push(normalizedPath.error)
      else collectPath = normalizedPath.path
      if (infinite.staticProxy !== undefined && infinite.staticProxy !== "vercel") {
        blockers.push("Infinite staticProxy must be vercel when supplied.")
      }
      if (infinite.apiOrigin !== undefined) {
        // An artifact FILE can carry apiOrigin unvalidated; the CLI flag/env were validated at parse.
        try {
          resolveInfiniteApiOrigin({ flag: infinite.apiOrigin })
        } catch (error) {
          blockers.push(error instanceof Error ? error.message : String(error))
        }
      }
      if (infinite.downloadDestinationPath !== undefined) {
        const normalizedDestination = normalizeInfiniteDownloadDestinationPath(
          infinite.downloadDestinationPath
        )
        if ("error" in normalizedDestination) blockers.push(normalizedDestination.error)
        else downloadDestinationPath = normalizedDestination.path
      }
    }
    if (configuredProductionHosts !== undefined || infinite) {
      const normalizedHosts = normalizeInfiniteProductionHosts(configuredProductionHosts ?? [])
      if ("error" in normalizedHosts) blockers.push(normalizedHosts.error)
      else productionHosts = normalizedHosts.hosts
    }
    const ready = blockers.length === 0
    const config: InfiniteBrowserConfig = {
      ...(infinite ? { siteSourceKey: infinite.siteSourceKey } : {}),
      collectPath,
      productionHosts,
      respectDnt: true,
      consent:
        consentMode === "not_required"
          ? { mode: "not_required" }
          : { mode: "required", storageKey: "infinite_analytics_consent" },
      ...(downloadDestinationPath !== undefined ? { downloadDestinationPath } : {}),
      // Only `false` is serialized — an absent flag keeps the runtime config byte-identical to 0.6.2.
      ...(infinite?.autocapture === false ? { autocapture: false } : {}),
      // Only `true` is serialized — an absent flag keeps the runtime config byte-identical (bots
      // are never counted). Synthetic/test sandbox sources only; installer-gated to non-prod hosts.
      ...(infinite?.allowAutomation === true ? { allowAutomation: true } : {})
    }
    return {
      assumptions: [
        infinite
          ? `Infinite collection is bound to ${productionHosts.join(", ")} through a same-origin proxy.`
          : "Infinite collection is dormant until a verified site source artifact is supplied.",
        ...(infinite && consentMode === "required"
          ? [
              "Required consent must be supplied by your consent UI: dispatch infinite:analytics-consent-change with detail: { granted: true } on grant and detail: { granted: false } on denial or revocation."
            ]
          : []),
        ...(infinite && (context?.artifacts.ga4 || context?.artifacts.posthog)
          ? [
              "GA4 and PostHog run independently of Infinite: each installs its own native bootstrap with its own page views and its own consent handling. Infinite never forwards browser events into them and never changes their configuration."
            ]
          : [])
      ],
      blockers,
      instructions: ready ? [runtimeInstruction(framework, config)] : []
    }
  }
}

function runtimeInstruction(
  framework: SupportedFramework,
  config: InfiniteBrowserConfig
): InstallInstruction {
  return {
    path: frameworkInstructionPath(framework),
    action: framework === "static-html" ? "modify" : "create",
    description: config.siteSourceKey
      ? "Embed the shared Infinite browser runtime with same-origin collection."
      : "Embed the shared browser runtime with Infinite collection dormant.",
    provider: "infinite",
    snippet:
      framework === "static-html"
        ? renderInfiniteBrowserTag(config)
        : renderInfiniteBrowserTag(config)
            .replace(/^<script[^>]*>/, "")
            .replace(/<\/script>$/, "")
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

export { renderInfiniteBrowserTag }
