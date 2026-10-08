import type { InstallManifestIds, WizardEditRecord } from "./wizard/contracts/jobs.js"

export const packageManagers = ["pnpm", "npm", "yarn", "bun"] as const
export type PackageManager = (typeof packageManagers)[number]

export type PackageManagerDetectionKind = PackageManager | "ambiguous" | "unknown"
export type RepoStatus = "clean" | "dirty" | "not-a-git-repo"
export type ApplyMode = "supported" | "plan-only"

export const supportedFrameworks = [
  "next-app-router",
  "next-pages-router",
  "vite-react",
  "static-html"
] as const
export type SupportedFramework = (typeof supportedFrameworks)[number]

/**
 * Frameworks whose analytics tag is injected as a managed `<script>` block into `index.html` (with
 * the config baked in at install time), rather than wired through a JS module + framework entrypoint.
 * Vite joins static-html here: the runtime self-installs its own SPA history hooks, so the React
 * entrypoint (`src/main.*`) is never read or edited.
 */
export function isHtmlInjectedFramework(framework: SupportedFramework): boolean {
  return framework === "static-html" || framework === "vite-react"
}

export const providerIds = ["infinite", "ga4", "posthog", "x", "meta"] as const
export type ProviderId = (typeof providerIds)[number]

/** Founder-facing provider names (plan output, adoption notes). */
export const providerLabels: Record<ProviderId, string> = {
  infinite: "Infinite",
  ga4: "Google Analytics",
  posthog: "PostHog",
  x: "X Pixel",
  meta: "Meta Pixel"
}

/** How an existing, unmanaged provider install was recognised. */
export type UnmanagedProviderVia = "snippet" | "gtm"

export interface UnmanagedProvider {
  provider: ProviderId
  via: UnmanagedProviderVia
  /** App-root-relative file the signature was found in (the first, in sorted walk order). */
  file: string
}

/**
 * A requested provider that already existed in the repo and was left byte-for-byte alone. `improve`
 * (decision 4, the wizard only) lists the in-place improvements proposed for it; each is a plan line
 * the user approves, and an unapproved line changes nothing. Absent = adopted byte-for-byte.
 */
export type AdoptedProvider = UnmanagedProvider & { improve?: ImproveLine[] }

/** The plan-line kinds an improvement to an ADOPTED provider can carry (each is "never" under --yes). */
export type ImproveLineKind =
  | "improve_additive"
  | "remove_duplicate"
  | "preview_guard_adopted"
  | "autoconfig_off_adopted"
  | "sensitive_pages"
  | "posthog_defaults_bump_adopted"
  | "capture_beside_adopted_pixel"
  | "retire_fbc_writer"

/**
 * One proposed improvement to an adopted provider. `owner: "code"` = the wizard makes a deterministic,
 * recorded, reversible edit (a vercel.json rewrite, the capture-only block, the autoConfig literal);
 * `owner: "agent"` = an agent job seeded only behind the approved line (`jobIds`).
 */
export interface ImproveLine {
  /** The plan line id this improvement is shown as. */
  id: string
  kind: ImproveLineKind
  provider: ProviderId
  /** Short target name (`proxy`, `history_change`, `capture`, `autoconfig`, …). */
  target: string
  text: string
  owner: "code" | "agent"
  /** Where the adopted code lives (app-root-relative), when known. */
  evidence: { file: string; line: number } | null
  jobIds?: string[]
}

export interface PackageManagerDetection {
  kind: PackageManagerDetectionKind
  reason: "lockfile" | "multiple-lockfiles" | "no-lockfile" | "override"
  lockfiles: string[]
}

export interface PackageManagerCommands {
  packageManager: PackageManager
  oneOff: string
  repeatableInstall: string
  repeatableRun: string
}

/**
 * The cost/privacy-relevant PostHog config surfaced by `inspect` when an existing PostHog
 * install is detected. Each value is the statically-read config value as written in the source,
 * or undefined when it is not statically determinable (rendered as "not detected"). This is
 * read-only reporting — inspect never changes the founder's config.
 */
