// LF4-P3-5: every scanner that writes a reason (rehearsal, jobs, done) allows the public ids the run READ from the site:
// the census's literal ids, the dry load's GA4 / Meta ids and the real visit's. Live run 4's done step got this (R4-9);
// the rehearsal and jobs scanners still turned a masked, unconnected site pixel id in a live-bytes reason into
// "[redacted: phone]". A real phone number stays redacted.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { baseState, fakeBridge, makeCtx, makeDeps, STEP_RUN_ID } from "../../test/wizard/agent-step-harness.js"
import { writeO8BeforeFile } from "../../test/wizard/before-file.js"
import { cleanup, tempDir } from "../../test/wizard/repo.js"
import { maskIdentifier } from "../checks/result.js"
import type { BeforeFacts } from "../wizard/contracts/jobs.js"
import { buildScanner, runPublicIds } from "./context.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const facts = (JSON.parse(readFileSync(join(RUN4, "wizard/before.json"), "utf8")) as { facts: BeforeFacts }).facts
const PIXEL = "7777000011112222"

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

async function world() {
  const root = tempDir("infinite-tag-public-ids-")
  dirs.push(root)
  const { bridge } = fakeBridge()
  const deps = makeDeps({ bridge, agents: {} as never, env: { HOME: root } })
  const { ctx } = makeCtx({ root, state: baseState({ root, runId: STEP_RUN_ID }) })
  await writeO8BeforeFile(deps.fs, root, STEP_RUN_ID, facts)
  return { ctx, deps }
}

describe("LF4-P3-5: runPublicIds", () => {
  it("collects the census's and the dry load's public ids for this run", async () => {
    const { ctx, deps } = await world()
    const ids = await runPublicIds(ctx, deps)
    expect(ids).toContain("G-QWERT67890")
    expect(ids).toContain(PIXEL)
  })

  it("a scanner given them keeps a masked site pixel id; a real phone is still redacted", async () => {
    const { ctx, deps } = await world()
    const reason = `live bytes: Meta pixel ${maskIdentifier(PIXEL)} sent PageView; call +1 415.555.0123`
    const scanner = buildScanner(ctx, deps, await runPublicIds(ctx, deps))
    const out = scanner.redact(reason).text
    expect(out).toContain(maskIdentifier(PIXEL))
    expect(out).toContain("[redacted: phone]")
    expect(out).not.toContain("415.555.0123")
  })

  it("NEGATIVE: without the site's ids (connections only, as rehearsal and jobs had), the masked id read as a phone", async () => {
    const { ctx, deps } = await world()
    expect(buildScanner(ctx, deps, []).redact(`Meta pixel ${maskIdentifier(PIXEL)}`).text).toContain("[redacted: phone]")
  })

  it("another run's before file gives nothing (never another run's ids)", async () => {
    const { ctx, deps } = await world()
    ctx.runId = "11111111-2222-4333-8444-555555555555"
    expect(await runPublicIds(ctx, deps)).toEqual([])
  })
})
