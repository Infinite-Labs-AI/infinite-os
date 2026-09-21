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
import { checkConversionPlacement } from "./conversion-placement.js"
import { runtimeConversionLanes } from "./contract.js"
import { checkSilentForms } from "./silent-form.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

export * from "./types.js"
export { parseConversionLanes, runtimeConversionLanes } from "./contract.js"
export { checkConversionPlacement } from "./conversion-placement.js"
export { checkSilentForms } from "./silent-form.js"
export { checkClickIdCapture, isSharedEntry } from "./click-id-capture.js"

export interface SetupChecksReport {
  version: 1
  /** Worst state across every check. */
  state: "ok" | "problem" | "undetermined"
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

export function runSetupChecks(appRootAbsolute: string): SetupChecksReport {
  const files = readAppSources(appRootAbsolute)
  const checks = [
    checkConversionPlacement({ files, lanes: runtimeConversionLanes() }),
    checkSilentForms({ files }),
    checkClickIdCapture({ files })
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
  return `${problems} setup problem${problems === 1 ? "" : "s"}, ${undetermined} undetermined`
}
