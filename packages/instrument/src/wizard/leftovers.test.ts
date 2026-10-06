// §3y.8 / IO-8 (P2-4, P2-5, P3-11): `--fresh` over the wizard's OWN leftovers (the live run 3 state), a refusal that
// names only someone else's paths, the receipt reset after branching, and the set-aside run marked abandoned. A real
// git fixture (no remote network), fakes for the bridge and the asks.
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { GITIGNORE_FENCE_BLOCK } from "../harness/outputs.js"
import { createGitOps } from "../git/index.js"
import { makeEditRecord, sha256Tagged } from "../install/edits.js"
import type { WizardDeps } from "./contracts/deps.js"
import type { WizardRunState } from "./contracts/state.js"
import { abandonRun, freshStart } from "./command.js"
import { nodeWizardFs } from "./fs.js"
import { findLeftovers, resetStaleReceipt } from "./leftovers.js"
import { createRunState } from "./run-state.js"
import type { WizardIo } from "./wiring.js"

const fixtures: GitFixture[] = []
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup()
})

const OLD_RUN = "11f15f98-0000-4000-8000-000000000003"
const BRANCH = "infinite/tag/2026-10-03-11f15f"
const LAYOUT = "export default function Layout() {\n  return <html><body>{children}</body></html>\n}\n"
const LAYOUT_AFTER = "export default function Layout() {\n  // the duplicate gtag was removed\n  return <html><body>{children}</body></html>\n}\n"

/** The live run-3 world: the set-aside run's agent edit on app/layout.tsx and its .gitignore fence, never committed. */
function liveRun3(): { fx: GitFixture; old: WizardRunState } {
  const fx = createGitFixture({ files: { "README.md": "# smoke\n", "app/layout.tsx": LAYOUT, "app/page.tsx": "export default function Page() { return null }\n", "app/privacy/page.tsx": "export default function Privacy() { return null }\n", "next.config.js": "module.exports = {}\n", "pages/_app.tsx": "export default function App() { return null }\n", ".gitignore": "node_modules\n" } })
  fixtures.push(fx)
  fx.git(["checkout", "-q", "-b", BRANCH])
  fx.write("app/layout.tsx", LAYOUT_AFTER)
  fx.write(".gitignore", `node_modules\n${GITIGNORE_FENCE_BLOCK}`)
  const record = makeEditRecord({ file: "app/layout.tsx", before: LAYOUT, after: LAYOUT_AFTER, jobId: "duplicates_remove:ga4", planLineId: "remove_duplicate:ga4:G-TEST0000000", by: "agent", runId: OLD_RUN })
  fx.write(".infinite/install.json", `${JSON.stringify({ workspaceId: "wizard:abc", edits: [record] }, null, 2)}\n`)
  const old = createRunState({ tagVersion: "0.12.0", root: fx.root, appRoot: ".", now: new Date("2026-10-03T05:20:00Z"), displayId: "r-5995" })
  old.runId = OLD_RUN
  old.link = { linkId: "lk_V0qMdOMEEFwiVnjdeP-GGg", workspaceName: "Tag smoke test", approvedAt: "2026-10-03T05:00:00Z", runtimeVariant: "dev9" }
  old.git = { base: "main", baseSource: "default_branch", branch: BRANCH, baseSha: fx.git(["rev-parse", "main"]).trim(), headSha: null }
  return { fx, old }
}

function io(): WizardIo & { errors: string[] } {
  const errors: string[] = []
  return { errors, stdin: {}, stdout: { write: () => true }, stderr: { write: (text: string) => errors.push(text) }, env: {}, platform: "darwin", cwd: () => "/", exit: () => undefined }
}

function depsFor(fx: GitFixture, patches: unknown[] = []): WizardDeps {
  const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
  const linkIds: Array<string | null> = []
  return {
    git,
    bridge: {
      has: () => true,
      setLinkId: (id: string | null) => linkIds.push(id),
      patchRun: async (runId: string, patch: unknown) => {
        patches.push({ runId, patch, linkId: linkIds.at(-1) })
        return {} as never
      }
    }
  } as unknown as WizardDeps
}

