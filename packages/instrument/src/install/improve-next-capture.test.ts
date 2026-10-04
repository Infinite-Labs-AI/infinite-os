// LF4-P2 (live run 4): the `_fbc` capture beside a Next `<Script>` pixel is a WIZARD code edit. Run 4 handed it to the agent
// as a 6 KB blob to retype (the brief grew 12.9k → 17.2k), and the offline check could not read every shape the agent
// chose (a client component, a src script) — a false negative. Now the wizard inserts Infinite's own capture as its own
// `<Script>` right before the pixel's, and the REAL T0 engine grades the page the edit produced.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { FAKE } from "../../test/wizard/t0-fixtures.js"
import { fakeKeys, IDS } from "../../test/wizard/o7-fakes.js"
import { detectProvidersWithEvidence } from "../harness/inspect.js"
import { reverseTextEdits } from "../server-lane/text-edits.js"
import { pageSourceFromFiles } from "../t0/inline-scripts.js"
import { runT0Scenarios } from "../t0/scenarios.js"
import { applyImproveEdit, CAPTURE_JSX_MARKER, detectAdoptedFacts, improveLinesFor, nextScriptPixelElement } from "./improve.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const BASE = readFileSync(join(RUN4, "site-b7c8347/app/layout.tsx"), "utf8")
const HOST = "shop.examplebrand.com"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "infinite-tag-next-capture-"))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

function captureLine(root: string) {
  const facts = detectAdoptedFacts(root, detectProvidersWithEvidence(root))
  const lines = improveLinesFor(facts, { framework: "next-app-router", keys: fakeKeys(), sensitivePaths: [], vercelServed: true })
  return { facts, line: lines.find((entry) => entry.kind === "capture_beside_adopted_pixel")! }
}

async function fbcCapture(layout: string) {
  const built = pageSourceFromFiles([{ file: "app/layout.tsx", source: layout }])
  if (!built.ok) throw new Error(built.reason)
  const [result] = await runT0Scenarios([{ id: "fbc", checkId: "fbc_capture", params: { productionHost: HOST, source: built.source } }], {}, { runId: FAKE.runId, now: () => new Date("2026-10-03T20:52:39.000Z") })
  return result!
}

const PACKAGE = JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } })

describe("LF4-P2: the capture beside run 4's Next <Script> pixel is a code edit, graded on the page it writes", () => {
  it("run 4's layout: the plan line is code-owned, the edit writes the capture before the pixel, and the real T0 engine passes it", async () => {
    const root = site({ "package.json": PACKAGE, "app/layout.tsx": BASE })
    const { facts, line } = captureLine(root)
    expect(facts.meta[0]).toMatchObject({ nextScript: true, executable: true })
    expect(line.owner).toBe("code")
    const result = applyImproveEdit({ root, appRoot: ".", framework: "next-app-router", line, keys: fakeKeys(), consentMode: "not_required", runId: IDS.run, vercelServed: true })
    expect(result.ok).toBe(true)
    const after = readFileSync(join(root, "app/layout.tsx"), "utf8")
    expect(after).toContain(CAPTURE_JSX_MARKER)
    expect(after.indexOf('<Script id="infinite-meta-click-id" strategy="afterInteractive">')).toBeLessThan(after.indexOf('<Script id="meta-pixel"'))
    // The pixel's own element is byte-for-byte unchanged.
    expect(after).toContain(BASE.slice(BASE.indexOf('<Script id="meta-pixel"'), BASE.indexOf("</head>")))
    expect(await fbcCapture(after)).toMatchObject({ state: "pass" })
    // NEGATIVE: the base layout has no capture.
    expect(await fbcCapture(BASE)).toMatchObject({ state: "problem" })
    // The record reverses to the exact original bytes; a second apply changes nothing.
    expect(result.ok && result.record && reverseTextEdits(after, result.record.textEdits)).toBe(BASE)
    expect(applyImproveEdit({ root, appRoot: ".", framework: "next-app-router", line, keys: fakeKeys(), consentMode: "not_required", runId: IDS.run, vercelServed: true })).toEqual({ ok: true, record: null })
  })

  it("NEGATIVE: a CMP-held <Script> pixel stays the agent's (the capture must wait for the same consent), and a forced edit refuses", () => {
    const held = BASE.replace('<Script id="meta-pixel" strategy="afterInteractive">', '<Script id="meta-pixel" type="text/plain" data-cookieconsent="marketing">')
    const root = site({ "package.json": PACKAGE, "app/layout.tsx": held })
    const { line } = captureLine(root)
    expect(line.owner).toBe("agent")
    expect(applyImproveEdit({ root, appRoot: ".", framework: "next-app-router", line: { ...line, owner: "code" }, keys: fakeKeys(), consentMode: "not_required", runId: IDS.run, vercelServed: true })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/consent manager/)
    })
    expect(readFileSync(join(root, "app/layout.tsx"), "utf8")).toBe(held)
  })

  it("NEGATIVE: a pixel <Script> returned as a component's root has no sibling slot, so it is never a code edit", () => {
    const component = `import Script from "next/script"\n\nexport function Pixel() {\n  return <Script id="meta-pixel">{\`fbq('init', '${IDS.meta}');\`}</Script>\n}\n`
    expect(nextScriptPixelElement(component)).toBeNull()
    expect(nextScriptPixelElement(BASE)).toMatchObject({ name: "Script" })
    // An attribute holding an arrow function's `>` does not end the opening tag early.
    const onLoad = BASE.replace('<Script id="meta-pixel" strategy="afterInteractive">', '<Script id="meta-pixel" strategy="afterInteractive" onLoad={() => window.x && 1 > 0}>')
    expect(nextScriptPixelElement(onLoad)?.tag).toContain("onLoad={() => window.x && 1 > 0}>")
  })
})
