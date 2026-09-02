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

    const pixelError = validateMetaPixelId(pixelId)
    if (pixelError) {
      return { assumptions: [], blockers: [pixelError], instructions: [] }
    }

    return {
      assumptions: ["Meta wiring will use only the public pixelId artifact."],
      blockers: [],
      instructions: [
        {
          path: frameworkInstructionPath(framework),
          action: isHtmlInjectedFramework(framework) ? "modify" : "create",
          description: isHtmlInjectedFramework(framework)
            ? "Inject the Meta Pixel bootstrap into index.html."
            : "Add the Meta Pixel bootstrap to the managed analytics module.",
          provider: "meta",
          snippet: isHtmlInjectedFramework(framework)
            ? wrapHtmlSnippet(buildMetaPixelSnippet(pixelId!))
            : buildMetaPixelSnippet(pixelId!)
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

export function buildMetaPixelSnippet(pixelId: string): string {
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
    "fbq('track', 'PageView');"
  ].join("\n")
}

export function wrapHtmlSnippet(source: string): string {
  return ["<script>", source, "</script>"].join("\n")
}
