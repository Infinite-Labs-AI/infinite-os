// R4-2 (live run 4): job 5's offline `fbc_capture` check graded the MANAGED page (built from Infinite's keys; Meta was
// not connected, so it had no capture) and said "a landing with an fbclid wrote no _fbc cookie", while production, running
// the agent's `<Script id="meta-fbc-capture">`, wrote `_fbc`. These tests execute the real T0 engine on the page the
// job's files put on the browser.
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { FAKE } from "../../test/wizard/t0-fixtures.js"
import { capturePasteAsWritten } from "../jobs/briefs.js"
import type { CheckResult, ChecklistItem } from "../wizard/contracts/jobs.js"
import { itemT0Scenarios, runItemT0 } from "../wizard/item-t0.js"
import { inlineScriptsOf } from "./inline-scripts.js"
import { reasonCode, runT0Scenarios } from "./scenarios.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const merged = readFileSync(join(RUN4, "merged-5e6f3f3/app/layout.tsx"), "utf8")
const base = readFileSync(join(RUN4, "site-b7c8347/app/layout.tsx"), "utf8")
const HOST = "shop.examplebrand.com"
const NOW = () => new Date("2026-10-03T20:52:39.000Z")

describe("inlineScriptsOf: run 4's merged app/layout.tsx", () => {
  it("reads the four inline <Script> bodies in order, cooked, and lists the gtag loader as external", () => {
    const read = inlineScriptsOf("app/layout.tsx", merged)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.scripts.map((script) => script.label)).toEqual(["app/layout.tsx:17", "app/layout.tsx:24", "app/layout.tsx:33", "app/layout.tsx:51"])
    expect(read.externals).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-QWERT67890"])
    // The guard's `\\s` in the source is `\s` once cooked.
    expect(read.scripts[1]!.code).toContain("replace(/^\\s+|\\s+$/g")
    expect(read.scripts[2]!.code).toContain("var fbc = 'fb.1.' + Date.now() + '.' + fbclid;")
  })

  it("negative: a body holding ${…} is refused with its line, never guessed", () => {
    const read = inlineScriptsOf("app/layout.tsx", '<Script id="x">{`fbq("init", "${PIXEL}")`}</Script>')
    expect(read).toEqual({ ok: false, reason: expect.stringContaining("app/layout.tsx:1") })
  })
})

