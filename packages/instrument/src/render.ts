// Human-readable terminal output for the founder-facing CLI. Pure string builders
// (no I/O) so they are unit-testable; cli.ts decides stdout vs stderr and only uses
// these when --json is NOT passed. --json keeps the machine-readable contract.
import { nothingToInstallMessage } from "./apply.js"
import { adoptedProviderLine } from "./plan.js"
import { serverLaneCopy } from "./server-lane/copy.js"
import type {
  ApplyResult,
  InspectResult,
  InstallPlan,
  UninstallResult,
  VerifyResult,
  WorkspaceInstallArtifacts
} from "./types.js"

const HEADER = "Infinite OS · analytics installer"
const MANIFEST_REL = ".infinite/install.json"

export function frameworkLabel(framework: string): string {
  switch (framework) {
    case "next-app-router":
      return "Next.js — App Router"
    case "next-pages-router":
      return "Next.js — Pages Router"
    case "vite-react":
      return "Vite + React"
    case "static-html":
      return "static HTML"
    default:
      return framework
  }
}

/** Short "GA4 · G-XXXX" lines for the providers present in the artifacts. */
export function providerLines(artifacts: WorkspaceInstallArtifacts): string[] {
  const lines: string[] = []
  if (artifacts.infinite?.siteSourceKey) {
    lines.push(`Infinite · ${artifacts.infinite.siteSourceKey} (${artifacts.infinite.collectPath})`)
  }
  if (artifacts.ga4?.measurementId) {
    lines.push(`GA4 · ${artifacts.ga4.measurementId}`)
  }
  if (artifacts.posthog && (artifacts.posthog.projectKey || artifacts.posthog.apiHost)) {
    const host = artifacts.posthog.apiHost ? ` (${artifacts.posthog.apiHost})` : ""
    lines.push(`PostHog · ${artifacts.posthog.projectKey || "project"}${host}`)
  }
  if (artifacts.x && (artifacts.x.pixelId || artifacts.x.eventTagIds.length > 0)) {
    lines.push(`X Pixel · ${artifacts.x.pixelId || "pixel"}`)
  }
  if (artifacts.meta?.pixelId) {
    lines.push(`Meta Pixel · ${artifacts.meta.pixelId}`)
  }
  return lines
}

