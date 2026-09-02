import {
  HARNESS_PROVIDER_ORDER,
  type HarnessMode,
  type HarnessProviderId,
  type HarnessReport,
  type ProviderState,
  type ProviderStateKind,
  type VerificationOutcome
} from "./types.js"

export { HARNESS_PROVIDER_ORDER }

/** The pasteable handoff line (teardown §5.2 step 11), in the wizard's voice, both sides. */
export const HARNESS_HANDOFF_LINE =
  "Open `.infinite/REPORT.md` and work through its 'Verify before merging' checklist: investigate each item, then list the changes you'd make and get my approval before applying any of them."

export const HARNESS_REPORT_RELATIVE_PATH = ".infinite/REPORT.md"

export function initialProviderStates(): ProviderState[] {
  return HARNESS_PROVIDER_ORDER.map((provider) => ({
    provider,
    state: "absent",
    verification: { kind: "not_run" }
  }))
}

export function createHarnessReport(input: {
  mode: HarnessMode
  root: string
  startedAt?: string
}): HarnessReport {
  return {
    version: 1,
    mode: input.mode,
    root: input.root,
    startedAt: input.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    framework: null,
    appRoot: null,
    hosting: null,
    providers: initialProviderStates(),
    steps: [],
    conversions: null,
    failure: null,
    failures: [],
    nextSteps: [],
    handoff: HARNESS_HANDOFF_LINE
  }
}

export type ProviderTransition =
  | { to: "installed"; reason?: string; key?: string; evidence?: string }
  | { to: "adopted"; reason?: string; key?: string; evidence?: string }
  | { to: "skipped"; reason?: string; key?: string; evidence?: string }
  | { to: "conflict"; reason?: string; key?: string; evidence?: string }
  | { to: "absent"; reason?: string; key?: string; evidence?: string }
  | { to: "verified"; receiptAt: string }

/** Which states may follow which. `verified` is the only one with an extra precondition. */
const allowedTransitions: Record<ProviderStateKind, ReadonlySet<ProviderStateKind>> = {
  absent: new Set(["absent", "installed", "adopted", "skipped", "conflict"]),
  installed: new Set(["installed", "verified", "skipped", "conflict"]),
  adopted: new Set(["adopted", "skipped"]),
  conflict: new Set(["conflict", "skipped"]),
  skipped: new Set(["skipped"]),
  verified: new Set(["verified"])
}

/**
 * The one door into every state. Enforces the honesty invariant in code, not copy: `verified`
 * requires a non-empty receipt timestamp and is reachable only from `installed`.
 */
export function transitionProvider(current: ProviderState, transition: ProviderTransition): ProviderState {
  if (!allowedTransitions[current.state].has(transition.to)) {
    throw new Error(
      `Provider ${current.provider} cannot move from ${current.state} to ${transition.to}.`
    )
  }
  if (transition.to === "verified") {
    const receiptAt = typeof transition.receiptAt === "string" ? transition.receiptAt.trim() : ""
    if (!receiptAt) {
      throw new Error(
        `Provider ${current.provider} cannot be marked verified without a receipt timestamp.`
      )
    }
    return {
      ...current,
      state: "verified",
      verification: { kind: "verified", receiptAt }
    }
  }
  return {
    ...current,
    state: transition.to,
    ...(transition.reason !== undefined ? { reason: transition.reason } : {}),
    ...(transition.key !== undefined ? { key: transition.key } : {}),
    ...(transition.evidence !== undefined ? { evidence: transition.evidence } : {})
  }
}

/** Unconditional set — for seeding test fixtures and for `classify` (absent → X is always legal). */
export function setProviderState(
  current: ProviderState,
  state: ProviderStateKind,
  reason?: string
): ProviderState {
  return { ...current, state, ...(reason !== undefined ? { reason } : {}) }
}

export function findProvider(report: HarnessReport, provider: HarnessProviderId): ProviderState {
  const found = report.providers.find((state) => state.provider === provider)
  if (!found) {
    throw new Error(`Report is missing the ${provider} row.`)
  }
  return found
}

export function updateProvider(
  report: HarnessReport,
  provider: HarnessProviderId,
  update: (state: ProviderState) => ProviderState
): void {
  report.providers = report.providers.map((state) =>
    state.provider === provider ? update(state) : state
  )
}

