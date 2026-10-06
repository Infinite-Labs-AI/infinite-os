// `npx infinite-tag` (and `npx infinite-tag wizard …`, and any flag-first argv such as
// `npx infinite-tag --json`): the setup wizard's entry point. Also `npx infinite-tag uninstall --pr`.
//
// Routing:
// - a TTY → the TTY UI;
// - not a TTY with `--json` → the JSON UI (NDJSON events on stdout, `ask.answer` lines on stdin);
// - not a TTY without `--json` → "needs an interactive terminal; agents use --json; CI uses doctor or
//   harness", exit 2;
// - launched by an agent (a nesting marker is set) with no TTY → nested mode (§3d.7): `--json` required, no
//   agent spawned, the jobs go to the parent agent, user-only asks stay human.
// The run holds `.infinite/wizard/run.lock`; SIGINT/SIGTERM aborts, kills the agent tree, restores the
// fence snapshot, releases the lock and exits 130.
import { promises as fsp } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import { INSTRUMENT_VERSION } from "../package-manager.js"
import { NESTING_ENV_MARKERS } from "./contracts/agents.js"
import { WIZARD_EXIT, exitCodeFor, type WizardCode } from "./contracts/codes.js"
import type { RunStateAccessor, WizardContext, WizardDeps, WizardOptions } from "./contracts/deps.js"
import type { ReportV2 } from "./contracts/report.js"
import type { WizardRunState, WizardStoreSnapshot } from "./contracts/state.js"
import type { WizardStepId } from "./contracts/steps.js"
import { createWizardAsks, readAnswersFile, type AnswersFile, type TtyPrompter } from "./asks.js"
import { openDevTtyPrompter } from "./dev-tty.js"
import { rebuildFromPrMarker } from "./fresh-machine.js"
import { EngineInvariantError, runWizard } from "./engine.js"
import { WizardEventEmitter } from "./events.js"
import { nodeWizardFs, systemClock } from "./fs.js"
import { acquireRunLock, type RunLockHandle } from "./lock.js"
import { renderTerminal } from "./report.js"
import { RunStateFile, WIZARD_REPORT_PATHS, createRunState, firstOpenStep, loadRunState, setStateAside, stateFilePath } from "./run-state.js"
import { WIZARD_PATHS } from "./contracts/state.js"
import { installInterruptHandlers, runInterruptSequence, type SignalSource } from "./signals.js"
import { WizardStore } from "./store.js"
import { WIZARD_STEPS } from "./steps/index.js"
import { hostRefusalLine, parseHostInput } from "./site-host.js"
import { discardCommand, discardLeftovers, dirtyTreeMessage, findLeftovers } from "./leftovers.js"
import { wizardGitExtras } from "../git/index.js"
import { runUninstallFlow, type UninstallLinkFn } from "./uninstall-flow.js"
import { getWizardWiring, type WizardIo, type WizardWiring } from "./wiring.js"
import { sanitizeUntrusted } from "../agents/sanitize.js"

export const WIZARD_NOT_BUILT_MESSAGE =
  "The infinite-tag setup wizard is not built yet in this build (its parts are not wired together). Use `npx infinite-tag harness` or `npx infinite-tag install` for now."

export const NOT_A_TTY_MESSAGE =
  "infinite-tag needs an interactive terminal. Agents run it with --json; CI uses `infinite-tag doctor` or `infinite-tag harness`."

export const WIZARD_USAGE = [
  "Usage: npx infinite-tag [--json] [--yes] [--answers <file>] [--root <dir>] [--app-root <dir>] [--resume]",
  "                        [--no-agent] [--worker claude|codex] [--reviewer claude|codex|brief|none]",
  "                        [--consent-mode not_required|required] [--production-host <domain>] [--no-prove] [--fresh] [--relink]",
  "       npx infinite-tag uninstall --pr [--json] [--root <dir>] [--base <branch>] [--answers <file>]"
].join("\n")

export function processIo(): WizardIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    // Through console.error like the rest of the CLI (one line per message).
    stderr: { write: (text: string) => console.error(text.replace(/\n$/, "")) },
    env: process.env,
    platform: process.platform,
    cwd: () => process.cwd(),
    exit: (code) => process.exit(code)
  }
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

export interface ParsedWizardArgs {
  options: WizardOptions
  root: string
  /** Repo-relative ("." for a single-app repo). */
  appRoot: string
  /** `--fresh`: set an unfinished run aside (kept, never deleted) and start a new one. */
  fresh: boolean
}

type Parse<T> = { ok: true; value: T } | { ok: false; message: string }

const ENUMS = {
  "--worker": ["claude", "codex"],
  "--reviewer": ["claude", "codex", "brief", "none"],
  "--consent-mode": ["not_required", "required"]
} as const

