import { join } from "node:path"

import { getFrameworkAdapter, isSupportedFramework } from "./frameworks/index.js"
import { normalizeAppRelativePath } from "./frameworks/shared.js"
import { getProviderAdapter } from "./providers/index.js"
import { detectUnmanagedProviders, inspectWorkspace } from "./inspect.js"
import type {
  ApplyMode,
  InspectResult,
  InstallPlan,
  InstallInstruction,
  PackageManager,
  ProviderId,
  WorkspaceInstallArtifacts
} from "./types.js"

const providerOrder: ProviderId[] = ["ga4", "posthog", "x"]

export interface PlanInstallationOptions {
  root: string
  inspect?: InspectResult
  workspaceId?: string
  packageManager?: PackageManager
  artifacts: WorkspaceInstallArtifacts
}

function selectedProviders(artifacts: WorkspaceInstallArtifacts): ProviderId[] {
  return providerOrder.filter((providerId) => artifacts[providerId] !== undefined)
}

export function planInstallation(options: PlanInstallationOptions): InstallPlan {
  const inspectResult =
    options.inspect ??
    inspectWorkspace(options.root, {
      packageManager: options.packageManager
    })
  const providers = selectedProviders(options.artifacts)
  const assumptions = [...inspectResult.assumptions]
  const blockers = [...inspectResult.blockers]

  if (!isSupportedFramework(inspectResult.framework)) {
    if (!blockers.includes("Unsupported repository shape for instrumentation.")) {
      blockers.push("Unsupported repository shape for instrumentation.")
    }

    return {
      framework: inspectResult.framework,
      providers,
      files: [],
      envKeys: [],
      applyMode: "plan-only",
      instructions: [],
      assumptions,
      blockers,
      confidence: Math.min(inspectResult.confidence, 0.45),
      appRoot: inspectResult.appRoot,
      packageManager: inspectResult.packageManager,
      repoStatus: inspectResult.repoStatus,
      workspaceId: options.workspaceId,
      artifacts: options.artifacts
    }
  }

  if (providers.length === 0) {
    blockers.push("No supported public install artifacts were provided.")
  }

  const appRootAbsolute =
    inspectResult.appRoot === "." ? options.root : join(options.root, inspectResult.appRoot)
  const frameworkAdapter = getFrameworkAdapter(inspectResult.framework)
  const frameworkDraft = frameworkAdapter?.plan(appRootAbsolute)

  if (frameworkDraft) {
    assumptions.push(...frameworkDraft.assumptions)
    blockers.push(...frameworkDraft.blockers)
  }

  const unmanagedProviders = detectUnmanagedProviders(appRootAbsolute)
  const envKeys: string[] = []
  const instructions: InstallInstruction[] = []
  for (const providerId of providers) {
    const adapter = getProviderAdapter(providerId)
    if (unmanagedProviders.includes(providerId)) {
      blockers.push(
        `Existing ${adapter.displayName} analytics wiring was detected in this repo and is not managed by Infinite. Remove or migrate the existing ${adapter.displayName} tag before installing it with infinite-tag.`
      )
    }
    const providerPlan = adapter.plan(inspectResult.framework, options.artifacts[providerId])
    assumptions.push(...providerPlan.assumptions)
    blockers.push(...providerPlan.blockers)
    instructions.push(...providerPlan.instructions)
    envKeys.push(...adapter.envKeys(inspectResult.framework))
  }

  const uniqueEnvKeys = [...new Set(envKeys)]
  const files = (frameworkDraft?.files ?? []).map((file) =>
    normalizeAppRelativePath(inspectResult.appRoot, file)
  )
  const frameworkInstructions = (frameworkDraft?.instructions ?? []).map((instruction) => ({
    ...instruction,
    path: normalizeAppRelativePath(inspectResult.appRoot, instruction.path)
  }))
  const providerInstructions = instructions.map((instruction) => ({
    ...instruction,
    path: normalizeAppRelativePath(inspectResult.appRoot, instruction.path)
  }))
  const applyMode: ApplyMode = frameworkDraft?.applyMode ?? "plan-only"
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
    artifacts: options.artifacts
  }
}