/** Friendly product names for the providers present, e.g. "Google Analytics and PostHog". */
export function providerNames(artifacts: WorkspaceInstallArtifacts): string {
  const names: string[] = []
  if (artifacts.infinite) {
    names.push("Infinite")
  }
  if (artifacts.ga4) {
    names.push("Google Analytics")
  }
  if (artifacts.posthog) {
    names.push("PostHog")
  }
  if (artifacts.x) {
    names.push("X Pixel")
  }
  if (artifacts.meta) {
    names.push("Meta Pixel")
  }
  return joinWithAnd(names) || "analytics"
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? ""
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

/** The artifacts the plan will actually WRITE — adopted (already-present) providers removed. */
function installedArtifacts(plan: InstallPlan): WorkspaceInstallArtifacts {
  const artifacts: WorkspaceInstallArtifacts = { ...plan.artifacts }
  for (const entry of plan.adopted) {
    delete artifacts[entry.provider]
  }
  return artifacts
}

/** "Already on your site (left untouched):" block, empty when nothing was adopted. */
function adoptedLines(plan: InstallPlan): string[] {
  if (plan.adopted.length === 0) return []
  return [
    "",
    "Already on your site (left untouched):",
    ...plan.adopted.map((entry) => `  ✓ ${adoptedProviderLine(entry)}`)
  ]
}

/** Shown when every requested provider already exists: nothing is written, nothing is recorded. */
export function renderNothingToInstall(plan: InstallPlan): string {
  return [
    "",
    HEADER,
    "",
    `  Project repo    ${repoLabel(plan)}  (${frameworkLabel(plan.framework)})`,
    ...adoptedLines(plan),
    "",
    nothingToInstallMessage(plan),
    "To install anyway, remove the existing tag and re-run.",
    ""
  ].join("\n")
}

function repoLabel(plan: InstallPlan): string {
  return plan.appRoot && plan.appRoot !== "." ? `this repo (app at ${plan.appRoot})` : "this repo"
}

function actionByPath(plan: InstallPlan): Map<string, "create" | "modify"> {
  const map = new Map<string, "create" | "modify">()
  for (const instruction of plan.instructions) {
    // "create" only wins when no "modify" already claimed the path.
    if (!map.has(instruction.path) || instruction.action === "modify") {
      map.set(instruction.path, instruction.action)
    }
  }
  return map
}

/** The "I'll make N changes" block shown before applying (preview). */
export function renderPreview(plan: InstallPlan): string {
  const actions = actionByPath(plan)
  const installing = installedArtifacts(plan)
  const tagWord = providerNames(installing) === "analytics" ? "analytics" : `${providerNames(installing)}`
  const laneFiles = new Set(plan.serverLane?.files ?? [])
  const pixelFiles = plan.files.filter((file) => !laneFiles.has(file))
  const changeLines = pixelFiles.map((file) => {
    const symbol = actions.get(file) === "create" ? "+" : "~"
    return `  ${symbol} ${pad(file)}${actions.get(file) === "create" ? "add" : "inject"} the ${tagWord} tag`
  })
  const laneLines = renderServerLaneLines(plan)
  changeLines.push(...laneLines)
  changeLines.push(`  + ${pad(MANIFEST_REL)}install record (lets a later \`uninstall\` undo this cleanly)`)

  const providerBlock = providerLines(installing)
  const analyticsValue =
    providerBlock.length === 0
      ? "—"
      : providerBlock[0] + (providerBlock.length > 1 ? "\n" + providerBlock.slice(1).map((l) => `                  ${l}`).join("\n") : "")

  const meta = [`  Project repo    ${repoLabel(plan)}  (${frameworkLabel(plan.framework)})`]
  if (plan.packageManager !== "unknown" && plan.packageManager !== "ambiguous") {
    meta.push(`  Package manager ${plan.packageManager}`)
  }
  meta.push(`  Analytics       ${analyticsValue}`)

  const consentLines = consentGuidance(plan.artifacts)
  return [
    "",
    HEADER,
    "",
    ...meta,
    ...adoptedLines(plan),
    "",
    `I'll make ${changeLines.length} change${changeLines.length === 1 ? "" : "s"}:`,
    ...changeLines,
    ...(consentLines.length > 0 ? ["", "Consent integration:", ...consentLines.map((line) => `  ${line}`)] : []),
    ""
  ].join("\n")
}

/** The narration + ✅ success + next-steps block shown after a successful apply. */
export function renderApplied(input: {
  inspect: InspectResult
  plan: InstallPlan
  apply: ApplyResult
  verify: VerifyResult
}): string {
  const { plan, apply, verify } = input
  const installing = installedArtifacts(plan)
  const names = providerNames(installing)
  const codeFiles = apply.changedFiles.filter((file) => !file.endsWith("install.json"))
  const manifestWritten = apply.changedFiles.some((file) => file.endsWith("install.json"))

  const steps: string[] = [`  ✓ Detected ${frameworkLabel(plan.framework)} at ${plan.appRoot}`]
  if (codeFiles.length > 0) {
    steps.push(`  ✓ Installed ${names} → ${codeFiles.join(", ")}`)
  }
  if (manifestWritten) {
    steps.push(`  ✓ Recorded the install → ${MANIFEST_REL}`)
  }
  if (verify.buildOk) {
    const n = plan.files.length
    steps.push(`  ✓ Verified ${n} file${n === 1 ? "" : "s"} against the recorded install`)
  }

  const ids = providerLines(installing).join(", ")
  const idSuffix = ids ? ` (${ids})` : ""

  const lines = [
    "",
    "Installing analytics into your site…",
    ...steps,
    "",
    `✅ Done — your site is now wired for ${names}${idSuffix}.`,
    ...adoptedLines(plan),
    "",
    "Next steps:",
    "  1. Review the change:  git diff",
    "  2. Commit & deploy your site so the tag goes live.",
    `  3. Confirm it's working: ${confirmHint(plan.artifacts)}`
  ]

  const consentLines = consentGuidance(plan.artifacts)
  if (consentLines.length > 0) {
    lines.push("", "Consent integration:", ...consentLines.map((line) => `  ${line}`))
  }

  if (plan.serverLane) {
    lines.push("", `${serverLaneCopy.cli.sectionTitle}:`, ...renderServerLaneLines(plan, apply))
    lines.push("", `  ${serverLaneCopy.cli.envIntro}`, ...serverLaneCopy.cli.envLines.map((line) => `  ${line}`))
    const host = plan.artifacts.infinite?.productionHosts?.[0] ?? plan.artifacts.productionHosts?.[0] ?? "<your-production-host>"
    lines.push(`  ${serverLaneCopy.cli.verifyHint(host)}`)
  }

  const warnings = [...apply.warnings, ...verify.warnings.filter((w) => !w.startsWith("Static verification only"))]
  if (warnings.length > 0) {
    lines.push("", "Notes:", ...warnings.map((w) => `  • ${w}`))
  }
  lines.push("")
  return lines.join("\n")
}

function consentGuidance(artifacts: WorkspaceInstallArtifacts): string[] {
  if (artifacts.infinite?.consentMode === "required") {
    return [
      "Required mode stays dormant until your consent UI dispatches infinite:analytics-consent-change.",
      "Grant with detail: { granted: true }; deny or revoke with detail: { granted: false }."
    ]
  }
  if (
    artifacts.infinite?.consentMode === "not_required" &&
    (artifacts.ga4 || artifacts.posthog)
  ) {
    return [
      "Infinite collects without consent unless DNT/GPC is enabled; GA4/PostHog stay fully independent.",
      "Each provider runs its own native bootstrap (own page views, own consent); Infinite never forwards events into it."
    ]
  }
  return []
}

function confirmHint(artifacts: WorkspaceInstallArtifacts): string {
  if (artifacts.infinite) {
    return "open Infinite Site Analytics and confirm website events are arriving for the selected source."
  }
  if (artifacts.ga4) {
    return "open Google Analytics → Realtime (live within minutes; full reports ~24h)."
  }
  if (artifacts.posthog) {
    return "open PostHog → Activity to watch events arrive."
  }
  if (artifacts.meta) {
    return "open Meta Events Manager → Test Events to watch the pixel fire."
  }
  return "check your provider's dashboard for incoming events."
}

/** Shown when no artifacts were found and none were passed — the silent-no-op fix. */
export function renderNoArtifacts(artifactsDir: string): string {
  return [
    "",
    HEADER,
    "",
    "I couldn't find any analytics to install.",
    "",
    `No saved setup data was found on this machine (looked in ${artifactsDir}). Either:`,
    "  • Run `infinite local setup` first (it saves your keys there), then re-run this; or",
    "  • Pass it directly:  npx infinite-tag install --ga4-measurement-id G-XXXXXXX",
    ""
  ].join("\n")
}

/** Shown when the repo's framework isn't recognised — with a manual GA4 fallback if we have an ID. */
export function renderUnsupported(plan: InstallPlan): string {
  const lines = ["", HEADER, ""]
  const providerBlock = providerLines(plan.artifacts)
  if (providerBlock.length > 0) {
    lines.push(`  Analytics   ${providerBlock.join(", ")}`, "")
  }
  lines.push(
    "⚠️  I couldn't recognize this project's framework (I look for Next.js, Vite + React, or static HTML).",
    "Nothing was changed."
  )
  const measurementId = plan.artifacts.ga4?.measurementId
  if (measurementId) {
    lines.push(
      "",
      "You can add the Google Analytics tag by hand — paste this into the <head> of every page:",
      ...ga4ManualSnippet(measurementId)
    )
  }
  lines.push("")
  return lines.join("\n")
}

/** Other refusals (existing analytics, low confidence, etc.) surfaced as plain reasons. */
export function renderBlocked(plan: InstallPlan): string {
  return [
    "",
    HEADER,
    "",
    "I can't safely install yet:",
    ...plan.blockers.map((blocker) => `  • ${blocker}`),
    "",
    "Fix the above and re-run, or pass --json to see the full machine-readable plan.",
    ""
  ].join("\n")
}

export function renderInspect(inspect: InspectResult): string {
  const lines = [
    "",
    HEADER,
    "",
    `  Framework       ${frameworkLabel(inspect.framework)}`,
    `  App root        ${inspect.appRoot}`,
    `  Package manager ${inspect.packageManager}`,
    `  Git status      ${inspect.repoStatus}`
  ]
  if (inspect.existingProviders.length > 0) {
    lines.push(`  Existing tags   ${inspect.existingProviders.join(", ")}`)
  }
  if (inspect.blockers.length > 0) {
    lines.push("", "Blockers:", ...inspect.blockers.map((b) => `  • ${b}`))
  }
  lines.push("")
  return lines.join("\n")
}

export function renderVerify(verify: VerifyResult): string {
  const lines = ["", HEADER, ""]
  if (verify.buildOk) {
    lines.push("✅ Verified — the managed analytics files match the recorded install.")
  } else {
    lines.push("❌ Verification failed:")
    lines.push(...verify.routeChecks.map((c) => `  • ${c}`))
  }
  lines.push("")
  return lines.join("\n")
}

export function renderUninstall(result: UninstallResult, dryRun: boolean): string {
  const lines = ["", HEADER, ""]
  if (!result.manifestPath) {
    lines.push("Nothing to uninstall — no Infinite install record was found in this repo.", "")
    return lines.join("\n")
  }
  if (dryRun) {
    lines.push("Uninstall preview (nothing was changed):")
  } else {
    lines.push("✅ Removed the Infinite analytics install:")
  }
  for (const file of result.restoredFiles) {
    lines.push(`  ~ ${file}${dryRun ? "  (would restore)" : "  restored"}`)
  }
  for (const file of result.removedFiles) {
    lines.push(`  - ${file}${dryRun ? "  (would remove)" : "  removed"}`)
  }
  if (result.warnings.length > 0) {
    lines.push("", "Notes:", ...result.warnings.map((w) => `  • ${w}`))
  }
  if (dryRun) {
    lines.push("", "To remove for real:  npx infinite-tag uninstall --yes")
  }
  lines.push("")
  return lines.join("\n")
}

export function ga4ManualSnippet(measurementId: string): string[] {
  return [
    "",
    "  <!-- Google tag (gtag.js) -->",
    `  <script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>`,
    "  <script>",
    "    window.dataLayer = window.dataLayer || [];",
    "    function gtag(){dataLayer.push(arguments);}",
    "    gtag('js', new Date());",
    `    gtag('config', '${measurementId}');`,
    "  </script>"
  ]
}

function pad(value: string): string {
  const width = 26
  return value.length >= width ? `${value}  ` : value.padEnd(width)
}

/** The server-lane change lines for preview and applied output (indented two spaces). */
export function renderServerLaneLines(plan: InstallPlan, apply?: ApplyResult): string[] {
  const lane = plan.serverLane
  if (!lane) return []
  const lines: string[] = []
  const middleware = lane.middleware
  if (lane.mode === "next-middleware" && middleware && lane.modulePath) {
    switch (middleware.action) {
      case "create":
        lines.push(`  ${serverLaneCopy.cli.created(middleware.path)}`)
        break
      case "patch":
        lines.push(`  ${serverLaneCopy.cli.patched(middleware.path)}`)
        break
      case "keep":
        lines.push(`  ${serverLaneCopy.cli.kept(middleware.path)}`)
        break
      case "unpatchable":
        lines.push(`  ${serverLaneCopy.cli.unpatchable(middleware.path)}`)
        break
    }
    lines.push(`  ${serverLaneCopy.cli.module(lane.modulePath)}`)
    lines.push(`  ${serverLaneCopy.cli.brief(lane.briefPath)}`)
  } else if (lane.created && lane.created.length > 0) {
    // A host-chosen target: say WHICH lane and WHY before listing its files.
    lines.push(`  ${serverLaneCopy.cli.targetChosen(lane.targetLabel ?? lane.mode, lane.targetEvidence)}`)
    for (const file of lane.created) {
      if (file.action === "manual") {
        lines.push(`  ${serverLaneCopy.cli.targetManualFile(file.path)}`)
      } else if (file.action === "keep") {
        lines.push(`  ${serverLaneCopy.cli.targetKeptFile(file.path)}`)
      } else if (/infinite-outcome\.[jt]s$/.test(file.path)) {
        lines.push(`  ${serverLaneCopy.cli.targetOutcomeFile(file.path)}`)
      } else {
        lines.push(`  ${serverLaneCopy.cli.targetFile(file.path)}`)
      }
    }
    lines.push(`  ${serverLaneCopy.cli.brief(lane.briefPath)}`)
    if (lane.installPackages && lane.installPackages.length > 0) {
      lines.push(`  ${serverLaneCopy.cli.targetInstall(lane.installPackages)}`)
    }
    if (lane.mode === "node-module") {
      lines.push(`  ${serverLaneCopy.cli.targetMount(lane.briefPath)}`)
    }
  } else {
    lines.push(`  ${serverLaneCopy.cli.briefOnly(lane.briefPath)}`)
  }
  if (apply?.serverLane && !apply.serverLane.briefWritten) {
    lines.push(`  ! ${lane.briefPath} was not written (an unmanaged file is in the way); the brief is printed below.`)
  }
  return lines
}