export interface PosthogInitConfig {
  /** App-root-relative file the PostHog init was read from. */
  file: string
  /** 1-based line of the init call (1 when the file has evidence but no readable init). */
  line: number
  autocapture?: string
  disableSessionRecording?: string
  capturePageview?: string
  capturePageleave?: string
  persistence?: string
  apiHost?: string
  uiHost?: string
  /** PostHog's `defaults` bundle date (e.g. `2025-05-24`), as written. */
  defaults?: string
}

/** The FIRST PostHog init's options (as before), plus every init found (`inits`). */
export interface PosthogConfigSummary extends PosthogInitConfig {
  inits: PosthogInitConfig[]
}

export interface InspectResult {
  framework: string
  appRoot: string
  packageManager: string
  confidence: number
  existingProviders: string[]
  repoStatus: RepoStatus
  assumptions: string[]
  blockers: string[]
  detectedFiles: string[]
  /** Present when an existing PostHog install is detected — its cost/privacy-relevant options. */
  posthogConfig?: PosthogConfigSummary
}

export interface InstallPlan {
  framework: string
  providers: string[]
  files: string[]
  envKeys: string[]
  applyMode: ApplyMode
  instructions: InstallInstruction[]
  assumptions: string[]
  blockers: string[]
  confidence: number
  appRoot: string
  packageManager: string
  repoStatus: RepoStatus
  workspaceId?: string
  artifacts: WorkspaceInstallArtifacts
  /** Requested providers that already exist unmanaged in the repo; removed from `providers` and
   *  from the instructions, never installed twice, never touched. */
  adopted: AdoptedProvider[]
  /** Present when the plan was made with `--server-lane`. */
  serverLane?: ServerLanePlan
  /** The wizard only: the user's own config(s) the managed rewrites still have to be added to (an agent job). */
  deferredConfigRewrites?: DeferredConfigRewrite[]
}

/**
 * A file infinite-tag could NOT safely edit itself, and the exact snippet the user must add. Its
 * presence means the install is INCOMPLETE — the pixel is not live until the snippet is added — so
 * apply/install/verify treat it as a distinct "needs action" state, never as a completed install.
 */
export interface ManualRequirement {
  /** App/root-relative file the snippet belongs in. */
  path: string
  /** Why infinite-tag could not do it automatically. */
  reason: string
  /** The exact lines to add by hand. */
  snippet: string
  /** The installer itself refused this source edit; it is never delegated to a worker. */
  ownerBoundary?: { kind: "frozen_unit" | "policy_page" | "unproven_wiring"; file: string; line: number; unitHash?: string; lineOffset?: number; unitOrdinal?: number }
}

export interface ManagedCaptureRecord {
  module: string
  entrypoints: string[]
  pixelFiles: string[]
  mode: "required" | "not_required"
  strategy: "first_import" | "before_interactive" | "blocking_script"
  moduleHash: string
}

export interface ApplyResult {
  changedFiles: string[]
  manifestPath: string
  warnings: string[]
  /** Present and non-empty when the install completed only partially and needs a manual step. */
  requiresManual?: ManualRequirement[]
  /** Present when the plan carried `--server-lane`. */
  serverLane?: {
    manifest: ServerLaneManifest
    /** The rendered agent brief (also written to briefPath unless an unmanaged file was in the way). */
    brief: string
    briefWritten: boolean
  }
}

export interface UninstallResult {
  removedFiles: string[]
  restoredFiles: string[]
  warnings: string[]
  manifestPath: string | null
  /** Receipt edits reversed this run (repo-root-relative files), newest first. */
  editsReversed?: string[]
  /** Receipt edits NOT reversed because the file changed since ("changed since; left as is"). */
  editsLeftAsIs?: string[]
}

export interface VerifyResult {
  buildOk: boolean
  routeChecks: string[]
  beaconChecks: string[]
  warnings: string[]
  /** Recorded manual steps still outstanding — the managed files can verify while the pixel is not live. */
  requiresManual?: Array<{ path: string; reason: string }>
}

export type InfiniteConsentMode = "required" | "not_required"

