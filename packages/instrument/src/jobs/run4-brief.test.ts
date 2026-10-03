// R4-6 (live run 4): Claude Code (claude-opus-4-8, xhigh) read the 56 KB managed module and thought for 4 min 14 s before
// its first edit; it wrote its own `_fbc` capture (first click wins) because its job said "Boot the pixel…; send browser
// conversions only through infiniteMetaMirror" and gave no bytes. On run 4's own layout, the brief now hands each job its
// exact change, names Infinite's modules as never to be opened (never a file a job must change), and says what the
// helpers do.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, makeSite } from "../../test/wizard/o7-fakes.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { adoptedInitSites } from "../wizard/deps.js"
import { cookTemplateLiteral } from "../t0/inline-scripts.js"
import { buildMetaClickIdCaptureScript } from "../providers/meta-browser/click-id.js"
import { autoConfigOffLine, buildBrief, HELPER_API, type BriefFacts } from "./briefs.js"

afterEach(cleanupSites)

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const layout = readFileSync(join(RUN4, "site-b7c8347/app/layout.tsx"), "utf8")

const item = (id: string, files: string[]): ChecklistItem => ({
  id,
  jobId: id.split(":")[0] as ChecklistItem["jobId"],
  n: 5,
  title: "Improve the existing Meta pixel",
  owner: "agent",
  trigger: { finding: "Meta: save the ad-click id (_fbc) on landing pages beside your existing pixel", evidence: [{ file: "app/layout.tsx", line: 41 }] },
  allow: { files, create: [] },
  checks: [],
  state: "pending"
})

function facts(root: string, over: Partial<BriefFacts> = {}): BriefFacts {
  return {
    runId: "85483904-c9a1-4125-bb85-8fd66e709247",
    framework: "next-app-router",
    packageManager: "npm",
    router: "app",
    appRoot: ".",
    plan: { conversionNames: ["signup"], privacyText: null, lines: [] },
    connections: { ga4MeasurementIds: ["G-8YB9G7SJE7"], posthog: null, metaPixelIds: [] },
    helpers: { module: "lib/infinite-analytics.ts" },
    guardSites: adoptedInitSites(root, "."),
    consentMode: "not_required",
    managedFiles: ["lib/infinite-analytics.ts", "lib/infinite-analytics-client.tsx", "app/layout.tsx"],
    ...over
  }
}

const planData = (brief: string, id: string): Record<string, unknown> => {
  const block = brief.slice(brief.indexOf(`### Job "${id}"`))
  return JSON.parse(/Plan data \(JSON; decided by the user, use it exactly\): (.*)$/m.exec(block)![1]!) as Record<string, unknown>
}

describe("R4-6: run 4's brief hands each job its exact change", () => {
  it("the capture job gets Infinite's capture as written for the <Script> body, and where; its own task, not the job's gist", () => {
    const root = makeSite({ "app/layout.tsx": layout })
    const brief = buildBrief([item("meta_improve:capture", ["app/layout.tsx"])], facts(root))
    const capture = planData(brief, "meta_improve:capture").capture as { insertBefore: string; pasteAsWritten: string }
    expect(capture.insertBefore).toBe("the <Script> element that holds fbq('init') at app/layout.tsx:41")
    const body = /^<Script id="infinite-meta-click-id" strategy="afterInteractive">\{`([\s\S]*)`\}<\/Script>$/.exec(capture.pasteAsWritten)![1]!
    expect(cookTemplateLiteral(body)).toBe(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "not_required" } }))
    expect(brief).toContain("What: Add Infinite's `_fbc` capture beside the existing pixel, exactly as Plan data gives it.")
    // NEGATIVE: run 4's capture job read the whole job's gist (mirror + boot), which is not this job.
    expect(brief).not.toContain("send browser conversions only through `infiniteMetaMirror(metaEventId)`")
  })

  it("the autoConfig job gets the one line, with the pixel id read from the site's own init", () => {
    const root = makeSite({ "app/layout.tsx": layout })
    const data = planData(buildBrief([item("meta_improve:autoconfig_off_adopted", ["app/layout.tsx"])], facts(root)), "meta_improve:autoconfig_off_adopted")
    expect(data.autoConfigOff).toEqual({ insertBefore: "fbq('init', '1116400780828774') at app/layout.tsx:41", lineAsWritten: autoConfigOffLine("1116400780828774") })
  })

  it("Infinite's modules are named as never to be opened, never a file a job must change; the helpers' API is in the brief", () => {
    const root = makeSite({ "app/layout.tsx": layout })
    const brief = buildBrief([item("meta_improve:capture", ["app/layout.tsx"])], facts(root))
    expect(brief).toContain(`Infinite's own files (never open or edit them; everything you need from them is in this brief): ["lib/infinite-analytics.ts","lib/infinite-analytics-client.tsx"].`)
    expect(brief).toContain(HELPER_API)
    expect(HELPER_API).toContain("never Infinite's ledger")
  })

  it("negative: a capture job with no consent answer refuses to brief (never a guessed consent hook)", () => {
    const root = makeSite({ "app/layout.tsx": layout })
    expect(() => buildBrief([item("meta_improve:capture", ["app/layout.tsx"])], facts(root, { consentMode: null }))).toThrow(/approved consent mode/)
  })
})
