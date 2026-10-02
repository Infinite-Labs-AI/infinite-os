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
import { isAbsolute, join, relative, resolve } from "node:path"

import { INSTRUMENT_VERSION } from "../package-manager.js"
import { NESTING_ENV_MARKERS } from "./contracts/agents.js"
import { WIZARD_EXIT, exitCodeFor } from "./contracts/codes.js"
import type { WizardContext, WizardDeps, WizardOptions } from "./contracts/deps.js"
import type { ReportV2 } from "./contracts/report.js"
import type { WizardRunState } from "./contracts/state.js"
import { createWizardAsks, readAnswersFile, type AnswersFile, type TtyPrompter } from "./asks.js"
import { openDevTtyPrompter } from "./dev-tty.js"
import { EngineInvariantError, runWizard } from "./engine.js"
import { WizardEventEmitter } from "./events.js"
import { nodeWizardFs, systemClock } from "./fs.js"
import { acquireRunLock, type RunLockHandle } from "./lock.js"
import { renderTerminal } from "./report.js"
import { RunStateFile, createRunState, firstOpenStep, loadRunState, setStateAside } from "./run-state.js"
import { installInterruptHandlers } from "./signals.js"
import { WIZARD_REPORT_PATHS } from "./steps/done.js"
import { WizardStore } from "./store.js"
import { runUninstallFlow } from "./uninstall-flow.js"
import { getWizardWiring, type WizardIo, type WizardWiring } from "./wiring.js"

export const WIZARD_NOT_BUILT_MESSAGE =
  "The infinite-tag setup wizard is not built yet in this build (its parts are not wired together). Use `npx infinite-tag harness` or `npx infinite-tag install` for now."

export const NOT_A_TTY_MESSAGE =
  "infinite-tag needs an interactive terminal. Agents run it with --json; CI uses `infinite-tag doctor` or `infinite-tag harness`."

export const WIZARD_USAGE = [
  "Usage: npx infinite-tag [--json] [--yes] [--answers <file>] [--root <dir>] [--app-root <dir>] [--resume]",
  "                        [--no-agent] [--worker claude|codex] [--reviewer claude|codex|brief|none]",
  "                        [--consent-mode not_required|required] [--no-prove]",
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
  const root = resolve(cwd, rootArg ?? ".")
  const appRoot = appRootArg === null ? { ok: true as const, value: "." } : resolveAppRoot(root, appRootArg)
  if (!appRoot.ok) return appRoot
  return { ok: true, value: { options, root, appRoot: appRoot.value } }
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

async function readFinalReport(root: string): Promise<ReportV2 | null> {
  try {
    return JSON.parse(await fsp.readFile(join(root, WIZARD_REPORT_PATHS.json), "utf8")) as ReportV2
  } catch {
    return null
  }
}

export interface RunWizardCommandOverrides {
  io?: WizardIo
  wiring?: WizardWiring | null
}

export async function runWizardCommand(argv: readonly string[], overrides: RunWizardCommandOverrides = {}): Promise<number> {
  const io = overrides.io ?? processIo()
  const parsed = parseWizardArgs(argv, io.cwd())
  if (!parsed.ok) {
    io.stderr.write(`${parsed.message}\n${WIZARD_USAGE}\n`)
    return WIZARD_EXIT.usage
  }
  const { root, appRoot } = parsed.value
  const options = { ...parsed.value.options }
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
    io.stderr.write(`Another infinite-tag run is using this repo${holder}. Wait for it, or remove ${lock.path} if it is gone.\n`)
    return exitCodeFor("INF_WIZ_LOCKED")
  }
  return runLocked({ io, wiring, options, root, appRoot, answers, lock: lock.handle })
}

interface LockedRun {
  io: WizardIo
  wiring: WizardWiring
  options: WizardOptions
  root: string
  appRoot: string
  answers: AnswersFile | null
  lock: RunLockHandle
}

