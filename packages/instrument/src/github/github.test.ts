
import { afterEach, describe, expect, it } from "vitest"

import { createFakeGh, type FakeGh } from "../../test/wizard/fake-gh-harness.js"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { createGitHubAdapter } from "../hosts/github.js"
import { parseRemote } from "../hosts/index.js"
import { createGitLabAdapter } from "../hosts/gitlab.js"
import { createBitbucketAdapter } from "../hosts/bitbucket.js"
import { assertSafeGhCall, createGhClient, GhSafetyError } from "./gh.js"

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
})

describe("remotes and other hosts", () => {
  it("parses remotes without their credentials", () => {
    expect(parseRemote("https://user:ghp_secret@github.com/Acme/acme-store.git?x=1#y")).toMatchObject({ host: "github.com", path: "Acme/acme-store", label: "github.com/Acme/acme-store" })
    expect(parseRemote("git@github.com:acme/acme-store.git")).toMatchObject({ host: "github.com", owner: "acme", repo: "acme-store" })
    expect(parseRemote("ssh://git@gitlab.com:22/group/sub/app.git")).toMatchObject({ host: "gitlab.com", owner: "group/sub", repo: "app" })
    expect(JSON.stringify(parseRemote("https://user:ghp_secret@github.com/Acme/acme-store.git"))).not.toContain("ghp_secret")
    expect(parseRemote("/local/path/repo.git")).toBeNull()
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
