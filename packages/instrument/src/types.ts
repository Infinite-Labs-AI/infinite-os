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

/** A requested provider that already existed in the repo and was left byte-for-byte alone. */
export type AdoptedProvider = UnmanagedProvider

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
}

export interface InfiniteBrowserConfig {
  siteSourceKey?: string
  collectPath: string
  productionHosts: string[]
  respectDnt: boolean
  consent:
    | { mode: "not_required" }
    | { mode: "required"; storageKey: "infinite_analytics_consent" }
  /** Conversion destination for app_download_click detection. Absent = "/download". */
  downloadDestinationPath?: string
  /** `false`: unmarked links/buttons emit nothing; marked CTAs, the conversion destination, Stripe
   *  checkout buckets, data-conversion markers and sign-up paths still emit. Absent = on. */
  autocapture?: boolean
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
}

export interface XPublicArtifact {
  pixelId: string
  eventTagIds: string[]
}

export interface WorkspaceInstallArtifacts {
  /** Explicit host allowlist for the shared browser runtime (Infinite collection only — the
   *  runtime never forwards into GA4/PostHog since 0.6.0; those providers install natively). */
  productionHosts?: string[]
  infinite?: InfinitePublicArtifact
  ga4?: Ga4PublicArtifact
  posthog?: PosthogPublicArtifact
  x?: XPublicArtifact
  meta?: MetaPublicArtifact
}

export interface InstallManifest {
  workspaceId: string
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
  wiringVersion: number
  verifiedAt: string | null
}

export interface ServerLaneManifest {
  mode: ServerLaneMode
  /** The middleware/proxy file infinite-tag created or patched (ownership in configOwnership). */
  middleware?: string
  /** The managed lib/infinite-server-lane.ts module. */
  module?: string
  /** The written INSTALL-SERVER-LANE.md agent brief (banner-gated removal, never hash-verified). */
  brief?: string
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
}

export interface InstallInstruction {
  path: string
  /** "manual" = infinite-tag will NOT edit this file; the snippet is what the user adds by hand. */
  action: "create" | "modify" | "manual"
  description: string
  snippet: string
  provider?: ProviderId
}

/** Optional context passed to FrameworkAdapter.plan so it can see cross-cutting install choices. */
export interface FrameworkPlanOptions {
  posthogProxy?: PosthogProxySpec
  infiniteProxy?: InfiniteProxySpec
  allowStaticVercelProxy?: boolean
  configOwnership?: Record<string, ManagedConfigOwnership>
  /** The manifest from a prior install, so an adapter can tell files IT wired from ones the user owns. */
  previousManifest?: InstallManifest | null
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
    context?: { artifacts: WorkspaceInstallArtifacts }
  ): ProviderPlanDraft
}
