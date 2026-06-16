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

export const providerIds = ["ga4", "posthog", "x"] as const
export type ProviderId = (typeof providerIds)[number]

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
}

export interface ApplyResult {
  changedFiles: string[]
  manifestPath: string
  warnings: string[]
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
}

export interface Ga4PublicArtifact {
  measurementId: string
}

export interface PosthogPublicArtifact {
  projectKey: string
  apiHost: string
}

export interface XPublicArtifact {
  pixelId: string
  eventTagIds: string[]
}

export interface WorkspaceInstallArtifacts {
  ga4?: Ga4PublicArtifact
  posthog?: PosthogPublicArtifact
  x?: XPublicArtifact
}

export interface InstallManifest {
  workspaceId: string
  appRoot: string
  framework: SupportedFramework
  providers: ProviderId[]
  files: string[]
  envKeys: string[]
  contentHashes: Record<string, string>
  wiringVersion: number
  verifiedAt: string | null
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
  action: "create" | "modify"
  description: string
  snippet: string
  provider?: ProviderId
}

export interface FrameworkAdapter {
  id: SupportedFramework
  displayName: string
  detect(root: string): FrameworkMatch | null
  plan(root: string): FrameworkPlanDraft
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
}

export interface FrameworkApplyResult {
  changedFiles: string[]
  warnings: string[]
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
    artifact: WorkspaceInstallArtifacts[ProviderId] | undefined
  ): ProviderPlanDraft
}
