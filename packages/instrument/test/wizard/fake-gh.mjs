/* global process */
// A fake `gh` for lane O4's tests (and I1's offline E2E). It keeps its state in the JSON file named by
// FAKE_GH_STATE, records every call (argv + stdin) there, and answers the subset of gh the wizard uses:
//   auth status, repo view, pr list/create/view/ready/checks/comment/update-branch,
//   api (deployments, deployment statuses, branch rules), api graphql (addPullRequestReview, reviewThreads,
//   addPullRequestReviewThreadReply, resolveReviewThread).
// A PR's headRefOid is read from the bare remote (FAKE_GH_REMOTE), so it follows real pushes. `pr merge` and any
// unknown command fail loudly. No network, ever.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const statePath = process.env.FAKE_GH_STATE
if (!statePath) {
  process.stderr.write("fake gh: FAKE_GH_STATE is not set\n")
  process.exit(2)
}
const state = JSON.parse(readFileSync(statePath, "utf8"))
state.calls ??= []
state.prs ??= []
state.threads ??= []
state.deployments ??= []
state.rules ??= {}
state.checks ??= {}
state.nextPrNumber ??= 42
state.nextId ??= 1

const argv = process.argv.slice(2)
let stdin = ""
try {
  stdin = readFileSync(0, "utf8")
} catch {
  stdin = ""
}
state.calls.push({ argv, stdin: stdin === "" ? null : stdin })