function resolveAppRoot(root: string, value: string): Parse<string> {
  const absolute = isAbsolute(value) ? value : resolve(root, value)
  const rel = relative(root, absolute) || "."
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, message: `--app-root must be inside the repo (${value}).` }
  return { ok: true, value: rel.split("\\").join("/") }
}

export function parseWizardArgs(argv: readonly string[], cwd: string): Parse<ParsedWizardArgs> {
  const options: WizardOptions = {
    json: false,
    yes: false,
    answersFile: null,
    resume: false,
    noAgent: false,
    worker: null,
    reviewer: null,
    consentMode: null,
    noProve: false,
    nested: false
  }
  let rootArg: string | null = null
  let appRootArg: string | null = null
  let fresh = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!
    const value = (): string | null => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) return null
      index += 1
      return next
    }
    switch (flag) {
      case "--json":
        options.json = true
        break
      case "--yes":
      case "-y":
        options.yes = true
        break
      case "--resume":
        options.resume = true
        break
      case "--no-agent":
        options.noAgent = true
        break
      case "--no-prove":
        options.noProve = true
        break
      case "--fresh":
        fresh = true
        break
      case "--relink":
        // §3x.8: a new link needs a new run (the old one belongs to the old workspace).
        options.relink = true
        fresh = true
        break
      case "--answers": {
        const file = value()
        if (!file) return { ok: false, message: "--answers needs a file." }
        options.answersFile = resolve(cwd, file)
        break
      }
      case "--root": {
        const dir = value()
        if (!dir) return { ok: false, message: "--root needs a directory." }
        rootArg = dir
        break
      }
      case "--app-root": {
        const dir = value()
        if (!dir) return { ok: false, message: "--app-root needs a directory." }
        appRootArg = dir
        break
      }
      case "--production-host": {
        // §3y.1: validated like the typed answer; a malformed or preview-shaped host is a usage error (exit 2).
        const raw = value()
        if (!raw) return { ok: false, message: "--production-host needs your live site's domain (for example acme.com)." }
        const parsed = parseHostInput(raw)
        if (!parsed.ok) return { ok: false, message: `--production-host: ${hostRefusalLine(parsed, "final").replace(/^! /, "")}` }
        options.productionHost = parsed.host
        break
      }
      case "--worker":
      case "--reviewer":
      case "--consent-mode": {
        const choice = value()
        const allowed: readonly string[] = ENUMS[flag]
        if (!choice || !allowed.includes(choice)) return { ok: false, message: `${flag} must be one of ${allowed.join(", ")}.` }
        if (flag === "--worker") options.worker = choice as WizardOptions["worker"]
        else if (flag === "--reviewer") options.reviewer = choice as WizardOptions["reviewer"]
        else options.consentMode = choice as WizardOptions["consentMode"]
        break
      }
      default:
        return { ok: false, message: `Unknown option ${JSON.stringify(flag)}.` }
    }
  }
  if (options.noAgent && options.worker) return { ok: false, message: "--no-agent and --worker cannot be used together." }
  if (fresh && options.resume) return { ok: false, message: "--fresh and --resume cannot be used together." }
  const root = resolve(cwd, rootArg ?? ".")
  const appRoot = appRootArg === null ? { ok: true as const, value: "." } : resolveAppRoot(root, appRootArg)
  if (!appRoot.ok) return appRoot
  return { ok: true, value: { options, root, appRoot: appRoot.value, fresh } }
}

/** The nesting marker that is set (an agent launched the wizard), if any. */
export function nestingMarker(env: Readonly<Record<string, string | undefined>>): string | null {
  return NESTING_ENV_MARKERS.find((marker) => env[marker] !== undefined && env[marker] !== "") ?? null
}

export type WizardRoute = { kind: "tty" } | { kind: "json"; nested: boolean } | { kind: "refuse"; message: string }

/** TTY / JSON / nested routing (pure). */
export function routeWizard(options: Pick<WizardOptions, "json">, io: Pick<WizardIo, "stdin" | "stdout" | "env">): WizardRoute {
  const tty = Boolean(io.stdin.isTTY && io.stdout.isTTY)
  const marker = nestingMarker(io.env)
  if (marker && !tty) {
    if (!options.json) {
      return { kind: "refuse", message: `infinite-tag was started by an agent (${marker} is set). Run it with --json: npx infinite-tag --json` }
    }
    return { kind: "json", nested: true }
  }
  if (tty) return options.json ? { kind: "json", nested: false } : { kind: "tty" }
  if (!options.json) return { kind: "refuse", message: NOT_A_TTY_MESSAGE }
  return { kind: "json", nested: false }
}

