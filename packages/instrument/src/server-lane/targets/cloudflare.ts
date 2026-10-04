// Cloudflare Pages Functions middleware.
//
//   "Middleware is similar to standard Pages Functions but middleware is always defined in a
//    `_middleware.js` file in your project's `/functions` directory."
//   — https://developers.cloudflare.com/pages/functions/middleware/
//   "Pages Functions can be typed using the `PagesFunction` type." (we type the context inline
//    instead, so the generated file needs no @cloudflare/workers-types dependency)
//   — https://developers.cloudflare.com/pages/functions/typescript/
//
// Context, from https://developers.cloudflare.com/pages/functions/api-reference/ :
//   request — "This is the incoming Request."
//   next(input?, init?) — "Passes the request through to the next Function or to the asset server
//     if no other Function is available." (so the middleware must return it)
//   waitUntil(promise) — the standard fire-and-forget extension
//   env — "Holds the environment variables, secrets, and bindings for a Function."
//
// Client IP: "CF-Connecting-IP provides the client IP address connecting to Cloudflare to the
// origin web server." — https://developers.cloudflare.com/fundamentals/reference/http-headers/
//
// A plain Worker gets NO written file: its entry is the customer's own `fetch` handler, and there
// is no safe place to put ours. `isCloudflarePagesProject` in hosting.ts makes that call, and the
// brief carries the Worker snippet.
import { SERVER_LANE_SECRET_ENV, SERVER_LANE_SOURCE_KEY_ENV } from "../helpers.js"

import {
  edgeLaneCoreSource,
  managedGeneratedFile,
  outcomeHelperSource,
  outcomeHelperTarget,
  type ServerLaneTargetDefinition,
  type TargetBuildInput
} from "./shared.js"

export const CLOUDFLARE_MIDDLEWARE_PATH = "functions/_middleware.ts"
export const CLOUDFLARE_OUTCOME_PATH = "lib/infinite-outcome.ts"

/**
 * functions/_middleware.ts — self-contained on purpose: every file under `functions/` is a route,
 * so there is nowhere under it to put a shared module without publishing it as one.
 */
export function cloudflarePagesMiddlewareSource(input: TargetBuildInput): string {
  return managedGeneratedFile(
    [
      "// Infinite server lane — records every HTML document Pages serves, then passes the request on.",
      "// Recording rides ctx.waitUntil(), so it never blocks or fails a response.",
      `//   ${SERVER_LANE_SECRET_ENV}  the source's server-event secret (Pages → Settings → Variables and Secrets)`,
      `//   ${SERVER_LANE_SOURCE_KEY_ENV}      the public site source key (falls back to the value baked below)`
    ],
    String.raw`${edgeLaneCoreSource({ ...input, exported: false })}

/** The Pages Functions context: https://developers.cloudflare.com/pages/functions/api-reference/ */
interface InfiniteCloudflareContext {
  request: Request
  env: Record<string, string | undefined>
  next: () => Promise<Response>
  waitUntil: (promise: Promise<unknown>) => void
}

export const onRequest = async (context: InfiniteCloudflareContext): Promise<Response> => {
  try {
    const request = context.request
    const path = new URL(request.url).pathname
    if (isInfiniteDocumentRequest(request, path)) {
      context.waitUntil(
        recordInfiniteDocumentRequest(request, {
          secret: context.env[${JSON.stringify(SERVER_LANE_SECRET_ENV)}] ?? "",
          sourceKey: context.env[${JSON.stringify(SERVER_LANE_SOURCE_KEY_ENV)}] ?? "",
          clientIp: request.headers.get("cf-connecting-ip") ?? undefined
        })
      )
    }
  } catch {
    // The lane never affects the response.
  }
  return context.next()
}`
  )
}

export const cloudflarePagesTarget: ServerLaneTargetDefinition = {
  mode: "cloudflare-pages",
  label: "Cloudflare Pages functions/_middleware.ts",
  installPackages: [],
  files: (appRootAbsolute) => [
    { path: outcomeHelperTarget(appRootAbsolute).path, role: "module" },
    { path: CLOUDFLARE_MIDDLEWARE_PATH, role: "entry" }
  ],
  build: (input, appRootAbsolute) => {
    const outcome = outcomeHelperTarget(appRootAbsolute)
    return {
      [outcome.path]: outcomeHelperSource(input, outcome),
      [CLOUDFLARE_MIDDLEWARE_PATH]: cloudflarePagesMiddlewareSource(input)
    }
  }
}
