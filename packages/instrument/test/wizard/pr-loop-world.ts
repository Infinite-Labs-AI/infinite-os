// The `rehearsal`, `review` and `merge` steps' test world: a real git fixture (bare remote + clone), the
// stateful fake gh, a recording fake bridge and scripted agents. Shared by pr-loop*.test.ts.
import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { expect } from "vitest"

import { createFakeGh, type FakeGh, type FakeGhState } from "./fake-gh-harness.js"
import { createGitFixture, type GitFixture } from "./git-fixture.js"
import {
  fakeBridge,
  fakeChecks,
  fakeClock,
  fakeHosting,
  fakeInstaller,
  initialState,
  PIXEL_ID,
  RUN_ID,
  scriptedAgents,
  testContext,
  testDeps,
  type FakeBridge,
  type ScriptedAgents,
  type TestContext
} from "./o4-fakes.js"
import { createGitOps, type WizardGitOps } from "../../src/git/index.js"
import { createGhClient } from "../../src/github/gh.js"
import { createGitHubAdapter } from "../../src/hosts/github.js"
import { createGitLabAdapter } from "../../src/hosts/gitlab.js"
import { createOtherAdapter } from "../../src/hosts/other.js"
import type { TagHosting } from "../../src/wizard/contracts/bridge.js"
import type { Clock, StepOutcome, WizardDeps } from "../../src/wizard/contracts/deps.js"
import type { GitHostAdapter } from "../../src/wizard/contracts/git-host.js"
import type { ChecklistItem } from "../../src/wizard/contracts/jobs.js"
import type { AgentRunResult, RunJobsInput } from "../../src/wizard/contracts/agents.js"

export const BRANCH = "infinite/tag/2026-10-02-7f3c2a"
export const PREVIEW = "https://acme-store-git-infinite-tag-acme.vercel.app"
export const STRIPE = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")

const worlds: GitFixture[] = []
/** Call from afterEach: removes every world the test built. */
export function cleanupWorlds(): void {
  while (worlds.length > 0) worlds.pop()!.cleanup()
}

export const SIGNUP_JOB: ChecklistItem = {
  id: "conversions_to_tools:sign_up",
  jobId: "conversions_to_tools",
  n: 10,
  title: "Send sign_up to the tools",
  owner: "agent",
  trigger: { finding: "sign up button", evidence: [{ url: "https://acme-store.com/signup" }, { file: "app/signup/page.tsx", line: 3 }] },
  allow: { files: ["app/signup/page.tsx", "app/layout.tsx"], create: [] },
  checks: [{ id: "click_test", tier: "RH", state: "not_run" }],
  state: "done_in_code"
}

export interface World {
  fx: GitFixture
  gh: FakeGh
  git: WizardGitOps
  host: GitHostAdapter
  bridge: FakeBridge
  agents: ScriptedAgents
  ctx: TestContext
  deps: WizardDeps
  baseSha: string
}

export interface WorldOptions {
  approveGa4Settings?: boolean
  gh?: FakeGhState
  hosting?: TagHosting
  reviewer?: "codex" | "claude_code" | "brief" | null
  worker?: "claude_code" | "codex" | null
  reviews?: ScriptedAgents["reviews"]
  /** §3y.7: the scripted reviewer reads nothing (it never quotes the read-check nonce). */
  blindReviewer?: boolean
  fix?: (input: RunJobsInput, round: number, world: World) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>
  answers?: Parameters<typeof testContext>[0]["answers"]
  npmRecorded?: boolean
  installer?: ReturnType<typeof fakeInstaller>
  clock?: Clock
  host?: "github" | "gitlab" | "other"
  previewDeployed?: boolean
  fork?: boolean
  checks?: ReturnType<typeof fakeChecks>
}