// ---------------------------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------------------------

/**
 * The final report, but ONLY when it is this run's: the state's `done` step finished ok in this run and
 * the report carries this run's id. A previous run's report is never shown as this run's outro or
 * `run.end.reportPath` ("verified/proven only with a receipt from THIS run").
 */
async function readFinalReport(root: string, state: Readonly<WizardRunState> | null): Promise<ReportV2 | null> {
  if (!state?.runId || state.steps.done?.outcome !== "ok") return null
  try {
    const report = JSON.parse(await fsp.readFile(join(root, WIZARD_REPORT_PATHS.json), "utf8")) as ReportV2
    return report.runId === state.runId ? report : null
  } catch {
    return null
  }
}

export const NESTED_CONSENT_FLAG_MESSAGE =
  "--consent-mode is your answer, not your agent's: run npx infinite-tag in your own terminal to choose it (the agent can run the rest with --json)."

export interface RunWizardCommandOverrides {
  io?: WizardIo
  wiring?: WizardWiring | null
  /** Where SIGINT/SIGTERM come from (default the process; tests pass a fake). */
  signals?: SignalSource
}

export async function runWizardCommand(argv: readonly string[], overrides: RunWizardCommandOverrides = {}): Promise<number> {
  const io = overrides.io ?? processIo()
  const parsed = parseWizardArgs(argv, io.cwd())
  if (!parsed.ok) {
    io.stderr.write(`${parsed.message}\n${WIZARD_USAGE}\n`)
    return WIZARD_EXIT.usage
  }
  const { root, appRoot, fresh } = parsed.value
  const options = { ...parsed.value.options }
  const route = routeWizard(options, io)
  if (route.kind === "refuse") {
    io.stderr.write(`${route.message}\n`)
    return WIZARD_EXIT.usage
  }
  options.nested = route.kind === "json" && route.nested
  // §3d.7 / R2-14: consent is a user-only answer. In nested mode the flag would be the PARENT AGENT's
  // answer (the plan step resolves consent from it), so it is refused, never passed on.
  if (options.nested && options.consentMode !== null) {
    io.stderr.write(`${NESTED_CONSENT_FLAG_MESSAGE}\n`)
    return WIZARD_EXIT.usage
  }
  const wiring = overrides.wiring === undefined ? getWizardWiring() : overrides.wiring
  if (!wiring) {
    io.stderr.write(`${WIZARD_NOT_BUILT_MESSAGE}\n`)
    return exitCodeFor("INF_WIZ_NOT_BUILT")
  }
  let answers: AnswersFile | null = null
  if (options.answersFile) {
    try {
      answers = readAnswersFile(options.answersFile)
    } catch (error) {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return WIZARD_EXIT.usage
    }
  }

  const lock = await acquireRunLock(root)
  if (!lock.ok) {
    const holder = lock.holder ? ` (pid ${lock.holder.pid} on ${lock.holder.hostname}, since ${lock.holder.startedAt})` : ""
    io.stderr.write(`INF_WIZ_LOCKED: Another infinite-tag run is using this repo${holder}. Wait for it, or remove ${lock.path} if it is gone.\n`)
    return exitCodeFor("INF_WIZ_LOCKED")
  }
  return runLocked({ io, wiring, options, root, appRoot, fresh, answers, lock: lock.handle, signals: overrides.signals ?? process })
}

interface LockedRun {
  io: WizardIo
  wiring: WizardWiring
  options: WizardOptions
  root: string
  appRoot: string
  fresh: boolean
  answers: AnswersFile | null
  lock: RunLockHandle
  signals: SignalSource
}

/** Whether the closing screen waits for a key: an interactive terminal on both ends, and not `--json`. */
export function closingScreenWaits(options: Pick<WizardOptions, "json">, io: Pick<WizardIo, "stdin" | "stdout">): boolean {
  return !options.json && io.stdin.isTTY === true && io.stdout.isTTY === true
}

/**
 * The width the closing text is laid out for: the frame keeps one column each side, so the text is two columns
 * narrower than the terminal and no line of it is cut on screen. Unknown or 0 columns → the frame's 80.
 */
export function outroWidth(columns: number | undefined): number {
  const usable = typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? columns : 80
  return Math.max(20, usable - 2)
}

/** What the Learn cards may name, from the run state: the repo folder, the linked workspace and the two agents. */
export function learnFactsFrom(state: Readonly<WizardRunState>, root: string): NonNullable<WizardStoreSnapshot["learnFacts"]> {
  return {
    site: basename(root) || null,
    workspace: state.link?.workspaceName ?? null,
    worker: state.agent?.worker ?? null,
    reviewer: state.agent?.reviewer ?? null
  }
}