export interface InfinitePublicArtifact {
  siteSourceKey: string
  collectPath: "/infinite/ledger" | string
  productionHosts: string[]
  staticProxy?: "vercel"
  /** Optional for legacy artifact decoding; plans with an Infinite source require an explicit value. */
  consentMode?: InfiniteConsentMode
  /** The workspace's conversion destination for download-intent clicks. Absent = the platform
   *  default "/download" — must match the source's cloud config or the collect boundary rejects. */
  downloadDestinationPath?: string
  /** The API origin the same-origin route proxies to. Absent = INFINITE_API_ORIGIN. Never reaches
   *  the browser runtime — it only shapes the Vercel/Next rewrite destination. */
  apiOrigin?: string
  /** `false` turns unmarked-click autocapture off. Absent = on (the 0.6.1+ default). */
  autocapture?: boolean
  /**
   * `true` lets automation-driven browsers (navigator.webdriver) be counted, for SYNTHETIC/TEST
   * sandbox sources only — never a production source (the installer hard-refuses it on production
   * hosts). Absent/false = the production default (bots are never counted). See the runtime.
   */
  allowAutomation?: boolean
  /**
   * `true` when the site already runs its own analytics or ad pixels: the tag starts when they start
   * and stops when they stop, so the site's own banner governs it the same way. Absent = start on load.
   */
  followSitePixels?: boolean
  /**
   * Root-relative paths where the Infinite browser runtime should emit nothing. Only an explicit owner choice: the
   * wizard never fills it from another tool's list (review P1-6: the PostHog sensitive-page list hid /checkout and
   * /success from Infinite).
   */
  excludedPaths?: string[]
  /**
   * The site's own routes where it keeps its ad and analytics pixels off (a cart, a success page). Used only with
   * `followSitePixels`: on these routes the absence of the site's pixels is not read as a refusal, and the tag carries
   * the decision it saw earlier in the same tab session. See the runtime's follow-mode comment.
   */
  pixelFreePaths?: string[]
  /**
   * `true` when infinite-tag installed the Meta pixel (it sets `disablePushState`) on a single-page app whose own code
   * sends no Meta PageView on a route change: the runtime's history hook sends one per route change (parity gap 8).
   */
  metaPageViews?: boolean
}

export interface InfiniteBrowserConfig {
  siteSourceKey?: string
  collectPath: string
  productionHosts: string[]
  respectDnt: boolean
  consent:
    | {
        mode: "not_required"
        /** The site's own pixel globals to follow (the tag itself names no provider). Absent = start on load. */
        followSitePixels?: readonly string[]
      }
    | { mode: "required"; storageKey: "infinite_analytics_consent" }
  /** Conversion destination for app_download_click detection. Absent = "/download". */
  downloadDestinationPath?: string
  /** `false`: unmarked links/buttons emit nothing; marked CTAs, the conversion destination, Stripe
   *  checkout buckets, data-conversion markers and sign-up paths still emit. Absent = on. */
  autocapture?: boolean
  /** `true`: count automation-driven browsers (navigator.webdriver) and lift the loopback-host
   *  exclusion, for SYNTHETIC/TEST sandbox sources only. Every WebDriver event is stamped
   *  `automation: true`. The installer hard-refuses this on production hosts. Absent = off. */
  allowAutomation?: boolean
  /** Root-relative paths where page views, clicks, submits and helper-recorded events emit nothing. */
  excludedPaths?: string[]
  /** Follow mode only: the site's own pixel-free routes (see `InfinitePublicArtifact.pixelFreePaths`). */
  pixelFreePaths?: string[]
  /** `true`: send `fbq('track', 'PageView')` on each client-side route change (managed pixel, see the artifact). */
  metaPageViews?: boolean
}

/**
 * What `window.__infiniteHandoffContext()` returns — the narrow, consent-gated context the site
 * reads when a visitor clicks Download so a browser journey can be handed to the desktop app.
 *
 * It is attribution context, never a capability: no event emitter, no `track()`, no workspace,
 * authority, environment, endpoint, or cloud knowledge. The ids are the runtime's OWN random
 * localStorage/sessionStorage ids — the accessor mints no new identity — and the accessor exists
 * only for a configured source on a verified production host. It returns `null` (never a silent
 * identity) whenever consent is absent, denied, or defaulted away by DNT/GPC.
 */
export interface InfiniteHandoffContext {
  siteSourceKey: string
  anonymousId: string
  sessionId: string
  url: string
}