/** A repo the `install` and `jobs` steps already changed (uncommitted), on the PR branch. */
export async function world(options: WorldOptions = {}): Promise<World> {
  const fx = createGitFixture({
    files: {
      "README.md": "# acme\n",
      "app/layout.tsx": "export default function Layout() {\n  return null\n}\n",
      "app/signup/page.tsx": "export default function Signup() {\n  return <button>Sign up</button>\n}\n",
      "package.json": '{\n  "name": "acme",\n  "dependencies": {}\n}\n',
      "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
      ".gitignore": "node_modules\n"
    }
  })
  worlds.push(fx)
  const forkRemote = options.fork ? join(fx.dir, "viewer-fork.git") : null
  if (forkRemote) {
    execFileSync("git", ["clone", "--bare", fx.remote, forkRemote])
    execFileSync("git", ["-C", fx.root, "config", `url.file://${forkRemote}.insteadOf`, "https://github.com/acme-dev/acme-store.git"])
  }
  const gh = createFakeGh({
    dir: fx.dir,
    remote: fx.remote,
    env: fx.env,
    state: {
      deployments:
        options.previewDeployed === false
          ? []
          : [{ id: 7, sha: "*", environment: "Preview", creator: "vercel[bot]", statuses: [{ state: "success", environment_url: PREVIEW }] }],
      ...options.gh,
      ...(forkRemote ? { forkRemote } : {})
    }
  })
  const git = createGitOps({ cwd: fx.root, env: gh.env, worktreeRoot: join(fx.dir, "worktrees") })
  const { baseSha } = await git.createBranch("main", BRANCH)
  // What `install` (managed files + the npm job + the receipt + the fence) and `jobs` (an agent edit) left behind.
  fx.write("lib/infinite-server-lane.ts", 'import { waitUntil } from "@vercel/functions"\nexport const lane = waitUntil\n')
  fx.write("app/layout.tsx", `export default function Layout() {\n  // managed: fbq('init', '${PIXEL_ID}')\n  return null\n}\n`)
  fx.write("app/signup/page.tsx", 'export default function Signup() {\n  return <button data-infinite-conversion="sign_up">Sign up</button>\n}\n')
  fx.write(".gitignore", "node_modules\n# infinite:start\n.infinite/wizard/\n# infinite:end\n")
  fx.write("README.md", "# acme (edited by someone else)\n")
  fx.write(".env.local", `STRIPE_SECRET_KEY=${STRIPE}\n`)
  if (options.npmRecorded !== false) {
    fx.write("package.json", '{\n  "name": "acme",\n  "dependencies": {\n    "@vercel/functions": "^2.0.0"\n  }\n}\n')
    fx.write("package-lock.json", '{\n  "lockfileVersion": 3,\n  "packages": { "node_modules/@vercel/functions": {} }\n}\n')
  }
  const edits = [
    ...(options.npmRecorded !== false
      ? [
          { id: "e1", file: "package.json", jobId: "npm_install", planLineId: "npm", by: "wizard", beforeHash: null, afterHash: "sha256:x", textEdits: [], runId: RUN_ID },
          { id: "e2", file: "package-lock.json", jobId: "npm_install", planLineId: "npm", by: "wizard", beforeHash: null, afterHash: "sha256:x", textEdits: [], runId: RUN_ID }
        ]
      : [])
  ]
  fx.write(".infinite/install.json", `${JSON.stringify({ workspaceId: "wizard:0123456789abcdef", appRoot: ".", framework: "next-app-router", providers: ["meta"], files: ["lib/infinite-server-lane.ts"], envKeys: [], contentHashes: {}, wiringVersion: 1, verifiedAt: null, edits }, null, 2)}\n`)
  fx.write(".infinite/wizard/state.json", "{}\n")

  const bridge = fakeBridge({ hosting: options.hosting ?? fakeHosting() })
  const clock = options.clock ?? fakeClock()
  let current: World
  const agents = scriptedAgents({ reviews: options.reviews ?? [], blind: options.blindReviewer ?? false, fix: options.fix ? (input, round) => options.fix!(input, round, current) : undefined })
  const host =
    options.host === "gitlab" ? createGitLabAdapter(git) : options.host === "other" ? createOtherAdapter() : createGitHubAdapter(createGhClient({ cwd: fx.root, env: gh.env }))
  const ctx = testContext({
    root: fx.root,
    clock,
    answers: options.answers,
    state: initialState({
      root: fx.root,
      agent: {
        worker: options.worker === undefined ? "claude_code" : options.worker,
        reviewer: options.reviewer === undefined ? "codex" : options.reviewer,
        workerSession: null,
        whoPays: { worker: null, reviewer: null }
      },
      git: { base: "main", baseSource: "vercel", branch: BRANCH, baseSha, headSha: baseSha },
      jobs: [SIGNUP_JOB]
    })
  })
  if (options.approveGa4Settings) ctx.state.update(state => { state.plan!.lines.push({ id: "account_settings:ga4", approved: true }) })
  const deps = testDeps({ bridge, agents, git, host, clock, installer: options.installer, checks: options.checks, env: {} })
  current = { fx, gh, git, host, bridge, agents, ctx, deps, baseSha }
  return current
}

/** Every bare-package import in the files of `sha` must be declared in package.json at `sha` (the npm job's point). */
export function assertCommittedImportsDeclared(fx: GitFixture, sha: string): void {
  const files = fx.git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter((path) => /\.(t|j)sx?$/.test(path))
  const pkg = JSON.parse(fx.git(["show", `${sha}:package.json`])) as { dependencies?: Record<string, string> }
  for (const file of files) {
    const text = fx.git(["show", `${sha}:${file}`])
    for (const match of text.matchAll(/from\s+["'](@[^/"']+\/[^/"']+|[^./"'][^/"']*)["']/g)) {
      if (!pkg.dependencies?.[match[1]!]) throw new Error(`${file} imports ${match[1]} but package.json at ${sha.slice(0, 7)} does not declare it`)
    }
  }
}

export function bridgeVerbs(bridge: FakeBridge): string[] {
  return bridge.calls.map((call) => call.verb)
}

export function expectOk(outcome: StepOutcome): asserts outcome is Extract<StepOutcome, { kind: "ok" }> {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
}
