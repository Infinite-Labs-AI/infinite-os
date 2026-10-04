// §3d.1 of the wizard build plan, as code: the 13 steps in order, who acts in each, which Learn card
// it shows, the bridge capabilities it needs, and which lane owns its file.
//
// NORMATIVE. `WIZARD_STEP_IDS` is the ONE source of the step order (the engine runs it through a
// Record keyed by WizardStepId, so a step id with no step does not compile and a step missing from
// this list never runs, the same rule as the harness's RUNBOOK_STEP_IDS). Titles are the §3d.1 copy.
import type { TagCapability } from "./bridge.js"

export const WIZARD_STEP_IDS = [
  "link",
  "agent",
  "before",
  "keys",
  "plan",
  "install",
  "jobs",
  "settings",
  "rehearsal",
  "review",
  "merge",
  "prove",
  "done"
] as const

export type WizardStepId = (typeof WIZARD_STEP_IDS)[number]

/** Who acts in a step (the design's chips): the user, the wizard's own code, the Infinite app, the user's agent. */
export const WHO = ["you", "code", "infinite", "agent"] as const
export type Who = (typeof WHO)[number]

/** The Learn cards (`v6-data.js` `__LEARN`). */
export const LEARN_IDS = [
  "link",
  "agent",
  "standard",
  "keys",
  "asks",
  "checklist",
  "tests",
  "review",
  "proof",
  "after"
] as const
export type LearnId = (typeof LEARN_IDS)[number]

/** The build lanes that own a step file (`src/wizard/steps/<id>.ts`, one lane per file; §2.0). */
export type StepOwnerLane = "O1" | "O2" | "O3" | "O4" | "O7" | "O8"

export interface WizardStepMeta<Id extends WizardStepId = WizardStepId> {
  id: Id
  /** 0-based position, as the design numbers the steps. */
  n: number
  title: string
  who: readonly Who[]
  learn: LearnId
  owner: StepOwnerLane
  /** The bridge capabilities the step checks before it runs (missing → INF_WIZ_BRIDGE_PROTOCOL). */
  requiredCapabilities: readonly TagCapability[]
}

/** §3d.1, one row per step. */
export const WIZARD_STEP_META: { readonly [Id in WizardStepId]: WizardStepMeta<Id> } = {
  link: {
    id: "link",
    n: 0,
    title: "Link to Infinite",
    who: ["you"],
    learn: "link",
    owner: "O2",
    requiredCapabilities: ["tag.status.v1", "tag.link.v1"]
  },
  agent: {
    id: "agent",
    n: 1,
    title: "Pick the agent",
    who: ["code"],
    learn: "agent",
    owner: "O3",
    requiredCapabilities: ["tag.runs.v1"]
  },
  before: {
    id: "before",
    n: 2,
    title: "Check the live site",
    who: ["code", "infinite"],
    learn: "standard",
    owner: "O8",
    requiredCapabilities: ["tag.hosting.v1", "tag.keys.v1", "tag.test.v2", "tag.baseline.v1"]
  },
  keys: {
    id: "keys",
    n: 3,
    title: "Keys from Infinite",
    who: ["infinite", "you"],
    learn: "keys",
    owner: "O2",
    requiredCapabilities: ["tag.keys.v1"]
  },
  plan: {
    id: "plan",
    n: 4,
    title: "Plan + your decisions",
    who: ["you"],
    learn: "asks",
    owner: "O7",
    requiredCapabilities: ["tag.runs.v1"]
  },
  install: {
    id: "install",
    n: 5,
    title: "Install",
    who: ["code"],
    learn: "standard",
    owner: "O7",
    requiredCapabilities: ["tag.site-source.v1"]
  },
  jobs: {
    id: "jobs",
    n: 6,
    title: "Agent jobs",
    who: ["agent"],
    learn: "checklist",
    owner: "O3",
    requiredCapabilities: ["tag.runs.v1"]
  },
  settings: {
    id: "settings",
    n: 7,
    title: "Infinite settings",
    who: ["infinite"],
    learn: "keys",
    owner: "O2",
    requiredCapabilities: ["tag.conversions.v1", "tag.server-lane.v1", "tag.ga4-key-events.v1", "tag.meta-relay.v1"]
  },
  rehearsal: {
    id: "rehearsal",
    n: 8,
    title: "Draft PR + rehearsal",
    who: ["code", "infinite"],
    learn: "tests",
    owner: "O4",
    requiredCapabilities: ["tag.test.v2", "tag.runs.v1", "tag.ga4-key-events.v1"]
  },
  review: {
    id: "review",
    n: 9,
    title: "Second-agent review",
    who: ["code", "agent"],
    learn: "review",
    owner: "O4",
    requiredCapabilities: ["tag.test.v2", "tag.runs.v1", "tag.ga4-key-events.v1"]
  },
  merge: {
    id: "merge",
    n: 10,
    title: "You merge",
    who: ["you"],
    learn: "review",
    owner: "O4",
    requiredCapabilities: ["tag.runs.v1"]
  },
  prove: {
    id: "prove",
    n: 11,
    title: "Prove it live",
    who: ["infinite", "code"],
    learn: "proof",
    owner: "O1",
    requiredCapabilities: ["tag.hosting.v1", "tag.runs.v1", "tag.test.v2", "tag.receipts.v1"]
  },
  done: {
    id: "done",
    n: 12,
    title: "What happened",
    who: ["infinite"],
    learn: "after",
    owner: "O1",
    requiredCapabilities: ["tag.report.v2", "tag.runs.v1"]
  }
}

/**
 * §3d.1 copy overrides (honest values; R2-17): `v6-data.js` is the copy EXCEPT where it states
 * something the plan does not do.
 */
export const STEP_COPY_OVERRIDES = {
  settings: {
    what:
      "Saves the server-lane settings on Vercel through Infinite; they go live with your merge (production is not " +
      "restarted). GA4 key events are marked only for conversions whose offline click test passed; the report later " +
      "shows when GA4 really receives them.",
    sub1: "✓ Saved on Vercel · goes live with your merge"
  }
} as const

/** The five ways a step can end (§3d.8 `StepOutcome.kind`, also `step.done.outcome` and `state.steps[*].outcome`). */
export const STEP_OUTCOME_KINDS = ["ok", "skipped", "parked", "blocked", "failed"] as const
export type StepOutcomeKind = (typeof STEP_OUTCOME_KINDS)[number]
