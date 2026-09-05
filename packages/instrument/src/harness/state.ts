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

export const IMPLEMENTATION_CHECKLIST = [
  "Map editable source, build-time injection, generated output and deployed routes before editing. Update the existing owner; never patch generated output or install a second bootstrap just to get a green check.",
  "Compare the project's pinned tag and adopted custom bootstraps with the running installer. Adoption does not upgrade dependencies or apply newer provider settings; preserve existing consent and sensitive-page exclusions.",
  "Write an event matrix for each relevant view, attempt, confirmed success, failure, retry and exit. Use bounded names and properties in each independent provider; a click or animation is not a server-confirmed conversion. Keep outcomes on the server that owns them.",
  "Test the real handlers: one observation per action, keyboard and pointer submission, async errors, retries, consent denial/revocation, and navigation before delivery. Preserve identity correlation across browser, authentication and server outcomes without logging identifiers or secrets.",
  "Inspect provider-added URL metadata as well as custom properties. OAuth callbacks, emails, verification codes and handoff secrets must not leak through page URLs, DOM autocapture or replay. Exercise success and failure callbacks.",
  "Build and inspect every affected deployed route for the intended runtime/configuration and duplicate bootstraps. Then trigger representative actions in a real browser and read back a receipt per provider. Static HTTP inspection does not run JavaScript; record manual or unavailable checks as incomplete.",
  "When a CLI or app is distributed, repeat the audit using the actual packaged executable outside the checkout and through its installed launcher. Source tests alone do not prove the shipped package layout works."
] as const

export function verificationSummary(report: HarnessReport): string {
  if (report.steps.find(step => step.id === "classify")?.status !== "ok") return "Coverage not established: inspection/classification did not complete."
  const verify = report.steps.find(step => step.id === "verify")
  if (!verify || verify.status === "skipped" || verify.status === "not_run") return "Receipt verification was not run; installation evidence is not delivery evidence."
  const verified = report.providers.filter(row => row.verification.kind === "verified").length
  if (verify.status === "failed") return `Receipt verification incomplete (${verified} provider receipts verified).`
  return `${verified} provider receipts verified. Per-action funnel coverage still requires the test matrix below.`
}


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

/**
 * The Meta relay line, or null when the founder has no Meta pixel (then it is noise).
 *
 * WHAT THIS TOOL CAN AND CANNOT SEE. The relay has two halves. The LOCAL half — a Meta pixel plus a
 * server lane that actually reports outcomes — is in this repo and readable here. The CLOUD half —
 * the per-source toggle in Infinite → Site → Settings — is not: this command holds no session and
 * must never claim a state it did not read. So the line reports the LOCAL half by name and says
 * plainly that the toggle is elsewhere. Anything else would be a fabricated "on".
 *
 * WHY IT IS WORTH A LINE AT ALL. A founder running Meta ads without PostHog has no server-side
 * conversion path: Meta's optimiser never learns about the purchase their own server confirmed. The
 * pieces are already installed at this point; all that is missing is one switch nobody mentioned.
 */
export function metaRelayNote(report: HarnessReport): string | null {
  const meta = report.providers.find((state) => state.provider === "meta")
  // No pixel, no relay to talk about. (A `key` is only ever set once a pixel id was resolved.)
  if (!meta || !meta.key || meta.state === "absent" || meta.state === "skipped") return null

  const lane = report.providers.find((state) => state.provider === "server_lane")
  const laneReady =
    lane !== undefined && (lane.state === "installed" || lane.state === "adopted" || lane.state === "verified")

  if (!laneReady) {
    return "Meta relay: off — a Meta pixel is installed but no server lane reports outcomes, so there is nothing to forward. Install the server lane first (`--server-lane`)."
  }
  return "Meta relay: on locally — a Meta pixel is installed and the server lane can carry outcomes. Forwarding still needs the cloud toggle (Infinite → Site → Settings → “Send outcomes to Meta Conversions API”), which this command cannot read or set. Only turn it on if you do NOT use PostHog: PostHog ships its own Meta destination, and two senders for one conversion is a double count."
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
    `- Verification: ${verificationSummary(report)}`,
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
    } else if (state.state === "adopted") {
      checklist.push(`${state.provider}: adopted, not verified. Confirm the current deployed bootstrap, configuration and action receipts with its existing owner; do not install a duplicate.`)
    } else if (state.state === "installed" && state.verification.kind === "not_run") {
      checklist.push(`${state.provider}: installed, but no receipt check ran. Deploy and perform delivery verification before claiming coverage.`)
    } else if (state.state === "conflict") {
      checklist.push(`${state.provider}: conflict — ${state.reason ?? "see evidence"}. Nothing was installed for it.`)
    }
  }
  for (const next of report.nextSteps) {
    checklist.push(next)
  }
  checklist.push(...IMPLEMENTATION_CHECKLIST)
  for (const item of checklist) {
    lines.push(`- [ ] ${item}`)
  }
  lines.push("", "## Handoff", "", report.handoff, "")
  return lines.join("\n")
}