async function runLocked(input: LockedRun): Promise<number> {
  const { io, wiring, options, root, appRoot, answers, lock } = input
  const controller = new AbortController()
  const loaded = await loadRunState(nodeWizardFs, root)
  const existing = loaded.kind === "ok" ? loaded.state : null
  const store = new WizardStore({ displayId: existing?.displayId ?? "r-····", tagVersion: INSTRUMENT_VERSION })
  const emitter = new WizardEventEmitter({ store, ndjson: options.json ? (line) => io.stdout.write(`${line}\n`) : null })
  const ui = wiring.createUi(options.json ? "json" : "tty", store, io)
  let ttyPrompter: TtyPrompter | null = null
  let removeHandlers: (() => void) | null = null
  let deps: WizardDeps | null = null
  ui.start(store)
  try {
    if (options.nested) ttyPrompter = wiring.ttyPrompter ? wiring.ttyPrompter() : openDevTtyPrompter()
    const asks = createWizardAsks({ store, emitter, options, answers, ttyPrompter, signal: controller.signal })

    // The run state: resume, start fresh, or ask (a corrupt file is never silently reset).
    let state: WizardRunState
    let resumedFrom = null as ReturnType<typeof firstOpenStep>
    if (loaded.kind === "corrupt") {
      const fresh = await asks.askUserOnly("confirm", {
        question: `The saved run (${loaded.path}) cannot be read (${loaded.problems[0] ?? "corrupt"}). Start a fresh run? The old file is kept beside it.`,
        defaultYes: false
      })
      if (fresh !== true) {
        io.stderr.write("Not started: fix or move .infinite/wizard/state.json, or answer yes to start fresh.\n")
        return finish(exitCodeFor("INF_WIZ_NEEDS_ANSWERS"), null)
      }
      await setStateAside(root, `corrupt-${Date.now()}`)
      state = createRunState({ tagVersion: INSTRUMENT_VERSION, root, appRoot, now: systemClock.now() })
    } else if (loaded.kind === "ok" && loaded.state.steps.done?.outcome !== "ok") {
      state = loaded.state
      resumedFrom = firstOpenStep(state)
    } else {
      if (loaded.kind === "ok") await setStateAside(root, `${loaded.state.runId ?? loaded.state.displayId}.done`)
      if (options.resume) {
        io.stderr.write("There is no unfinished run to resume here; starting a fresh one.\n")
      }
      state = createRunState({ tagVersion: INSTRUMENT_VERSION, root, appRoot, now: systemClock.now() })
    }
    store.setRun({ displayId: state.displayId, runId: state.runId })
    const runState = new RunStateFile(nodeWizardFs, root, state)
    await runState.save()

    deps = await wiring.createDeps({
      root,
      appRoot: state.appRoot,
      options,
      env: io.env,
      platform: io.platform,
      tagVersion: INSTRUMENT_VERSION,
      signal: controller.signal
    })
    const agents = deps.agents
    removeHandlers = installInterruptHandlers({
      abort: () => controller.abort(new Error("interrupted")),
      killAgents: () => agents.killAll(),
      ...(wiring.fenceAbort ? { fenceAbort: () => wiring.fenceAbort!() } : {}),
      releaseLock: () => lock.release(),
      exit: (code) => {
        ui.stop()
        io.exit(code)
      },
      notice: (text) => io.stderr.write(`${text}\n`)
    })

    const ctx: WizardContext = {
      get runId() {
        return runState.get().runId
      },
      state: runState,
      emit: emitter,
      ask: asks.ask,
      signal: controller.signal,
      options,
      root,
      appRoot: state.appRoot,
      now: () => deps!.clock.now()
    }
    const result = await runWizard(ctx, deps, { ...(wiring.engine ?? {}), resumedFrom })
    return finish(result.exitCode, runState.get())
  } catch (error) {
    const prefix = error instanceof EngineInvariantError ? "Internal error (the wizard stopped itself)" : "Internal error"
    io.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`)
    return finish(WIZARD_EXIT.failed, null)
  }

  async function finish(exitCode: number, state: Readonly<WizardRunState> | null): Promise<number> {
    const report = await readFinalReport(root)
    const reportPath = report ? WIZARD_REPORT_PATHS.markdown : null
    emitter.emit("run.end", {
      exitCode,
      runId: state?.runId ?? null,
      ...(state?.pr?.url ? { prUrl: state.pr.url } : {}),
      reportPath
    })
    if (report) store.setOutro(renderTerminal(report, io.stdout.columns ?? 100))
    emitter.dispose()
    ui.stop()
    removeHandlers?.()
    ttyPrompter?.close()
    await lock.release()
    return exitCode
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
    io.stderr.write(`Another infinite-tag run is using this repo. Wait for it, or remove ${lock.path} if it is gone.\n`)
    return exitCodeFor("INF_WIZ_LOCKED")
  }
  const loaded = await loadRunState(nodeWizardFs, args.root)
  const state = loaded.kind === "ok" ? loaded.state : null
  const store = new WizardStore({ displayId: state?.displayId ?? "r-····", tagVersion: INSTRUMENT_VERSION })
  const emitter = new WizardEventEmitter({ store, ndjson: options.json ? (line) => io.stdout.write(`${line}\n`) : null })
  const ui = wiring.createUi(options.json ? "json" : "tty", store, io)
  const controller = new AbortController()
  ui.start(store)
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
      signal: controller.signal
    })
    const result = await runUninstallFlow(
      { root: args.root, state, ask: asks.askUserOnly, print: (line) => io.stderr.write(`${line}\n`), now: () => deps.clock.now(), base: args.base },
      deps
    )
    store.setOutro(result.lines.join("\n"))
    if (!options.json) for (const line of result.lines) io.stdout.write(`${line}\n`)
    emitter.emit("run.end", { exitCode: result.exitCode, runId: state?.runId ?? null, ...(result.record?.pr ? { prUrl: result.record.pr.url } : {}), reportPath: null })
    return result.exitCode
  } catch (error) {
    io.stderr.write(`Internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    return WIZARD_EXIT.failed
  } finally {
    emitter.dispose()
    ui.stop()
    ttyPrompter?.close()
    await lock.handle.release()
  }
}