/** A suffix for a run set aside: its run id (or display id) plus why. */
function asideSuffix(state: Pick<WizardRunState, "runId" | "displayId">, why: string): string {
  return `${state.runId ?? state.displayId}.${why}`
}

async function runLocked(input: LockedRun): Promise<number> {
  const { io, wiring, options, root, appRoot, fresh, answers, lock, signals } = input
  const controller = new AbortController()
  const loaded = await loadRunState(nodeWizardFs, root)
  const existing = loaded.kind === "ok" ? loaded.state : null
  const store = new WizardStore({ displayId: existing?.displayId ?? "r-····", tagVersion: INSTRUMENT_VERSION })
  let runState: RunStateFile | null = null
  const emitter = new WizardEventEmitter({
    store,
    ndjson: options.json ? (line) => io.stdout.write(`${line}\n`) : null,
    // After each step the Learn cards may name what the run now knows (the workspace, the two agents).
    onEvent: (event) => {
      if (event.t === "step.done" && runState) store.setLearnFacts(learnFactsFrom(runState.get(), root))
    }
  })
  const ui = wiring.createUi(options.json ? "json" : "tty", store, io)
  let ttyPrompter: TtyPrompter | null = null
  let deps: WizardDeps | null = null
  /** True when this process created the state file (not a loaded or rebuilt run). */
  let freshState = false
  /**
   * Final verify F21: why a crashed run stopped. Written only once the UI has given the terminal back: written
   * while the TTY UI still held the alternate screen, it vanished with that screen and the user kept only
   * "failed" (the reason is the last thing they need).
   */
  let crashReason: string | null = null
  let preEngineStop: { code: WizardCode; reason: string } | null = null
  const deferredNotices: string[] = []
  const deferNotice = (text: string): void => { deferredNotices.push(text.endsWith("\n") ? text : `${text}\n`) }
  const deferredIo: WizardIo = { ...io, stderr: { write: deferNotice } }
  const writeCrashReason = () => {
    if (crashReason === null) return
    io.stderr.write(crashReason)
    crashReason = null
  }

  // Every way out releases the lock exactly once, and only AFTER the agent tree is killed and the fence
  // snapshot is restored: `finish` is the sequence's lock-release stage, never called before it.
  let finished: Promise<number> | null = null
  let interrupt: Promise<void> | null = null
  const finish = (exitCode: number): Promise<number> =>
    (finished ??= (async () => {
      const state = runState?.get() ?? null
      const report = await readFinalReport(root, state)
      const reportPath = report ? WIZARD_REPORT_PATHS.markdown : null
      emitter.emit("run.end", {
        exitCode,
        runId: state?.runId ?? null,
        ...(state?.pr?.url ? { prUrl: state.pr.url } : {}),
        reportPath
      })
      if (preEngineStop && store.getSnapshot().exit) store.setExit({ ...store.getSnapshot().exit!, ...preEngineStop })
      if (report) {
        const startedAt = Date.parse(state?.createdAt ?? "")
        store.setOutro(
          renderTerminal(report, outroWidth(io.stdout.columns), {
            displayId: state?.displayId ?? null,
            durationMs: Number.isFinite(startedAt) ? Math.max(0, systemClock.now().getTime() - startedAt) : null
          })
        )
      }
      emitter.dispose()
      // Final verify F5: in a terminal the closing screen (the verdict and the before/after table) stays up until
      // the user presses a key; it used to close in the same tick, so nobody saw it. Never under `--json`, never
      // without a TTY, never after a signal. The run is over, so the lock goes first: a closing screen left open
      // never blocks another run in this repo. A signal while it waits ends the wait (the abort), then the
      // interrupt sequence carries on as usual.
      const waitForDismiss = ui.waitForDismiss?.bind(ui)
      if (report && waitForDismiss && closingScreenWaits(options, io) && !interrupt && exitCode !== WIZARD_EXIT.interrupted && !controller.signal.aborted) {
        await lock.release()
        await Promise.race([
          waitForDismiss(),
          new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }))
        ])
      }
      ui.stop()
      writeCrashReason()
      if (preEngineStop && options.json) io.stderr.write(`${preEngineStop.code}: ${sanitizeUntrusted(preEngineStop.reason, 2_000)}\n`)
      for (const line of deferredNotices) io.stderr.write(line)
      deferredNotices.length = 0
      removeHandlers()
      ttyPrompter?.close()
      await lock.release()
      // Review I1 P3-2: a run that never got past `link` (no app, the wrong folder, not a repo) leaves nothing
      // behind in the customer's folder: the fresh state file it wrote, and the wizard dirs if now empty.
      if (runState && freshState && !runState.get().link && runState.get().steps.link?.outcome !== "ok") await removeUnlinkedState(root, runState)
      return exitCode
    })())
  /** abort → kill the agents → fence abort → finish (lock release) → exit, for a signal or a crash. */
  const stopAndFinish = (exitCode: number, exit: (code: number) => void): Promise<void> =>
    runInterruptSequence({
      abort: () => controller.abort(new Error(exitCode === WIZARD_EXIT.interrupted ? "interrupted" : "stopped")),
      killAgents: async () => {
        if (deps) await deps.agents.killAll()
      },
      ...(wiring.fenceAbort ? { fenceAbort: () => wiring.fenceAbort!() } : {}),
      releaseLock: async () => {
        await finish(exitCode)
      },
      exit,
      notice: deferNotice
    })
  const removeHandlers = installInterruptHandlers({
    abort: () => controller.abort(new Error("interrupted")),
    killAgents: async () => {
      if (deps) await deps.agents.killAll()
    },
    ...(wiring.fenceAbort ? { fenceAbort: () => wiring.fenceAbort!() } : {}),
    releaseLock: async () => {
      await finish(WIZARD_EXIT.interrupted)
    },
    exit: (code) => io.exit(code),
    notice: deferNotice,
    started: (sequence) => {
      interrupt = sequence
    }
  }, signals)
  /** The normal way out; after a signal it waits for the whole interrupt sequence instead. */
  const end = async (exitCode: number): Promise<number> => {
    if (interrupt) {
      await interrupt
      return WIZARD_EXIT.interrupted
    }
    return finish(exitCode)
  }
  const stopBeforeEngine = (code: WizardCode, reason: string): Promise<number> => {
    preEngineStop = { code, reason: reason.trim() }
    return end(exitCodeFor(code))
  }

  ui.start(store)
  try {
    if (options.nested) ttyPrompter = wiring.ttyPrompter ? wiring.ttyPrompter() : openDevTtyPrompter()
    const asks = createWizardAsks({ store, emitter, options, answers, ttyPrompter, signal: controller.signal })
    const newState = () => createRunState({ tagVersion: INSTRUMENT_VERSION, root, appRoot, now: systemClock.now() })

    // The run state: resume, start fresh, or ask (a corrupt file is never silently reset).
    let state: WizardRunState
    let resuming = false
    /** §3y.8: the unfinished run `--fresh` set aside (its leftovers and its cloud run are handled below). */
    let setAside: WizardRunState | null = null
    if (loaded.kind === "corrupt") {
      const yes = await asks.askUserOnly("confirm", {
        question: `The saved run (${loaded.path}) cannot be read (${loaded.problems[0] ?? "corrupt"}). Start a fresh run? The old file is kept beside it.`,
        defaultYes: false
      })
      if (yes !== true) {
        return await stopBeforeEngine("INF_WIZ_NEEDS_ANSWERS", "Not started: fix or move .infinite/wizard/state.json, or answer yes to start fresh.")
      }
      await setStateAside(root, `corrupt-${Date.now()}`)
      state = newState()
    } else if (loaded.kind === "ok" && loaded.state.steps.done?.outcome !== "ok" && !fresh) {
      state = loaded.state
      resuming = true
    } else {
      if (loaded.kind === "ok") {
        await setStateAside(root, asideSuffix(loaded.state, loaded.state.steps.done?.outcome === "ok" ? "done" : `set-aside-${Date.now()}`))
        if (loaded.state.steps.done?.outcome !== "ok") setAside = loaded.state
      }
      state = newState()
    }
    // A set-aside run is no longer this run, even when the new run stops before the engine starts.
    store.setRun({ displayId: state.displayId, runId: state.runId })

    const createDeps = (forState: WizardRunState) =>
      wiring.createDeps({
        root,
        appRoot: forState.appRoot,
        options,
        env: io.env,
        platform: io.platform,
        tagVersion: INSTRUMENT_VERSION,
        signal: controller.signal,
        // The engine's in-memory state once it exists (the loaded state until then).
        state: () => runState?.get() ?? forState
      })
    deps = await createDeps(state)

    // §3y.8 (P2-4, P3-11): `--fresh` offers to discard the set-aside run's OWN unfinished edits (never anyone
    // else's), then marks its cloud run abandoned so no run is left open at `before`.
    if (setAside) {
      const stopped = await freshStart({ root, deps, ask: asks.ask, io: deferredIo, old: setAside })
      if (stopped !== null) return await stopBeforeEngine("INF_WIZ_DIRTY_TREE", deferredNotices.pop() ?? "The prior run's changes could not be discarded safely.")
      await abandonRun(deps, setAside, deferredIo)
    }

    // §3d.6 / §3z.5 (B25): no state file here (a fresh clone, a teammate's machine) → an OPEN wizard PR's
    // marker names the run; the minimal state is rebuilt from it and `link` checks the run with `runs.get`.
    if (loaded.kind === "none" && !fresh && !options.nested) {
      const rebuilt = await rebuildFromPrMarker(state, deps.host)
      if (rebuilt) {
        resuming = true
        deferNotice(`Resuming the run of pull request #${rebuilt.prNumber} (${rebuilt.branch}) from its marker. To start over instead: npx infinite-tag --fresh`)
      }
    }
    if (!resuming && options.resume) deferNotice("There is no unfinished run to resume here; starting a fresh one.")

    // §3d.6: a resumed run whose pull request was CLOSED (not merged) cannot go on; offer a fresh run.
    // A merged PR resumes at `merge`, which records the merge commit and hands over to `prove`.
    let resumeAt: WizardStepId | null = null
    if (resuming && state.pr?.number !== undefined && state.pr.number !== null) {
      const pr = await deps.host.readPr(state.pr.number)
      if (!("unsupported" in pr) && pr.state === "MERGED") resumeAt = "merge"
      if (!("unsupported" in pr) && pr.state === "CLOSED") {
        const yes = await asks.askUserOnly("confirm", {
          question: `The pull request #${pr.number} of this run was closed without merging. Start a fresh run? The closed run is kept aside.`,
          defaultYes: false
        })
        if (yes !== true) {
          return await stopBeforeEngine("INF_WIZ_NEEDS_ANSWERS", `Not resumed: the pull request #${pr.number} is closed. Reopen it and run again, or run npx infinite-tag --fresh.`)
        }
        await setStateAside(root, asideSuffix(state, "pr-closed"))
        await abandonRun(deps, state, deferredIo)
        const previousAppRoot = state.appRoot
        state = newState()
        resuming = false
        if (state.appRoot !== previousAppRoot) deps = await createDeps(state)
      }
    }

    store.setRun({ displayId: state.displayId, runId: state.runId })
    freshState = !resuming && loaded.kind !== "ok"
    runState = new RunStateFile(nodeWizardFs, root, state)
    await runState.save()
    const accessor = runState

    const ctx: WizardContext = {
      get runId() {
        return accessor.get().runId
      },
      // A step that sets the run id (`agent`) writes it into the state; the state stays the one source.
      set runId(value: string | null) {
        accessor.update((current) => {
          current.runId = value
        })
      },
      state: accessor,
      emit: emitter,
      ask: asks.ask,
      signal: controller.signal,
      options,
      root,
      appRoot: state.appRoot,
      now: () => deps!.clock.now()
    }
    const result = await runWizard(ctx, deps, {
      ...(wiring.engine ?? {}),
      ...(wiring.fenceAbort ? { fenceAbort: () => wiring.fenceAbort!() } : {}),
      resumedFrom: resumeAt ?? (resuming ? firstOpenStep(state) : null),
      resumeAt
    })
    return await end(result.exitCode)
  } catch (error) {
    if (interrupt) return end(WIZARD_EXIT.interrupted)
    const prefix = error instanceof EngineInvariantError ? "Internal error (the wizard stopped itself)" : "Internal error"
    crashReason = `${prefix}: ${error instanceof Error ? error.message : String(error)}\n`
    // A crash may leave an agent child mid-turn (an invariant fires exactly while one is alive): kill it
    // and restore the snapshot BEFORE the lock is released, as on Ctrl+C. `finish` writes the reason right
    // after the UI left the full screen; if it never got there (it was already done), write it now.
    try {
      await stopAndFinish(WIZARD_EXIT.failed, () => {})
    } finally {
      ui.stop()
      writeCrashReason()
    }
    return WIZARD_EXIT.failed
  }
}