export interface MetaPublicArtifact {
  pixelId: string
  /** The wizard's answer also governs capture when no Infinite tag is installed. */
  consentMode?: InfiniteConsentMode
  /**
   * ADOPTED pixel: emit only the managed `_fbc` landing capture (no pixel bootstrap) beside the pixel the
   * site already has. Set by an approved plan line (wf5-PORT-PLAN row 5); `pixelId` names the adopted
   * pixel. Absent = a full managed install.
   */
  captureOnly?: boolean
  /**
   * `--meta-advanced-matching on|off`. ABSENT = OFF, and only an explicit `true` installs it.
   *
   * Manual Advanced Matching: the page defines `window.infiniteMetaAdvancedMatch`, which the
   * CUSTOMER's own code calls with a raw email / external id once it knows who the visitor is.
   * The accessor hashes them (sha256, once) before anything reaches Meta, and never reads the
   * page — scraping is Meta's AUTOMATIC Advanced Matching, which this installer refuses. Off by
   * default because sending a visitor's contact details from a customer's own pages is the
   * customer's decision, exactly like the `autoConfig` opt-out it sits beside.
   */
  advancedMatching?: boolean
}

export interface Ga4PublicArtifact {
  measurementId: string
}

/**
 * The reverse-proxy ingestion setup for PostHog. Its PRESENCE on a PosthogPublicArtifact is
 * the signal that the framework adapter must inject the first-party `/ingest` rewrites so
 * ad-blockers can't drop analytics. `path` is the browser-facing api_host prefix (e.g.
 * `/ingest`); `assetsHost`/`ingestHost` are the real PostHog upstreams the rewrites forward to.
 */
export interface PosthogProxySpec {
  path: string
  assetsHost: string
  ingestHost: string
}

export interface PosthogPublicArtifact {
  projectKey: string
  apiHost: string
  /** PostHog app host for the toolbar/app-links (posthog.init ui_host); region-derived by default. */
  uiHost?: string
  /** When present, the framework adapter injects the reverse-proxy rewrites. */
  proxy?: PosthogProxySpec
  /**
   * PostHog's `defaults` bundle. ABSENT = keep what the site's managed PostHog already carries (read from
   * the managed files the previous manifest lists; "2025-05-24" for every install made before 0.12), or
   * "2026-01-30" on a fresh install (infinite.fast's value). Moving an existing install to a new bundle
   * changes what is measured, so it happens only when this is set explicitly (an approved plan line), and
   * the plan then says "measurement changed".
   */
  defaults?: "2025-05-24" | "2026-01-30"
  /**
   * Decision 17: pages where session replay and autocapture are OFF (`disable_session_recording: true`,
   * `autocapture: false` at init), from an approved plan line. Root-relative paths; a trailing slash is
   * ignored. Absent or empty = PostHog's own defaults everywhere.
   */
  sensitivePaths?: string[]
}

export interface XPublicArtifact {
  pixelId: string
  eventTagIds: string[]
}

export interface WorkspaceInstallArtifacts {
  /** Explicit host allowlist for the shared browser runtime (Infinite collection only — the runtime
   *  forwards nothing into GA4/PostHog; those providers install natively, and the site's own code
   *  reaches them through the managed helpers). */
  productionHosts?: string[]
  infinite?: InfinitePublicArtifact
  ga4?: Ga4PublicArtifact
  posthog?: PosthogPublicArtifact
  x?: XPublicArtifact
  meta?: MetaPublicArtifact
  /**
   * The preview guard (decision 3; decision 8 for Meta) around the managed GA4, PostHog and Meta
   * bootstraps (`src/host-guard.ts`). `exempt` = the production hosts that always fire; `deny` = extra
   * preview hosts on top of `contracts/host-deny-v1.json`. Absent = no guard (the plain installer).
   */
  hostGuard?: { mode: "deny"; exempt: string[]; deny: string[] }
  /**
   * The managed conversion helpers (decisions 9 and 13, `src/conversions/`). Only an explicit
   * `helpers: true` emits them. Absent = none (the plain installer's bytes are unchanged).
   */
  conversions?: { helpers: boolean }
}

