// The terminal round, wizard side (final verify F2 to F5 and the terminal QA's display items): the words the
// steps and the closing text put on screen. Every test here fails on the code before the round.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import type { ToolProofFact } from "./verdict.js"
import { computeVerdict } from "./verdict.js"

import { gradeReasonCode, gradeWords } from "./before-column.js"
import { closingScreenWaits, learnFactsFrom, outroWidth } from "./command.js"
import type { CheckResult, ChecklistItem } from "./contracts/jobs.js"
import type { ReportV2 } from "./contracts/report.js"
import { WizardEventEmitter } from "./events.js"
import { TERMINAL_TABLE_MIN_COLUMNS, durationWords, renderTerminal, verdictLine } from "./report.js"
import { createRunState } from "./run-state.js"
import { beforeStatus } from "./steps/before.js"
import { notDoneLines } from "./steps/jobs.js"
import { mergeSummary } from "./steps/merge.js"
import { reviewFoundLine, reviewTally } from "./steps/review.js"
import { WizardStore } from "./store.js"

const here = dirname(fileURLToPath(import.meta.url))
const example = JSON.parse(readFileSync(join(here, "../../contracts/tag-wizard-v1/report-v2.example.json"), "utf8")) as ReportV2

/** Every word of `text` appears in `rendered`, in order, whatever the wrapping. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim()

describe("F2: the final table never cuts a cell", () => {
  for (const width of [80, 100, 118, 120, 139, 140, 160, 200]) {
    it(`${width} columns: every cell, label, note and footnote is in the text in full; no line is wider than the screen`, () => {
      const text = renderTerminal(example, width)
      for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(width)
      expect(text).not.toContain("…")
      // "of 14" lived only in the cell, and the cell was cut at about 30 characters from 100 to 180 columns.
      expect((text.match(/\b14\b/g) ?? []).length).toBe(3)
      if (width < TERMINAL_TABLE_MIN_COLUMNS) {
        expect(flat(text).split("of 14").length - 1).toBe(3)
        // Stacked: each cell is on its own row(s), so its words are contiguous.
        for (const row of example.rows.filter((entry) => entry.id !== "day7_checkin")) {
          expect(flat(text)).toContain(row.label)
          for (const cell of Object.values(row.cells)) expect(flat(text), row.id).toContain(flat(cell.display))
        }
      } else {
        // A table: a cell wraps inside its column, so every word of it is on the row's lines.
        for (const row of example.rows.filter((entry) => entry.id !== "day7_checkin")) {
          for (const cell of Object.values(row.cells)) for (const word of flat(cell.display).split(" ")) expect(text, `${row.id}: ${word}`).toContain(word)
        }
        expect(text).toMatch(/Live site today\s+In this pull request\s+Proven live/)
      }
      for (const note of example.notes) expect(flat(text)).toContain(flat(note))
    })
  }

  it("100 and 120 columns show the count of 14 for the live site in one piece (it was cut off from 100 to 180)", () => {
    for (const width of [100, 120]) {
      const lines = renderTerminal(example, width).split("\n")
      expect(lines, `${width}`).toContain("  Live site today:       4 pass · 8 problems · 2 not testable of 14 (problem)")
      expect(lines).toContain("  In this pull request:  12 pass · 0 problems · 2 not testable of 14")
    }
  })

  it("a table cell wraps inside its own column (the columns stay aligned)", () => {
    const lines = renderTerminal(example, 160).split("\n")
    const header = lines.find((line) => line.includes("In this pull request"))!
    const columns = ["Live site today", "In this pull request", "Proven live"].map((label) => header.indexOf(label))
    const row = lines.findIndex((line) => line.startsWith("Page views from preview links"))
    // The wrapped second line of the first column starts under the column, never under the label.
    expect(lines[row + 1]!.slice(0, columns[0]).trim()).toBe("")
    expect(lines[row + 1]!.slice(columns[0]!, columns[1]).trim().length).toBeGreaterThan(0)
  })
})

describe("QA #6 and #7: the closing verdict, the duration and ONE run id", () => {
  it("the first line is the verdict, the display id and how long it took; the run id's first 8 are not shown beside it", () => {
    const text = renderTerminal(example, 160, { displayId: "r-49b8", durationMs: 9 * 60_000 })
    expect(text.split("\n")[0]).toBe("◆ www.acme-store.com collects analytics properly now · 3 checks wait for real visitors or the 7-day check-in · run r-49b8 · 9 min")
    expect(text).not.toContain(example.runId.slice(0, 8))
    // With no display id the run id's first 8 are the id (the report alone knows no other).
    expect(renderTerminal(example, 160).split("\n")[0]).toContain(`run ${example.runId.slice(0, 8)}`)
  })

  it("the closing line IS the verdict's headline; the verdict reads the columns (negatives: a problem, no proof, not checked yet)", () => {
    expect(verdictLine(example)).toBe(example.verdict!.headline)
    const verdictOf = (report: ReportV2) =>
      computeVerdict({ site: "www.acme-store.com", finishLine: report.finishLine, provenLive: report.columns.proven_live, jobs: [], openFindings: [], tools: null, installedUnknown: null }).headline
    const problem = structuredClone(example)
    problem.finishLine.find((line) => line.id === "each_tool_once")!.cells.proven_live.state = "problem"
    expect(verdictOf(problem)).toBe("www.acme-store.com does not collect properly yet: 1 problem on the live site (each tool once)")
    const unproven = structuredClone(example)
    unproven.finishLine.find((line) => line.id === "proof_from_real_visit")!.cells.proven_live.state = "undetermined"
    expect(verdictOf(unproven)).toBe("www.acme-store.com: the real visit ran, but its receipts are not in")
    const waiting = structuredClone(example)
    waiting.columns.proven_live = { measuredAt: null, sha: null, pending: "deploy" }
    expect(verdictOf(waiting)).toBe("www.acme-store.com: set up in the pull request · not checked live yet (waiting for the deploy)")
    for (const report of [problem, unproven, waiting]) expect(verdictOf(report)).not.toMatch(/properly now|verified|proven\b/)
    // A report with no verdict (never a tag report) says it was not graded; it never guesses one.
    expect(verdictLine({ ...example, verdict: null })).toBe("www.acme-store.com: not graded yet · run npx infinite-tag to finish the live checks")
  })

  it("the duration is said in the largest honest unit", () => {
    expect(durationWords(20_000)).toBe("under a minute")
    expect(durationWords(9 * 60_000)).toBe("9 min")
    expect(durationWords(5 * 3_600_000)).toBe("5 h")
    expect(durationWords(3 * 86_400_000)).toBe("3 days")
  })
})

describe("F4: one 'before' count", () => {
  const check = (state: CheckResult["state"]): CheckResult => ({ checkId: "c", tier: "T1", state, at: "2026-10-02T09:12:00.000Z", runId: "r" })
  const checks = [check("pass"), check("pass"), check("problem"), check("undetermined")]

  it("the step's status is the report's own 'Checks passing' cell for the live site, word for word", () => {
    const cell = example.rows.find((row) => row.id === "checks_passing")!.cells.live_today
    const column = { meta: { measuredAt: null, sha: null }, cells: { checks_passing: cell }, finishLine: {} }
    expect(beforeStatus(column, checks)).toBe(`Before: ${cell.display}`)
    expect(beforeStatus(column, checks)).toBe("Before: 4 pass · 8 problems · 2 not testable of 14")
  })

  it("negative: with no column the line names what it counts (never the report's words for another count)", () => {
    expect(beforeStatus(null, checks)).toBe("Before: 4 code and live checks run · 2 pass · 1 problem · 1 unknown")
    expect(beforeStatus(null, checks)).not.toMatch(/^Before: \d+ pass/)
  })
})

describe("QA #17: a graded problem is said in words (the grader writes '<code> — <detail>')", () => {
  const grade = (reason: string, state: CheckResult["state"] = "problem"): CheckResult => ({ checkId: "dry_live_ga4", tier: "T1", state, reason, at: "2026-10-02T09:12:00.000Z", runId: "r" })

  it("reads the code out of the grader's reason", () => {
    expect(gradeReasonCode(grade("duplicate_page_view — 2 page views per visit"))).toBe("duplicate_page_view")
    expect(gradeReasonCode(grade("wrong_id"))).toBe("wrong_id")
    expect(gradeReasonCode(undefined)).toBe("")
  })

  it("the words follow the code, with or without the detail (it read 'a problem' for every real grade)", () => {
    expect(gradeWords(grade("duplicate_page_view — 2 page views per visit"), null)).toBe("counts every page twice")
    expect(gradeWords(grade("traffic_permissions_blocked — the pixel refused www.acme-store.com"), "www.acme-store.com")).toBe("blocked on www.acme-store.com")
    expect(gradeWords(grade("no_beacon — ga4 sent nothing"), null)).toBe("not firing")
    expect(gradeWords(grade("held_by_consent — waits", "undetermined"), null)).toBe("waits for consent (not counted as a problem)")
    // A code with no words of its own never reads "a problem".
    expect(gradeWords(grade("something_new — detail"), null)).toBe("did not pass the live test")
  })
})

describe("QA #20: the jobs that are not done are named", () => {
  const item = (title: string, state: ChecklistItem["state"], blockedReason?: ChecklistItem["blockedReason"], owner: ChecklistItem["owner"] = "agent"): ChecklistItem => ({
    id: title,
    jobId: "posthog_improve",
    n: 3,
    title,
    owner,
    trigger: { finding: "", evidence: [] },
    allow: { files: [], create: [] },
    checks: [],
    state,
    ...(blockedReason ? { blockedReason } : {})
  })

  it("each blocked or failed agent job gets one line with its name and why, in plain words", () => {
    expect(
      notDoneLines([
        item("Improve the existing PostHog", "done_in_code"),
        item("Server-side sign-up event", "blocked", "needs_you"),
        item("Remove the second GA4 tag", "blocked", "agent_blocked"),
        item("Join logged-in visitors", "failed"),
        item("A code job", "blocked", "needs_you", "code")
      ])
    ).toEqual([
      "! Not done: Server-side sign-up event (needs your answer)",
      "! Not done: Remove the second GA4 tag (the agent did not finish it)",
      "! Not done: Join logged-in visitors (the wizard's check did not pass)"
    ])
  })

  it("§3x.2 the item's own note is the reason when the wizard kept one (a safety-check refusal is never 'outside the job's files')", () => {
    const refused = { ...item("Keep previews silent: GA4", "failed"), note: "the wizard's safety check refused app/layout.tsx:29: the edit uses a provider id as a default or fallback value (||, ?? or ?:)" }
    expect(notDoneLines([refused])).toEqual([
      "! Not done: Keep previews silent: GA4 (the wizard's safety check refused app/layout.tsx:29: the edit uses a provider id as a default or fallback value (||, ?? or ?:))"
    ])
  })

  it("the closing list names fewer jobs when the step already said more (the terminal keeps 8 result lines; an incident is never pushed out)", () => {
    const failed = ["A", "B", "C", "D", "E", "F", "G"].map((name) => ({ ...item(`Job ${name}`, "failed"), id: `job:${name}` }))
    expect(notDoneLines(failed)).toHaveLength(7)
    expect(notDoneLines(failed, 5)).toEqual([...["A", "B", "C", "D", "E"].map((name) => `! Not done: Job ${name} (the wizard's check did not pass)`), "! …and 2 more not done: the pull request lists every job"])
  })

  it("parts of one job that ended the same way are one line, with how many parts", () => {
    expect(
      notDoneLines([
        { ...item("Keep previews silent (existing tags)", "blocked", "agent_blocked"), id: "preview_guard:ga4" },
        { ...item("Keep previews silent (existing tags)", "blocked", "agent_blocked"), id: "preview_guard:posthog" },
        { ...item("Keep previews silent (existing tags)", "failed"), id: "preview_guard:meta" }
      ])
    ).toEqual(["! Not done: Keep previews silent (existing tags) (2 parts: the agent did not finish it)", "! Not done: Keep previews silent (existing tags) (the wizard's check did not pass)"])
  })

  it("more than six are counted, and a clean run adds nothing (negative)", () => {
    const many = Array.from({ length: 9 }, (_, index) => item(`Job ${index + 1}`, "blocked", "agent_blocked"))
    const lines = notDoneLines(many)
    expect(lines).toHaveLength(7)
    expect(lines.at(-1)).toBe("! …and 3 more not done: the pull request lists every job")
    expect(notDoneLines([item("Done", "done_in_code")])).toEqual([])
  })
})

describe("QA #18 and #19: the review says what was found, and who is working", () => {
  it("a re-review that finds nothing says it re-checked the fix (it read 'Codex: no comments')", () => {
    expect(reviewFoundLine("Codex", 0, 2)).toEqual({ text: "Codex re-checked the fix: no new comments", tone: "ok" })
    expect(reviewFoundLine("Codex", 0, 1)).toEqual({ text: "Codex reviewed the pull request: nothing to change", tone: "ok" })
    expect(reviewFoundLine("Codex", 2, 1)).toEqual({ text: "Codex left 2 comments", tone: "info" })
    expect(reviewFoundLine("Claude Code", 1, 2)).toEqual({ text: "Claude Code left 1 new comment", tone: "info" })
  })

  it("the closing line counts what the reviewer found and how it was fixed (the round's own lines scroll away)", () => {
    expect(reviewTally([{ fixSha: "abc", review: { findings: [1] } }, { fixSha: null, review: { findings: [] } }])).toBe("1 comment, fixed in 1 new commit")
    expect(reviewTally([{ fixSha: null, review: { findings: [1, 2] } }])).toBe("2 comments, none fixed")
    expect(reviewTally([{ fixSha: null, review: { findings: [] } }])).toBe("no comments")
  })

  it("a new step starts with no agent line: the worker's last words never sit above the reviewer's step", () => {
    const store = new WizardStore({ displayId: "r-7f3c", tagVersion: "0.12.0" })
    const emitter = new WizardEventEmitter({ store })
    emitter.emit("step.start", { step: "jobs" })
    emitter.emit("narrate", { agent: "claude_code", role: "worker", text: "Reading its checklist" })
    expect(store.getSnapshot().narration.map((beat) => beat.text)).toEqual(["Reading its checklist"])
    emitter.emit("step.done", { step: "jobs", outcome: "ok" })
    emitter.emit("step.start", { step: "review" })
    expect(store.getSnapshot().narration).toEqual([])
    emitter.emit("narrate", { agent: "codex", role: "reviewer", text: "Reading the pull request (read-only)" })
    expect(store.getSnapshot().narration.at(-1)).toMatchObject({ agent: "codex", role: "reviewer" })
    emitter.dispose()
  })
})

describe("F3: the merge summary", () => {
  it("is the middle sentence first, then the branch and the files changed, and never the overlay's own sentences", () => {
    const summary = mergeSummary({ sentence: "Reviewed by Codex · rehearsal passed.", branch: "infinite/tag/2026-10-02-7f3c2a", base: "main", filesChanged: 9, checks: "rehearsal passed on the latest commit" })
    expect(summary.split("\n")).toEqual(["Reviewed by Codex · rehearsal passed.", "infinite/tag/2026-10-02-7f3c2a → main", "9 files changed · rehearsal passed on the latest commit"])
    expect(summary).not.toMatch(/is ready|Merge it to ship/)
  })

  it("one file is 'file'; an unreadable diff leaves the count out (never 0)", () => {
    expect(mergeSummary({ sentence: "s.", branch: "b", base: "main", filesChanged: 1, checks: "c" })).toContain("1 file changed · c")
    expect(mergeSummary({ sentence: "s.", branch: "b", base: "main", filesChanged: null, checks: "c" }).split("\n").at(-1)).toBe("c")
  })
})

describe("F5: when the closing screen waits, and how wide its text is", () => {
  const tty = { stdin: { isTTY: true }, stdout: { isTTY: true, write() {} } }
  it("waits only in an interactive terminal without --json", () => {
    expect(closingScreenWaits({ json: false }, tty)).toBe(true)
    expect(closingScreenWaits({ json: true }, tty)).toBe(false)
    expect(closingScreenWaits({ json: false }, { stdin: { isTTY: false }, stdout: { isTTY: true, write() {} } })).toBe(false)
    expect(closingScreenWaits({ json: false }, { stdin: { isTTY: true }, stdout: { write() {} } })).toBe(false)
  })

  it("the text is laid out two columns narrower than the terminal, so the frame cuts nothing", () => {
    expect(outroWidth(120)).toBe(118)
    expect(outroWidth(undefined)).toBe(78)
    expect(outroWidth(0)).toBe(78)
  })
})

describe("QA #12: what the Learn cards may name comes from the run state", () => {
  it("nothing before the run knows it; the workspace and the agents once the steps saved them", () => {
    const state = createRunState({ tagVersion: "0.12.0", root: "/Users/sam/Github/acme-store", appRoot: ".", now: new Date("2026-10-02T09:00:00Z") })
    expect(learnFactsFrom(state, "/Users/sam/Github/acme-store")).toEqual({ site: "acme-store", workspace: null, worker: null, reviewer: null })
    state.link = { linkId: "l", workspaceName: "Acme", approvedAt: "2026-10-02T09:00:00Z", runtimeVariant: "prod" }
    state.agent = { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } }
    expect(learnFactsFrom(state, "/Users/sam/Github/acme-store")).toEqual({ site: "acme-store", workspace: "Acme", worker: "claude_code", reviewer: "codex" })
  })
})


describe("live run 6: unconfirmed headline preserves every verified receipt", () => {
  const tool = (name: ToolProofFact["tool"], receipt: ToolProofFact["receipt"], connected = true): ToolProofFact => ({
    tool: name, receipt, connected, installed: true, fired: true, ungraded: false, ids: [], receiptReason: null
  })
  function headline(tools: ToolProofFact[]) {
    const report = structuredClone(example)
    report.finishLine.find(line => line.id === "proof_from_real_visit")!.cells.proven_live.state = "undetermined"
    return computeVerdict({ site: "site.test", finishLine: report.finishLine, provenLive: report.columns.proven_live, jobs: [], openFindings: [], tools, installedUnknown: null }).headline
  }
  it("names Infinite and GA4 receipts and conjugates the single unconnected tool", () => {
    expect(headline([tool("infinite", "verified"), tool("ga4", "verified"), tool("meta", "delivering", false)]))
      .toBe("site.test: Infinite's tag and GA4 received this run's real visit; Meta sends, but its ID is not checked (not connected in Infinite)")
  })
  it("names a verified GA4 receipt even without Infinite, but never calls a delivering tool received", () => {
    expect(headline([tool("ga4", "verified"), tool("meta", "delivering", false)]))
      .toBe("site.test: GA4 received this run's real visit; Meta sends, but its ID is not checked (not connected in Infinite)")
  })
  it("live run 6 addition: Infinite delivering is sent but not confirmed; only verified is received", () => {
    expect(headline([tool("infinite", "delivering")]))
      .toBe("site.test: Infinite's tag sent this run's real visit, but receipt is not confirmed")
    expect(headline([tool("infinite", "verified")]))
      .toBe("site.test: Infinite's tag received this run's real visit")
    expect(headline([tool("infinite", "delivering"), tool("ga4", "verified")]))
      .toBe("site.test: GA4 received this run's real visit · Infinite's tag sent this run's real visit, but receipt is not confirmed")
    expect(headline([tool("infinite", "delivering"), tool("ga4", "pending")]))
      .toBe("site.test: Infinite's tag sent this run's real visit, but receipt is not confirmed · the receipts of GA4 are not in yet")
  })

  it("names every verified tool and keeps plural send and pending receipt wording", () => {
    expect(headline([tool("infinite", "verified"), tool("ga4", "verified"), tool("posthog", "verified"), tool("meta", "pending")]))
      .toBe("site.test: Infinite's tag, GA4 and PostHog received this run's real visit · the receipts of Meta are not in yet")
    expect(headline([tool("ga4", "delivering", false), tool("meta", "delivering", false)]))
      .toContain("GA4 and Meta send, but their IDs are not checked")
  })
})