/**
 * §3y.8: `--fresh` over the set-aside run's own leftovers. When EVERY blocking dirty path is the run's own edit (its
 * bytes still exactly what the run wrote) and the checked-out branch is the run's branch or its base, ONE confirm
 * (default yes; `--yes` never answers it): yes discards exactly those edits and switches to the base. Anyone else's
 * change refuses, naming only those paths. Returns an exit code to stop with, or null to go on.
 */
export async function freshStart(input: { root: string; deps: WizardDeps; ask: WizardContext["ask"]; io: WizardIo; old: WizardRunState }): Promise<number | null> {
  const { root, deps, io, old } = input
  const git = wizardGitExtras(deps.git)
  if (!git || !old.runId) return null
  const scan = await findLeftovers(root, nodeWizardFs, git, old.runId)
  if (scan.leftovers.length === 0 && !scan.gitignoreFence) return null
  if (scan.others.length > 0) {
    io.stderr.write(`${dirtyTreeMessage(scan.others)}\n`)
    return exitCodeFor("INF_WIZ_DIRTY_TREE")
  }
  const base = old.git?.base ?? null
  const current = await git.currentBranch()
  if (!base || (current !== old.git?.branch && current !== base)) {
    io.stderr.write(`${dirtyTreeMessage(scan.leftovers.map((entry) => entry.path))}\n`)
    return exitCodeFor("INF_WIZ_DIRTY_TREE")
  }
  const paths = scan.leftovers.map((entry) => entry.path)
  if (paths.length > 0) {
    const yes = await input.ask("confirm", {
      question: `Your last run (${old.displayId}) left its own unfinished changes, never committed: ${paths.join(", ")}. Discard them and start fresh?`,
      defaultYes: true
    })
    if (yes !== true) {
      io.stderr.write(`Not started: your last run's own changes are still there. To discard them yourself: ${discardCommand(scan, base)}\n`)
      return exitCodeFor("INF_WIZ_DIRTY_TREE")
    }
  }
  await discardLeftovers(root, nodeWizardFs, git, scan, old.runId)
  if (current !== base) await git.switchTo(base)
  return null
}