export interface InstallManifest {
  managedCapture?: ManagedCaptureRecord
  workspaceId: string
  /** The wizard run that last wrote the managed-file content hashes. */
  runId?: string
  appRoot: string
  framework: SupportedFramework
  providers: ProviderId[]
  files: string[]
  envKeys: string[]
  contentHashes: Record<string, string>
  configOwnership?: Record<string, ManagedConfigOwnership>
  /** Present when `--server-lane` installed the lossless server lane; root-relative paths. */
  serverLane?: ServerLaneManifest
  /**
   * Manual steps recorded at apply time (the `requires_manual_snippet` state). The snippet is stored
   * so verify can check the target file against on-disk reality — a requirement is SATISFIED once the
   * file actually contains the wiring, not merely because it was recorded here.
   */
  requiresManual?: ManualRequirement[]
  /**
   * §3e.6 the edit receipt: every change the wizard or an agent made to a file it does not own as a
   * whole (improve edits, guard wraps, the npm job's package.json + lockfile, agent job edits), with
   * exact text edits so `uninstall` reverses each one byte for byte, newest first, only while the
   * file still hashes to `afterHash`. Absent on installs made without the wizard.
   */
  edits?: WizardEditRecord[]
  /** §3e.6 the public IDs this install emitted (they are in the committed code anyway); `doctor` reads them. */
  ids?: InstallManifestIds
  wiringVersion: number
  verifiedAt: string | null
}

export interface ServerLaneManifest {
  mode: ServerLaneMode
  /** The middleware/proxy file infinite-tag created or patched (ownership in configOwnership). */
  middleware?: string
  /** The managed lib/infinite-server-lane.ts module. */
  module?: string
  /** The written INSTALL-SERVER-LANE.md root pointer (banner-gated removal, never hash-verified). */
  brief?: string
  /** The full agent guide under docs/ (docs/infinite-server-lane.md); banner-gated removal like brief. */
  guide?: string
  /**
   * Non-Next targets: every whole file the lane created, root-relative, each with a "created"
   * record in configOwnership so uninstall deletes it only when it is byte-identical.
   */
  created?: string[]
  /**
   * Directories the lane itself had to create, root-relative and deepest-first. Uninstall prunes
   * ONLY these, and only while empty — a `netlify/` or `functions/` directory the customer already
   * had is part of their tree (and, for `netlify/`, is the hosting evidence), never ours to delete.
   */
  createdDirs?: string[]
}

export interface ManagedConfigInsertion {
  offset: number
  text: string
}

/** One reversible edit in ORIGINAL-file coordinates: `removed` was replaced by `inserted`. */
export interface ManagedTextEdit {
  offset: number
  removed: string
  inserted: string
}

export type ManagedConfigOwnership =
  | {
      kind: "created"
      installedHash: string
    }
  | {
      kind: "vercel-json-insertions"
      originalHash: string
      installedHash: string
      insertions: ManagedConfigInsertion[]
    }
  | {
      kind: "text-edits"
      originalHash: string
      installedHash: string
      edits: ManagedTextEdit[]
    }

/**
 * Which server lane was installed — the target name, so a manifest says what runs where.
 *   next-middleware   Next.js middleware.ts / proxy.ts + the managed module (any host).
 *   vercel-middleware Vercel's framework-agnostic root middleware.ts, for a non-Next framework.
 *   netlify-edge      A Netlify Edge Function under netlify/edge-functions/.
 *   cloudflare-pages  A Cloudflare Pages functions/_middleware.ts.
 *   node-module       A generated Node module the customer mounts (`app.use(...)`) themselves.
 *   brief             No file was written: the agent brief IS the install.
 */
export type ServerLaneMode =
  | "next-middleware"
  | "vercel-middleware"
  | "netlify-edge"
  | "cloudflare-pages"
  | "node-module"
  | "brief"

export type ServerLaneMiddlewareAction = "create" | "patch" | "keep" | "unpatchable"

export interface ServerLanePlan {
  mode: ServerLaneMode
  /** Root-relative path of the brief written into the project. */
  briefPath: string
  /** Root-relative path of the managed module (next-middleware mode). */
  modulePath?: string
  middleware?: {
    /** Root-relative path of the middleware/proxy file targeted. */
    path: string
    action: ServerLaneMiddlewareAction
    /** Why an existing file was left untouched (action "unpatchable"). */
    reason?: string
  }
  /**
   * Non-Next targets: the whole files the lane writes, root-relative and in write order.
   * "create" writes it, "keep" leaves an edited copy of ours alone, "manual" leaves someone
   * else's file alone and puts the exact addition in the brief.
   */
  created?: Array<{
    path: string
    role: "entry" | "module"
    action: "create" | "keep" | "manual"
    reason?: string
  }>
  /** Packages the generated entry imports that the repo may not depend on yet (Vercel: @vercel/functions). */
  installPackages?: string[]
  /** Human name of the chosen target, for the CLI ("Vercel root middleware (any framework)"). */
  targetLabel?: string
  /** The file or dependency that picked it ("vercel.json"), for the CLI's "why". */
  targetEvidence?: string
  envKeys: string[]
  /** Root-relative files the lane manages (hash-verified): middleware + module, or the target's files. */
  files: string[]
  assumptions: string[]
}

