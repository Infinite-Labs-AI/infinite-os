import { describe, expect, it } from "vitest"

import {
  HARNESS_PROVIDER_ORDER,
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

describe("provider state machine", () => {
  it("starts every one of the seven providers as absent, in a fixed order", () => {
    const states = initialProviderStates()
    expect(states.map((state) => state.provider)).toEqual([
      "ga4",
      "gtm",
      "posthog",
      "meta",
      "x",
      "infinite",
      "server_lane"
    ])
    expect(HARNESS_PROVIDER_ORDER).toHaveLength(7)
    for (const state of states) {
      expect(state.state).toBe("absent")
      expect(state.verification).toEqual({ kind: "not_run" })
    }
  })

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

  it("keeps adopted and conflict terminal for install steps", () => {
    const adopted = setProviderState(initialProviderStates()[0], "adopted", "existing gtag")
    expect(() => transitionProvider(adopted, { to: "installed" })).toThrow(/adopted/)
    const conflict = setProviderState(initialProviderStates()[0], "conflict", "two ids")
    expect(() => transitionProvider(conflict, { to: "installed" })).toThrow(/conflict/)
  })
})

describe("renderReportTable", () => {
  it("prints all seven providers even when nothing was done", () => {
    const table = renderReportTable(report())
    for (const provider of ["ga4", "gtm", "posthog", "meta", "x", "infinite", "server_lane"]) {
      expect(table).toContain(provider)
    }
    expect(table.split("\n").filter((line) => line.includes("absent"))).toHaveLength(7)
  })

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

  it("renders adopted rows as not ours to verify", () => {
    const current = report()
    current.providers = current.providers.map((state) =>
      state.provider === "gtm"
        ? {
            ...setProviderState(state, "adopted", "GTM-ABCD12 container in index.html"),
            verification: { kind: "adopted_not_ours" }
          }
        : state
    )
    const line = renderReportTable(current)
      .split("\n")
      .find((row) => row.includes("gtm"))
    expect(line).toContain("adopted, not ours to verify")
  })
})

describe("renderReportMarkdown", () => {
  it("writes the table, the failure, the next steps and the Verify before merging checklist", () => {
    const current = report()
    current.failure = {
      step: "verify",
      code: "INF_VERIFY_NO_RECEIPT",
      message: "No ga4 event arrived within 60s.",
      next: "continue"
    }
    current.nextSteps.push("Designate GA4 key events from the Infinite desktop (not done by this run).")
    current.conversions = { proposed: 3, marked: 2, skipped: 1, stale: 0 }
    const markdown = renderReportMarkdown(current)
    expect(markdown).toContain("# Infinite analytics harness report")
    expect(markdown).toContain("| Provider | State | Key | Evidence | Verification |")
    expect(markdown).toContain("`INF_VERIFY_NO_RECEIPT`")
    expect(markdown).toContain("## Verify before merging")
    expect(markdown).toContain("Designate GA4 key events")
    expect(markdown).toContain("Conversions: 3 proposed · 2 marked · 1 skipped · 0 stale")
    expect(markdown).toContain(
      "Open `.infinite/REPORT.md` and work through its 'Verify before merging' checklist"
    )
  })

  it("never prints the word verified for a provider without a receipt", () => {
    const current = report()
    current.providers = current.providers.map((state) =>
      state.provider === "meta"
        ? {
            ...transitionProvider(state, { to: "installed" }),
            verification: { kind: "not_verifiable", reason: "Meta has no install-time read-back" }
          }
        : state
    )
    const markdown = renderReportMarkdown(current)
    const metaRow = markdown.split("\n").find((line) => line.startsWith("| meta"))
    expect(metaRow).toBeDefined()
    expect(metaRow).not.toMatch(/\bverified\b/)
    expect(metaRow).toContain("installed, not verifiable (Meta has no install-time read-back)")
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

  it("says nothing at all when there is no Meta pixel — the line would be noise", () => {
    expect(metaRelayNote(report([{ provider: "server_lane", state: "installed" }]))).toBeNull()
    // A pixel row with no key is a provider we could not resolve, not a pixel on file.
    expect(metaRelayNote(report([{ provider: "meta", state: "skipped" }]))).toBeNull()
  })

  it("reports OFF when a pixel exists but nothing reports outcomes", () => {
    const note = metaRelayNote(report([{ provider: "meta", state: "installed", key: "1234567890123" }]))
    expect(note).toContain("Meta relay: off")
    expect(note).toContain("no server lane reports outcomes")
  })

  it("reports the LOCAL half only, and never claims the cloud toggle it cannot read", () => {
    const note = metaRelayNote(
      report([
        { provider: "meta", state: "adopted", key: "1234567890123" },
        { provider: "server_lane", state: "installed" }
      ])
    )
    expect(note).toContain("Meta relay: on locally")
    expect(note).toContain("cannot read or set")
    // The audience gate travels with the offer: the wrong founder double-counts by turning it on.
    expect(note).toContain("do NOT use PostHog")
    // It must never assert the cloud state as a bare fact.
    expect(note).not.toMatch(/relay is (on|enabled)\b/)
  })
})