/** §3y.8 (P3-11): marks a set-aside run `abandoned` in Infinite (best effort: a refusal is one line, never a stop). */
export async function abandonRun(deps: WizardDeps, old: WizardRunState, io: WizardIo): Promise<void> {
  if (!old.runId || !old.link) return
  try {
    if (!deps.bridge.has("tag.runs.v1")) return
    deps.bridge.setLinkId(old.link.linkId)
    await deps.bridge.patchRun(old.runId, { phase: "abandoned" })
  } catch {
    io.stderr.write("The earlier run could not be marked abandoned in Infinite (it stays as it was); this run goes on.\n")
  } finally {
    try {
      deps.bridge.setLinkId(null)
    } catch {
      // No descriptor: nothing was set.
    }
  }
}

/** Removes a fresh, never-linked run's state file, then `.infinite/wizard` and `.infinite` when they are empty. */
async function removeUnlinkedState(root: string, runState: RunStateFile): Promise<void> {
  await runState.settled()
  await fsp.rm(stateFilePath(root), { force: true }).catch(() => undefined)
  for (const dir of [join(root, WIZARD_PATHS.dir), join(root, ".infinite")]) {
    // rmdir refuses a non-empty folder: anything else in it (an install receipt, a user file) stays.
    await fsp.rmdir(dir).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------------------------

export interface ParsedUninstallArgs {
  root: string
  json: boolean
  yes: boolean
  base: string | null
  answersFile: string | null
}

export function parseUninstallArgs(argv: readonly string[], cwd: string): Parse<ParsedUninstallArgs> {
  const out: ParsedUninstallArgs = { root: cwd, json: false, yes: false, base: null, answersFile: null }
  let sawPr = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!
    const value = (): string | null => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) return null
      index += 1
      return next
    }
    if (flag === "--pr") sawPr = true
    else if (flag === "--json") out.json = true
    else if (flag === "--yes" || flag === "-y") out.yes = true
    else if (flag === "--root" || flag === "--base" || flag === "--answers") {
      const given = value()
      if (!given) return { ok: false, message: `${flag} needs a value.` }
      if (flag === "--root") out.root = resolve(cwd, given)
      else if (flag === "--base") out.base = given
      else out.answersFile = resolve(cwd, given)
    } else return { ok: false, message: `Unknown option ${JSON.stringify(flag)}.` }
  }
  if (!sawPr) return { ok: false, message: "uninstall through the wizard needs --pr." }
  return { ok: true, value: out }
}

