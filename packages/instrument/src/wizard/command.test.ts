import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { fakeDeps, fakeStepRecord, type StepBehaviour } from "../../test/wizard/runtime-fakes.js"
import { INSTRUMENT_VERSION } from "../package-manager.js"
import type { AskPayloads, PlanLine } from "./contracts/asks.js"
import type { WizardOptions } from "./contracts/deps.js"
import type { ChecklistItem } from "./contracts/jobs.js"
import type { WizardStepId } from "./contracts/steps.js"
import { acquireRunLock } from "./lock.js"
import { NOT_A_TTY_MESSAGE, WIZARD_NOT_BUILT_MESSAGE, parseWizardArgs, routeWizard, runWizardCommand } from "./command.js"
import type { WizardStore } from "./store.js"
import type { WizardIo, WizardWiring } from "./wiring.js"

const roots: string[] = []
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fakeIo(root: string, options: { tty?: boolean; env?: Record<string, string> } = {}) {
  const out: string[] = []
  const err: string[] = []
  const io: WizardIo = {
    stdin: { isTTY: options.tty ?? false },
    stdout: { isTTY: options.tty ?? false, columns: 120, write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    env: options.env ?? {},
    platform: "darwin",
    cwd: () => root,
    exit: () => {}
  }
  const events = () =>
    out
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { t: string } & Record<string, unknown>)
  return { io, out, err, events }
}

interface WiringSpy {
  wiring: WizardWiring
  createdWith: Array<{ options: WizardOptions }>
  bundle: ReturnType<typeof fakeDeps>
}

/** A wiring of fakes; the fake UI answers each opened ask with `answer(kind, payload)`. */
function fakeWiring(
  steps: Partial<Record<WizardStepId, StepBehaviour>>,
  answer: (kind: string, payload: unknown) => unknown = () => "__cancelled__",
  ran: string[] = []
): WiringSpy {
  const bundle = fakeDeps()
  const createdWith: Array<{ options: WizardOptions }> = []
  const wiring: WizardWiring = {
    async createDeps(input) {
      createdWith.push({ options: input.options })
      bundle.deps.tagVersion = input.tagVersion
      return bundle.deps
    },
    createUi(_kind, store: WizardStore) {
      let off: (() => void) | null = null
      return {
        start() {
          off = store.subscribe(() => {
            const pending = store.getSnapshot().pendingAsk
            if (pending) queueMicrotask(() => store.answerAsk(pending.askId, answer(pending.kind, pending.payload)))
          })
        },
        stop() {
          off?.()
        }
      }
    },
    ttyPrompter: () => null,
    engine: { steps: fakeStepRecord(steps, ran), afterStep: async () => {} }
  }
  return { wiring, createdWith, bundle }
}

describe("routing and flags", () => {
  it("not a TTY without --json → the 'needs an interactive terminal' line and exit 2 (nothing runs)", async () => {
    const root = tempDir("wizard-cmd-")
    const { io, err } = fakeIo(root)
    const spy = fakeWiring({})
    expect(await runWizardCommand([], { io, wiring: spy.wiring })).toBe(2)
    expect(err.join("")).toContain(NOT_A_TTY_MESSAGE)
    expect(spy.createdWith).toEqual([])
  })

  it("routes TTY → tty UI, --json → json UI, and a nesting marker with no TTY → nested (which needs --json)", () => {
    const tty = { stdin: { isTTY: true }, stdout: { isTTY: true, write() {} }, env: {} }
    const pipe = { stdin: { isTTY: false }, stdout: { isTTY: false, write() {} }, env: {} }
    const nested = { ...pipe, env: { CLAUDECODE: "1" } }
    expect(routeWizard({ json: false }, tty)).toEqual({ kind: "tty" })
    expect(routeWizard({ json: true }, pipe)).toEqual({ kind: "json", nested: false })
    expect(routeWizard({ json: true }, nested)).toEqual({ kind: "json", nested: true })
    expect(routeWizard({ json: false }, nested)).toMatchObject({ kind: "refuse" })
    // A marker inside a real terminal is a human who happens to run in an agent's shell: not nested.
    expect(routeWizard({ json: false }, { ...tty, env: { CODEX_SANDBOX: "seatbelt" } })).toEqual({ kind: "tty" })
  })

  it("parses every flag and rejects bad ones (usage, exit 2)", async () => {
    const parsed = parseWizardArgs(
      ["--json", "--yes", "--answers", "a.json", "--root", "site", "--app-root", "apps/web", "--resume", "--worker", "codex", "--reviewer", "brief", "--consent-mode", "required", "--no-prove"],
      "/home/me"
    )
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        root: "/home/me/site",
        appRoot: "apps/web",
        options: { json: true, yes: true, answersFile: "/home/me/a.json", resume: true, worker: "codex", reviewer: "brief", consentMode: "required", noProve: true, nested: false }
      }
    })
    expect(parseWizardArgs(["--consent-mode", "maybe"], "/r")).toMatchObject({ ok: false })
    expect(parseWizardArgs(["--app-root", "../elsewhere"], "/r")).toMatchObject({ ok: false })
    expect(parseWizardArgs(["--frobnicate"], "/r")).toMatchObject({ ok: false })
    const root = tempDir("wizard-cmd-")
    const { io, err } = fakeIo(root)
    expect(await runWizardCommand(["--json", "--frobnicate"], { io, wiring: fakeWiring({}).wiring })).toBe(2)
    expect(err.join("")).toContain("Unknown option")
  })

  it("an unwired build says so and exits 2 (never pretends the wizard ran)", async () => {
    const root = tempDir("wizard-cmd-")
    const { io, err } = fakeIo(root)
    expect(await runWizardCommand(["--json"], { io, wiring: null })).toBe(2)
    expect(err.join("")).toContain(WIZARD_NOT_BUILT_MESSAGE)
  })
})

