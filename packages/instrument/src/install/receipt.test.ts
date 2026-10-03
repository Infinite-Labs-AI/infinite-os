// §3e.6 the edit receipt in `.infinite/install.json`: shape, confinement, round-trip, rebuild from
// markers, and uninstall's reversal (dry run included).
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, IDS, makeSite, read, STATIC_HTML } from "../../test/wizard/o7-fakes.js"
import { readInstallManifest, readInstallManifestOrRebuild, rebuildInstallManifestFromMarkers, writeInstallManifest } from "../manifest.js"
import type { InstallManifest } from "../types.js"
import { reverseRecordedEdits, uninstallInstallation } from "../uninstall.js"

import { makeEditRecord } from "./edits.js"

afterEach(cleanupSites)

function manifestWith(extra: Partial<InstallManifest>): InstallManifest {
  return {
    workspaceId: "wizard:abababababababab",
    appRoot: ".",
    framework: "static-html",
    providers: [],
    files: [],
    envKeys: [],
    contentHashes: {},
    wiringVersion: 1,
    verifiedAt: null,
    ...extra
  }
}

const ids = { ga4: [IDS.ga4], posthog: { projectKey: IDS.posthog, apiHost: "/ingest" }, meta: [IDS.meta], infinite: { siteSourceKey: IDS.siteSource } }

describe("install.json edits + ids (§3e.6)", () => {
  it("round-trips edits and ids through the shape check", () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const edit = makeEditRecord({ file: "index.html", before: STATIC_HTML, after: `${STATIC_HTML}<!-- x -->\n`, jobId: null, planLineId: "l1", by: "wizard", runId: IDS.run })
    writeInstallManifest(root, manifestWith({ edits: [edit], ids }))
    expect(readInstallManifest(root)).toMatchObject({ edits: [edit], ids })
  })

  it("a NEWER tag's extra fields on an edit or on ids are tolerated, never 'corrupt' (P3-22)", () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const edit = makeEditRecord({ file: "index.html", before: "a", after: "b", jobId: null, planLineId: null, by: "agent", runId: IDS.run })
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify(manifestWith({ edits: [{ ...edit, reviewedBy: "codex" } as never], ids: { ...ids, x: [] } as never })))
    expect(readInstallManifest(root)?.edits?.[0]?.id).toBe(edit.id)
  })

  it.each([
    ["an edit missing its id", (edit: Record<string, unknown>) => {
      const { id: _drop, ...rest } = edit
      return rest
    }],
    ["a bare hex hash", (edit: Record<string, unknown>) => ({ ...edit, afterHash: "ab".repeat(32) })],
    ["an edit with no textEdits", (edit: Record<string, unknown>) => {
      const { textEdits: _drop, ...rest } = edit
      return rest
    }],
    ["an unknown author", (edit: Record<string, unknown>) => ({ ...edit, by: "someone" })]
  ])("NEGATIVE: %s is a corrupt receipt", (_label, mutate) => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const edit = makeEditRecord({ file: "index.html", before: "a", after: "b", jobId: null, planLineId: null, by: "agent", runId: IDS.run })
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify(manifestWith({ edits: [mutate(edit as unknown as Record<string, unknown>) as never] })))
    expect(() => readInstallManifest(root)).toThrow(/Corrupt/)
  })

  it("NEGATIVE: ids missing a tool, or an edit pointing outside the repo, are refused", () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    mkdirSync(join(root, ".infinite"), { recursive: true })
    const { meta: _meta, ...withoutMeta } = ids
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify(manifestWith({ ids: withoutMeta as never })))
    expect(() => readInstallManifest(root)).toThrow(/Corrupt/)
    const escape = makeEditRecord({ file: "../outside.html", before: "a", after: "b", jobId: null, planLineId: null, by: "agent", runId: IDS.run })
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify(manifestWith({ edits: [escape] })))
    expect(() => readInstallManifest(root)).toThrow()
  })
})

