// `.infinite/wizard/state.json` (§3d.6, schema `infinite-tag.wizard-state.v1`): load, validate, create
// and save the run state. Gitignored by the fence, written atomically (temp + rename), mode 0600.
//
// A corrupt file is never silently reset: the loader reports it, the command asks "start fresh?"
// (never answered by `--yes`), and only a yes moves the corrupt file aside (it is kept, not deleted).
import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import { join } from "node:path"

import type { RunStateAccessor, WizardFs } from "./contracts/deps.js"
import { shapeErrors } from "./contracts/shape.js"
import {
  WIZARD_PATHS,
  WIZARD_RUN_STATE_SHAPE,
  WIZARD_STATE_FILE_MODE,
  WIZARD_STATE_SCHEMA,
  type WizardRunState
} from "./contracts/state.js"
import { WIZARD_STEP_IDS, type WizardStepId } from "./contracts/steps.js"

export function stateFilePath(root: string): string {
  return join(root, WIZARD_PATHS.state)
}

export type LoadedRunState =
  | { kind: "none" }
  | { kind: "ok"; state: WizardRunState }
  | { kind: "corrupt"; path: string; problems: string[] }

/** `r-` + 4 hex: the short id the terminal and the report show. */
export function newDisplayId(): string {
  return `r-${randomBytes(2).toString("hex")}`
}

export function createRunState(input: {
  tagVersion: string
  root: string
  appRoot: string
  now: Date
  displayId?: string
}): WizardRunState {
  return {
    schema: WIZARD_STATE_SCHEMA,
    runId: null,
    displayId: input.displayId ?? newDisplayId(),
    createdAt: input.now.toISOString(),
    tagVersion: input.tagVersion,
    root: input.root,
    appRoot: input.appRoot,
    link: null,
    steps: {},
    agent: null,
    git: null,
    pr: null,
    plan: null,
    jobs: [],
    markers: { before: {}, rehearsal: {}, prove: {} },
    report: { live_today: null, in_pr: null, proven_live: null },
    snapshot: null
  }
}

const STEP_OUTCOMES = new Set(["ok", "skipped", "parked", "blocked", "failed"])

/** Every way a parsed value is not a run state (shape, schema, step ids and outcomes). */
export function runStateProblems(value: unknown): string[] {
  const problems = shapeErrors(value, WIZARD_RUN_STATE_SHAPE)
  if (problems.length > 0) return problems
  const state = value as WizardRunState
  if (state.schema !== WIZARD_STATE_SCHEMA) problems.push(`schema is ${JSON.stringify(state.schema)}, not ${WIZARD_STATE_SCHEMA}`)
  for (const [id, record] of Object.entries(state.steps)) {
    if (!(WIZARD_STEP_IDS as readonly string[]).includes(id)) problems.push(`steps.${id}: not a wizard step`)
    else if (!STEP_OUTCOMES.has(record?.outcome as string)) problems.push(`steps.${id}.outcome is not an outcome`)
  }
  return problems
}

export async function loadRunState(fs: WizardFs, root: string): Promise<LoadedRunState> {
  const path = stateFilePath(root)
  const text = await fs.readText(path)
  if (text === null) return { kind: "none" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { kind: "corrupt", path, problems: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const problems = runStateProblems(parsed)
  if (problems.length > 0) return { kind: "corrupt", path, problems }
  return { kind: "ok", state: parsed as WizardRunState }
}

/** Where the final report lands (inside the gitignored `.infinite/wizard/`); `done` writes it. */
export const WIZARD_REPORT_PATHS = {
  json: `${WIZARD_PATHS.dir}/report.json`,
  markdown: `${WIZARD_PATHS.dir}/report.md`
} as const

async function moveAside(path: string, suffix: string): Promise<string | null> {
  const target = `${path}.${suffix}`
  try {
    await fsp.rename(path, target)
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * Moves a corrupt (or finished, or abandoned) run aside, never deletes it: the state file AND the run's
 * report files, so a new run can never show the old run's report as its own. Returns the state's new path.
 */
export async function setStateAside(root: string, suffix: string): Promise<string | null> {
  const moved = await moveAside(stateFilePath(root), suffix)
  for (const path of Object.values(WIZARD_REPORT_PATHS)) await moveAside(join(root, path), suffix)
  return moved
}

/** The first step whose last outcome was not `ok` (the step a resume starts from), or null when all are ok. */
export function firstOpenStep(state: WizardRunState): WizardStepId | null {
  for (const id of WIZARD_STEP_IDS) if (state.steps[id]?.outcome !== "ok") return id
  return null
}

/** `RunStateAccessor` over one in-memory state, saved atomically at 0600. */
export class RunStateFile implements RunStateAccessor {
  private state: WizardRunState
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly fs: WizardFs,
    private readonly root: string,
    initial: WizardRunState
  ) {
    this.state = initial
  }

  get(): Readonly<WizardRunState> {
    return this.state
  }

  update(mutate: (state: WizardRunState) => void): void {
    const draft = structuredClone(this.state)
    mutate(draft)
    const problems = runStateProblems(draft)
    if (problems.length > 0) throw new Error(`Refusing a run-state update that breaks the state schema: ${problems.join("; ")}`)
    this.state = draft
  }

  /**
   * Serialised: two saves never interleave, and the last write wins. Each save reports ITS OWN write; a
   * failed write never poisons the saves after it (they run once the cause clears).
   */
  save(): Promise<void> {
    const text = `${JSON.stringify(this.state, null, 2)}\n`
    const write = this.saving.catch(() => {}).then(() => this.fs.writeTextAtomic(stateFilePath(this.root), text, WIZARD_STATE_FILE_MODE))
    this.saving = write
    return write
  }
}