describe("a --json run", () => {
  it("prints the resolved version in run.start, one NDJSON line per event, run.end last; exit 0", async () => {
    const root = tempDir("wizard-cmd-")
    const { io, events } = fakeIo(root)
    const ran: string[] = []
    const spy = fakeWiring({}, undefined, ran)
    expect(await runWizardCommand(["--json"], { io, wiring: spy.wiring })).toBe(0)
    const lines = events()
    expect(lines[0]).toMatchObject({ v: 1, t: "run.start", tagVersion: INSTRUMENT_VERSION, root })
    expect(lines.at(-1)).toMatchObject({ t: "run.end", exitCode: 0 })
    expect(ran).toHaveLength(13)
    expect(existsSync(join(root, ".infinite/wizard/run.lock"))).toBe(false)
    expect(spy.createdWith[0]!.options).toMatchObject({ json: true, nested: false })
  })

  it("a second concurrent run gets INF_WIZ_LOCKED (exit 2) and runs nothing", async () => {
    const root = tempDir("wizard-cmd-")
    const held = await acquireRunLock(root)
    if (!held.ok) throw new Error("expected the lock")
    const { io, err } = fakeIo(root)
    const ran: string[] = []
    expect(await runWizardCommand(["--json"], { io, wiring: fakeWiring({}, undefined, ran).wiring })).toBe(2)
    expect(err.join("")).toContain("Another infinite-tag run is using this repo")
    expect(ran).toEqual([])
    await held.handle.release()
  })

  it("a corrupt state file asks 'start fresh?': no → exit 3 and the file is untouched; yes → a fresh run, the old file kept", async () => {
    const root = tempDir("wizard-cmd-")
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(join(root, ".infinite/wizard/state.json"), "{ broken")
    const no = fakeIo(root)
    expect(await runWizardCommand(["--json"], { io: no.io, wiring: fakeWiring({}, () => false).wiring })).toBe(3)
    expect(readFileSync(join(root, ".infinite/wizard/state.json"), "utf8")).toBe("{ broken")

    const yes = fakeIo(root)
    expect(await runWizardCommand(["--json"], { io: yes.io, wiring: fakeWiring({}, (kind) => (kind === "confirm" ? true : "__cancelled__")).wiring })).toBe(0)
    expect(readdirSync(join(root, ".infinite/wizard")).some((name) => name.startsWith("state.json.corrupt-"))).toBe(true)
  })

  it("negative: --yes never answers 'start fresh?' (exit 3, file untouched)", async () => {
    const root = tempDir("wizard-cmd-")
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(join(root, ".infinite/wizard/state.json"), "{ broken")
    const { io } = fakeIo(root)
    expect(await runWizardCommand(["--json", "--yes"], { io, wiring: fakeWiring({}, () => true).wiring })).toBe(3)
    expect(readFileSync(join(root, ".infinite/wizard/state.json"), "utf8")).toBe("{ broken")
  })

  it("--yes with no --consent-mode parks at plan (exit 3) and never reaches install", async () => {
    const root = tempDir("wizard-cmd-")
    const { io } = fakeIo(root)
    const ran: string[] = []
    const spy = fakeWiring({ plan: consentPlanStep }, undefined, ran)
    expect(await runWizardCommand(["--json", "--yes"], { io, wiring: spy.wiring })).toBe(3)
    expect(ran.at(-1)).toBe("plan")
    expect(ran).not.toContain("install")
  })
})

