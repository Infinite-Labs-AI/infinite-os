// Review I1 P1-5: an agent job the wizard could not check ships its code in the PR, and the PR says so.
import { describe, expect, it } from "vitest"

import type { ChecklistItem } from "../contracts/jobs.js"
import { notCheckedNotes, olderWizardPrNotes } from "./rehearsal.js"

const base = (state: ChecklistItem["state"], owner: ChecklistItem["owner"] = "agent"): ChecklistItem => ({
  id: "identify_reset:auth",
  jobId: "identify_reset",
  n: 9,
  title: "Join visits to accounts",
  owner,
  trigger: { finding: "f", evidence: [] },
  allow: { files: ["app/api/auth/login/route.ts"], create: [] },
  checks: [],
  state,
  edits: [{ editId: "agent-1", file: "app/api/auth/login/route.ts" }]
})

describe("notCheckedNotes", () => {
  it("request 2 P3-1: the pre-rehearsal note defers to the rehearsal rather than permanently declaring unreviewed code", () => {
    const [note] = notCheckedNotes([base("claimed")])
    expect(note).toContain("Not checked at pull request creation")
    expect(note).toContain("what-happened comment")
    expect(note).not.toContain("Review it yourself")
    expect(note).toContain("Join visits to accounts (app/api/auth/login/route.ts)")
  })
  it("negative: checked, failed or code-owned jobs add no note", () => {
    expect(notCheckedNotes([base("done_in_code"), base("waiting_real_event"), base("failed"), base("claimed", "code")])).toEqual([])
  })
})


it("request 3 P3-body: name only jobs actually checked by rehearsal; no clause when none ran", () => {
  const spa = { ...base("claimed"), id: "ga4_improve:spa_page_view", title: "GA4 page changes", checks: [{ id: "ga4_spa_page_view", tier: "RH" as const, state: "not_run" as const }] }
  const notes = notCheckedNotes([base("claimed"), spa], [spa.id]).join(" ")
  expect(notes).toContain("The preview rehearsal checked: GA4 page changes.")
  expect(notes).not.toContain("The preview rehearsal checked: Join visits")
  expect(notCheckedNotes([base("claimed"), spa]).join(" ")).not.toContain("rehearsal")
})


it("notices older open wizard PRs with one owner command and never closes them", async () => {
  const branches: string[] = []
  const host = { olderWizardPrs: async (branch: string) => { branches.push(branch); return [{ number: 12 }, { number: 12 }, { number: 31 }] } }
  expect(await olderWizardPrNotes(host as never, "infinite/tag/current")).toEqual([
    "Older wizard pull request #12 is still open on another branch. To close it yourself: gh pr close 12",
    "Older wizard pull request #31 is still open on another branch. To close it yourself: gh pr close 31"
  ])
  expect(branches).toEqual(["infinite/tag/current"])
})

it("lists only other open marked wizard branches through the GitHub adapter", async () => {
  const { createGitHubAdapter } = await import("../../hosts/github.js")
  const calls: readonly string[][] = []
  const rows = [
    { number: 1, branch: "infinite/tag/current", state: "OPEN", marked: true },
    { number: 2, branch: "infinite/tag/old", state: "OPEN", marked: true },
    { number: 3, branch: "infinite/tag/closed", state: "CLOSED", marked: true },
    { number: 4, branch: "feature/unrelated", state: "OPEN", marked: true },
    { number: 5, branch: "infinite/tag/unmarked", state: "OPEN", marked: false }
  ].map(row => ({ number: row.number, headRefName: row.branch, state: row.state, url: `https://github.com/example/site/pull/${row.number}`, body: row.marked ? "<!-- infinite-tag:pr v1 run=11111111-1111-4111-8111-111111111111 -->" : "Unrelated" }))
  const host = createGitHubAdapter({ json: async (args: string[]) => { (calls as string[][]).push(args); return rows } } as never)
  expect(await host.olderWizardPrs!("infinite/tag/current")).toEqual([{ number: 2 }])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.slice(0, 2)).toEqual(["pr", "list"])
  expect(calls[0]).toContain("@me")
})
