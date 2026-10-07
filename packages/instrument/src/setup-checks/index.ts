// Setup checks, composed.
//
// WHERE THIS SITS IN THE LIFECYCLE — adopt → install → MARK → verify → report — and why:
//
// It runs as its own step immediately after `mark`, and it runs in EVERY mode, including `--check`.
// Three reasons, in order of how much they matter:
//
//   1. It is about the SOURCE, so it can be answered without a deploy, without a browser, and
//      without waiting 60 seconds for a receipt that was never going to come. A founder who has to
//      ship to production to learn that an attribute is on the wrong element will learn it late or
//      not at all.
//   2. `mark` is the step that writes `data-conversion`, and the step whose skip rule ("already
//      marked") is what hid the original bug. Checking straight after marking means the run that
//      creates the state is the run that inspects it.
//   3. It must not change what `verify` means. The receipt lanes stay exactly what they are — a
//      backend answering whether an event arrived. This is a second, independent class of finding
//      printed alongside them, never folded into a lane and never able to mint or deny a receipt.
//
// It writes nothing, fetches nothing, and reads no attribute VALUE except the one `data-conversion`
// token the runtime itself switches on.
import { readSourceFile, walkSourceFiles } from "../harness/scan.js"

import { checkClickIdCapture } from "./click-id-capture.js"
import { readManagedCaptureSync } from "../install/managed-capture.js"
import { relative, sep } from "node:path"
import { checkConversionPlacement } from "./conversion-placement.js"
import { runtimeConversionLanes } from "./contract.js"
import { checkHostGuard } from "./host-guard.js"
import { checkMetaEventId } from "./meta-event-id.js"
import { checkMetaPixelConfig } from "./meta-pixel-config.js"
import { checkPosthogConfig } from "./posthog-config.js"
import { checkProviderCensus } from "./provider-census.js"
import { checkSensitivePages } from "./sensitive-pages.js"
import { checkSilentForms } from "./silent-form.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

export * from "./types.js"
export { parseConversionLanes, runtimeConversionLanes } from "./contract.js"
export { checkConversionPlacement } from "./conversion-placement.js"
export { checkSilentForms } from "./silent-form.js"
export { checkClickIdCapture, isSharedEntry } from "./click-id-capture.js"
export { checkMetaPixelConfig, metaSourceUnits } from "./meta-pixel-config.js"
export { censusEntries, checkProviderCensus } from "./provider-census.js"
export { checkPosthogConfig, posthogConfigDrift, readPosthogConfigs, type PosthogConfigRead } from "./posthog-config.js"
export { checkHostGuard, readAdoptedInitGuards, type HostGuardRead } from "./host-guard.js"
export { checkSensitivePages, detectSensitivePages, type SensitiveRoute } from "./sensitive-pages.js"
export {
  META_STANDARD_CONVERSIONS,
  checkMetaEventId,
  clickHandlerRegions,
  findEventIdHits,
  findStandardOnClick
} from "./meta-event-id.js"

export interface SetupChecksReport {
  version: 1
  /** Worst state across every check. */
  state: "ok" | "info" | "problem" | "undetermined"
  checks: SetupCheckResult[]
  findings: SetupFinding[]
}

/** Read the app's source once; every check shares the same bounded walk the harness already uses. */
export function readAppSources(appRootAbsolute: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const file of walkSourceFiles(appRootAbsolute)) {
    const contents = readSourceFile(appRootAbsolute, file)
    if (contents !== null) files.set(file, contents)
  }
  return files
}

/** What the wizard knows that the harness does not (the connection's ids and hosts). Optional. */
export interface SetupChecksContext {
  repoRoot?: string
  /** Root used by supplied file keys; readAppSources always returns app-relative keys. */
  appRoot?: string
  /** Internal validated entry facts; O9 and runSetupChecks replace any supplied value from disk. */
  managedCaptureEntries?: readonly string[]
  /** The connected PostHog project's `apiHost`: enables the region verdict. */
  expectedPosthogApiHost?: string
  /** The exempt production hosts: enables the "guard silences production" verdict. */
  productionHosts?: readonly string[]
}

export function runSetupChecks(appRootAbsolute: string, context: SetupChecksContext = {}): SetupChecksReport {
  const files = readAppSources(appRootAbsolute)
  return setupChecksOver(files, validatedCaptureContext(context.repoRoot ?? appRootAbsolute, appRootAbsolute, context))
}

export function validatedCaptureContext(root: string, appRootAbsolute: string, context: SetupChecksContext = {}): SetupChecksContext {
  const proof = readManagedCaptureSync(root)
  const appRoot = relative(root, appRootAbsolute).split(sep).join("/")
  const entries = proof?.record.entrypoints.map(file => appRoot ? file.startsWith(`${appRoot}/`) ? file.slice(appRoot.length + 1) : null : file).filter((file): file is string => file !== null)
  return { ...context, appRoot: ".", managedCaptureEntries: entries }
}

/** The same checks over files already read (the wizard re-runs them between agent turns). */
export function setupChecksOver(files: ReadonlyMap<string, string>, context: SetupChecksContext = {}): SetupChecksReport {
  const checks = [
    checkConversionPlacement({ files, lanes: runtimeConversionLanes() }),
    checkSilentForms({ files }),
    checkClickIdCapture({ files, appRoot: context.appRoot, managedCaptureEntries: context.managedCaptureEntries }),
    checkMetaPixelConfig({ files }),
    checkProviderCensus({ files }),
    checkPosthogConfig({ files, ...(context.expectedPosthogApiHost ? { expectedApiHost: context.expectedPosthogApiHost } : {}) }),
    checkHostGuard({ files, ...(context.productionHosts ? { productionHosts: context.productionHosts } : {}) }),
    checkSensitivePages({ files }),
    checkMetaEventId({ files })
  ]
  const findings = checks.flatMap((check) => check.findings)
  return { version: 1, state: worstState(findings), checks, findings }
}

/** One line per finding for the harness's next-steps list. `ok` findings are not next steps. */
export function setupFindingLines(report: SetupChecksReport): string[] {
  return report.findings
    .filter((finding) => finding.state !== "ok")
    .map((finding) => `${finding.code} — ${finding.message}`)
}

/** The step note: what was looked at and what came back, never a bare "ok". */
export function setupChecksNote(report: SetupChecksReport): string {
  const problems = report.findings.filter((finding) => finding.state === "problem").length
  const undetermined = report.findings.filter((finding) => finding.state === "undetermined").length
  // `info` is listed in the next steps ("Worth checking: …"), so the note counts it too: a note that
  // says nothing was found above a list of things to review reads as a contradiction.
  const info = report.findings.filter((finding) => finding.state === "info").length
  return `${problems} setup problem${problems === 1 ? "" : "s"}, ${undetermined} undetermined, ${info} worth checking`
}
