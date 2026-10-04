// Live run 5, decided where the check really runs: the rehearsal sent the GA4 page-change job back to the agent although
// Infinite's exact bytes were already in the layout, and the agent re-pasted them for its whole 20-minute budget. Through
// the REAL `applyRehearsalToJobs`, the REAL registry (state machine + the brief's prescribed bytes) and a real commit:
//   - a rehearsal problem on a job whose Infinite bytes are in place in the rehearsed commit fails it, naming the check, as
//     Infinite's code to fix (never back to the agent);
//   - bytes not in place in that commit: back to the agent, as before;
//   - a rehearsal pass never ticks a job that has no check proving its change.
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

import { baseState, makeCtx, STEP_RUN_ID } from "../../test/wizard/agent-step-harness.js"
import { cleanup, tempDir, write } from "../../test/wizard/repo.js"
import { GA4_PAGE_CHANGE_SCRIPT } from "../jobs/briefs.js"
import { createJobRegistry } from "../jobs/registry.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { applyRehearsalToJobs, type RehearsalOutcome } from "./rehearse.js"

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const SPA = "ga4_improve:spa_page_view"
const ID = "G-TEST1"
const IN_PLACE = `export default function RootLayout() {}\nconst ga4 = \`gtag('config', '${ID}');\n${GA4_PAGE_CHANGE_SCRIPT}\`\n`
const MISPLACED = `export default function RootLayout() {}\nconst ga4 = \`gtag('config', '${ID}');\nwindow.other = 1;\n${GA4_PAGE_CHANGE_SCRIPT}\`\n`

function repoAt(committed: string, working?: string, options: { subdir?: string; file?: string } = {}): { root: string; sha: string } {
  const top = tempDir("infinite-tag-rehearse-in-place-")
  dirs.push(top)
  const root = options.subdir ? `${top}/${options.subdir}` : top
  const file = options.file ?? "app/layout.tsx"
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: top, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  write(root, file, committed)
  git("add", "-A")
  git("commit", "-q", "-m", "wizard")
  if (working !== undefined) write(root, file, working)
  return { root, sha: git("rev-parse", "HEAD") }
}

function spaJob(state: ChecklistItem["state"], edits: boolean): ChecklistItem {
  return {
    id: SPA,
    jobId: "ga4_improve",
    n: 4,
    title: "Improve the existing GA4",
    owner: "agent",
    trigger: { finding: "GA4 sends nothing on a page change", evidence: [{ file: "app/layout.tsx", line: 2 }] },
    allow: { files: ["app/layout.tsx"], create: [] },
    checks: [
      { id: "ga4_spa_page_view", tier: "RH", state: "not_run" },
      { id: "ga4_one_page_view", tier: "RH", state: "not_run" },
      { id: "ga4_seen_leaving", tier: "PV", state: "not_run" }
    ],
    claim: { status: "done", note: "pasted", at: "2026-10-02T09:00:00.000Z" },
    ...(edits ? { edits: [{ editId: "agent-run1-t1-0", file: "app/layout.tsx" }] } : {}),
    state
  }
}

function outcome(ga4: number): RehearsalOutcome {
  return {
    state: "graded",
    reason: null,
    previewUrl: null,
    grades: {},
    previewGrades: {},
    clickTested: [],
    ga4ClickTested: [],
    facts: { posthogSameOrigin: null, cspViolations: 0, spaPageViews: { ga4, meta: null } },
    spaExercised: true
  }
}

async function rehearse(input: { committed: string; working?: string; job: ChecklistItem; ga4: number; subdir?: string; file?: string; censusFails?: boolean }) {
  const file = input.file ?? "app/layout.tsx"
  const { root, sha } = repoAt(input.committed, input.working, { ...(input.subdir ? { subdir: input.subdir } : {}), file })
  const registry = createJobRegistry({
    briefFacts: () => {
      if (input.censusFails) throw new Error("the code census could not run")
      return ({
        runId: STEP_RUN_ID,
        framework: "next-app-router",
        packageManager: "npm",
        router: "app",
        appRoot: ".",
        plan: null,
        connections: { ga4MeasurementIds: [ID], metaPixelIds: [], posthog: null },
        guardSites: [{ tool: "ga4", file, line: 2, publicId: ID, context: "template_literal" }]
      }) as never
    }
  })
  const { ctx, recorded, state } = makeCtx({ root, state: baseState({ root, runId: STEP_RUN_ID, jobs: [input.job] }) })
  await applyRehearsalToJobs(ctx, { registry }, outcome(input.ga4), STEP_RUN_ID, sha, "rehearsal")
  const job = state().jobs[0]!
  const said = recorded.events.filter((event) => event.type === "job.state").map((event) => String(event.fields.note ?? ""))
  const warned = recorded.events.filter((event) => event.type === "step.sub" && event.fields.tone === "warn").map((event) => String(event.fields.text ?? ""))
  return { job, said, sha, warned }
}