describe("--fresh over the wizard's own leftovers (§3y.8, P2-4)", () => {
  it("recognises four edit records plus three matching installer content hashes, then discards once and switches to base", async () => {
    const { fx, old } = liveRun3()
    const editInputs = [
      ["app/page.tsx", "export default function Page() { return null }\n", "export default function Page() { return <main>Ready</main> }\n"],
      ["app/privacy/page.tsx", "export default function Privacy() { return null }\n", "export default function Privacy() { return <p>Ready</p> }\n"],
      ["next.config.js", "module.exports = {}\n", "module.exports = { reactStrictMode: true }\n"]
    ] as const
    const receipt = JSON.parse(readFileSync(join(fx.root, ".infinite/install.json"), "utf8")) as { edits: unknown[]; files?: string[]; contentHashes?: Record<string, string> }
    for (const [file, before, after] of editInputs) {
      fx.write(file, after)
      receipt.edits.push(makeEditRecord({ file, before, after, jobId: "setup_check_fixes", planLineId: "fix", by: "agent", runId: OLD_RUN }))
    }
    const managed = {
      "pages/_app.tsx": "import { InfiniteAnalyticsClient } from '../lib/infinite-analytics-client'\nexport default function App() { return <InfiniteAnalyticsClient /> }\n",
      "lib/infinite-analytics.ts": "export const infiniteTrack = () => undefined\n",
      "lib/infinite-analytics-client.tsx": "export function InfiniteAnalyticsClient() { return null }\n"
    }
    for (const [file, contents] of Object.entries(managed)) fx.write(file, contents)
    receipt.files = Object.keys(managed)
    receipt.contentHashes = Object.fromEntries(Object.entries(managed).map(([file, contents]) => [file, sha256Tagged(contents).slice("sha256:".length)]))
    fx.write(".infinite/install.json", `${JSON.stringify(receipt, null, 2)}\n`)
    const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
    const scan = await findLeftovers(fx.root, nodeWizardFs, git, OLD_RUN)
    expect(scan.others).toEqual([])
    expect(scan.leftovers.map((entry) => entry.path).sort()).toEqual([...editInputs.map(([file]) => file), "app/layout.tsx", ...Object.keys(managed)].sort())
    expect(scan.leftovers.filter((entry) => entry.created).map((entry) => entry.path).sort()).toEqual(["lib/infinite-analytics.ts", "lib/infinite-analytics-client.tsx"].sort())
    fx.write("pages/_app.tsx", `${managed["pages/_app.tsx"]}// user edit\n`)
    const changed = await findLeftovers(fx.root, nodeWizardFs, git, OLD_RUN)
    expect(changed.others).toEqual(["pages/_app.tsx"])
    fx.write("pages/_app.tsx", managed["pages/_app.tsx"])
    const asked: string[] = []
    expect(await freshStart({ root: fx.root, deps: depsFor(fx), ask: (async (_kind: string, payload: { question: string }) => { asked.push(payload.question); return true }) as never, io: io(), old })).toBeNull()
    expect(asked).toHaveLength(1)
    expect(fx.git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe("main")
    expect(fx.git(["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("")
    expect(readFileSync(join(fx.root, "pages/_app.tsx"), "utf8")).toBe("export default function App() { return null }\n")
    expect(existsSync(join(fx.root, "lib/infinite-analytics.ts"))).toBe(false)
    expect(existsSync(join(fx.root, "lib/infinite-analytics-client.tsx"))).toBe(false)
  })

  it.each([false, true])("never treats another or mixed run's matching content hash as this set-aside run's leftover (mixed=%s)", async (mixed) => {
    const { fx } = liveRun3()
    fx.write("pages/_app.tsx", "export const marker = true\n")
    const receipt = JSON.parse(readFileSync(join(fx.root, ".infinite/install.json"), "utf8")) as { edits: Array<{ runId: string }>; files?: string[]; contentHashes?: Record<string, string> }
    receipt.edits.forEach((edit) => { edit.runId = "other-run" })
    if (mixed) receipt.edits.push({ ...receipt.edits[0]!, runId: OLD_RUN })
    receipt.files = ["pages/_app.tsx"]
    receipt.contentHashes = { "pages/_app.tsx": sha256Tagged("export const marker = true\n").slice(7) }
    fx.write(".infinite/install.json", JSON.stringify(receipt))
    const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
    const scan = await findLeftovers(fx.root, nodeWizardFs, git, OLD_RUN)
    expect(scan.others).toContain("pages/_app.tsx")
    expect(scan.leftovers.some((entry) => entry.path === "pages/_app.tsx")).toBe(false)
  })

  it("the live run-3 state → ONE confirm naming app/layout.tsx; yes restores exactly it, drops the run's receipt entries, switches to the base", async () => {
    const { fx, old } = liveRun3()
    const asked: Array<{ kind: string; payload: { question: string; defaultYes: boolean } }> = []
    const ask = (async (kind: string, payload: { question: string; defaultYes: boolean }) => (asked.push({ kind, payload }), true)) as never
    const out = io()
    const stopped = await freshStart({ root: fx.root, deps: depsFor(fx), ask, io: out, old })
    expect(stopped).toBeNull()
    expect(asked).toEqual([{ kind: "confirm", payload: { question: "Your last run (r-5995) left its own unfinished changes, never committed: app/layout.tsx. Discard them and start fresh?", defaultYes: true } }])
    expect(readFileSync(join(fx.root, "app/layout.tsx"), "utf8")).toBe(LAYOUT)
    expect(readFileSync(join(fx.root, ".gitignore"), "utf8")).toBe("node_modules\n")
    expect(fx.git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe("main")
    const receipt = JSON.parse(readFileSync(join(fx.root, ".infinite/install.json"), "utf8")) as { edits?: unknown[] }
    expect(receipt.edits).toBeUndefined()
    expect(fx.git(["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("")
  })

  it("--yes never answers it (the ask times out) → exit 2 with the exact commands; nothing is touched", async () => {
    const { fx, old } = liveRun3()
    const out = io()
    const stopped = await freshStart({ root: fx.root, deps: depsFor(fx), ask: (async () => "__timeout__") as never, io: out, old })
    expect(stopped).toBe(2)
    expect(out.errors.join("")).toContain("git restore --source=HEAD --staged --worktree -- app/layout.tsx .gitignore && git switch main")
    expect(readFileSync(join(fx.root, "app/layout.tsx"), "utf8")).toBe(LAYOUT_AFTER)
  })

  it("NEGATIVE: someone else's change (or a later hand edit of the wizard's file) refuses, naming ONLY those paths", async () => {
    const { fx, old } = liveRun3()
    fx.write("README.md", "# smoke (my own edit)\n")
    const out = io()
    const stopped = await freshStart({ root: fx.root, deps: depsFor(fx), ask: (async () => true) as never, io: out, old })
    expect(stopped).toBe(2)
    expect(out.errors.join("")).toBe("Commit or stash your changes first (README.md); the wizard works on its own branch.\n")
    // A wizard file edited again by hand is no longer the wizard's bytes: it is not a leftover.
    fx.write("README.md", "# smoke\n")
    fx.write("app/layout.tsx", `${LAYOUT_AFTER}// mine\n`)
    const scan = await findLeftovers(fx.root, nodeWizardFs, createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "wt") }), OLD_RUN)
    expect(scan.leftovers).toEqual([])
    expect(scan.others).toEqual(["app/layout.tsx"])
  })

  it("the set-aside run is PATCHed abandoned through its own link (best effort)", async () => {
    const { fx, old } = liveRun3()
    const patches: unknown[] = []
    await abandonRun(depsFor(fx, patches), old, io())
    expect(patches).toEqual([{ runId: OLD_RUN, patch: { phase: "abandoned" }, linkId: "lk_V0qMdOMEEFwiVnjdeP-GGg" }])
    // A refusal is one line, never a stop.
    const out = io()
    const refusing = { ...depsFor(fx), bridge: { has: () => true, setLinkId: () => undefined, patchRun: async () => Promise.reject(Object.assign(new Error("x"), { code: "not_found" })) } } as unknown as WizardDeps
    await abandonRun(refusing, old, out)
    expect(out.errors).toHaveLength(1)
  })
})

describe("the receipt reset after branching (§3y.8, P2-5)", () => {
  it("a working receipt the base never had is moved to the cache (0600) and removed; one that equals the base's stays", async () => {
    const { fx } = liveRun3()
    const home = join(fx.dir, "home")
    const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "wt") })
    const baseSha = fx.git(["rev-parse", "main"]).trim()
    const before = readFileSync(join(fx.root, ".infinite/install.json"), "utf8")
    const kept = await resetStaleReceipt({ root: fx.root, fs: nodeWizardFs, git, baseSha, runId: "f42a314e-0000-4000-8000-000000000004", home })
    expect(kept).toBe(join(home, "Library/Caches/infinite-tag/f42a314e-0000-4000-8000-000000000004/install.json.before-reset"))
    expect(readFileSync(kept!, "utf8")).toBe(before)
    expect(existsSync(join(fx.root, ".infinite/install.json"))).toBe(false)
    // NEGATIVE: nothing to reset (no receipt, or the base's own) → null, nothing moved.
    expect(await resetStaleReceipt({ root: fx.root, fs: nodeWizardFs, git, baseSha, runId: "r", home })).toBeNull()
    expect(sha256Tagged(before)).toMatch(/^sha256:/)
  })
})
