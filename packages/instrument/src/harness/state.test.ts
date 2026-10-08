import { describe, expect, it } from "vitest"

import {
  createHarnessReport,
  initialProviderStates,
  metaRelayNote,
  renderReportMarkdown,
  renderReportTable,
  setProviderState,
  transitionProvider
} from "./state.js"
import type { HarnessReport } from "./types.js"

function report(): HarnessReport {
  return createHarnessReport({
    mode: "apply",
    root: "/tmp/site",
    startedAt: "2026-09-02T10:00:00.000Z"
  })
}

it("does not claim a consent or policy measurement in an unmeasured harness report", () => {
  const markdown = renderReportMarkdown(report())
  expect(markdown).not.toContain("changed neither")
  expect(markdown).not.toContain("checked against the commits it made")
})

describe("provider state machine", () => {
  it("moves absent → installed → verified only with a receipt timestamp", () => {
    const installed = transitionProvider(initialProviderStates()[0], {
      to: "installed",
      reason: "gtag snippet written to index.html"
    })
    expect(installed.state).toBe("installed")

    const verified = transitionProvider(installed, {
      to: "verified",
      receiptAt: "2026-09-02T10:01:03.000Z"
    })
    expect(verified.state).toBe("verified")
    expect(verified.verification).toEqual({
      kind: "verified",
      receiptAt: "2026-09-02T10:01:03.000Z"
    })
  })

  it("refuses verified without a receipt timestamp", () => {
    const installed = transitionProvider(initialProviderStates()[0], { to: "installed" })
    expect(() =>
      transitionProvider(installed, { to: "verified" } as never)
    ).toThrow(/receipt/)
    expect(() =>
      transitionProvider(installed, { to: "verified", receiptAt: "" })
    ).toThrow(/receipt/)
  })

  it("refuses verified from absent, adopted, conflict, or skipped", () => {
    for (const from of ["absent", "adopted", "conflict", "skipped"] as const) {
      const base = setProviderState(initialProviderStates()[0], from, "test")
      expect(() =>
        transitionProvider(base, { to: "verified", receiptAt: "2026-09-02T10:01:03.000Z" })
      ).toThrow(new RegExp(`cannot move .*${from}.* to verified`))
    }
  })
})

describe("renderReportTable", () => {
  it("prints verified only with its receipt timestamp and never for un-receipted rows", () => {
    const current = report()
    current.providers = current.providers.map((state) =>
      state.provider === "ga4"
        ? transitionProvider(transitionProvider(state, { to: "installed" }), {
            to: "verified",
            receiptAt: "2026-09-02T10:01:03.000Z"
          })
        : state.provider === "posthog"
          ? {
              ...transitionProvider(state, { to: "installed" }),
              verification: { kind: "not_verifiable", reason: "no query key" }
            }
          : state
    )
    const table = renderReportTable(current)
    const ga4Line = table.split("\n").find((line) => line.startsWith("ga4") || line.includes(" ga4 "))
    expect(ga4Line).toContain("verified")
    expect(ga4Line).toContain("receipt at 2026-09-02T10:01:03.000Z")
    const posthogLine = table.split("\n").find((line) => line.includes("posthog"))
    expect(posthogLine).toContain("installed, not verifiable (no query key)")
    expect(posthogLine).not.toContain("verified")
  })
})

describe("metaRelayNote", () => {
  function report(states: Array<{ provider: string; state: string; key?: string }>): HarnessReport {
    const base = createHarnessReport({ mode: "check", root: "/tmp/x" })
    for (const entry of states) {
      const target = base.providers.find((provider) => provider.provider === entry.provider)
      if (target) {
        target.state = entry.state as (typeof target)["state"]
        if (entry.key) target.key = entry.key
      }
    }
    return base
  }

  it("reports the LOCAL half only, and never claims the cloud toggle it cannot read", () => {
    const note = metaRelayNote(
      report([
        { provider: "meta", state: "adopted", key: "1234567890123" },
        { provider: "server_lane", state: "installed" }
      ])
    )
    expect(note).toContain("Meta relay: on locally")
    expect(note).toContain("cannot read or set")
    // The relay is the Meta path for every founder; PostHog's own Meta destination is the one turned off.
    expect(note).toContain("whether or not you use PostHog")
    expect(note).toContain("turn PostHog's Meta destination off")
    expect(note).not.toContain("do NOT use PostHog")
    // It must never assert the cloud state as a bare fact.
    expect(note).not.toMatch(/relay is (on|enabled)\b/)
  })
})