function save() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}
function out(value) {
  save()
  process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`)
  process.exit(0)
}
function fail(message, code = 1) {
  save()
  process.stderr.write(`${message}\n`)
  process.exit(code)
}
function flag(name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}
function nextId(prefix) {
  const id = `${prefix}_${state.nextId}`
  state.nextId += 1
  return id
}
function headOf(pr) {
  const remote = process.env.FAKE_GH_REMOTE
  if (!remote) return pr.headRefOid ?? ""
  try {
    return execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${pr.headRefName}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return pr.headRefOid ?? ""
  }
}
function prView(pr, fields) {
  const full = {
    number: pr.number,
    url: pr.url,
    id: pr.id,
    isDraft: pr.isDraft,
    state: pr.state,
    headRefOid: headOf(pr),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    title: pr.title,
    body: pr.body,
    mergeCommit: pr.mergeCommit ?? null,
    mergedAt: pr.mergedAt ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? "CLEAN",
    reviewDecision: pr.reviewDecision ?? "",
    author: { login: pr.author },
    isCrossRepository: pr.isCrossRepository ?? false,
    comments: pr.comments ?? [],
    reviews: pr.reviews ?? []
  }
  if (!fields) return full
  return Object.fromEntries(fields.split(",").map((field) => [field, full[field]]))
}
function findPr(selector) {
  const number = Number(selector)
  return state.prs.find((pr) => pr.number === number) ?? null
}

const [group, sub] = argv

if (group === "auth" && sub === "status") {
  const host = flag("--hostname") ?? "github.com"
  out({ hosts: { [host]: [state.authOk === false ? { state: "error", active: true, host, login: state.login ?? null } : { state: "success", active: true, host, login: state.login }] } })
}

if (group === "repo" && sub === "view") {
  const repo = state.repo ?? {}
  out({
    nameWithOwner: repo.nameWithOwner ?? "acme/acme-store",
    isPrivate: repo.isPrivate ?? true,
    defaultBranchRef: repo.defaultBranch === null ? null : { name: repo.defaultBranch ?? "main" },
    viewerPermission: repo.viewerPermission ?? "WRITE",
    homepageUrl: repo.homepageUrl ?? null
  })
}

if (group === "pr") {
  if (sub === "merge") fail("fake gh: `gh pr merge` is never allowed")
  if (sub === "list") {
    const head = flag("--head")
    const author = flag("--author")
    const stateFilter = (flag("--state") ?? "open").toUpperCase()
    const limit = Number(flag("--limit") ?? "30")
    const fields = flag("--json")
    let rows = [...state.prs].sort((a, b) => b.number - a.number)
    if (head) rows = rows.filter((pr) => pr.headRefName === head)
    if (author === "@me") rows = rows.filter((pr) => pr.author === state.login)
    if (stateFilter !== "ALL") rows = rows.filter((pr) => pr.state === stateFilter)
    out(rows.slice(0, limit).map((pr) => prView(pr, fields)))
  }
  if (sub === "create") {
    const draft = argv.includes("--draft")
    if (draft && state.draftUnsupported) {
      fail("pull request create failed: GraphQL: Draft pull requests are not supported in this repository. (createPullRequest) HTTP 422")
    }
    const head = flag("--head")
    const bodyFile = flag("--body-file")
    // Like the real gh: "-" is stdin, a relative path is from the cwd, an absolute one is used as is.
    const body = bodyFile === "-" ? stdin : readFileSync(isAbsolute(bodyFile) ? bodyFile : join(process.cwd(), bodyFile), "utf8")
    const number = state.nextPrNumber
    state.nextPrNumber += 1
    const repo = state.repo?.nameWithOwner ?? "acme/acme-store"
    const pr = {
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      id: `PR_${number}`,
      isDraft: draft,
      state: "OPEN",
      headRefName: head,
      baseRefName: flag("--base"),
      title: flag("--title"),
      body,
      author: state.login,
      mergeStateStatus: "CLEAN",
      reviewDecision: state.reviewDecision ?? "",
      comments: [],
      reviews: []
    }
    state.prs.push(pr)
    out(`${pr.url}\n`)
  }
  const pr = findPr(argv[2])
  if (!pr) fail(`fake gh: no pull requests found for ${argv[2]}`)
  if (sub === "view") out(prView(pr, flag("--json")))
  if (sub === "ready") {
    pr.isDraft = false
    out("")
  }
  if (sub === "comment") {
    pr.comments.push({ author: { login: state.login }, authorAssociation: "OWNER", body: stdin })
    out(`${pr.url}#issuecomment-1\n`)
  }
  if (sub === "update-branch") {
    if (argv.includes("--rebase")) fail("fake gh: update-branch --rebase is never allowed")
    if (pr.mergeStateStatus === "DIRTY") fail("GraphQL: merge conflict between base and head (updatePullRequestBranch)")
    // GitHub's default: merge the base into the PR branch with a merge commit (made on the bare remote).
    const remote = process.env.FAKE_GH_REMOTE
    if (remote && pr.mergeStateStatus === "BEHIND") {
      const git = (args) => execFileSync("git", ["--git-dir", remote, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" }
      }).trim()
      const head = git(["rev-parse", `refs/heads/${pr.headRefName}`])
      const base = git(["rev-parse", `refs/heads/${pr.baseRefName}`])
      const tree = git(["merge-tree", "--write-tree", head, base])
      const merge = git(["commit-tree", tree.split("\n")[0], "-p", head, "-p", base, "-m", `Merge branch '${pr.baseRefName}' into ${pr.headRefName}`])
      git(["update-ref", `refs/heads/${pr.headRefName}`, merge])
    }
    pr.mergeStateStatus = "CLEAN"
    out("")
  }
  if (sub === "checks") {
    const rows = state.checks[String(pr.number)]
    if (!rows || rows.length === 0) fail("no required checks reported on the 'infinite' branch")
    save()
    process.stdout.write(`${JSON.stringify(rows)}\n`)
    process.exit(rows.some((row) => row.bucket === "pending") ? 8 : 0)
  }
}

