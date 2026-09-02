// Vercel, any framework that is not Next.js.
//
// Vercel's Routing Middleware is framework-agnostic — a Vite/React SPA, a static HTML site, or a
// SvelteKit app all get the same root `middleware.ts`:
//
//   "You can use Routing Middleware with any framework."
//   — https://vercel.com/docs/routing-middleware
//   "Create a file called `middleware.ts` in your project root (same level as your `package.json`)"
//   — https://vercel.com/docs/routing-middleware/getting-started
//   "The Routing Middleware must be a default export, with the function being named anything you
//    like." … For "Other Frameworks" the handler receives `request: Request`, `context: RequestContext`.
//   — https://vercel.com/docs/routing-middleware/api
//
// The continue helper and waitUntil come from `@vercel/functions` (the docs' non-Next import):
//   "import { next } from '@vercel/functions';" — https://vercel.com/docs/routing-middleware/api
//   "Import the `@vercel/functions` package (non-Next.js frameworks or Next.js versions below 15.1)"
//   — https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
//   "The `waitUntil()` method … accepts a Promise as an argument, which will keep the function
//    running until the Promise resolves." — https://vercel.com/docs/routing-middleware/api
//
// NOT for Astro: "You can't use `proxy` with frameworks that build their own routing middleware,
// such as Next.js and Astro." — https://vercel.com/docs/routing-middleware
import { SERVER_LANE_SECRET_ENV, SERVER_LANE_SOURCE_KEY_ENV } from "../helpers.js"

import {
  documentMatcherPattern,
  edgeLaneCoreSource,
  managedGeneratedFile,
  outcomeHelperSource,
  type ServerLaneTargetDefinition,
  type TargetBuildInput
} from "./shared.js"

export const VERCEL_MIDDLEWARE_PATH = "middleware.ts"
export const VERCEL_MODULE_PATH = "lib/infinite-server-lane.ts"
export const VERCEL_OUTCOME_PATH = "lib/infinite-outcome.ts"
export const VERCEL_MIDDLEWARE_PACKAGE = "@vercel/functions"

// Generated import lines live in constants so the package self-containment scanner
// (package-shape.test.ts) never mistakes them for this package's own imports.
const VERCEL_FUNCTIONS_IMPORT = `import { next } from "${VERCEL_MIDDLEWARE_PACKAGE}"`
const LANE_MODULE_IMPORT =
  'import { isInfiniteDocumentRequest, recordInfiniteDocumentRequest } from "./lib/infinite-server-lane"'

/** lib/infinite-server-lane.ts — the shared web-standard core as an importable module. */
export function vercelLaneModuleSource(input: TargetBuildInput): string {
  return managedGeneratedFile(
    [
      "// Infinite server lane — the document + outcome recorder, WebCrypto only (Edge-runtime safe).",
      "// Secrets come from the environment only; infinite-tag never writes them here.",
      `//   ${SERVER_LANE_SECRET_ENV}  the source's server-event secret (Infinite → Site Analytics → Settings → Conversions → Server events)`,
      `//   ${SERVER_LANE_SOURCE_KEY_ENV}      the public site source key (falls back to the value baked below)`
    ],
    edgeLaneCoreSource({ ...input, exported: true })
  )
}

/** middleware.ts — the root, framework-agnostic Vercel entry. */
export function vercelMiddlewareSource(input: TargetBuildInput): string {
  return managedGeneratedFile(
    [
      "// Infinite server lane — records every HTML document this deployment serves, then continues.",
      "// Vercel Routing Middleware runs for any framework and must live at the project root, next to",
      "// package.json: https://vercel.com/docs/routing-middleware/getting-started",
      "// Recording is fire-and-forget inside context.waitUntil(); it never blocks or fails a response."
    ],
    String.raw`${VERCEL_FUNCTIONS_IMPORT}
${LANE_MODULE_IMPORT}

/** Vercel hands framework-agnostic middleware a RequestContext carrying waitUntil(). */
interface InfiniteRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

export default function middleware(request: Request, context?: InfiniteRequestContext) {
  try {
    const path = new URL(request.url).pathname
    if (isInfiniteDocumentRequest(request, path)) {
      const task = recordInfiniteDocumentRequest(request, {
        secret: process.env.${SERVER_LANE_SECRET_ENV} ?? "",
        sourceKey: process.env.${SERVER_LANE_SOURCE_KEY_ENV} ?? ""
      })
      if (typeof context?.waitUntil === "function") context.waitUntil(task)
    }
  } catch {
    // The lane never affects the response.
  }
  return next()
}

// Every HTML document, and nothing else: no API routes, no platform internals, no files.
export const config = {
  matcher: [${JSON.stringify(documentMatcherPattern(input.collectPath))}]
}`
  )
}

export const vercelAnyTarget: ServerLaneTargetDefinition = {
  mode: "vercel-middleware",
  label: "Vercel root middleware (any framework)",
  installPackages: [VERCEL_MIDDLEWARE_PACKAGE],
  files: () => [
    { path: VERCEL_MODULE_PATH, role: "module" },
    { path: VERCEL_OUTCOME_PATH, role: "module" },
    { path: VERCEL_MIDDLEWARE_PATH, role: "entry" }
  ],
  build: (input) => ({
    [VERCEL_MODULE_PATH]: vercelLaneModuleSource(input),
    [VERCEL_OUTCOME_PATH]: outcomeHelperSource(input),
    [VERCEL_MIDDLEWARE_PATH]: vercelMiddlewareSource(input)
  })
}