/** `npx infinite-tag uninstall --pr [flags…]`. */
export async function runWizardUninstall(argv: readonly string[], overrides: RunWizardCommandOverrides = {}): Promise<number> {
  const io = overrides.io ?? processIo()
  const parsed = parseUninstallArgs(argv, io.cwd())
  if (!parsed.ok) {
    io.stderr.write(`${parsed.message}\n${WIZARD_USAGE}\n`)
    return WIZARD_EXIT.usage
  }
  const args = parsed.value
  const options: WizardOptions = {
    json: args.json,
    yes: args.yes,
    answersFile: args.answersFile,
    resume: false,
    noAgent: true,
    worker: null,
    reviewer: null,
    consentMode: null,
    noProve: true,
    nested: false
  }
  const route = routeWizard(options, io)
  if (route.kind === "refuse") {
    io.stderr.write(`${route.message}\n`)
    return WIZARD_EXIT.usage
  }
  options.nested = route.kind === "json" && route.nested
  const wiring = overrides.wiring === undefined ? getWizardWiring() : overrides.wiring
  if (!wiring) {
    io.stderr.write(`${WIZARD_NOT_BUILT_MESSAGE}\n`)
    return exitCodeFor("INF_WIZ_NOT_BUILT")
  }
  let answers: AnswersFile | null = null
  if (args.answersFile) {
    try {
      answers = readAnswersFile(args.answersFile)
    } catch (error) {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return WIZARD_EXIT.usage
    }
  }
  const lock = await acquireRunLock(args.root)
  if (!lock.ok) {
    io.stderr.write(`INF_WIZ_LOCKED: Another infinite-tag run is using this repo. Wait for it, or remove ${lock.path} if it is gone.\n`)
    return exitCodeFor("INF_WIZ_LOCKED")
  }
  const loaded = await loadRunState(nodeWizardFs, args.root)
  const state = loaded.kind === "ok" ? loaded.state : null
  const store = new WizardStore({ displayId: state?.displayId ?? "r-····", tagVersion: INSTRUMENT_VERSION })
  const emitter = new WizardEventEmitter({ store, ndjson: options.json ? (line) => io.stdout.write(`${line}\n`) : null })
  const ui = wiring.createUi(options.json ? "json" : "tty", store, io)
  const controller = new AbortController()
  ui.start(store)
  const afterScreen: string[] = []
  let resultLines: string[] = []
  const ttyPrompter = options.nested ? (wiring.ttyPrompter ? wiring.ttyPrompter() : openDevTtyPrompter()) : null
  try {
    const asks = createWizardAsks({ store, emitter, options, answers, ttyPrompter, signal: controller.signal })
    const deps = await wiring.createDeps({
      root: args.root,
      appRoot: state?.appRoot ?? ".",
      options,
      env: io.env,
      platform: io.platform,
      tagVersion: INSTRUMENT_VERSION,
      signal: controller.signal,
      state: () => state
    })
    // No saved link (a fresh clone, a teammate's machine): run the `link` step on an in-memory state, so a
    // remembered site links at once and a new one shows the app's approval card.
    const link: UninstallLinkFn = async () => {
      let current = createRunState({ tagVersion: INSTRUMENT_VERSION, root: args.root, appRoot: state?.appRoot ?? ".", now: deps.clock.now() })
      const memory: RunStateAccessor = {
        get: () => current,
        update(mutate) {
          const draft = structuredClone(current)
          mutate(draft)
          current = draft
        },
        async save() {}
      }
      const linkCtx: WizardContext = {
        runId: null,
        state: memory,
        emit: emitter,
        ask: asks.ask,
        signal: controller.signal,
        options,
        root: args.root,
        appRoot: current.appRoot,
        now: () => deps.clock.now()
      }
      const steps = wiring.engine?.steps ?? WIZARD_STEPS
      const outcome = await steps.link.run(linkCtx, deps)
      if (outcome.kind === "ok" && current.link) return { linkId: current.link.linkId }
      const code = outcome.kind === "parked" || outcome.kind === "blocked" || outcome.kind === "failed" ? outcome.code : null
      const message = outcome.kind === "failed" ? outcome.message : outcome.kind === "ok" ? "the link step saved no link" : outcome.reason
      return { linkId: null, code, message }
    }
    const result = await runUninstallFlow(
      { root: args.root, state, ask: asks.askUserOnly, link, print: (line) => options.json ? io.stderr.write(`${line}\n`) : afterScreen.push(line), now: () => deps.clock.now(), base: args.base },
      deps
    )
    resultLines = result.lines
    store.setOutro(result.lines.join("\n"))
    // stdout carries only NDJSON in --json mode, so the per-piece lines go to stderr there.
    if (options.json) for (const line of result.lines) io.stderr.write(`${line}\n`)
    emitter.emit("run.end", { exitCode: result.exitCode, runId: state?.runId ?? null, ...(result.record?.pr ? { prUrl: result.record.pr.url } : {}), reportPath: null })
    return result.exitCode
  } catch (error) {
    const message = `Internal error: ${error instanceof Error ? error.message : String(error)}\n`
    if (options.json) io.stderr.write(message)
    else afterScreen.push(message)
    return WIZARD_EXIT.failed
  } finally {
    emitter.dispose()
    ui.stop()
    if (!options.json) for (const line of afterScreen) if (!resultLines.includes(line)) io.stderr.write(line.endsWith("\n") ? line : `${line}\n`)
    ttyPrompter?.close()
    await lock.handle.release()
  }
}
