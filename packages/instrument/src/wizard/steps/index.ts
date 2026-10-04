// The 13 steps as the Record the engine runs (§3d.1, §3d.8). Keyed by WizardStepId, so a missing step
// does not compile; the engine walks WIZARD_STEP_IDS for the order. Each lane fills its own step file;
// nobody edits this one.
import type { WizardStepRecord } from "../contracts/deps.js"
import { step as agent } from "./agent.js"
import { step as before } from "./before.js"
import { step as done } from "./done.js"
import { step as install } from "./install.js"
import { step as jobs } from "./jobs.js"
import { step as keys } from "./keys.js"
import { step as link } from "./link.js"
import { step as merge } from "./merge.js"
import { step as plan } from "./plan.js"
import { step as prove } from "./prove.js"
import { step as rehearsal } from "./rehearsal.js"
import { step as review } from "./review.js"
import { step as settings } from "./settings.js"

export const WIZARD_STEPS: WizardStepRecord = {
  link,
  agent,
  before,
  keys,
  plan,
  install,
  jobs,
  settings,
  rehearsal,
  review,
  merge,
  prove,
  done
}
