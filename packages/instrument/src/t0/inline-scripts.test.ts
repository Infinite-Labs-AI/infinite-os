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
import { itemT0Scenarios, runItemT0, T0_UNBUILDABLE_PREFIX } from "../wizard/item-t0.js"
import { cookTemplateLiteral, definesComponent, inlineScriptsOf, pageSourceFromFiles } from "./inline-scripts.js"
import { reasonCode, runT0Scenarios } from "./scenarios.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const merged = readFileSync(join(RUN4, "merged-5e6f3f3/app/layout.tsx"), "utf8")
const base = readFileSync(join(RUN4, "site-b7c8347/app/layout.tsx"), "utf8")
const HOST = "shop.examplebrand.com"
const NOW = () => new Date("2026-10-03T20:52:39.000Z")

async function fbcCapture(source: ReturnType<typeof pageSourceFromFiles>): Promise<CheckResult> {
  if (!source.ok) throw new Error(source.reason)
  const results = await runT0Scenarios([{ id: "fbc", checkId: "fbc_capture", params: { productionHost: HOST, source: source.source } }], {}, { runId: FAKE.runId, now: NOW })
  expect(results).toHaveLength(1)
  return results[0]!
}

/** The run-4 layout with Infinite's capture pasted as the brief now gives it, in place of the agent's own script. */
function withManagedCapture(layout: string): string {
  const start = layout.indexOf('        {/* Meta ad-click id (_fbc) capture')
  const pixel = layout.indexOf('        {/* Meta Pixel (added by the marketing agency) */}')
  expect(start).toBeGreaterThan(0)
  expect(pixel).toBeGreaterThan(start)
  return `${layout.slice(0, start)}        ${capturePasteAsWritten("component", "not_required")}\n${layout.slice(pixel)}`
}

describe("cookTemplateLiteral (the engine's own escapes)", () => {
  it("cooks escapes the way a template literal does", () => {
    expect(cookTemplateLiteral("a\\\\s+b")).toBe("a\\s+b")
    expect(cookTemplateLiteral("x\\`y\\${z}")).toBe("x`y${z}")
    expect(cookTemplateLiteral("\\u0041\\x42\\u{43}\\n")).toBe("ABC\n")
    expect(cookTemplateLiteral("line\\\nnext")).toBe("linenext")
  })

  it("negative: a substitution or an engine-rejected escape cannot be known without running the file", () => {
    expect(cookTemplateLiteral("var id = '${process.env.X}'")).toBeNull()
    expect(cookTemplateLiteral("\\08")).toBeNull()
    expect(cookTemplateLiteral("\\xZZ")).toBeNull()
  })
})

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

  it("reads a single-quoted literal escape by escape: an escaped quote, an escaped backslash before a double quote, a bare double quote", () => {
    expect(inlineScriptsOf("app/a.tsx", "<script dangerouslySetInnerHTML={{ __html: 'gtag(\\'js\\', \"x\")' }} />")).toMatchObject({ ok: true, scripts: [{ code: "gtag('js', \"x\")" }] })
    expect(inlineScriptsOf("app/a.tsx", "<script dangerouslySetInnerHTML={{ __html: 'a\\\\\\\"b' }} />")).toMatchObject({ ok: true, scripts: [{ code: 'a\\"b' }] })
  })

  it("an HTML script's end tag may carry whitespace and junk before its >", () => {
    expect(inlineScriptsOf("index.html", "<script>window.a = 1</script\t\n bar>")).toMatchObject({ ok: true, scripts: [{ code: "window.a = 1" }] })
  })

  it("reads dangerouslySetInnerHTML literals and an HTML page's own scripts", () => {
    expect(inlineScriptsOf("app/a.tsx", '<script dangerouslySetInnerHTML={{ __html: "window.a = 1" }} />')).toMatchObject({ ok: true, scripts: [{ code: "window.a = 1" }] })
    expect(inlineScriptsOf("index.html", '<script src="/x.js"></script><script type="application/ld+json">{}</script><script>window.b=2</script>')).toMatchObject({
      ok: true,
      scripts: [{ code: "window.b=2", label: "index.html:1" }],
      externals: ["/x.js"]
    })
  })
})

