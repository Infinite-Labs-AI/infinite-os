// The PR itself (lane O4, §3g.2): adopt an existing one, create a draft (or a ready PR with the
// `[review pending] ` prefix when the plan has no drafts), read it, mark it ready, comment, update the branch
// with a merge commit. Bodies always go on stdin. Never `gh pr merge`.
import { PR_LOOP_LIMITS, DRAFT_UNSUPPORTED_TITLE_PREFIX, type PrSummary } from "../wizard/contracts/git-host.js"
import { WIZARD_BRANCH_PREFIX } from "../wizard/contracts/state.js"
import { GhError, type GhClient } from "./gh.js"

const PR_FIELDS = "number,url,id,isDraft,state,headRefOid,headRefName,mergeCommit,mergedAt,mergeStateStatus,reviewDecision"

interface RawPr {
  number?: number
  url?: string
  id?: string
  isDraft?: boolean
  state?: string
  headRefOid?: string
  headRefName?: string
  mergeCommit?: { oid?: string } | null
  mergedAt?: string | null
  mergeStateStatus?: string | null
  reviewDecision?: string | null
  body?: string
  isCrossRepository?: boolean
}

export function toPrSummary(raw: RawPr): PrSummary {
  if (typeof raw.number !== "number" || typeof raw.url !== "string") throw new Error("gh returned a PR without number/url")
  const state = raw.state === "MERGED" || raw.state === "CLOSED" ? raw.state : "OPEN"
  return {
    number: raw.number,
    url: raw.url,
    nodeId: typeof raw.id === "string" ? raw.id : "",
    isDraft: raw.isDraft === true,
    state,
    headRefOid: typeof raw.headRefOid === "string" ? raw.headRefOid : "",
    mergeCommitOid: raw.mergeCommit?.oid ?? null,
    mergedAt: raw.mergedAt ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    // `""` = the base requires no review (S2 fact 15).
    reviewDecision: raw.reviewDecision ?? null
  }
}

export async function readPr(gh: GhClient, number: number): Promise<PrSummary> {
  return toPrSummary(await gh.json<RawPr>(["pr", "view", String(number), "--json", PR_FIELDS]))
}

/**
 * `gh pr list --head <branch> --author @me --state all --limit 200`: an open PR is adopted; else the newest.
 * `--limit 200` because gh's default of 30 misses the PR for a busy author (wf4 RV-12). Only the user's OWN
 * same-repo PRs count: `--head` also matches a stranger's fork PR that reuses the branch name, and the wizard must
 * never post on, ready or merge-watch someone else's PR.
 */
export async function findPr(gh: GhClient, branch: string): Promise<PrSummary | null> {
  const rows = await gh.json<RawPr[]>([
    "pr",
    "list",
    "--head",
    branch,
    "--author",
    "@me",
    "--state",
    "all",
    "--limit",
    String(PR_LOOP_LIMITS.prListLimit),
    "--json",
    `${PR_FIELDS},isCrossRepository`
  ])
  const matching = rows.filter((row) => row.headRefName === branch && row.isCrossRepository !== true)
  if (matching.length === 0) return null
  const open = matching.find((row) => row.state === "OPEN")
  const chosen = open ?? [...matching].sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0]!
  return toPrSummary(chosen)
}

/** `<!-- infinite-tag:pr v1 run=<runId> -->` → the run id. */
export function prMarkerRunId(body: string): string | null {
  const match = /<!-- infinite-tag:pr v1 run=([0-9a-fA-F-]{8,64}) -->/.exec(body)
  return match ? match[1]! : null
}

/**
 * §3d.6 fresh-machine resume: the author's PRs, filtered client-side to the `infinite/tag/` prefix AND the body
 * marker (gh's `--head` takes no `owner:branch`). Each comes with the run id its marker carries.
 */
export async function findWizardPrs(gh: GhClient): Promise<Array<{ pr: PrSummary; runId: string; branch: string }>> {
  const rows = await gh.json<RawPr[]>([
    "pr",
    "list",
    "--author",
    "@me",
    "--state",
    "all",
    "--limit",
    String(PR_LOOP_LIMITS.prListLimit),
    "--json",
    `${PR_FIELDS},body`
  ])
  const out: Array<{ pr: PrSummary; runId: string; branch: string }> = []
  for (const row of rows) {
    if (typeof row.headRefName !== "string" || !row.headRefName.startsWith(WIZARD_BRANCH_PREFIX)) continue
    const runId = prMarkerRunId(row.body ?? "")
    if (!runId) continue
    out.push({ pr: toPrSummary(row), runId, branch: row.headRefName })
  }
  return out
}

function prNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)\b/.exec(url)
  return match ? Number(match[1]) : null
}

/**
 * `gh pr create --draft --base --head --title --body-file`. `--head` skips any fork or push prompt. A 422 about
 * drafts → the same PR opened ready, with the `[review pending] ` title prefix (the caller says so).
 */
export async function createDraftPr(
  gh: GhClient,
  input: { base: string; head: string; title: string; bodyFile: string }
): Promise<PrSummary> {
  const base = ["pr", "create", "--base", input.base, "--head", input.head, "--body-file", input.bodyFile]
  let url: string
  try {
    url = (await gh.run([...base, "--draft", "--title", input.title])).stdout.trim()
  } catch (error) {
    if (!(error instanceof GhError) || error.kind !== "draft_unsupported") throw error
    url = (await gh.run([...base, "--title", `${DRAFT_UNSUPPORTED_TITLE_PREFIX}${input.title}`])).stdout.trim()
  }
  const lastLine = url.split("\n").filter(Boolean).pop() ?? ""
  const number = prNumberFromUrl(lastLine)
  if (number === null) throw new Error("gh pr create printed no PR URL")
  return readPr(gh, number)
}

export async function markReady(gh: GhClient, number: number): Promise<void> {
  await gh.run(["pr", "ready", String(number)])
}

export async function comment(gh: GhClient, number: number, body: string): Promise<void> {
  await gh.run(["pr", "comment", String(number), "--body-file", "-"], { input: body })
}

/** `gh pr update-branch` (a merge commit; `--rebase` is never used). */
export async function updateBranch(gh: GhClient, number: number): Promise<void> {
  await gh.run(["pr", "update-branch", String(number)])
}
