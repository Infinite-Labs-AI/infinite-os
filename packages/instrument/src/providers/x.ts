import type { InstallInstruction, ProviderAdapter, SupportedFramework } from "../types.js"
import { jsLiteral, validateXEventTagIds, validateXPixelId } from "./validate.js"

function frameworkEnvKeys(framework: SupportedFramework): string[] {
  switch (framework) {
    case "next-app-router":
    case "next-pages-router":
      return ["NEXT_PUBLIC_X_EVENT_TAG_IDS", "NEXT_PUBLIC_X_PIXEL_ID"]
    case "vite-react":
      return ["VITE_X_EVENT_TAG_IDS", "VITE_X_PIXEL_ID"]
    case "static-html":
      return []
  }
}

export const xProviderAdapter: ProviderAdapter = {
  id: "x",
  displayName: "X",
  envKeys(framework) {
    return frameworkEnvKeys(framework)
  },
  plan(framework, artifact) {
    const pixelId =
      artifact && typeof artifact === "object" && "pixelId" in artifact ? artifact.pixelId : undefined
    const eventTagIds =
      artifact && typeof artifact === "object" && "eventTagIds" in artifact
        ? artifact.eventTagIds
        : undefined

    const blockers: string[] = []
    const pixelError = validateXPixelId(pixelId)
    if (pixelError) {
      blockers.push(pixelError)
    }
    const tagsError = validateXEventTagIds(eventTagIds)
    if (tagsError) {
      blockers.push(tagsError)
    }

    return {
      assumptions:
        blockers.length === 0
          ? ["X wiring will use only the public pixelId and eventTagIds artifacts."]
          : [],
      blockers,
      instructions:
        blockers.length === 0
          ? [
              {
                path: frameworkInstructionPath(framework),
                action: framework === "static-html" ? "modify" : "create",
                description:
                  framework === "static-html"
                    ? "Inject the X public pixel bootstrap into index.html."
                    : "Add the X public pixel bootstrap to the managed analytics module.",
                provider: "x",
                snippet:
                  framework === "static-html"
                    ? wrapHtmlSnippet(buildXBootstrapSnippet(pixelId!, eventTagIds!))
                    : buildXBootstrapSnippet(pixelId!, eventTagIds!)
              }
            ]
          : []
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

export function buildXBootstrapSnippet(pixelId: string, eventTagIds: string[]): string {
  return [
    `window.__INFINITE_X_EVENT_TAG_IDS = ${jsLiteral(eventTagIds)};`,
    "!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments)},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');",
    `twq('config', ${jsLiteral(pixelId)});`
  ].join("\n")
}

function wrapHtmlSnippet(source: string): string {
  return ["<script>", source, "</script>"].join("\n")
}
