// Netlify Edge Functions.
//
//   "To create an edge function to deploy with your site, write a JavaScript or TypeScript file
//    stored in your edge functions directory. The default edge functions directory is
//    YOUR_BASE_DIRECTORY/netlify/edge-functions."
//   — https://docs.netlify.com/build/edge-functions/get-started/
//
// The declaration is IN-FILE, so no customer file is edited at all. Netlify supports both:
//   export const config: Config = { path: "/*", excludedPath: ["/*.css", "/*.js"] }
//   [[edge_functions]] / path = "/*" / excludedPath = "/img/*" / function = "common"
//   — https://docs.netlify.com/build/edge-functions/declarations/
// The same page recommends netlify.toml only for ordering several edge functions
// ("If you want to customize the order in which multiple edge functions run on a given path, we
// recommend that you add the declarations to netlify.toml"), which does not apply to one function —
// so we take the in-file form and leave netlify.toml untouched. The brief carries the toml
// equivalent for anyone who needs ordering.
//
// Handler + context, from https://docs.netlify.com/build/edge-functions/api/ :
//   export default async (request: Request, context: Context) => { ... }
//   context.next() — "Invokes the next item in the request chain … you should only use this method
//   if you need access to the response body. In all other cases, you do not need to explicitly call
//   next." (so this function returns nothing and the chain continues)
//   context.waitUntil() — "allows you to extend the edge function's execution until the given
//   Promise it completed, without blocking the response to the client from being sent."
//   context.ip — "A string containing the client IP address."
//   Netlify.env.get(name) — "returns the string value of an environment variable with a given name"
import { SERVER_LANE_SECRET_ENV, SERVER_LANE_SOURCE_KEY_ENV } from "../helpers.js"

import {
  edgeLaneCoreSource,
  managedGeneratedFile,
  nonDocumentPrefixes,
  outcomeHelperSource,
  outcomeHelperTarget,
  type ServerLaneTargetDefinition,
  type TargetBuildInput
} from "./shared.js"

export const NETLIFY_EDGE_FUNCTION_NAME = "infinite-server-lane"
export const NETLIFY_EDGE_FUNCTION_PATH = `netlify/edge-functions/${NETLIFY_EDGE_FUNCTION_NAME}.ts`
export const NETLIFY_OUTCOME_PATH = "lib/infinite-outcome.ts"

/**
 * Static extensions the edge function never needs to see. Deliberately an explicit list rather than
 * a single catch-all:
 *
 *   `path`/`excludedPath` take "[`URLPattern`] expression[s]" and the docs' own asset example is
 *   `excludedPath: ["/*.css", "/*.js"]` — https://docs.netlify.com/build/edge-functions/declarations/
 *   URLPattern's wildcard is greedy and crosses "/": "The wildcard token (`*`) is a shorthand for an
 *   unnamed capturing group that matches all characters zero or more times… The wildcard is greedy"
 *   — https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API
 *
 * So the tempting `"/*.*"` does NOT mean "the last segment has a dot": it excludes any path with a
 * dot anywhere at any depth, which would silently drop a real page like `/v1.0/pricing`. This list
 * can only ever UNDER-exclude, and under-exclusion is free — `isInfiniteDocumentRequest` rejects
 * every extension exactly, so the declaration is a cold-start saving, never the correctness gate.
 */
export const NETLIFY_EXCLUDED_ASSET_EXTENSIONS = [
  "css",
  "js",
  "mjs",
  "map",
  "json",
  "xml",
  "txt",
  "ico",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "mp4",
  "webm",
  "pdf"
] as const

/** The in-file declaration: every path except assets and the prefixes the lane already skips. */
export function netlifyExcludedPaths(collectPath?: string): string[] {
  return [
    ...nonDocumentPrefixes(collectPath).map((prefix) => `${prefix}*`),
    ...NETLIFY_EXCLUDED_ASSET_EXTENSIONS.map((extension) => `/*.${extension}`)
  ]
}

/**
 * netlify/edge-functions/infinite-server-lane.ts — self-contained on purpose.
 *
 * Netlify runs edge functions on Deno, where a relative import needs its file extension and every
 * file under the edge-functions directory is itself a function. One file with the core inlined has
 * no resolution surface to get wrong.
 */
export function netlifyEdgeFunctionSource(input: TargetBuildInput): string {
  return managedGeneratedFile(
    [
      "// Infinite server lane — records every HTML document Netlify serves, then continues the chain.",
      "// Declared in-file (config below), so netlify.toml is never edited.",
      `//   ${SERVER_LANE_SECRET_ENV}  the source's server-event secret (site environment variables)`,
      `//   ${SERVER_LANE_SOURCE_KEY_ENV}      the public site source key (falls back to the value baked below)`
    ],
    String.raw`${edgeLaneCoreSource({ ...input, exported: false })}

/** The Netlify Edge Function context: https://docs.netlify.com/build/edge-functions/api/ */
interface InfiniteNetlifyContext {
  /** "A string containing the client IP address." */
  ip?: string
  waitUntil?: (promise: Promise<unknown>) => void
}

/** Netlify.env.get(name) is the documented reader; Deno.env is the fallback for local netlify dev. */
function infiniteNetlifyEnv(name: string): string {
  const scope = globalThis as {
    Netlify?: { env?: { get(name: string): string | undefined } }
    Deno?: { env?: { get(name: string): string | undefined } }
  }
  return scope.Netlify?.env?.get(name) ?? scope.Deno?.env?.get(name) ?? ""
}

export default async (request: Request, context: InfiniteNetlifyContext): Promise<void> => {
  try {
    const path = new URL(request.url).pathname
    if (isInfiniteDocumentRequest(request, path)) {
      const task = recordInfiniteDocumentRequest(request, {
        secret: infiniteNetlifyEnv(${JSON.stringify(SERVER_LANE_SECRET_ENV)}),
        sourceKey: infiniteNetlifyEnv(${JSON.stringify(SERVER_LANE_SOURCE_KEY_ENV)}),
        clientIp: context.ip
      })
      if (typeof context.waitUntil === "function") context.waitUntil(task)
    }
  } catch {
    // The lane never affects the response.
  }
  // Returning nothing continues the request chain without pulling the origin response body.
}

export const config = {
  path: "/*",
  excludedPath: ${JSON.stringify(netlifyExcludedPaths(input.collectPath))}
}`
  )
}

export const netlifyTarget: ServerLaneTargetDefinition = {
  mode: "netlify-edge",
  label: "Netlify Edge Function",
  installPackages: [],
  files: (appRootAbsolute) => [
    { path: outcomeHelperTarget(appRootAbsolute).path, role: "module" },
    { path: NETLIFY_EDGE_FUNCTION_PATH, role: "entry" }
  ],
  build: (input, appRootAbsolute) => {
    const outcome = outcomeHelperTarget(appRootAbsolute)
    return {
      [outcome.path]: outcomeHelperSource(input, outcome),
      [NETLIFY_EDGE_FUNCTION_PATH]: netlifyEdgeFunctionSource(input)
    }
  }
}
