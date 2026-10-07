// Lane O4: the GitHub adapter against the stateful fake gh (test/wizard/bin/gh). Never the real GitHub.
import { readFileSync, statSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { createFakeGh, type FakeGh } from "../../test/wizard/fake-gh-harness.js"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { DRAFT_UNSUPPORTED_TITLE_PREFIX } from "../wizard/contracts/git-host.js"
import { createGitHubAdapter } from "../hosts/github.js"
import { detectHostKind, hostLinkFor, parseRemote } from "../hosts/index.js"
import { createGitLabAdapter } from "../hosts/gitlab.js"
import { createBitbucketAdapter } from "../hosts/bitbucket.js"
import { assertSafeGhCall, createGhClient, GhSafetyError } from "./gh.js"
import { findWizardPrs } from "./pr.js"
import { matchesProject } from "./preview.js"

const SHA = "a".repeat(40)
const fixtures: GitFixture[] = []
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup()
})

function setup(state: Parameters<typeof createFakeGh>[0]["state"] = {}): { fx: GitFixture; gh: FakeGh; adapter: ReturnType<typeof createGitHubAdapter> } {
  const fx = createGitFixture()
  fixtures.push(fx)
  const gh = createFakeGh({ dir: fx.dir, remote: fx.remote, env: fx.env, state })
  const adapter = createGitHubAdapter(createGhClient({ cwd: fx.root, env: gh.env }))
  return { fx, gh, adapter }
}