describe("live run 5: a rehearsal problem on Infinite's own bytes in place is Infinite's to fix, decided at the rehearsal", () => {
  it("in place in the rehearsed commit: failed, naming the check, as Infinite's code to fix (not back to the agent)", async () => {
    const { job, said, sha } = await rehearse({ committed: IN_PLACE, job: spaJob("done_in_code", true), ga4: 0 })
    expect(job.state).toBe("failed")
    const note = `This run's rehearsal found a problem on commit ${sha.slice(0, 7)}: ga4_spa_page_view: ga4_spa_page_view_missing — no page_view after the page change. Infinite's exact code for this is in app/layout.tsx, where its brief puts it, so it is not handed back to the agent: it is Infinite's code to fix.`
    expect(job.note).toBe(note)
    expect(said).toContain(note)
  })

  it("the committed tree decides, not the working copy: in place in the commit, misplaced on disk → still failed", async () => {
    const { job } = await rehearse({ committed: IN_PLACE, working: MISPLACED, job: spaJob("done_in_code", true), ga4: 0 })
    expect(job.state).toBe("failed")
  })

  it("negative: not in place in the rehearsed commit (even if in place on disk) → back to the agent, as before", async () => {
    const misplaced = await rehearse({ committed: MISPLACED, job: spaJob("done_in_code", true), ga4: 0 })
    expect(misplaced.job.state).toBe("pending")
    expect(misplaced.job.note ?? "").not.toContain("Infinite's code to fix")
    const onDiskOnly = await rehearse({ committed: MISPLACED, working: IN_PLACE, job: spaJob("done_in_code", true), ga4: 0 })
    expect(onDiskOnly.job.state).toBe("pending")
  })

  it("review 4: the run started in a subfolder of the repo still reads the rehearsed commit (git show ./path)", async () => {
    const { job, warned } = await rehearse({ committed: IN_PLACE, job: spaJob("done_in_code", true), ga4: 0, subdir: "apps/web" })
    expect(job.state).toBe("failed")
    expect(warned).toEqual([])
  })

  it("review 4: a long path keeps the whole 'Infinite's code to fix' sentence; only the check's reason is shortened", async () => {
    const file = "src/app/[locale]/(marketing)/(site)/very-long-segment-name/layout.tsx"
    const long = { ...spaJob("done_in_code", true), allow: { files: [file], create: [] }, edits: [{ editId: "agent-run1-t1-0", file }] }
    const { job } = await rehearse({ committed: IN_PLACE, job: long, ga4: 0, file })
    expect(job.state).toBe("failed")
    expect(job.note!.length).toBeLessThanOrEqual(300)
    expect(job.note).toContain(`Infinite's exact code for this is in ${file}, where its brief puts it, so it is not handed back to the agent: it is Infinite's code to fix.`)
  })

  it("review 4 negative: the census cannot run → the job goes back to the agent with a warning, and the step does not throw", async () => {
    const { job, warned } = await rehearse({ committed: IN_PLACE, job: spaJob("done_in_code", true), ga4: 0, censusFails: true })
    expect(job.state).toBe("pending")
    expect(warned.some((text) => text.includes("Infinite's code could not be read, so it goes back to the agent"))).toBe(true)
  })

  it("a rehearsal pass never ticks a job with no check that proves its change (claimed, nothing recorded): it stays claimed", async () => {
    // Its only rehearsal check is the one this rehearsal graded (pass), so nothing but the rule keeps it unticked.
    const only = { ...spaJob("claimed", false), checks: [{ id: "ga4_spa_page_view", tier: "RH" as const, state: "not_run" as const }] }
    const { job } = await rehearse({ committed: IN_PLACE, job: only, ga4: 1 })
    expect(job.state).toBe("claimed")
  })

  it("live run 6: a claimed edited SPA job advances after its rehearsal check passes", async () => {
    const only = { ...spaJob("claimed", true), checks: [
      { id: "ga4_spa_page_view", tier: "RH" as const, state: "not_run" as const },
      { id: "ga4_seen_leaving", tier: "PV" as const, state: "not_run" as const }
    ] }
    const { job } = await rehearse({ committed: IN_PLACE, job: only, ga4: 1 })
    expect(job.state).toBe("waiting_deploy")
  })

  it("a pass on a job already done in code moves it on its done path (waiting for the deploy), never to failed", async () => {
    const { job } = await rehearse({ committed: IN_PLACE, job: spaJob("done_in_code", true), ga4: 1 })
    expect(job.state).toBe("waiting_deploy")
  })
})