if (group === "api") {
  const path = argv[1]
  if (path === "graphql") {
    const { query, variables } = JSON.parse(stdin)
    if (query.includes("addPullRequestReview(")) {
      const pr = state.prs.find((candidate) => candidate.id === variables.pr)
      if (!pr) fail("GraphQL: Could not resolve to a node with the global id")
      if (!/event: COMMENT/.test(query)) fail("fake gh: review event must be COMMENT")
      const threads = variables.threads ?? []
      if (state.rejectInlineThreads && threads.length > 0) fail("GraphQL: Line could not be resolved (addPullRequestReview) HTTP 422")
      const reviewId = nextId("PRR")
      pr.reviews.push({ id: reviewId, author: { login: state.login }, authorAssociation: "OWNER", body: variables.body, state: "COMMENTED", commitOID: variables.sha })
      for (const thread of threads) {
        state.threads.push({
          id: nextId("PRRT"),
          prNumber: pr.number,
          isResolved: false,
          isOutdated: false,
          path: thread.path,
          line: thread.line,
          side: thread.side,
          comments: [{ author: state.login, authorAssociation: "OWNER", body: thread.body }]
        })
      }
      out({ data: { addPullRequestReview: { pullRequestReview: { id: reviewId, url: `${pr.url}#pullrequestreview-${reviewId}` } } } })
    }
    if (query.includes("reviewThreads(")) {
      const rows = state.threads.filter((thread) => thread.prNumber === variables.number)
      out({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: rows.map((thread) => ({
                  id: thread.id,
                  isResolved: thread.isResolved,
                  isOutdated: thread.isOutdated ?? false,
                  path: thread.path,
                  line: thread.line,
                  viewerCanResolve: true,
                  viewerCanReply: true,
                  comments: {
                    nodes: thread.comments.map((comment) => ({
                      author: { login: comment.author },
                      authorAssociation: comment.authorAssociation,
                      viewerDidAuthor: comment.author === state.login,
                      body: comment.body
                    }))
                  }
                })),
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }
        }
      })
    }
    if (query.includes("addPullRequestReviewThreadReply(")) {
      const thread = state.threads.find((candidate) => candidate.id === variables.thread)
      if (!thread) fail("GraphQL: Could not resolve thread")
      thread.comments.push({ author: state.login, authorAssociation: "OWNER", body: variables.body })
      out({ data: { addPullRequestReviewThreadReply: { comment: { id: nextId("PRRC") } } } })
    }
    if (query.includes("resolveReviewThread(")) {
      const thread = state.threads.find((candidate) => candidate.id === variables.thread)
      if (!thread) fail("GraphQL: Could not resolve thread")
      thread.isResolved = true
      out({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } })
    }
    fail("fake gh: unknown graphql document")
  }
  // GitHub's deployment row shape (Vercel writes `environment:"Production"` with `production_environment:false`).
  const row = (entry, sha) => ({
    id: entry.id,
    sha: entry.sha === "*" ? sha : entry.sha,
    environment: entry.environment,
    production_environment: entry.production_environment ?? false,
    created_at: entry.created_at ?? "2026-10-02T10:00:00Z",
    creator: { login: entry.creator }
  })
  const newestFirst = (rows) => [...rows].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))
  const deployments = /^repos\/\{owner\}\/\{repo\}\/deployments\?sha=([0-9a-f]{40})/.exec(path)
  if (deployments) {
    out(newestFirst(state.deployments.filter((entry) => entry.sha === "*" || entry.sha === deployments[1])).map((entry) => row(entry, deployments[1])))
  }
  const byEnvironment = /^repos\/\{owner\}\/\{repo\}\/deployments\?environment=([^&]+)&per_page=(\d+)$/.exec(path)
  if (byEnvironment) {
    const environment = decodeURIComponent(byEnvironment[1])
    out(newestFirst(state.deployments.filter((entry) => entry.environment === environment && entry.sha !== "*")).slice(0, Number(byEnvironment[2])).map((entry) => row(entry, entry.sha)))
  }
  const recent = /^repos\/\{owner\}\/\{repo\}\/deployments\?per_page=(\d+)$/.exec(path)
  if (recent) {
    out(newestFirst(state.deployments).slice(0, Number(recent[1])).map((entry) => row(entry, entry.sha === "*" ? "0".repeat(40) : entry.sha)))
  }
  const statuses = /^repos\/\{owner\}\/\{repo\}\/deployments\/(\d+)\/statuses/.exec(path)
  if (statuses) {
    const row = state.deployments.find((candidate) => String(candidate.id) === statuses[1])
    out(row ? row.statuses : [])
  }
  const rules = /^repos\/\{owner\}\/\{repo\}\/rules\/branches\/(.+)$/.exec(path)
  if (rules) out(state.rules[decodeURIComponent(rules[1])] ?? [])
}

fail(`fake gh: unsupported command: ${argv.join(" ")}`)