describe("the gh guard (never merge, approve, rebase or fork)", () => {
  it.each([
    [["pr", "merge", "42"]],
    [["pr", "merge", "42", "--admin"]],
    [["pr", "update-branch", "42", "--rebase"]],
    [["pr", "review", "42", "--approve"]],
    [["repo", "fork"]],
    [["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/x"]],
    [["api", "repos/{owner}/{repo}/pulls/42/merge"]]
  ])("refuses %j before spawning", (args) => {
    expect(() => assertSafeGhCall(args)).toThrow(GhSafetyError)
  })

  it("refuses GraphQL merges and any review event but COMMENT", () => {
    expect(() => assertSafeGhCall(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }" }))).toThrow(GhSafetyError)
    expect(() =>
      assertSafeGhCall(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation($pr: ID!) { addPullRequestReview(input: {pullRequestId: $pr, event: APPROVE}) { clientMutationId } }" }))
    ).toThrow(/COMMENT only/)
    expect(() =>
      assertSafeGhCall(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation($pr: ID!) { addPullRequestReview(input: {pullRequestId: $pr, event: COMMENT}) { clientMutationId } }" }))
    ).not.toThrow()
  })

  it("a refused call never reaches gh", async () => {
    const { gh, fx } = setup()
    const client = createGhClient({ cwd: fx.root, env: gh.env })
    await expect(client.run(["pr", "merge", "42"])).rejects.toThrow(GhSafetyError)
    expect(gh.read().calls).toEqual([])
  })
})

describe("the GitHub adapter (§3g.2)", () => {
  it("reads auth from `gh auth status --json hosts` and the repo facts", async () => {
    const { adapter } = setup({ repo: { isPrivate: false, viewerPermission: "READ" } })
    expect(await adapter.auth()).toEqual({ ok: true, login: "acme-dev" })
    expect(await adapter.repoFacts()).toEqual({ isPrivate: false, defaultBranch: "main", viewerPermission: "READ", homepageUrl: null, allowForking: true, nameWithOwner: "acme/acme-store" })
    // §3y.1: the repo's homepage rides the SAME `gh repo view` (a hint for the live-site ask only).
    const withHome = setup({ repo: { homepageUrl: "https://acme-store.com" } })
    expect(await withHome.adapter.repoFacts()).toMatchObject({ homepageUrl: "https://acme-store.com" })
  })

  it("creates only the viewer fork and distinguishes its PR from a same-branch upstream PR", async () => {
    const { adapter, gh, fx } = setup({ repo: { viewerPermission: "TRIAGE", allowForking: true } })
    expect(await adapter.createFork(false)).toEqual({ remoteUrl: "https://github.com/acme-dev/acme-store.git", headOwner: "acme-dev" })
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    const branch = "infinite/tag/2026-10-02-7f3c2a"
    await adapter.createDraftPr({ base: "main", head: `acme-dev:${branch}`, title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    expect(await adapter.findPr(branch, "acme-dev")).toMatchObject({ number: 42 })
    expect(await adapter.findPr(branch)).toBeNull()
    expect(gh.read().prs[0]).toMatchObject({ isCrossRepository: true, headOwner: "acme-dev" })
  })

  it("reuses an existing viewer fork only when GitHub says it belongs to the target", async () => {
    const { adapter, gh } = setup({ repo: { viewerPermission: "TRIAGE", allowForking: true }, forkExists: true })
    expect(await adapter.createFork(false)).toEqual({ remoteUrl: "https://github.com/acme-dev/acme-store.git", headOwner: "acme-dev" })
    expect(gh.read().calls.some((call) => call.argv.includes("POST"))).toBe(false)
  })

  it("is not logged in when gh says so (negative)", async () => {
    const { adapter } = setup({ authOk: false })
    expect(await adapter.auth()).toEqual({ ok: false, login: null })
  })

  it("creates a draft PR with the body on a file and adopts an existing open PR by --head", async () => {
    const { adapter, gh, fx } = setup()
    fx.write(".infinite/wizard/pr-body.md", "body\n<!-- infinite-tag:pr v1 run=r1 -->\n")
    const created = await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    expect(created).toMatchObject({ number: 42, isDraft: true, state: "OPEN" })
    const createCall = gh.read().calls.find((call) => call.argv[1] === "create")!
    expect(createCall.argv).toEqual(expect.arrayContaining(["--draft", "--base", "main", "--head", "infinite/tag/2026-10-02-7f3c2a", "--body-file", ".infinite/wizard/pr-body.md"]))
    const found = await adapter.findPr("infinite/tag/2026-10-02-7f3c2a")
    expect(found).toMatchObject({ number: 42 })
    expect(await adapter.findPr("infinite/tag/2026-10-02-000000")).toBeNull()
  })

  it("review P2-2: a read-only gh call never writes the state file, so a merge written meanwhile is never overwritten", async () => {
    const { adapter, gh, fx } = setup()
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    const bytes = readFileSync(gh.statePath, "utf8")
    const inode = statSync(gh.statePath).ino
    await adapter.readPr(42)
    await adapter.findPr("infinite/tag/2026-10-02-7f3c2a")
    // Nothing changed: the file is the same bytes AND the same file (a rename would give a new inode).
    expect(readFileSync(gh.statePath, "utf8")).toBe(bytes)
    expect(statSync(gh.statePath).ino).toBe(inode)
    // The calls are still recorded (append-only, beside the state).
    expect(gh.read().calls.map((call) => call.argv.slice(0, 2).join(" ")).slice(-2)).toEqual(["pr view", "pr list"])
    // The merge poller's race, for real: many `gh pr view` processes in flight while the test merges the PR.
    const polls = Array.from({ length: 12 }, () => adapter.readPr(42))
    gh.update((state) => {
      Object.assign(state.prs![0]!, { state: "MERGED", mergeCommit: { oid: SHA }, mergedAt: "2026-10-02T10:00:00Z" })
    })
    await Promise.all(polls)
    expect(gh.read().prs[0]).toMatchObject({ state: "MERGED" })
    expect(await adapter.readPr(42)).toMatchObject({ state: "MERGED", mergeCommitOid: SHA })
  })

  it("opens a ready PR with the [review pending] prefix when drafts are not supported", async () => {
    const { adapter, gh, fx } = setup({ draftUnsupported: true })
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    const created = await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "Infinite: analytics", bodyFile: ".infinite/wizard/pr-body.md" })
    expect(created).toMatchObject({ isDraft: false })
    const pr = gh.read().prs[0]!
    expect(pr.title).toBe(`${DRAFT_UNSUPPORTED_TITLE_PREFIX}Infinite: analytics`)
  })

  it("finds the wizard's PR for an author with more than 30 PRs (--limit 200 + the body marker)", async () => {
    const prs = Array.from({ length: 40 }, (_, index) => ({
      number: index + 1,
      url: `https://github.com/acme/acme-store/pull/${index + 1}`,
      id: `PR_${index + 1}`,
      isDraft: false,
      state: "OPEN",
      headRefName: index === 0 ? "infinite/tag/2026-10-01-abcdef" : `feature/${index}`,
      body: index === 0 ? "x\n<!-- infinite-tag:pr v1 run=7f3c2a91-b0de-4c55-9a11-23456789abcd -->" : "",
      author: "acme-dev"
    }))
    // A look-alike: right prefix, no marker → ignored.
    prs.push({ ...prs[1]!, number: 99, id: "PR_99", url: "https://github.com/acme/acme-store/pull/99", headRefName: "infinite/tag/2026-10-01-ffffff", body: "no marker" })
    const { gh, fx } = setup({ prs })
    const client = createGhClient({ cwd: fx.root, env: gh.env })
    const found = await findWizardPrs(client)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ runId: "7f3c2a91-b0de-4c55-9a11-23456789abcd", branch: "infinite/tag/2026-10-01-abcdef", pr: { number: 1 } })
    expect(gh.read().calls[0]!.argv).toEqual(expect.arrayContaining(["--limit", "200"]))
  })

  it("posts ONE review with event COMMENT and inline threads; reads, replies and resolves threads", async () => {
    const { adapter, gh, fx } = setup()
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    await adapter.postReview(42, { headSha: SHA, body: "summary", threads: [{ path: "app/layout.tsx", line: 3, body: "fix this" }] })
    const reviewCall = gh.read().calls.find((call) => call.stdin?.includes("addPullRequestReview"))!
    const sent = JSON.parse(reviewCall.stdin!) as { query: string; variables: { threads: Array<{ side: string }> } }
    expect(sent.query).toMatch(/event: COMMENT/)
    expect(sent.variables.threads[0]!.side).toBe("RIGHT")
    const threads = await adapter.readThreadDetails(42)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ path: "app/layout.tsx", line: 3, author: "acme-dev", isResolved: false })
    await adapter.reply(threads[0]!.threadId, "Fixed in abc1234.")
    await adapter.resolve(threads[0]!.threadId)
    const after = gh.read().threads[0]!
    expect(after.comments.map((comment) => comment.body)).toEqual(["fix this", "Fixed in abc1234."])
    expect(after.isResolved).toBe(true)
  })

  it("R2-5: edits ONLY its own marked comment (author AND marker), by PATCH; none → false (the caller posts)", async () => {
    const { adapter, gh, fx } = setup()
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    const marker = "<!-- infinite-tag:final v1 run=r-1 -->"
    // Someone else pasted the marker: never edited (trust is author AND marker).
    gh.update((state) => {
      ;(state.prs![0]! as { comments: unknown[] }).comments.push({ id: 9001, author: { login: "someone-else" }, authorAssociation: "NONE", body: `fake ${marker}` })
    })
    expect(await adapter.updateOwnComment(42, marker, (body) => `${body} EDITED`)).toBe(false)
    await adapter.comment(42, `what happened\n\n${marker}`)
    expect(await adapter.updateOwnComment(42, marker, (body) => body.replace("what happened", "what happened, final"))).toBe(true)
    const comments = (gh.read().prs[0]! as { comments: Array<{ id: number; body: string; author: { login: string } }> }).comments
    expect(comments.find((entry) => entry.author.login === "acme-dev")!.body).toBe(`what happened, final\n\n${marker}`)
    expect(comments.find((entry) => entry.id === 9001)!.body).toBe(`fake ${marker}`)
    const patch = gh.read().calls.find((call) => call.argv.includes("PATCH"))!
    expect(patch.argv.slice(0, 4)).toEqual(["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${comments.find((entry) => entry.author.login === "acme-dev")!.id}`])
    expect(gh.read().calls.some((call) => call.argv.includes("DELETE"))).toBe(false)
  })

  it("falls back to a body-only review when GitHub refuses the inline threads (422)", async () => {
    const { adapter, gh, fx } = setup({ rejectInlineThreads: true })
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    await adapter.postReview(42, { headSha: SHA, body: "summary", threads: [{ path: "app/layout.tsx", line: 300, body: "outside" }] })
    const state = gh.read()
    expect(state.threads).toHaveLength(0)
    const reviews = (state.prs[0]!.reviews as Array<{ body: string }>).map((entry) => entry.body)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatch(/\*\*app\/layout\.tsx:300\*\*/)
  })

  it("reads the Vercel preview URL from deployments (vercel[bot], Preview, success)", async () => {
    const { adapter, gh } = setup({
      deployments: [
        { id: 1, sha: SHA, environment: "Production", creator: "vercel[bot]", statuses: [{ state: "success", environment_url: "https://acme-store.com" }] },
        { id: 2, sha: SHA, environment: "Preview", creator: "someone", statuses: [{ state: "success", environment_url: "https://evil.example" }] },
        { id: 3, sha: SHA, environment: "Preview", creator: "vercel[bot]", statuses: [{ state: "success", environment_url: "https://acme-store-git-x-acme.vercel.app" }, { state: "pending", environment_url: null }] }
      ]
    })
    expect(await adapter.previewUrl(SHA)).toBe("https://acme-store-git-x-acme.vercel.app")
    gh.update(state => { state.deployments![2]!.statuses.unshift({ state: "pending", environment_url: null }) })
    expect(await adapter.previewUrl(SHA)).toBeNull()
    // Negative: another SHA has no deployment.
    expect(await adapter.previewUrl("b".repeat(40))).toBeNull()
  })

  it("matches the linked project when several Vercel projects deploy the same SHA, else none", async () => {
    const { adapter } = setup({
      deployments: [
        { id: 4, sha: SHA, environment: "Preview – docs", creator: "vercel[bot]", statuses: [{ state: "success", environment_url: "https://docs-git-x-acme.vercel.app" }] },
        { id: 5, sha: SHA, environment: "Preview – acme-store", creator: "vercel[bot]", statuses: [{ state: "success", environment_url: "https://acme-store-git-x-acme.vercel.app" }] }
      ]
    })
    expect(await adapter.previewUrl(SHA)).toBeNull()
    adapter.setPreviewProject("acme-store")
    expect(await adapter.previewUrl(SHA)).toBe("https://acme-store-git-x-acme.vercel.app")
    expect(matchesProject({ id: 9, environment: "Preview" }, "https://docs-git-x.vercel.app", "acme-store")).toBe(false)
  })

  it("§3y.4: the production deploy signal, with the live smoke's shapes (environment 'Production', production_environment false)", async () => {
    const OTHER = "c".repeat(40)
    const { adapter } = setup({
      deployments: [
        // Vercel's preview of the same SHA is never production.
        { id: 11, sha: SHA, environment: "Preview", creator: "vercel[bot]", created_at: "2026-10-03T05:40:00Z", statuses: [{ state: "success", environment_url: "https://x-git.vercel.app" }] },
        { id: 12, sha: SHA, environment: "Production", production_environment: false, creator: "vercel[bot]", created_at: "2026-10-03T05:47:00Z", statuses: [{ state: "success", environment_url: "https://site-mix177n53-example-team.vercel.app" }, { state: "in_progress" }] },
        { id: 13, sha: OTHER, environment: "Production", production_environment: false, creator: "vercel[bot]", created_at: "2026-10-03T06:10:00Z", statuses: [{ state: "failure" }] }
      ]
    })
    expect(await adapter.productionDeployment(SHA)).toEqual({ state: "ready" })
    expect(await adapter.productionDeployment(OTHER)).toEqual({ state: "failed", reason: "Vercel production deployment failed", blocked: false })
    expect(await adapter.productionDeployment("d".repeat(40))).toEqual({ state: "not_found" })
    // The newest SUCCESSFUL production deployment (the failed newer one is skipped).
    expect(await adapter.latestProductionDeployment()).toEqual({ sha: SHA, createdAt: "2026-10-03T05:47:00Z" })
    expect(await adapter.vercelDeploymentSeen()).toBe(true)
  })

  it("§3y.4 negative: an ambiguous monorepo is not_found (never a guess); the linked project picks; building and inactive read right", async () => {
    const { adapter } = setup({
      deployments: [
        { id: 21, sha: SHA, environment: "Production – docs", creator: "vercel[bot]", statuses: [{ state: "success" }] },
        { id: 22, sha: SHA, environment: "Production – acme-store", creator: "vercel[bot]", statuses: [{ state: "queued" }] }
      ]
    })
    expect(await adapter.productionDeployment(SHA)).toEqual({ state: "not_found" })
    adapter.setPreviewProject("acme-store")
    expect(await adapter.productionDeployment(SHA)).toEqual({ state: "building" })
    adapter.setPreviewProject("docs")
    expect(await adapter.productionDeployment(SHA)).toEqual({ state: "ready" })
    const superseded = setup({ deployments: [{ id: 31, sha: SHA, environment: "Production", creator: "vercel[bot]", statuses: [{ state: "inactive" }, { state: "success" }] }] })
    expect(await superseded.adapter.productionDeployment(SHA)).toEqual({ state: "ready" })
    // Review P3-2: only `inactive` statuses (no success ever recorded) is an unmeasured success, so not_found;
    // `latestProductionDeployment` skips it too.
    const onlyInactive = setup({ deployments: [{ id: 32, sha: SHA, environment: "Production", creator: "vercel[bot]", statuses: [{ state: "inactive" }, { state: "inactive" }] }] })
    expect(await onlyInactive.adapter.productionDeployment(SHA)).toEqual({ state: "not_found" })
    expect(await onlyInactive.adapter.latestProductionDeployment()).toBeNull()
    const none = setup({ deployments: [] })
    expect(await none.adapter.vercelDeploymentSeen()).toBe(false)
    expect(await none.adapter.latestProductionDeployment()).toBeNull()
  })

  it("reads branch rules (pull_request approvals, merge queue) and required checks (exit 8 = pending)", async () => {
    const { adapter, fx } = setup({
      rules: { main: [{ type: "merge_queue" }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }] },
      checks: { "42": [{ name: "ci", bucket: "pending", state: "IN_PROGRESS" }] }
    })
    expect(await adapter.rules("main")).toEqual({ requiresReview: true, mergeQueue: true })
    expect(await adapter.rules("other")).toEqual({ requiresReview: false, mergeQueue: false })
    fx.write(".infinite/wizard/pr-body.md", "body\n")
    await adapter.createDraftPr({ base: "main", head: "infinite/tag/2026-10-02-7f3c2a", title: "t", bodyFile: ".infinite/wizard/pr-body.md" })
    expect(await adapter.checks(42)).toEqual([{ name: "ci", bucket: "pending", state: "IN_PROGRESS" }])
  })
})

