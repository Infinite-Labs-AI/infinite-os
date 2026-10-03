import { join } from "node:path"

import { conversionHelpersInstruction, conversionHelpersWanted } from "./conversions/globals.js"
import { getFrameworkAdapter, isSupportedFramework } from "./frameworks/index.js"
import { normalizeAppRelativePath } from "./frameworks/shared.js"
import { getProviderAdapter } from "./providers/index.js"
import { managedPosthogDefaults } from "./providers/posthog.js"
import { detectUnmanagedProviders, inspectWorkspace } from "./inspect.js"
import { infiniteProxySpec } from "./workspace-artifacts.js"
import { readInstallManifest } from "./manifest.js"
import { planServerLane } from "./server-lane/install.js"
import type {
  AdoptedProvider,
  ApplyMode,
  ImproveLine,
  InspectResult,
  InstallPlan,
  InstallInstruction,
  InstallManifest,
  PackageManager,
  ProviderId,
  ServerLanePlan,
  WorkspaceInstallArtifacts
} from "./types.js"
import { providerLabels } from "./types.js"

const providerOrder: ProviderId[] = ["ga4", "posthog", "x", "meta", "infinite"]

export interface PlanInstallationOptions {
  root: string
  inspect?: InspectResult
  workspaceId?: string
  packageManager?: PackageManager
  artifacts: WorkspaceInstallArtifacts
  /** `--server-lane`: add the lossless server lane (Next.js middleware, or the agent brief). */
  serverLane?: boolean
  /**
   * The wizard's in-place improvements per ADOPTED provider (decision 4). They ride on the adopted
   * entry (`adopted[].improve`) so the plan says what will change in the customer's own tag; they never
   * move the provider into the install set. Absent = adopted byte-for-byte.
   */
  improve?: Partial<Record<ProviderId, readonly ImproveLine[]>>
  /** The wizard: an unmanaged Next config without the rewrites becomes an agent job, not a blocker (review I1 P1-2). */
  deferUnmanagedNextConfig?: boolean
}

function selectedProviders(artifacts: WorkspaceInstallArtifacts): ProviderId[] {
  return providerOrder.filter((providerId) => artifacts[providerId] !== undefined)
}

/** "existing snippet" / "Google Tag Manager" — how the adopted install was recognised. */
export function adoptedViaLabel(via: AdoptedProvider["via"]): string {
  return via === "gtm" ? "Google Tag Manager" : "existing snippet"
}

/** One founder-facing line per adopted provider: `Google Analytics — index.html (existing snippet)`. */
export function adoptedProviderLine(entry: AdoptedProvider): string {
  return `${providerLabels[entry.provider]} — ${entry.file} (${adoptedViaLabel(entry.via)})`
}