/** "verified (receipt at <ts>)" / "installed, not verifiable (<why>)" / "adopted, not ours to verify". */
export function describeState(state: ProviderState): string {
  const verification = state.verification
  switch (verification.kind) {
    case "verified":
      return `verified (receipt at ${verification.receiptAt})`
    case "not_verifiable":
      return `${state.state}, not verifiable (${verification.reason})`
    case "no_receipt":
      return `${state.state}, no receipt`
    case "adopted_not_ours":
      return "adopted, not ours to verify"
    case "not_run":
      return state.state
  }
}

export function describeVerification(verification: VerificationOutcome): string {
  switch (verification.kind) {
    case "verified":
      return `receipt at ${verification.receiptAt}`
    case "not_verifiable":
      return `not verifiable (${verification.reason})`
    case "no_receipt":
      return `no receipt${verification.causes.length > 0 ? ` — ${verification.causes[0]}` : ""}`
    case "adopted_not_ours":
      return "not ours to verify"
    case "not_run":
      return "not run"
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

/** The terminal table: provider → state → key → evidence, one row per provider, every run. */
export function renderReportTable(report: HarnessReport): string {
  const rows = report.providers.map((state) => [
    state.provider,
    describeState(state),
    state.key ?? "—",
    state.evidence ?? state.reason ?? "—"
  ])
  const header = ["provider", "state", "key", "evidence"]
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length))
  )
  const line = (cells: string[]): string =>
    cells.map((cell, column) => pad(cell, widths[column])).join("  ").trimEnd()
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(row))
  ].join("\n")
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/** `.infinite/REPORT.md`: the same table plus failures, conversions, next steps, and the checklist. */
export function renderReportMarkdown(report: HarnessReport): string {
  const lines: string[] = [
    "# Infinite analytics harness report",
    "",
    `- Mode: \`${report.mode}\``,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt ?? "—"}`,
    `- Framework: ${report.framework ?? "not identified"}${report.appRoot && report.appRoot !== "." ? ` (app at ${report.appRoot})` : ""}`,
    "",
    "## Providers",
    "",
    "| Provider | State | Key | Evidence | Verification |",
    "|---|---|---|---|---|",
    ...report.providers.map(
      (state) =>
        `| ${state.provider} | ${markdownCell(describeState(state))} | ${markdownCell(state.key ?? "—")} | ${markdownCell(state.evidence ?? state.reason ?? "—")} | ${markdownCell(describeVerification(state.verification))} |`
    ),
    "",
    "`verified` is printed only with a receipt timestamp read back from the provider.",
    "`installed` means a file was written; `adopted` means an existing tag was left byte-for-byte alone.",
    ""
  ]

  if (report.conversions) {
    const c = report.conversions
    lines.push(
      "## Conversions",
      "",
      `Conversions: ${c.proposed} proposed · ${c.marked} marked · ${c.skipped} skipped · ${c.stale} stale`,
      ""
    )
  }

  lines.push("## Steps", "")
  for (const step of report.steps) {
    const suffix = step.failure ? ` — \`${step.failure.code}\`: ${step.failure.message}` : step.note ? ` — ${step.note}` : ""
    lines.push(`- ${step.status === "ok" ? "✓" : step.status === "failed" ? "✗" : "·"} ${step.title} (${step.status})${suffix}`)
  }
  lines.push("")

  const failures =
    report.failure && !report.failures.includes(report.failure)
      ? [report.failure, ...report.failures]
      : report.failures
  if (failures.length > 0) {
    lines.push("## Failures", "")
    for (const failure of failures) {
      lines.push(`- \`${failure.code}\` at ${failure.step} (${failure.next}): ${failure.message}`)
    }
    lines.push("")
  }

  lines.push("## Verify before merging", "")
  const checklist: string[] = []
  for (const state of report.providers) {
    if (state.verification.kind === "no_receipt") {
      checklist.push(
        `${state.provider}: no receipt arrived. ${state.verification.causes.length > 0 ? `Check: ${state.verification.causes.join(" · ")}` : ""}`.trim()
      )
    } else if (state.verification.kind === "not_verifiable" && state.state === "installed") {
      checklist.push(`${state.provider}: installed but not read back (${state.verification.reason}). Confirm an event in the provider's own live view before merging.`)
    } else if (state.state === "conflict") {
      checklist.push(`${state.provider}: conflict — ${state.reason ?? "see evidence"}. Nothing was installed for it.`)
    }
  }
  for (const next of report.nextSteps) {
    checklist.push(next)
  }
  if (checklist.length === 0) {
    checklist.push("Nothing outstanding from this run.")
  }
  for (const item of checklist) {
    lines.push(`- [ ] ${item}`)
  }
  lines.push("", "## Handoff", "", report.handoff, "")
  return lines.join("\n")
}