// ---- nested mode, end to end on a real git repo ----

const CONSENT_LINE: PlanLine = { id: "consent", kind: "consent_mode", text: "Consent for this site", requires: "approval", editable: true }
const NAMES_LINE: PlanLine = { id: "names", kind: "conversion_names", text: "Conversion names", requires: "approval", editable: true }

/** A plan step that parks NEEDS_ANSWERS when the consent line is unanswered (as lane O7's does). */
const consentPlanStep: StepBehaviour = async (ctx) => {
  const payload: AskPayloads["plan"] = {
    lines: [CONSENT_LINE, NAMES_LINE],
    decisions: { consentMode: null, conversionNames: [], privacyText: null, npmInstall: null }
  }
  const answer = await ctx.ask("plan", payload)
  const consent = typeof answer === "object" && answer.approved.includes("consent") ? answer.edits.consent : undefined
  if (!consent) {
    return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "The consent mode is not answered.", resumeHint: "Run npx infinite-tag --resume in your own terminal to answer it." }
  }
  return { kind: "ok", status: `consent ${consent}` }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
}

function gitRepo(): string {
  const root = tempDir("wizard-nested-")
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  mkdirSync(join(root, "app/api/signup"), { recursive: true })
  writeFileSync(join(root, "app/api/signup/route.ts"), "export async function POST() {\n  return Response.json({ ok: true })\n}\n")
  writeFileSync(join(root, "app/layout.tsx"), "export default function Layout({ children }) {\n  return children\n}\n")
  writeFileSync(join(root, "README.md"), "# Acme\n")
  writeFileSync(join(root, ".gitignore"), ".infinite/wizard/\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "init")
  return root
}

const SIGNUP_ITEM: ChecklistItem = {
  id: "server_conversions:signup",
  jobId: "server_conversions",
  n: 8,
  title: "Report conversions from the server",
  owner: "agent",
  trigger: { finding: "signup route", evidence: [{ file: "app/api/signup/route.ts", line: 1 }] },
  allow: { files: ["app/api/signup/route.ts"], create: [] },
  checks: [],
  state: "pending"
}
const LAYOUT_ITEM: ChecklistItem = {
  ...SIGNUP_ITEM,
  id: "identify_reset:layout",
  jobId: "identify_reset",
  n: 9,
  title: "Join visits to accounts",
  allow: { files: ["app/layout.tsx"], create: [] }
}

/** `before` seeds two agent jobs into the state, as lane O8's does. */
const seedJobs: StepBehaviour = async (ctx) => {
  ctx.state.update((state) => {
    state.runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    state.jobs = [SIGNUP_ITEM, LAYOUT_ITEM]
  })
  return { kind: "ok", status: "seeded" }
}

describe("nested-agent mode (§3d.7)", () => {
  it("spawns no agent, hands the jobs out as job.seeded with a brief and parks (exit 3); --resume fences the parent agent's edits", async () => {
    const root = gitRepo()
    const home = tempDir("wizard-home-")
    const env = { CLAUDECODE: "1", HOME: home }
    const first = fakeIo(root, { env })
    const spy = fakeWiring({ before: seedJobs })
    spy.bundle.deps.env = env
    spy.bundle.deps.fs = (await import("./fs.js")).nodeWizardFs
    expect(await runWizardCommand(["--json"], { io: first.io, wiring: spy.wiring })).toBe(3)
    expect(spy.createdWith[0]!.options.nested).toBe(true)
    expect(spy.bundle.log.names("agents")).not.toContain("agents.runJobs")
    const seeded = first.events().filter((event) => event.t === "job.seeded")
    expect(seeded.map((event) => (event.item as ChecklistItem).id)).toEqual([SIGNUP_ITEM.id, LAYOUT_ITEM.id])
    expect(readFileSync(join(root, ".infinite/wizard/nested-brief.md"), "utf8")).toContain("server_conversions:signup")
    const state = JSON.parse(readFileSync(join(root, ".infinite/wizard/state.json"), "utf8"))
    expect(state.snapshot.dir.startsWith(join(home, "Library/Caches/infinite-tag/snapshots"))).toBe(true)
    expect(state.snapshot.dir.startsWith(root)).toBe(false)

    // The parent agent does the jobs — and also edits a file no job allows, and a consent call.
    writeFileSync(join(root, "app/api/signup/route.ts"), "export async function POST() {\n  await reportInfiniteOutcome({ type: 'signup', path: '/signup', eventId: 'acct' })\n  return Response.json({ ok: true })\n}\n")
    writeFileSync(join(root, "README.md"), "# Acme\n\nanalytics by infinite\n")
    writeFileSync(join(root, "app/layout.tsx"), "export default function Layout({ children }) {\n  gtag('consent', 'update', { analytics_storage: 'granted' })\n  return children\n}\n")

    const second = fakeIo(root, { env })
    const resumed = fakeWiring({ before: seedJobs })
    resumed.bundle.deps.env = env
    resumed.bundle.deps.fs = spy.bundle.deps.fs
    // Same deps behaviour, but stage through real git so the index is what we assert.
    resumed.bundle.deps.git = { ...resumed.bundle.deps.git, stage: async (paths) => void git(root, "add", "--", ...paths) }
    expect(await runWizardCommand(["--resume", "--json"], { io: second.io, wiring: resumed.wiring })).toBe(0)

    const staged = git(root, "diff", "--cached", "--name-only").trim().split("\n")
    expect(staged).toEqual(["app/api/signup/route.ts"])
    const unstaged = git(root, "diff", "--name-only").trim().split("\n").sort()
    expect(unstaged).toEqual(["README.md", "app/layout.tsx"])
    const subs = second.events().filter((event) => event.t === "step.sub").map((event) => event.text as string)
    expect(subs).toContain("Left unstaged (outside the jobs' files): README.md")
    const jobStates = Object.fromEntries(second.events().filter((event) => event.t === "job.state").map((event) => [event.itemId, event.state]))
    expect(jobStates).toEqual({ [SIGNUP_ITEM.id]: "done_in_code", [LAYOUT_ITEM.id]: "blocked" })
    const final = JSON.parse(readFileSync(join(root, ".infinite/wizard/state.json"), "utf8"))
    expect(final.jobs.find((item: ChecklistItem) => item.id === LAYOUT_ITEM.id).blockedReason).toBe("consent_touched")
    expect(resumed.bundle.log.names("checks")).toContain("checks.turnGate")
    expect(resumed.bundle.log.names("agents")).not.toContain("agents.runJobs")
  })

  it("an answers file carrying consentMode / conversion names is ignored in nested mode and, with no /dev/tty, the run parks NEEDS_ANSWERS", async () => {
    const root = tempDir("wizard-cmd-")
    const answersPath = join(root, "answers.json")
    writeFileSync(answersPath, JSON.stringify({ v: 1, consentMode: "not_required", conversionNames: ["signup"] }))
    const { io } = fakeIo(root, { env: { CODEX_THREAD_ID: "t-1" } })
    const ran: string[] = []
    expect(await runWizardCommand(["--json", "--answers", answersPath], { io, wiring: fakeWiring({ plan: consentPlanStep }, undefined, ran).wiring })).toBe(3)
    expect(ran.at(-1)).toBe("plan")
  })

  it("negative: the same answers file outside nested mode IS applied and the run goes on", async () => {
    const root = tempDir("wizard-cmd-")
    const answersPath = join(root, "answers.json")
    writeFileSync(answersPath, JSON.stringify({ v: 1, consentMode: "not_required", conversionNames: ["signup"] }))
    const { io } = fakeIo(root)
    const ran: string[] = []
    expect(await runWizardCommand(["--json", "--answers", answersPath], { io, wiring: fakeWiring({ plan: consentPlanStep }, undefined, ran).wiring })).toBe(0)
    expect(ran).toContain("install")
  })

  it("nested without --json is refused (exit 2)", async () => {
    const root = tempDir("wizard-cmd-")
    const { io, err } = fakeIo(root, { env: { AI_AGENT: "1" } })
    expect(await runWizardCommand([], { io, wiring: fakeWiring({}).wiring })).toBe(2)
    expect(err.join("")).toContain("--json")
  })
})