export function planInstallation(options: PlanInstallationOptions): InstallPlan {
  const inspectResult =
    options.inspect ??
    inspectWorkspace(options.root, {
      packageManager: options.packageManager
    })
  const requestedProviders = selectedProviders(options.artifacts)
  const assumptions = [...inspectResult.assumptions]
  const blockers = [...inspectResult.blockers]

  if (!isSupportedFramework(inspectResult.framework)) {
    if (!blockers.includes("Unsupported repository shape for instrumentation.")) {
      blockers.push("Unsupported repository shape for instrumentation.")
    }

    const unsupportedServerLane = options.serverLane
      ? planServerLane({
          root: options.root,
          appRoot: inspectResult.appRoot,
          appRootAbsolute:
            inspectResult.appRoot === "." ? options.root : join(options.root, inspectResult.appRoot),
          framework: inspectResult.framework,
          previousManifest: null
        })
      : undefined
    return {
      framework: inspectResult.framework,
      providers: requestedProviders,
      files: [],
      envKeys: unsupportedServerLane?.envKeys ?? [],
      applyMode: "plan-only",
      instructions: [],
      assumptions,
      blockers,
      confidence: Math.min(inspectResult.confidence, 0.45),
      appRoot: inspectResult.appRoot,
      packageManager: inspectResult.packageManager,
      repoStatus: inspectResult.repoStatus,
      workspaceId: options.workspaceId,
      artifacts: options.artifacts,
      adopted: [],
      ...(unsupportedServerLane ? { serverLane: stripDraft(unsupportedServerLane) } : {})
    }
  }

  if (requestedProviders.length === 0 && !options.serverLane) {
    blockers.push("No supported public install artifacts were provided.")
  }

  const appRootAbsolute =
    inspectResult.appRoot === "." ? options.root : join(options.root, inspectResult.appRoot)

  // Harness rule: a requested provider that already exists in the repo (hand-pasted snippet, or
  // GA4 through a Tag Manager container) is ADOPTED — left byte-for-byte alone and dropped from the
  // install set — never refused and never installed a second time. A Tag Manager container only
  // proves GA4; any other requested provider still installs.
  const unmanagedProviders = detectUnmanagedProviders(appRootAbsolute)
  const adopted: AdoptedProvider[] = []
  const providers: ProviderId[] = []
  // Meta `captureOnly` is an approved plan line for an ADOPTED pixel (wf5-PORT-PLAN row 5, D8/D15): the
  // `_fbc` landing capture is added beside it and the pixel itself is left exactly as it is.
  const metaCaptureOnly = (options.artifacts.meta as { captureOnly?: unknown } | undefined)?.captureOnly === true
  let adoptedMetaCapture = false
  for (const providerId of requestedProviders) {
    const existing = unmanagedProviders.find((entry) => entry.provider === providerId)
    if (existing) {
      const improve = options.improve?.[providerId]
      if (improve && improve.length > 0) {
        adopted.push({ ...existing, improve: [...improve] })
        assumptions.push(
          `Existing ${providerLabels[providerId]} found in ${existing.file} (${adoptedViaLabel(existing.via)}); kept, never reinstalled. ${improve.length} in-place improvement${improve.length === 1 ? "" : "s"} proposed, each only on an approved plan line.`
        )
        continue
      }
      adopted.push(existing)
      assumptions.push(
        `Existing ${providerLabels[providerId]} found in ${existing.file} (${adoptedViaLabel(existing.via)}); left untouched. infinite-tag will not install a second copy.`
      )
      if (providerId === "meta" && metaCaptureOnly) adoptedMetaCapture = true
    } else if (providerId === "meta" && metaCaptureOnly) {
      // Capture-only exists for a pixel the site already has. Without one it would claim a pixel that
      // is not there, and the visitor would get a click-id cookie with no pixel to read it.
      blockers.push(
        "Meta click-id capture only (captureOnly) needs the site's existing Meta pixel, and none was found in this repo. Install the pixel instead (drop captureOnly), or point infinite-tag at the code that loads it."
      )
    } else {
      providers.push(providerId)
    }
  }
  // An adopted provider the wizard improves is not in the install set (its key is not an install
  // artifact), so it is listed here from the detection, with its improve lines.
  for (const providerId of providerOrder) {
    const improve = options.improve?.[providerId]
    if (!improve || improve.length === 0) continue
    if (providers.includes(providerId) || adopted.some((entry) => entry.provider === providerId)) continue
    const existing = unmanagedProviders.find((entry) => entry.provider === providerId)
    if (!existing) continue
    adopted.push({ ...existing, improve: [...improve] })
    assumptions.push(
      `Existing ${providerLabels[providerId]} found in ${existing.file} (${adoptedViaLabel(existing.via)}); kept, never reinstalled. ${improve.length} in-place improvement${improve.length === 1 ? "" : "s"} proposed, each only on an approved plan line.`
    )
  }

  // `--server-lane` alone is a complete install (the lane needs no browser artifact); the pixel
  // wiring is only planned when at least one provider remains to install. When everything
  // requested was adopted there is nothing to write — the plan says so instead of injecting an
  // empty managed block.
  // The managed conversion helpers (decisions 9 and 13) are their own reason to write the managed
  // block: they serve ADOPTED tools too, so an all-adopted plan that asked for them still writes it.
  const helpersWanted = conversionHelpersWanted(options.artifacts)
  const pixelWanted =
    providers.length > 0 ||
    helpersWanted ||
    adoptedMetaCapture ||
    (!options.serverLane && adopted.length === 0)
  const frameworkAdapter = getFrameworkAdapter(inspectResult.framework)
  const infiniteProxy = infiniteProxySpec(options.artifacts.infinite)
  const previousManifest = readInstallManifest(options.root)
  const configOwnership = appRelativeConfigOwnership(
    previousManifest?.configOwnership,
    inspectResult.appRoot
  )
  const frameworkDraft = pixelWanted
    ? frameworkAdapter?.plan(appRootAbsolute, {
        posthogProxy: options.artifacts.posthog?.proxy,
        infiniteProxy,
        allowStaticVercelProxy: options.artifacts.infinite?.staticProxy === "vercel",
        configOwnership,
        previousManifest,
        ...(options.deferUnmanagedNextConfig ? { deferUnmanagedNextConfig: true } : {})
      })
    : undefined

  if (frameworkDraft) {
    assumptions.push(...frameworkDraft.assumptions)
    blockers.push(...frameworkDraft.blockers)
  }

  const serverLaneDraft = options.serverLane
    ? planServerLane({
        root: options.root,
        appRoot: inspectResult.appRoot,
        appRootAbsolute,
        framework: inspectResult.framework,
        previousManifest
      })
    : undefined
  if (serverLaneDraft) {
    assumptions.push(...serverLaneDraft.assumptions)
    blockers.push(...serverLaneDraft.blockers)
  }

  const envKeys: string[] = []
  const instructions: InstallInstruction[] = []
  // First in the block, so the globals exist before any provider bootstrap runs.
  if (helpersWanted && frameworkDraft) {
    instructions.push(conversionHelpersInstruction(inspectResult.framework, options.artifacts))
  }
  // The adopted pixel's capture-only instruction (the adapter's `captureOnly` branch); `meta` stays in
  // `adopted`, never in `providers`, so the manifest never claims the customer's pixel as managed.
  if (adoptedMetaCapture && frameworkDraft) {
    const capturePlan = getProviderAdapter("meta").plan(inspectResult.framework, options.artifacts.meta, {
      artifacts: options.artifacts
    })
    assumptions.push(...capturePlan.assumptions)
    blockers.push(...capturePlan.blockers)
    instructions.push(...capturePlan.instructions)
  }
  const posthogDefaultsOnDisk = managedPosthogDefaults(options.root, previousManifest)
  for (const providerId of providers) {
    const adapter = getProviderAdapter(providerId)
    const providerPlan = adapter.plan(inspectResult.framework, options.artifacts[providerId], {
      artifacts: options.artifacts,
      ...(posthogDefaultsOnDisk !== undefined ? { managedPosthogDefaults: posthogDefaultsOnDisk } : {})
    })
    assumptions.push(...providerPlan.assumptions)
    blockers.push(...providerPlan.blockers)
    instructions.push(...providerPlan.instructions)
    envKeys.push(...adapter.envKeys(inspectResult.framework))
  }

  // 0.6.0: no dormant "mirror-only" Infinite runtime. Before mirror mode was removed, a GA4/PostHog
  // install without an Infinite source still embedded the Infinite runtime so it could forward
  // page views into those providers; the runtime now emits only to Infinite, so without a source
  // key there is nothing for it to do and nothing is embedded — GA4/PostHog install natively. The
  // runtime forwards nothing; conversions reach GA4/PostHog through the managed helpers the site's
  // own code calls (decisions 9 and 13), planned above when `conversions.helpers` is set.

  if (serverLaneDraft) {
    envKeys.push(...serverLaneDraft.envKeys)
  }
  const uniqueEnvKeys = [...new Set(envKeys)]
  const files = [
    ...(frameworkDraft?.files ?? []).map((file) =>
      normalizeAppRelativePath(inspectResult.appRoot, file)
    ),
    ...(serverLaneDraft?.files ?? [])
  ]
  const frameworkInstructions = (frameworkDraft?.instructions ?? []).map((instruction) => ({
    ...instruction,
    path: normalizeAppRelativePath(inspectResult.appRoot, instruction.path)
  }))
  const providerInstructions = instructions.map((instruction) => ({
    ...instruction,
    path: normalizeAppRelativePath(inspectResult.appRoot, instruction.path)
  }))
  // A server-lane-only plan has no framework draft; the lane itself is always applicable. An
  // all-adopted plan has nothing to write and is trivially applicable (apply is a no-op).
  const applyMode: ApplyMode =
    frameworkDraft?.applyMode ?? (serverLaneDraft || adopted.length > 0 ? "supported" : "plan-only")
  let confidence = frameworkDraft?.confidence ?? inspectResult.confidence
  if (providers.length > 0) {
    confidence = Math.min(0.99, confidence + Math.min(providers.length, 3) * 0.03)
  }
  if (blockers.length > 0) {
    confidence = Math.min(confidence, 0.45)
  }

  return {
    framework: inspectResult.framework,
    providers,
    files,
    envKeys: uniqueEnvKeys,
    applyMode,
    instructions: [...frameworkInstructions, ...providerInstructions],
    assumptions: [...new Set(assumptions)],
    blockers: [...new Set(blockers)],
    confidence,
    appRoot: inspectResult.appRoot,
    packageManager: inspectResult.packageManager,
    repoStatus: inspectResult.repoStatus,
    workspaceId: options.workspaceId,
    artifacts: options.artifacts,
    adopted,
    ...(serverLaneDraft ? { serverLane: stripDraft(serverLaneDraft) } : {}),
    ...(frameworkDraft?.deferredConfigRewrites?.length
      ? {
          deferredConfigRewrites: frameworkDraft.deferredConfigRewrites.map((entry) => ({
            path: normalizeAppRelativePath(inspectResult.appRoot, entry.path),
            snippet: entry.snippet
          }))
        }
      : {})
  }
}

/** The plan carries the lane's shape; its blockers were merged into plan.blockers above. */
function stripDraft(draft: ReturnType<typeof planServerLane>): ServerLanePlan {
  const { blockers: _blockers, ...plan } = draft
  return plan
}

function appRelativeConfigOwnership(
  ownership: InstallManifest["configOwnership"] | undefined,
  appRoot: string
): NonNullable<InstallManifest["configOwnership"]> {
  if (!ownership) return {}
  const prefix = appRoot === "." ? "" : `${appRoot}/`
  return Object.fromEntries(
    Object.entries(ownership)
      .filter(([path]) => prefix === "" || path.startsWith(prefix))
      .map(([path, value]) => [prefix === "" ? path : path.slice(prefix.length), value])
  )
}