describe("rebuild from markers (a corrupt receipt)", () => {
  it("finds the managed files by their markers and the providers in the managed bytes; says what is lost", () => {
    const managed = STATIC_HTML.replace(
      "</head>",
      `<!-- infinite:start -->\n<script>gtag('config', '${IDS.ga4}')</script>\n<!-- infinite:end -->\n  </head>`
    )
    const root = makeSite({ "index.html": managed, "about.html": STATIC_HTML, "lib/infinite-analytics.ts": "// Managed by Infinite\nexport {}\n" })
    const result = rebuildInstallManifestFromMarkers({ root, appRoot: ".", framework: "static-html", workspaceId: "wizard:abababababababab" })
    expect(result.managedFiles.sort()).toEqual(["index.html", "lib/infinite-analytics.ts"])
    expect(result.manifest.providers).toEqual(["ga4"])
    expect(result.lost).toEqual(["edits", "configOwnership", "serverLane", "requiresManual"])
  })

  it("readInstallManifestOrRebuild rebuilds only when allowed; NEGATIVE: without it a corrupt receipt still throws", () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), "{ nope")
    expect(() => readInstallManifestOrRebuild(root, { rebuild: null })).toThrow(/Corrupt/)
    const rebuilt = readInstallManifestOrRebuild(root, { rebuild: { appRoot: ".", framework: "static-html", workspaceId: "wizard:abababababababab" } })
    expect(rebuilt.rebuilt).toBe(true)
    expect(readInstallManifest(root)?.workspaceId).toBe("wizard:abababababababab")
  })
})

describe("uninstall reverses the receipt's edits newest first", () => {
  it("a chain of two edits on one file comes off in reverse; a dry run only reports", () => {
    const v0 = STATIC_HTML
    const v1 = v0.replace("<h1>Acme</h1>", "<h1>Acme</h1>\n    <p>one</p>")
    const v2 = v1.replace("<p>one</p>", "<p>one</p>\n    <p>two</p>")
    const root = makeSite({ "index.html": v2 })
    const edits = [
      makeEditRecord({ file: "index.html", before: v0, after: v1, jobId: null, planLineId: "l1", by: "wizard", runId: IDS.run, seq: 0 }),
      makeEditRecord({ file: "index.html", before: v1, after: v2, jobId: "csp", planLineId: null, by: "agent", runId: IDS.run, seq: 1 })
    ]
    expect(reverseRecordedEdits(root, { edits }, true)).toEqual({ reversed: ["index.html"], leftAsIs: [], warnings: [] })
    expect(read(root, "index.html")).toBe(v2)
    expect(reverseRecordedEdits(root, { edits }, false).reversed).toEqual(["index.html"])
    expect(read(root, "index.html")).toBe(v0)
  })

  it("a file an edit created is removed; NEGATIVE: a changed one is left as is with a warning", () => {
    const root = makeSite({ "index.html": STATIC_HTML, "lib/conversions.ts": "export const x = 1\n" })
    writeFileSync(join(root, "index.html"), `${STATIC_HTML}<!-- changed by the customer -->\n`)
    const created = makeEditRecord({ file: "lib/conversions.ts", before: null, after: "export const x = 1\n", jobId: "server_conversions", planLineId: null, by: "agent", runId: IDS.run })
    const changed = makeEditRecord({ file: "index.html", before: "old", after: STATIC_HTML, jobId: null, planLineId: "l", by: "wizard", runId: IDS.run })
    writeInstallManifest(root, manifestWith({ edits: [changed, created] }))
    const result = uninstallInstallation({ root, allowDirty: true })
    expect(result.editsReversed).toEqual(["lib/conversions.ts"])
    expect(result.editsLeftAsIs).toEqual(["index.html"])
    expect(result.warnings.some((warning) => warning.startsWith("index.html: changed since"))).toBe(true)
    expect(read(root, "index.html")).toBe(`${STATIC_HTML}<!-- changed by the customer -->\n`)
    expect(() => read(root, "lib/conversions.ts")).toThrow()
  })
})
