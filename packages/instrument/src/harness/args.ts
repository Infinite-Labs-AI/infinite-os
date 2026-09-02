// `npx infinite-tag harness [flags]` — the flag surface from teardown §5.1, plus the tag's own
// artifact flags so a run can carry explicit public keys. Parsing is pure and throws on anything
// unknown; the CLI turns the throw into exit code 2 with the usage line.
import type { InfiniteConsentMode, PackageManager } from "../types.js"
import { normalizeInfiniteConsentMode } from "../workspace-artifacts.js"

import { HARNESS_PROVIDER_ORDER, type HarnessMode, type HarnessProviderId } from "./types.js"

export interface HarnessArgs {
  mode: HarnessMode
  root?: string
  appRoot?: string
  workspaceId?: string
  /** `--providers ga4,posthog` — restrict the install set; undefined = all resolvable. */
  providers?: HarnessProviderId[]
  /** `--adopt-existing` (default) / `--no-adopt-existing`. */
  adoptExisting: boolean
  /** `--conversions <file>` — a pre-approved proposal (the non-interactive marking path). */
  conversions?: string
  /** `--no-mark` — skip the conversion-marking phase entirely. */
  noMark: boolean
  serverLane: boolean
  /** `--url <prod-url>` — the URL verification loads (defaults to the first production host). */
  url?: string
  /** Skips the INSTALL confirmation only. Never approves conversion marking. */
  yes: boolean
  allowDirty: boolean
  json: boolean
  /** Write the agent brief and stop. */
  brief: boolean
  posthogQueryKey?: string
  packageManager?: PackageManager
  // The tag's artifact flags (explicit public keys win over saved artifacts and .env).
  artifactFile?: string
  ga4MeasurementId?: string
  posthogProjectKey?: string
  posthogApiHost?: string
  xPixelId?: string
  xEventTagIds: string[]
  metaPixelId?: string
  infiniteSiteSourceKey?: string
  infiniteCollectPath?: string
  infiniteProductionHosts: string[]
  infiniteStaticProxy?: "vercel"
  infiniteConsentMode?: InfiniteConsentMode
  infiniteDownloadDestinationPath?: string
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`)
  }
  return value
}

function parseProviders(value: string): HarnessProviderId[] {
  const out: HarnessProviderId[] = []
  for (const raw of value.split(",")) {
    const token = raw.trim().toLowerCase()
    if (token === "") continue
    if (!(HARNESS_PROVIDER_ORDER as readonly string[]).includes(token)) {
      throw new Error(`--providers: unknown provider "${token}" (expected any of ${HARNESS_PROVIDER_ORDER.join(", ")}).`)
    }
    if (!out.includes(token as HarnessProviderId)) out.push(token as HarnessProviderId)
  }
  if (out.length === 0) throw new Error("--providers needs at least one provider.")
  return out
}

export function parseHarnessArgs(argv: readonly string[]): HarnessArgs {
  const parsed: HarnessArgs = {
    mode: "apply",
    adoptExisting: true,
    noMark: false,
    serverLane: false,
    yes: false,
    allowDirty: false,
    json: false,
    brief: false,
    xEventTagIds: [],
    infiniteProductionHosts: []
  }
  let modeFlags = 0
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]
    switch (token) {
      case "--check":
        parsed.mode = "check"
        modeFlags += 1
        break
      case "--plan":
        parsed.mode = "plan"
        modeFlags += 1
        break
      case "--apply":
        parsed.mode = "apply"
        modeFlags += 1
        break
      case "--verify-only":
        parsed.mode = "verify-only"
        modeFlags += 1
        break
      case "--root":
        parsed.root = requireValue(token, next)
        index += 1
        break
      case "--app-root":
        parsed.appRoot = requireValue(token, next)
        index += 1
        break
      case "--workspace":
        parsed.workspaceId = requireValue(token, next)
        index += 1
        break
      case "--providers":
        parsed.providers = parseProviders(requireValue(token, next))
        index += 1
        break
      case "--adopt-existing":
        parsed.adoptExisting = true
        break
      case "--no-adopt-existing":
        parsed.adoptExisting = false
        break
      case "--conversions":
        parsed.conversions = requireValue(token, next)
        index += 1
        break
      case "--no-mark":
        parsed.noMark = true
        break
      case "--server-lane":
        parsed.serverLane = true
        break
      case "--url":
        parsed.url = requireValue(token, next)
        index += 1
        break
      case "--yes":
        parsed.yes = true
        break
      case "--allow-dirty":
        parsed.allowDirty = true
        break
      case "--json":
        parsed.json = true
        break
      case "--brief":
        parsed.brief = true
        break
      case "--posthog-query-key":
        parsed.posthogQueryKey = requireValue(token, next)
        index += 1
        break
      case "--package-manager": {
        const value = requireValue(token, next)
        if (value !== "pnpm" && value !== "npm" && value !== "yarn" && value !== "bun") {
          throw new Error(`Unsupported package manager override: ${value}`)
        }
        parsed.packageManager = value
        index += 1
        break
      }
      case "--artifact-file":
        parsed.artifactFile = requireValue(token, next)
        index += 1
        break
      case "--ga4-measurement-id":
        parsed.ga4MeasurementId = requireValue(token, next)
        index += 1
        break
      case "--posthog-project-key":
        parsed.posthogProjectKey = requireValue(token, next)
        index += 1
        break
      case "--posthog-api-host":
        parsed.posthogApiHost = requireValue(token, next)
        index += 1
        break
      case "--x-pixel-id":
        parsed.xPixelId = requireValue(token, next)
        index += 1
        break
      case "--x-event-tag-id":
        parsed.xEventTagIds.push(requireValue(token, next))
        index += 1
        break
      case "--meta-pixel-id":
        parsed.metaPixelId = requireValue(token, next)
        index += 1
        break
      case "--infinite-site-source-key":
        parsed.infiniteSiteSourceKey = requireValue(token, next)
        index += 1
        break
      case "--infinite-collect-path":
        parsed.infiniteCollectPath = requireValue(token, next)
        index += 1
        break
      case "--infinite-production-host":
        parsed.infiniteProductionHosts.push(requireValue(token, next))
        index += 1
        break
      case "--infinite-static-proxy": {
        const value = requireValue(token, next)
        if (value !== "vercel") throw new Error("--infinite-static-proxy currently supports only: vercel")
        parsed.infiniteStaticProxy = value
        index += 1
        break
      }
      case "--infinite-consent-mode":
        parsed.infiniteConsentMode = normalizeInfiniteConsentMode(requireValue(token, next))
        index += 1
        break
      case "--infinite-download-destination-path":
        parsed.infiniteDownloadDestinationPath = requireValue(token, next)
        index += 1
        break
      default:
        throw new Error(`Unknown argument: ${token}. Run infinite-tag help for usage.`)
    }
  }
  if (modeFlags > 1) {
    throw new Error("Pick one of --check, --plan, --apply, --verify-only.")
  }
  return parsed
}

/** True when any explicit artifact input was given (then saved artifacts are not discovered). */
export function hasExplicitArtifacts(args: HarnessArgs): boolean {
  return (
    args.artifactFile !== undefined ||
    args.ga4MeasurementId !== undefined ||
    args.posthogProjectKey !== undefined ||
    args.posthogApiHost !== undefined ||
    args.xPixelId !== undefined ||
    args.xEventTagIds.length > 0 ||
    args.metaPixelId !== undefined ||
    args.infiniteSiteSourceKey !== undefined ||
    args.infiniteCollectPath !== undefined ||
    args.infiniteProductionHosts.length > 0 ||
    args.infiniteStaticProxy !== undefined ||
    args.infiniteConsentMode !== undefined
  )
}

export const HARNESS_HELP_LINES = [
  "Harness (one runbook: adopt what exists, install what is missing, mark conversions, verify, report):",
  "  harness [--check | --plan | --apply | --verify-only]  default --apply (plan → confirm → apply → verify)",
  "  --providers ga4,posthog,meta,x,infinite  Restrict the set; default = every resolvable provider",
  "  --adopt-existing | --no-adopt-existing   Adopt an unmanaged tag (default) or refuse to install beside it",
  "  --conversions <file>                      Pre-approved conversions (the non-interactive marking path)",
  "  --no-mark                                 Skip conversion marking entirely",
  "  --url <prod-url>                          The URL verification loads (defaults to the first production host)",
  "  --posthog-query-key <key>                 Optional personal key with Query Read, to read PostHog back",
  "  --brief                                   Write .infinite/harness-brief.json and stop",
  "  --yes skips the install confirmation only — it never approves conversion marking;",
  "  a non-interactive run needs --conversions or --no-mark (exit 2, INF_ARGS_CONVERSIONS_REQUIRED).",
  "  Standalone runs cannot read receipts back: providers print 'installed, not verifiable';",
  "  run `infinite analytics` from the desktop CLI to verify."
]