describe("R4-2: itemT0Scenarios hands an adopted Meta job ITS page, never the managed one", () => {
  it("runs the site module capture after re-indentation, and refuses changed or dead code", async () => {
    const moduleItem: ChecklistItem = { ...item(), allow: { files: ["src/common/tracking.ts"], create: [] } }
    const capture = capturePasteAsWritten("typescript_module", "not_required")
    const indented = capture.split("\n").map((line) => `  ${line}`).join("\r\n")
    const source = `${indented}\r\nexport function boot() { fbq('init', '555500001111222'); }`
    const scenarios = await itemT0Scenarios(moduleItem, [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(source), root: "/repo" })
    const browserCode = (scenarios[0]?.params.source as { scripts?: Array<{ code: string }> } | undefined)?.scripts?.[0]?.code
    expect(browserCode).toContain("\r\n")
    expect(browserCode).toMatch(/^  \(function/)
    const results = await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(results[0]?.state, results[0]?.reason).toBe("pass")
    const broken = await itemT0Scenarios(moduleItem, [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(source.replace('document.cookie = "_fbc=" + value', 'void "_fbc=" + value')), root: "/repo" })
    const negative = await runItemT0({ checks: { t0 } as never }, broken, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(negative[0]?.state).toBe("undetermined")
    for (const dead of [`function neverCalled() {\n${capture}\n}\nexport function boot() { fbq('init', '555500001111222'); }`, `/*\n${capture}\n*/\nexport function boot() { fbq('init', '555500001111222'); }`, `const example = \`${capture}\`;\nexport function boot() { fbq('init', '555500001111222'); }`]) {
      const unrun = await itemT0Scenarios(moduleItem, [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(dead), root: "/repo" })
      const result = await runItemT0({ checks: { t0 } as never }, unrun, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
      expect(result[0]?.state).toBe("undetermined")
    }
  })
  const item = (): ChecklistItem => ({
    id: "meta_improve:capture",
    jobId: "meta_improve",
    n: 5,
    title: "Improve the existing Meta pixel",
    owner: "agent",
    trigger: { finding: "capture", evidence: [{ file: "app/layout.tsx", line: 41 }] },
    allow: { files: ["app/layout.tsx"], create: [] },
    checks: [{ id: "fbc_capture", tier: "T0", state: "not_run" }],
    state: "claimed"
  })
  const fsOf = (text: string) => ({ readText: async () => text })
  const t0 = (scenarios: Parameters<typeof runT0Scenarios>[0]) => runT0Scenarios(scenarios, {}, { runId: FAKE.runId, now: NOW })
})

describe("LF4-P2-1: a capture the page model cannot run is undetermined, never 'no_fbc_capture'", () => {
  const capturePlace = '        {/* Meta ad-click id (_fbc) capture'
  const pixelPlace = '        {/* Meta Pixel (added by the marketing agency) */}'
  /** Run 4's merged layout with its inline capture swapped for `replacement` (and `imports` prepended). */
  const withCapture = (replacement: string, imports = "") =>
    `${imports}${merged.slice(0, merged.indexOf(capturePlace))}${replacement}\n${merged.slice(merged.indexOf(pixelPlace))}`
  const CLIENT = withCapture("        <FbcCapture />", 'import { FbcCapture } from "./fbc-capture"\n')
  const SRC = withCapture('        <Script src="/fbc-capture.js" strategy="afterInteractive" />')
  const item = (create: string[] = []): ChecklistItem => ({
    id: "meta_improve:capture",
    jobId: "meta_improve",
    n: 5,
    title: "Improve the existing Meta pixel",
    owner: "agent",
    trigger: { finding: "capture", evidence: [{ file: "app/layout.tsx", line: 41 }] },
    allow: { files: ["app/layout.tsx"], create },
    checks: [{ id: "fbc_capture", tier: "T0", state: "not_run" }],
    state: "claimed"
  })
  const t0 = (scenarios: Parameters<typeof runT0Scenarios>[0]) => runT0Scenarios(scenarios, {}, { runId: FAKE.runId, now: NOW })
  const grade = async (files: Record<string, string>, create: string[] = []) => {
    const fs = { readText: async (path: string) => files[path.replace(/^\/repo\//, "")] ?? null }
    const scenarios = await itemT0Scenarios(item(create), [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs, root: "/repo" })
    return (await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() }))[0]!
  }

  it("a capture as a client component the layout renders → undetermined, naming the component", async () => {
    const result = await grade({ "app/layout.tsx": CLIENT })
    expect(result.state).toBe("undetermined")
    expect(reasonCode(result)).not.toBe("no_fbc_capture")
    expect(result.reason).toContain("renders <FbcCapture> from ./fbc-capture")
  })

  // LF4 round 1 (P3): a Next layout almost always renders a component from the site's own code; each one made T0
  // undetermined. The page builder now follows it into its file.
  describe("round 1: a rendered local component is followed into its file", () => {
    const HEADER = '"use client"\nimport Link from "next/link"\nimport { useState } from "react"\nexport function SiteHeader() {\n  const [open, setOpen] = useState(false)\n  return <header><Link href="/">Smoke Co.</Link><button onClick={() => setOpen(!open)}>Menu</button></header>\n}\n'
    const withHeader = (spec: string) => `import { SiteHeader } from "${spec}"\n${merged.replace("      <body>\n", "      <body>\n        <SiteHeader />\n")}`
    const CAPTURE_BODY = "(function(){var p=new URLSearchParams(location.search).get('fbclid');if(!p)return;document.cookie='_fbc=fb.1.'+Date.now()+'.'+p+';path=/';window.infiniteMetaClickId='fb.1.'+Date.now()+'.'+p})();"
    const SCRIPTED = `import Script from "next/script"\nexport function FbcCapture() {\n  return <Script id="cap" strategy="afterInteractive">{\`${CAPTURE_BODY}\`}</Script>\n}\n`

    it("a component whose own <Script> is the capture: its script goes on the page and the real T0 grades it", async () => {
      const graded = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": SCRIPTED })
      expect(graded.state).not.toBe("undetermined")
      expect(reasonCode(graded)).not.toBe("no_fbc_capture")
      // NEGATIVE: the same component file with no script in it → the page holds no capture → a real problem.
      const empty = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": "export function FbcCapture() {\n  return null\n}\n" })
      expect(reasonCode(empty)).toBe("no_fbc_capture")
    })
  })

  // Live-fix 4 final round (P2): the page is what the exported layout component RENDERS. The text scan counted every
  // <Script> in a file (a helper nothing renders gave a false pass) and dropped a namespace member, a next/dynamic or
  // React.lazy component and a package component (a capture there gave a false `no_fbc_capture`).
  describe("final round: the page is what the exported component renders", () => {
    const CAPTURE_BODY = "(function(){var p=new URLSearchParams(location.search).get('fbclid');if(!p)return;document.cookie='_fbc=fb.1.'+Date.now()+'.'+p+';path=/';window.infiniteMetaClickId='fb.1.'+Date.now()+'.'+p})();"
    const SCRIPT = `<Script id="cap" strategy="afterInteractive">{\`${CAPTURE_BODY}\`}</Script>`
    const SCRIPTED = `import Script from "next/script"\nexport function FbcCapture() {\n  return ${SCRIPT}\n}\n`
    const EFFECT = '"use client"\nimport { useEffect } from "react"\nexport function FbcCapture() {\n  useEffect(() => { document.cookie = "_fbc=fb.1.1.x;path=/" }, [])\n  return null\n}\n'
    const undeterminedNot = (result: CheckResult, contains: string) => {
      expect(result.state).toBe("undetermined")
      expect(reasonCode(result)).not.toBe("no_fbc_capture")
      expect(result.reason).toContain(contains)
    }

    it("NEGATIVE: a <Script> in a helper the layout never renders is not on the page (never a false pass); a rendered one is", async () => {
      const helper = `\nfunction OldCapture() {\n  return ${SCRIPT}\n}\n`
      const unrendered = await grade({ "app/layout.tsx": withCapture("") + helper })
      expect(reasonCode(unrendered)).toBe("no_fbc_capture")
      const rendered = await grade({ "app/layout.tsx": withCapture("        <OldCapture />") + helper })
      expect(rendered.state).not.toBe("undetermined")
      expect(reasonCode(rendered)).not.toBe("no_fbc_capture")
      // A JSX value the layout puts in `{…}` is rendered too.
      const value = await grade({ "app/layout.tsx": withCapture("        {capture}") + `\nconst capture = ${SCRIPT}\n` })
      expect(reasonCode(value)).not.toBe("no_fbc_capture")
    })
  })
})