export interface FrameworkMatch {
  framework: SupportedFramework
  confidence: number
  files: string[]
  assumptions: string[]
}

export interface FrameworkPlanDraft {
  files: string[]
  applyMode: ApplyMode
  instructions: InstallInstruction[]
  assumptions: string[]
  blockers: string[]
  confidence: number
  /** `deferUnmanagedNextConfig`: the user's own Next config the rewrites still have to be added to (left as is). */
  deferredConfigRewrites?: DeferredConfigRewrite[]
}

/** A config file the installer leaves to the user / their agent, with the exact lines it needs (review I1 P1-2). */
export interface DeferredConfigRewrite {
  /** App-relative in a framework draft; repo-relative in an InstallPlan. */
  path: string
  snippet: string
}

export interface InstallInstruction {
  path: string
  /** "manual" = infinite-tag will NOT edit this file; the snippet is what the user adds by hand. */
  action: "create" | "modify" | "manual"
  description: string
  snippet: string
  provider?: ProviderId
  /** The managed conversion-helper script (`src/conversions/globals.ts`); it serves every provider. */
  helpers?: true
}

/** Optional context passed to FrameworkAdapter.plan so it can see cross-cutting install choices. */
export interface FrameworkPlanOptions {
  posthogProxy?: PosthogProxySpec
  infiniteProxy?: InfiniteProxySpec
  allowStaticVercelProxy?: boolean
  configOwnership?: Record<string, ManagedConfigOwnership>
  /** The manifest from a prior install, so an adapter can tell files IT wired from ones the user owns. */
  previousManifest?: InstallManifest | null
  /**
   * The wizard (review I1 P1-2): an existing, unmanaged Next config that lacks the rewrites is NOT a blocker;
   * the rest installs and the rewrites become a checked agent job (`deferredConfigRewrites`). The plain
   * installer leaves this unset and keeps refusing.
   */
  deferUnmanagedNextConfig?: boolean
}

export interface InfiniteProxySpec {
  path: string
  destination: string
}

export interface FrameworkAdapter {
  id: SupportedFramework
  displayName: string
  detect(root: string): FrameworkMatch | null
  plan(root: string, options?: FrameworkPlanOptions): FrameworkPlanDraft
  apply?(context: FrameworkApplyContext): FrameworkApplyResult
  uninstall?(context: FrameworkUninstallContext): FrameworkUninstallResult
}

export interface ProviderPlanDraft {
  assumptions: string[]
  blockers: string[]
  instructions: InstallInstruction[]
}

export interface FrameworkApplyContext {
  root: string
  appRoot: string
  plan: InstallPlan
  previousManifest: InstallManifest | null
}

export interface FrameworkApplyResult {
  changedFiles: string[]
  warnings: string[]
  configOwnership?: Record<string, ManagedConfigOwnership>
  /** Entrypoints the adapter could not safely wire; the install is incomplete until these are added. */
  requiresManual?: ManualRequirement[]
}

export interface FrameworkUninstallContext {
  root: string
  appRoot: string
  manifest: InstallManifest
  dryRun: boolean
}

export interface FrameworkUninstallResult {
  removedFiles: string[]
  restoredFiles: string[]
  warnings: string[]
}

export interface ProviderAdapter {
  id: ProviderId
  displayName: string
  envKeys(framework: SupportedFramework): string[]
  plan(
    framework: SupportedFramework,
    artifact: WorkspaceInstallArtifacts[ProviderId] | undefined,
    context?: {
      artifacts: WorkspaceInstallArtifacts
      /** The `defaults` value the site's current MANAGED PostHog carries (absent = no managed PostHog yet). */
      managedPosthogDefaults?: string
    }
  ): ProviderPlanDraft
}
