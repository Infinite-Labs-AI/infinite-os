// LF4-P1-2: the autoConfig job's own check, run by the REAL O9 check function over live run 4's files. Before this, the
// item carried only the mirror's event-id check, which passes on a layout with nothing of the job in it, so an untouched
// or unfinished autoConfig job could be ticked "done in code".
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { FIXED_NOW } from "../../test/wizard/fixture-fetch.js"
import { itemChecksFor } from "../jobs/registry.js"
import { o9CheckFunctions } from "./o9.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const ctx = { runId: "run-lf4", now: FIXED_NOW }
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "infinite-tag-autoconfig-"))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

const item = { id: "meta_improve:autoconfig_off_adopted", allow: { files: ["app/layout.tsx"], create: [] } }
async function verdict(layout: string, extra: Record<string, string> = {}) {
  const root = app({ "app/layout.tsx": layout, ...extra })
  return (await o9CheckFunctions({ version: "t", root }).meta_autoconfig_off!({ appRoot: ".", root, item }, ctx)) as Array<{ state: string; reason?: string }>
}

describe("LF4-P1-2: meta_autoconfig_off checks the autoConfig job's own work", () => {
  it("the autoConfig item carries it (and never the mirror's event-id check)", () => {
    const ids = itemChecksFor("meta_improve", "autoconfig_off_adopted", "next-app-router").map((check) => `${check.tier}:${check.id}`)
    expect(ids).toContain("S:meta_autoconfig_off")
    expect(ids).not.toContain("S:meta_event_id_from_helper")
  })

  it("run 4's merged layout (autoConfig false before init) passes", async () => {
    expect(await verdict(readFileSync(join(RUN4, "merged-5e6f3f3/app/layout.tsx"), "utf8"))).toMatchObject([{ state: "pass" }])
  })

  it("NEGATIVE: run 4's base layout (the pixel with no opt-out) is a problem naming the pixel", async () => {
    const results = await verdict(readFileSync(join(RUN4, "site-b7c8347/app/layout.tsx"), "utf8"))
    expect(results).toMatchObject([{ state: "problem" }])
    expect(results[0]!.reason).toContain("7777000011112222: opt_out_missing")
  })

  it("NEGATIVE: an opt-out after init is a problem; a page with no literal init is undetermined (never a pass)", async () => {
    const after = "fbq('init', '7777000011112222');\nfbq('set', 'autoConfig', false, '7777000011112222');\n"
    expect(await verdict(after)).toMatchObject([{ state: "problem" }])
    expect(await verdict("export default function Layout() { return null }\n")).toMatchObject([{ state: "undetermined" }])
  })

  it("NEGATIVE: another file's opt-out does not tick the job's file", async () => {
    const base = "fbq('init', '7777000011112222');\n"
    const results = await verdict(base, { "app/other.tsx": "fbq('set', 'autoConfig', false, '7777000011112222');\nfbq('init', '7777000011112222');\n" })
    expect(results).toMatchObject([{ state: "problem" }])
  })
})