describe("R4-2: fbc_capture grades the page the job's files put on the browser", () => {
  it("run 4's merged layout WRITES _fbc (never the live false negative 'wrote no _fbc cookie'); its first-click-wins script is named for what it is", async () => {
    const result = await fbcCapture(pageSourceFromFiles([{ file: "app/layout.tsx", source: merged }]))
    expect(reasonCode(result)).not.toBe("no_fbc_capture")
    // The agent's own capture never replaces a stored _fbc, so a second ad click is lost: a real problem, named.
    expect(result.state).toBe("problem")
    expect(reasonCode(result)).toBe("fbc_not_last_click")
  })

  it("the capture the brief now hands the agent (Infinite's, escaped for the <Script> body) passes on the same layout", async () => {
    const result = await fbcCapture(pageSourceFromFiles([{ file: "app/layout.tsx", source: withManagedCapture(merged) }]))
    expect(result.state, result.reason).toBe("pass")
  })

  it("negative: the layout before the run (no capture at all) wrote no _fbc", async () => {
    expect(reasonCode(await fbcCapture(pageSourceFromFiles([{ file: "app/layout.tsx", source: base }])))).toBe("no_fbc_capture")
  })
})

describe("R4-2: itemT0Scenarios hands an adopted Meta job ITS page, never the managed one", () => {
  it("runs the exact strict TypeScript module capture as browser code, and refuses changed bytes", async () => {
    const moduleItem: ChecklistItem = { ...item(), allow: { files: ["src/common/tracking.ts"], create: [] } }
    const source = `export function boot() {\n${capturePasteAsWritten("typescript_module", "not_required")}\nfbq('init', '555500001111222');\n}`
    const scenarios = await itemT0Scenarios(moduleItem, [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(source), root: "/repo" })
    const results = await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(results[0]?.state, results[0]?.reason).toBe("pass")
    const broken = await itemT0Scenarios(moduleItem, [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(source.replace('document.cookie = "_fbc=" + value', 'void "_fbc=" + value')), root: "/repo" })
    const negative = await runItemT0({ checks: { t0 } as never }, broken, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(negative[0]?.state).toBe("undetermined")
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

  it("the scenario carries the job file's scripts; the real T0 then grades the agent's code", async () => {
    const scenarios = await itemT0Scenarios(item(), [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(merged), root: "/repo" })
    expect(scenarios[0]!.params.source).toBeDefined()
    const results = await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(reasonCode(results[0]!)).toBe("fbc_not_last_click")
  })

  it("negative: a file the wizard cannot read without running it is undetermined (never the managed page's verdict)", async () => {
    const scenarios = await itemT0Scenarios(item(), [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf('<Script id="m">{`fbq("init", "${ID}")`}</Script>'), root: "/repo" })
    const results = await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(results[0]).toMatchObject({ state: "undetermined" })
    expect(results[0]!.reason).toContain(T0_UNBUILDABLE_PREFIX)
    expect(results[0]!.reason).toContain("app/layout.tsx:1")
  })
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

  it("a capture as a <Script src> of the site's own file → undetermined, naming the script", async () => {
    const result = await grade({ "app/layout.tsx": SRC })
    expect(result.state).toBe("undetermined")
    expect(result.reason).toContain("loads /fbc-capture.js")
  })

  it("a file the job may create is on the page: a capture <Script> in it is graded with the layout", async () => {
    const created = `import Script from "next/script"\nexport function Capture() {\n  return <Script id="cap">{\`${"document.cookie = '_fbc=fb.1.' + Date.now() + '.' + new URLSearchParams(location.search).get('fbclid') + ';path=/';"}\`}</Script>\n}\n`
    const pageOnly = pageSourceFromFiles([
      { file: "app/layout.tsx", source: withCapture("") },
      { file: "app/capture.tsx", source: created }
    ])
    expect(pageOnly.ok).toBe(true)
    // Through the item: the create file is read (its absence is not an error).
    const missing = await grade({ "app/layout.tsx": withCapture("") }, ["app/capture.tsx"])
    expect(reasonCode(missing)).toBe("no_fbc_capture")
    const present = await grade({ "app/layout.tsx": withCapture(""), "app/capture.tsx": created }, ["app/capture.tsx"])
    expect(reasonCode(present)).not.toBe("no_fbc_capture")
  })

  it("NEGATIVE: Infinite's managed client and vendor loaders are known code: run 4's merged layout is still graded (never refused)", () => {
    const read = inlineScriptsOf("app/layout.tsx", merged)
    expect(read).toMatchObject({ ok: true, unmodeled: [] })
  })

  // LF4 round 1 (P3): a Next layout almost always renders a component from the site's own code; each one made T0
  // undetermined. The page builder now follows it into its file.
  describe("round 1: a rendered local component is followed into its file", () => {
    const HEADER = '"use client"\nimport Link from "next/link"\nimport { useState } from "react"\nexport function SiteHeader() {\n  const [open, setOpen] = useState(false)\n  return <header><Link href="/">Smoke Co.</Link><button onClick={() => setOpen(!open)}>Menu</button></header>\n}\n'
    const withHeader = (spec: string) => `import { SiteHeader } from "${spec}"\n${merged.replace("      <body>\n", "      <body>\n        <SiteHeader />\n")}`
    const CAPTURE_BODY = "(function(){var p=new URLSearchParams(location.search).get('fbclid');if(!p)return;document.cookie='_fbc=fb.1.'+Date.now()+'.'+p+';path=/';window.infiniteMetaClickId='fb.1.'+Date.now()+'.'+p})();"
    const SCRIPTED = `import Script from "next/script"\nexport function FbcCapture() {\n  return <Script id="cap" strategy="afterInteractive">{\`${CAPTURE_BODY}\`}</Script>\n}\n`

    it("a markup-only header (state and a click handler, no effect) puts nothing on the page: the layout is graded on its own scripts", async () => {
      // Before: "renders <SiteHeader> from ./site-header, which the offline page cannot run" → undetermined.
      expect(pageSourceFromFiles([{ file: "app/layout.tsx", source: withHeader("./site-header") }])).toMatchObject({ ok: false })
      const graded = await grade({ "app/layout.tsx": withHeader("./site-header"), "app/site-header.tsx": HEADER })
      expect(graded.state).not.toBe("undetermined")
      expect(reasonCode(graded)).toBe("fbc_not_last_click")
      // The alias form, from the repo root or its src/.
      expect(reasonCode(await grade({ "app/layout.tsx": withHeader("@/components/site-header"), "src/components/site-header.tsx": HEADER }))).toBe("fbc_not_last_click")
    })

    it("a component whose own <Script> is the capture: its script goes on the page and the real T0 grades it", async () => {
      const graded = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": SCRIPTED })
      expect(graded.state).not.toBe("undetermined")
      expect(reasonCode(graded)).not.toBe("no_fbc_capture")
      // NEGATIVE: the same component file with no script in it → the page holds no capture → a real problem.
      const empty = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": "export function FbcCapture() {\n  return null\n}\n" })
      expect(reasonCode(empty)).toBe("no_fbc_capture")
    })

    it("NEGATIVE: a component that writes _fbc in an effect, or calls a hook from the site's code, stays undetermined, naming why", async () => {
      const effect = '"use client"\nimport { useEffect } from "react"\nexport function FbcCapture() {\n  useEffect(() => { document.cookie = "_fbc=fb.1.1.x;path=/" }, [])\n  return null\n}\n'
      const viaEffect = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": effect })
      expect(viaEffect.state).toBe("undetermined")
      expect(viaEffect.reason).toContain("app/layout.tsx:33: <FbcCapture> (app/fbc-capture.tsx) runs browser code, which the offline page cannot run")
      const hook = 'import { useFbc } from "../lib/use-fbc"\nexport function FbcCapture() {\n  useFbc()\n  return null\n}\n'
      const viaHook = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": hook })
      expect(viaHook.state).toBe("undetermined")
      expect(viaHook.reason).toContain("<FbcCapture> (app/fbc-capture.tsx) calls the hook useFbc")
    })
  })

  // LF4 close round 2 (P2-1): at 709c10b a capture behind a barrel file, a default re-export, or a local helper called
  // at render was graded as if the page held no capture: a false `problem no_fbc_capture` where 5a8d984 said
  // undetermined. The followed file must DEFINE the component, and a call into another file of the site is unknown code.
  describe("close round 2: a component the page model cannot see the body of is undetermined, never 'no_fbc_capture'", () => {
    const CAPTURE_BODY = "(function(){var p=new URLSearchParams(location.search).get('fbclid');if(!p)return;document.cookie='_fbc=fb.1.'+Date.now()+'.'+p+';path=/';window.infiniteMetaClickId='fb.1.'+Date.now()+'.'+p})();"
    const SCRIPTED = `import Script from "next/script"\nexport function FbcCapture() {\n  return <Script id="cap" strategy="afterInteractive">{\`${CAPTURE_BODY}\`}</Script>\n}\n`
    const EFFECT = '"use client"\nimport { useEffect } from "react"\nexport function FbcCapture() {\n  useEffect(() => { document.cookie = "_fbc=fb.1.1.x;path=/" }, [])\n  return null\n}\n'
    const BARREL_LAYOUT = withCapture("        <FbcCapture />", 'import { FbcCapture } from "./analytics"\n')
    const BARREL = 'export { FbcCapture } from "./fbc-capture"\n'
    const undeterminedNot = (result: CheckResult, contains: string) => {
      expect(result.state).toBe("undetermined")
      expect(reasonCode(result)).not.toBe("no_fbc_capture")
      expect(result.reason).toContain(contains)
    }

    it("a capture behind a barrel index.ts (an effect or a <Script>) → undetermined, naming the barrel", async () => {
      const files = { "app/layout.tsx": BARREL_LAYOUT, "app/analytics/index.ts": BARREL }
      undeterminedNot(await grade({ ...files, "app/analytics/fbc-capture.tsx": EFFECT }), "<FbcCapture> is not defined in app/analytics/index.ts")
      undeterminedNot(await grade({ ...files, "app/analytics/fbc-capture.tsx": SCRIPTED }), "<FbcCapture> is not defined in app/analytics/index.ts")
    })

    it("a default re-export file (`export { default } from`) → undetermined", async () => {
      const layout = withCapture("        <FbcCapture />", 'import FbcCapture from "./fbc-capture"\n')
      const result = await grade({
        "app/layout.tsx": layout,
        "app/fbc-capture.tsx": 'export { default } from "./fbc-capture-impl"\n',
        "app/fbc-capture-impl.tsx": EFFECT.replace("export function", "export default function")
      })
      undeterminedNot(result, "<FbcCapture> is not defined in app/fbc-capture.tsx")
    })

    it("a component that calls a function from the site's own code at render → undetermined, naming the call", async () => {
      const viaFn = 'import { writeFbc } from "../lib/fbc"\nexport function FbcCapture() {\n  if (typeof window !== "undefined") writeFbc()\n  return null\n}\n'
      const result = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": viaFn, "lib/fbc.ts": 'export function writeFbc() { document.cookie = "_fbc=fb.1.1.x;path=/" }\n' })
      undeterminedNot(result, "<FbcCapture> (app/fbc-capture.tsx) calls writeFbc from ../lib/fbc")
      // Through a namespace import too.
      const viaNs = 'import * as fbc from "@/lib/fbc"\nexport function FbcCapture() {\n  fbc.write()\n  return null\n}\n'
      undeterminedNot(await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": viaNs }), "calls fbc from @/lib/fbc")
    })

    it("NEGATIVE: a component defined in its own file is still followed and graded (named, default, `export { X }`)", async () => {
      expect(definesComponent(SCRIPTED, "FbcCapture")).toBe(true)
      expect(definesComponent(BARREL, "FbcCapture")).toBe(false)
      expect(definesComponent('export { default } from "./x"\n', "default")).toBe(false)
      expect(definesComponent('export { FbcCapture as Other } from "./x"\nexport function Unrelated() { return null }\n', "FbcCapture")).toBe(false)
      const asDefault = SCRIPTED.replace("export function FbcCapture", "export default function FbcCapture")
      const layout = withCapture("        <FbcCapture />", 'import FbcCapture from "./fbc-capture"\n')
      const graded = await grade({ "app/layout.tsx": layout, "app/fbc-capture.tsx": asDefault })
      expect(graded.state).not.toBe("undetermined")
      expect(reasonCode(graded)).not.toBe("no_fbc_capture")
      const listed = SCRIPTED.replace("export function FbcCapture", "function FbcCapture") + "export { FbcCapture }\n"
      expect(definesComponent(listed, "FbcCapture")).toBe(true)
      const viaList = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": listed })
      expect(viaList.state).not.toBe("undetermined")
      // A component file that imports another COMPONENT (rendered, never called) is not refused for it.
      const wrapper = 'import { Inner } from "./inner"\nexport function FbcCapture() {\n  return <Inner />\n}\n'
      const inner = SCRIPTED.replace("FbcCapture", "Inner")
      const nested = await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": wrapper, "app/inner.tsx": inner })
      expect(nested.state).not.toBe("undetermined")
      expect(reasonCode(nested)).not.toBe("no_fbc_capture")
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

    it("a namespace member (<Analytics.FbcCapture />) is followed into its file; unread, it is undetermined (never dropped)", async () => {
      const layout = withCapture("        <Analytics.FbcCapture />", 'import * as Analytics from "./analytics"\n')
      const graded = await grade({ "app/layout.tsx": layout, "app/analytics.tsx": SCRIPTED })
      expect(graded.state).not.toBe("undetermined")
      expect(reasonCode(graded)).not.toBe("no_fbc_capture")
      expect(pageSourceFromFiles([{ file: "app/layout.tsx", source: layout }])).toEqual({ ok: false, reason: expect.stringContaining("renders <Analytics.FbcCapture> from ./analytics") })
      undeterminedNot(await grade({ "app/layout.tsx": layout, "app/analytics.tsx": EFFECT }), "<Analytics.FbcCapture> (app/analytics.tsx) runs browser code")
    })

    it("a next/dynamic or React.lazy component is followed into the module it imports (default, or the .then member)", async () => {
      const dynamicDefault = withCapture("        <FbcCapture />", 'import dynamic from "next/dynamic"\nconst FbcCapture = dynamic(() => import("./fbc-capture"), { ssr: false })\n')
      const asDefault = SCRIPTED.replace("export function FbcCapture", "export default function FbcCapture")
      expect(reasonCode(await grade({ "app/layout.tsx": dynamicDefault, "app/fbc-capture.tsx": asDefault }))).not.toBe("no_fbc_capture")
      undeterminedNot(await grade({ "app/layout.tsx": dynamicDefault, "app/fbc-capture.tsx": EFFECT.replace("export function", "export default function") }), "runs browser code")
      const dynamicNamed = withCapture("        <FbcCapture />", 'import dynamic from "next/dynamic"\nconst FbcCapture = dynamic(() => import("./fbc-capture").then((mod) => mod.FbcCapture))\n')
      const named = await grade({ "app/layout.tsx": dynamicNamed, "app/fbc-capture.tsx": SCRIPTED })
      expect(named.state).not.toBe("undetermined")
      expect(reasonCode(named)).not.toBe("no_fbc_capture")
      const lazy = withCapture("        <FbcCapture />", 'import React from "react"\nconst FbcCapture = React.lazy(() => import("./fbc-capture"))\n')
      undeterminedNot(await grade({ "app/layout.tsx": lazy }), "renders <FbcCapture> from ./fbc-capture")
    })

    it("NEGATIVE: a package component (other than the known framework ones) or a name the wizard cannot find is undetermined", async () => {
      const pkg = withCapture("        <FbcTracker />", 'import { FbcTracker } from "@acme/meta-tools"\n')
      undeterminedNot(await grade({ "app/layout.tsx": pkg }), "renders <FbcTracker>, a component of the package @acme/meta-tools")
      undeterminedNot(await grade({ "app/layout.tsx": withCapture("        <Tracker />") }), "renders <Tracker>, which the wizard cannot find")
      // Known framework components (next/link, React's Suspense) and Infinite's own client are not refused: the page is
      // graded (this layout has no capture left, so it is the real `no_fbc_capture`).
      const known = withCapture("        <Suspense><Link href=\"/\">Home</Link></Suspense>", 'import { Suspense } from "react"\n')
      expect(reasonCode(await grade({ "app/layout.tsx": known }))).toBe("no_fbc_capture")
    })

    it("pages/_app's <Component {...pageProps} /> is the routed page (a slot), never an unknown component", async () => {
      const app = `import Script from "next/script"\nimport type { AppProps } from "next/app"\nexport default function App({ Component, pageProps }: AppProps) {\n  return (\n    <>\n      ${SCRIPT}\n      <Component {...pageProps} />\n    </>\n  )\n}\n`
      const built = pageSourceFromFiles([{ file: "pages/_app.tsx", source: app }])
      expect(built.ok).toBe(true)
      expect(reasonCode(await fbcCapture(built))).not.toBe("no_fbc_capture")
    })

    it("NEGATIVE: a followed file contributes only the component the import names, never its other exports' scripts", async () => {
      const other = `import Script from "next/script"\nexport function FbcCapture() {\n  return null\n}\nexport function Unused() {\n  return ${SCRIPT}\n}\n`
      expect(reasonCode(await grade({ "app/layout.tsx": CLIENT, "app/fbc-capture.tsx": other }))).toBe("no_fbc_capture")
    })
  })
})
