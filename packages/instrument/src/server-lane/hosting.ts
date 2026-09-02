// Where the site is HOSTED — a separate question from which framework built it.
//
// The framework (src/inspect.ts) decides what the pixel wires into; the host decides which server
// lane can actually run. A Vite/React SPA on Vercel gets Vercel's framework-agnostic root
// middleware; the same repo on Netlify gets an Edge Function. Detection is file/dependency
// evidence only — never a network call and never a guess from the framework id.
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { readWorkspacePackageJson } from "../frameworks/shared.js"

export type ServerLaneHosting = "vercel" | "netlify" | "cloudflare" | "node" | "unknown"

export interface HostingDetection {
  hosting: ServerLaneHosting
  /** The one file or dependency that decided it, for the CLI's "why". Null when unknown. */
  evidence: string | null
}

const VERCEL_CONFIG = "vercel.json"
const VERCEL_LINK = ".vercel/project.json"
const NETLIFY_CONFIG = "netlify.toml"
const NETLIFY_DIR = "netlify"
const CLOUDFLARE_PAGES_MIDDLEWARE = ["functions/_middleware.ts", "functions/_middleware.js"] as const
const WRANGLER_CONFIGS = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"] as const

function hasScopedDependency(appRootAbsolute: string, scope: string): string | null {
  const packageJson = readWorkspacePackageJson(appRootAbsolute)
  if (!packageJson) return null
  const names = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {})
  ]
  // Scope-prefix match only: "@vercel/analytics" counts, "vercelish-utils" does not.
  const match = names.find((name) => name.startsWith(`${scope}/`))
  return match ? `the "${match}" dependency` : null
}

function hasDependencyNamed(appRootAbsolute: string, dependency: string): string | null {
  const packageJson = readWorkspacePackageJson(appRootAbsolute)
  if (!packageJson) return null
  const present =
    packageJson.dependencies?.[dependency] !== undefined ||
    packageJson.devDependencies?.[dependency] !== undefined
  return present ? `the "${dependency}" dependency` : null
}

function firstExisting(appRootAbsolute: string, candidates: readonly string[]): string | null {
  return candidates.find((candidate) => existsSync(join(appRootAbsolute, candidate))) ?? null
}

function directoryExists(appRootAbsolute: string, relativePath: string): boolean {
  const stats = statSync(join(appRootAbsolute, relativePath), { throwIfNoEntry: false })
  return stats?.isDirectory() ?? false
}

/**
 * Which host serves this app root.
 *
 * Precedence: `vercel.json` first (an explicit Vercel config wins every tie — it is the file a
 * customer only writes when Vercel is the deploy target), then the strong per-host config files,
 * then dependency-only hints, then a bare Express dependency. Everything else is "unknown", which
 * means the brief is the install.
 */
export function detectHostingWithEvidence(appRootAbsolute: string): HostingDetection {
  if (existsSync(join(appRootAbsolute, VERCEL_CONFIG))) {
    return { hosting: "vercel", evidence: VERCEL_CONFIG }
  }

  const netlifyConfig = existsSync(join(appRootAbsolute, NETLIFY_CONFIG)) ? NETLIFY_CONFIG : null
  const netlifyDir = directoryExists(appRootAbsolute, NETLIFY_DIR) ? `the ${NETLIFY_DIR}/ directory` : null
  const netlifyDependency = hasScopedDependency(appRootAbsolute, "@netlify")
  const netlify = netlifyConfig ?? netlifyDir ?? netlifyDependency
  if (netlify) return { hosting: "netlify", evidence: netlify }

  const wrangler = firstExisting(appRootAbsolute, WRANGLER_CONFIGS)
  const pagesMiddleware = firstExisting(appRootAbsolute, CLOUDFLARE_PAGES_MIDDLEWARE)
  const cloudflareDependency = hasScopedDependency(appRootAbsolute, "@cloudflare")
  const cloudflare = wrangler ?? pagesMiddleware ?? cloudflareDependency
  if (cloudflare) return { hosting: "cloudflare", evidence: cloudflare }

  const vercelLink = existsSync(join(appRootAbsolute, VERCEL_LINK)) ? VERCEL_LINK : null
  const vercelDependency = hasScopedDependency(appRootAbsolute, "@vercel")
  const vercel = vercelLink ?? vercelDependency
  if (vercel) return { hosting: "vercel", evidence: vercel }

  const express = hasDependencyNamed(appRootAbsolute, "express")
  if (express) return { hosting: "node", evidence: express }

  return { hosting: "unknown", evidence: null }
}

export function detectHosting(appRootAbsolute: string): ServerLaneHosting {
  return detectHostingWithEvidence(appRootAbsolute).hosting
}

/**
 * True when a Cloudflare project looks like **Pages** (where `functions/_middleware.ts` runs)
 * rather than a plain Worker.
 *
 * Cloudflare docs: "Middleware is similar to standard Pages Functions but middleware is always
 * defined in a `_middleware.js` file in your project's `/functions` directory."
 * https://developers.cloudflare.com/pages/functions/middleware/
 *
 * Pages projects may now also carry a wrangler config, so its mere presence proves nothing. A
 * `main = ` entrypoint is a Workers-only key, so a wrangler config that declares one is a Worker
 * and gets the brief's Worker snippet instead of a written file.
 */
export function isCloudflarePagesProject(appRootAbsolute: string): boolean {
  if (directoryExists(appRootAbsolute, "functions")) return true
  const wrangler = firstExisting(appRootAbsolute, WRANGLER_CONFIGS)
  if (!wrangler) return false
  const source = readFileSync(join(appRootAbsolute, wrangler), "utf8")
  if (/pages_build_output_dir/.test(source)) return true
  return !/^\s*"?main"?\s*[:=]/m.test(source)
}