describe("remotes and other hosts", () => {
  it("parses remotes without their credentials", () => {
    expect(parseRemote("https://user:ghp_secret@github.com/Acme/acme-store.git?x=1#y")).toMatchObject({ host: "github.com", path: "Acme/acme-store", label: "github.com/Acme/acme-store" })
    expect(parseRemote("git@github.com:acme/acme-store.git")).toMatchObject({ host: "github.com", owner: "acme", repo: "acme-store" })
    expect(parseRemote("ssh://git@gitlab.com:22/group/sub/app.git")).toMatchObject({ host: "gitlab.com", owner: "group/sub", repo: "app" })
    expect(JSON.stringify(parseRemote("https://user:ghp_secret@github.com/Acme/acme-store.git"))).not.toContain("ghp_secret")
    expect(parseRemote("/local/path/repo.git")).toBeNull()
  })

  it("detects the host and prints the right link", () => {
    const github = parseRemote("git@github.com:acme/acme-store.git")
    const gitlab = parseRemote("https://gitlab.com/acme/store.git")
    const bitbucket = parseRemote("git@bitbucket.org:acme/store.git")
    expect([detectHostKind(github), detectHostKind(gitlab), detectHostKind(bitbucket), detectHostKind(parseRemote("git@git.acme.dev:a/b.git"))]).toEqual(["github", "gitlab", "bitbucket", "other"])
    expect(hostLinkFor("github", github, "main", "infinite/tag/x")).toBe("https://github.com/acme/acme-store/compare/main...infinite%2Ftag%2Fx?expand=1")
    expect(hostLinkFor("bitbucket", bitbucket, "main", "infinite/tag/x")).toBe("https://bitbucket.org/acme/store/pull-requests/new?source=infinite%2Ftag%2Fx")
    expect(hostLinkFor("gitlab", gitlab, "main", "infinite/tag/x")).toMatch(/^https:\/\/gitlab\.com\/acme\/store\/-\/merge_requests\/new\?/)
  })

  it("GitLab adapter never performs a hidden push outside the measured shipping boundary", async () => {
    const pushes: Array<{ branch: string; options: readonly string[] }> = []
    const gitlab = createGitLabAdapter({ pushWithOptions: async (branch, options) => void pushes.push({ branch, options }) })
    expect(await gitlab.createDraftPr({ base: "main", head: "infinite/tag/x", title: "t", bodyFile: "f" })).toEqual({ unsupported: true })
    expect(pushes).toEqual([])
    expect(await gitlab.postReview(1, { headSha: SHA, body: "b", threads: [] })).toEqual({ unsupported: true })
    expect(await createBitbucketAdapter().findPr("x")).toEqual({ unsupported: true })
  })
})
