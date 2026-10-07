// DECISIONS §10 W19 (live run 3, R3-4 / A7): on run 3's own site and `before.json`,
// - "IDs match connections" in Live today is undetermined (nothing connected), never the duplicate check's problem;
// - no "double-count" words without a measured `duplicate_page_view`;
// - the plan says GA4 and Meta are in the code but not connected (each with its in-code ID), and carries the Meta
//   Traffic Permissions line;
// - the install scan and the census agree on the adopted tools (ONE detector: the Meta snippet inside a
//   <Script>{`…`}</Script> template literal is seen by both).
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, fakeHosting, fakeProductionDeniedConflict, IDS, makeSite } from "../../test/wizard/o7-fakes.js"
import { RUN3_DIR, run3File, run3Json } from "../../test/wizard/run3-fixture.js"
import { runCensus } from "../checks/census.js"
import { liveTodayColumnInput } from "../wizard/before-column.js"
import type { BuildResult } from "../wizard/contracts/jobs.js"
import { testExpectFromKeys } from "../wizard/contracts/test-engine.js"
import type { BeforeFactsFile } from "../wizard/handoff/before-facts.js"
import { buildColumn } from "../wizard/report.js"
import { WizardInstaller } from "./installer.js"
import { duplicateFindings, type WizardBeforeFacts } from "./plan-model.js"

afterEach(cleanupSites)

const before = run3Json<BeforeFactsFile>("wizard/before.json")

function siteFiles(): Record<string, string> {
  const base = join(RUN3_DIR, "site-6d16d8f")
  const walk = (at: string): string[] =>
    readdirSync(join(base, at)).flatMap((name) => {
      const rel = at ? `${at}/${name}` : name
      return statSync(join(base, rel)).isDirectory() ? walk(rel) : [rel]
    })
  return Object.fromEntries(walk("").map((rel) => [rel, run3File(`site-6d16d8f/${rel}`)]))
}

describe("W19 live run 3's before facts and plan", () => {
  it("Live today: IDs match connections is undetermined (not connected), not the duplicate check's problem; each tool once is the problem", () => {
    const keys = before.facts.keys
    const column = buildColumn(
      "live_today",
      liveTodayColumnInput({
        runId: before.runId,
        measuredAt: before.measuredAt,
        keys,
        expect: testExpectFromKeys(keys),
        census: before.facts.census,
        dryLive: before.facts.dryLive,
        grades: before.grades,
        liveChecks: before.liveChecks,
        baseline: before.facts.baseline,
        repeatedInits: [{ tool: "ga4", id: "G-TEST0000000", count: 2 }],
        loginFound: before.loginFound,
        spaNavigationRequested: false
      })
    )
    expect(column.finishLine.ids_match_connections).toMatchObject({ state: "undetermined" })
    expect(column.finishLine.each_tool_once).toMatchObject({ state: "problem" })
  })

  it("no 'double-count' words without a measured duplicate page view (the code holds the ID twice: say only that)", () => {
    const texts = duplicateFindings(before.facts as WizardBeforeFacts).map((finding) => finding.text)
    expect(texts).toContain("GA4: G-TEST0000000 is set up 2 times in your code. Keep one.")
    for (const text of texts) expect(text).not.toMatch(/count|twice as/i)
  })

  it("the scan and the census agree on the adopted tools; the plan has the GA4 and Meta connect lines and the Traffic Permissions line", async () => {
    const root = makeSite(siteFiles())
    const adoptedByCensus = [...new Set(runCensus({ root, appRoot: "." }).entries.filter((entry) => entry.owner === "adopted").map((entry) => entry.tool))].sort()
    expect(adoptedByCensus).toEqual(["ga4", "meta"])

    const subject = new WizardInstaller({
      repoFingerprint: IDS.fingerprint,
      runId: () => IDS.run,
      agent: () => ({ worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } }),
      consentFlag: () => null,
      productionDeniedConflict: fakeProductionDeniedConflict,
      build: async (): Promise<BuildResult> => ({ ok: true, failureSignature: [], durationMs: 1 })
    })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, before.facts.keys, before.facts as WizardBeforeFacts, [])
    // An adopted, unconnected tool's connect line names its in-code ID; an absent tool keeps today's line.
    const adoptedByScan = [...new Set(plan.lines.filter((line) => line.id.startsWith("user_action:connect_") && line.text.includes("in your code")).map((line) => line.id.replace("user_action:connect_", "")))].sort()
    expect(adoptedByScan).toEqual(adoptedByCensus)
    const text = (id: string) => plan.lines.find((line) => line.id === id)?.text
    expect(text("user_action:connect_ga4")).toBe("GA4 (G-TEST…0000 in your code): connect it in Infinite so the wizard can check that ID is yours. The repository changes shown in this plan can still run.")
    expect(text("user_action:connect_meta")).toBe("Meta (777700…2222 in your code): connect it in Infinite so the wizard can check that ID is yours. The repository changes shown in this plan can still run.")
    expect(plan.lines.some((line) => line.id === "user_action:meta_traffic_permissions")).toBe(true)
  })
})
