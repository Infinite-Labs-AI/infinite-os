// R4-6 (live run 4): Claude Code (claude-opus-4-8, xhigh) read the 56 KB managed module and thought for 4 min 14 s before
// its first edit; it wrote its own `_fbc` capture (first click wins) because its job said "Boot the pixel…; send browser
// conversions only through infiniteMetaMirror" and gave no bytes. On run 4's own layout, the brief now hands each job its
// exact change, names Infinite's modules as never to be opened (never a file a job must change), and says what the
// helpers do.
import { readFileSync } from "node:fs"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import ts from "typescript"

import { cleanupSites, makeSite } from "../../test/wizard/o7-fakes.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { adoptedInitSites } from "../wizard/deps.js"
import { cookTemplateLiteral } from "../t0/inline-scripts.js"
import { buildMetaClickIdCaptureScript } from "../providers/meta-browser/click-id.js"
import { autoConfigOffLine, buildBrief, capturePasteAsWritten, HELPER_API, type BriefFacts } from "./briefs.js"
import { buildHostGuardExpression } from "../host-guard.js"
import { adoptedMetaGuardRecipe } from "../providers/meta.js"

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
    connections: { ga4MeasurementIds: ["G-QWERT67890"], posthog: null, metaPixelIds: [] },
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
  it("gives a strict TypeScript module plain capture statements beside an imperative pixel init", () => {
    const source = "declare const fbq: (...args: string[]) => void;\nexport function start() {\n  fbq('init', '555500001111222');\n}\n"
    const root = makeSite({ "src/common/tracking.ts": source })
    const brief = buildBrief([item("meta_improve:capture", ["src/common/tracking.ts"])], facts(root, { guardSites: [{ tool: "meta", file: "src/common/tracking.ts", line: 3, context: "js" }], managedFiles: [] }))
    const capture = planData(brief, "meta_improve:capture").capture as { insertBefore: string; pasteAsWritten: string }
    expect(capture.insertBefore).toContain("module top level immediately after imports")
    expect(capture.insertBefore).toContain("outside its preview guard and consent early returns")
    expect(capture.pasteAsWritten).not.toContain("<Script")
    const dir = mkdtempSync(join(tmpdir(), "infinite-capture-ts-"))
    try {
      const file = join(dir, "tracking.ts")
      writeFileSync(file, source.replace("  fbq('init'", `${capture.pasteAsWritten}\n  fbq('init'`))
      const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], skipLibCheck: true })
      expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(capture.pasteAsWritten).toBe(capturePasteAsWritten("typescript_module", "not_required"))
    const serverCode = ts.transpileModule(capture.pasteAsWritten, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    expect(() => runInNewContext(serverCode, { globalThis: {} })).not.toThrow()
  })
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
    expect(data.autoConfigOff).toEqual({ insertBefore: "fbq('init', '7777000011112222') at app/layout.tsx:41", lineAsWritten: autoConfigOffLine("7777000011112222") })
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

describe("LF4-P3: run 4's brief carries no capture blob (the capture is the wizard's code edit now)", () => {
  it("run 4's agent jobs without the capture job: the brief has no capture paste, and it is smaller than before live run 4's brief grew", () => {
    const root = makeSite({ "app/layout.tsx": layout })
    const state = JSON.parse(readFileSync(join(RUN4, "wizard/state.json"), "utf8")) as { jobs: ChecklistItem[] }
    const fresh = (entry: ChecklistItem): ChecklistItem => ({ ...structuredClone(entry), state: "pending", checks: entry.checks.map((check) => ({ id: check.id, tier: check.tier, state: "not_run" })) })
    const all = state.jobs.map(fresh)
    const spec = { mode: "deny" as const, exempt: ["shop.examplebrand.com"], deny: [] }
    const run4Facts = facts(root, { previewGuard: { expression: buildHostGuardExpression(spec), exemptHosts: spec.exempt, metaRecipe: adoptedMetaGuardRecipe(spec) } })
    const withCapture = buildBrief(all, run4Facts)
    const now = buildBrief(all.filter((entry) => entry.id !== "meta_improve:capture"), run4Facts)
    expect(withCapture).toContain("pasteAsWritten")
    expect(now).not.toContain("infinite-meta-click-id")
    expect(now).not.toContain(buildMetaClickIdCaptureScript({ gate: { kind: "infinite-consent", mode: "not_required" } }).slice(0, 80))
    // Measured on run 4's inputs: run 3's brief was 12,889 characters; live-fix 4's capture paste made it 17,219.
    console.info(`LF4-P3 brief chars: with the capture job ${withCapture.length}, now ${now.length}`)
    expect(now.length).toBeLessThan(12_889)
    expect(withCapture.length - now.length).toBeGreaterThan(5_000)
  })
})
