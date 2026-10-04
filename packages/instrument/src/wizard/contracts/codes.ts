// §3d.5 of the wizard build plan, as code: every `WizardCode`, the exit code each one maps to, the
// priority rule that picks a run's exit code, and `doctor`'s own exit codes.
//
// NORMATIVE. The exit code is a function of the CODE, never of the outcome kind (R1-36): a step that
// ends `blocked` or `failed` with `next:"continue"` sets no exit code; the highest-priority code among
// the outcomes that HALTED or PARKED the run does (priority 4 > 3 > 1 > 2 > 0). SIGINT/SIGTERM is 130
// and carries no code. Pure data + pure functions; no I/O.

/** Process exit codes the wizard uses (§3d.5). */
export const WIZARD_EXIT = {
  /** Done: the PR is open and/or the site is proven. */
  done: 0,
  failed: 1,
  /** Usage or environment: bad args, not a TTY without --json, unsupported platform, not the Mac app. */
  usage: 2,
  /** Parked and resumable: needs answers, waiting for the merge, out of usage, deploy not seen. */
  parked: 3,
  /** Needs the Infinite app: not running, signed out, not subscribed, link declined. */
  needsApp: 4,
  /** SIGINT / SIGTERM. No WizardCode carries it. */
  interrupted: 130
} as const

export type WizardExitCode = (typeof WIZARD_EXIT)[keyof typeof WIZARD_EXIT]

/** Every WizardCode, grouped by the exit code it maps to (§3d.5 table). */
export const WIZARD_CODES_BY_EXIT = {
  1: [
    "INF_WIZ_APPLY_ROLLED_BACK",
    "INF_WIZ_AGENT_TOOLLESS",
    "INF_WIZ_AGENT_TIMEOUT",
    "INF_WIZ_PUSH_REFUSED",
    "INF_WIZ_PR_CREATE_FAILED",
    "INF_WIZ_REVIEW_UNPARSEABLE",
    "INF_WIZ_PROOF_INCOMPLETE",
    "INF_WIZ_BRANCH_FAILED",
    "INF_WIZ_FENCE_TAMPER",
    // §3z.4 (B6): a generic agent error (not out of usage, not a timeout, not toolless).
    "INF_WIZ_AGENT_FAILED"
  ],
  2: [
    "INF_WIZ_NOT_BUILT",
    "INF_WIZ_NOT_MAC",
    "INF_WIZ_UNSUPPORTED_PLATFORM",
    "INF_WIZ_NO_GIT",
    "INF_WIZ_DIRTY_TREE",
    "INF_WIZ_BRIDGE_PROTOCOL",
    "INF_WIZ_LOCKED",
    "INF_WIZ_RUNTIME_MISMATCH",
    // §3x.8 (R3-7): the link points at Infinite's own workspace, which never takes a customer site; relink.
    "INF_WIZ_INFINITE_WORKSPACE"
  ],
  3: [
    "INF_WIZ_NEEDS_ANSWERS",
    "INF_WIZ_MERGE_PARKED",
    "INF_WIZ_AGENT_OUT_OF_USAGE",
    "INF_WIZ_DEPLOY_TIMEOUT",
    // Exit 3 only when it halts the run; a preview that never appears normally leaves the rehearsal
    // `undetermined (no preview)` and the run continues (§3d.1 step 8).
    "INF_WIZ_PREVIEW_NOT_FOUND",
    // §3z.4: a running website test in Infinite locks the site's setup (423 `site_setup_locked`).
    "INF_WIZ_SITE_LOCKED",
    // §3z.4: Infinite or its cloud did not answer (502/504, busy, rate limited, retryable internal error).
    "INF_WIZ_INFINITE_UNAVAILABLE",
    // §3z.12 (B21): a dev server keeps writing build output; stop it, then run again.
    "INF_WIZ_DEV_SERVER_RUNNING",
    // §3y.4: the merge's production deployment failed (GitHub or Infinite says so) and nothing later descends from it.
    "INF_WIZ_DEPLOY_FAILED",
    // §3y.4: deployed, but the site-file claim is not proven yet; the run's one real visit is kept for later.
    "INF_WIZ_HOST_UNCONFIRMED"
  ],
  4: [
    "INF_WIZ_NO_APP",
    "INF_WIZ_SIGNED_OUT",
    "INF_WIZ_SUBSCRIPTION_REQUIRED",
    "INF_WIZ_LINK_DECLINED",
    "INF_WIZ_LINK_EXPIRED"
  ]
} as const

type CodesByExit = typeof WIZARD_CODES_BY_EXIT
export type WizardCode = CodesByExit[keyof CodesByExit][number]

/** Every WizardCode, in table order. */
export const WIZARD_CODES: readonly WizardCode[] = [
  ...WIZARD_CODES_BY_EXIT[1],
  ...WIZARD_CODES_BY_EXIT[2],
  ...WIZARD_CODES_BY_EXIT[3],
  ...WIZARD_CODES_BY_EXIT[4]
]

/** The exit code a halting/parking code maps to. */
export type WizardCodeExit = 1 | 2 | 3 | 4

/** The explicit `WizardCode → exit code` table (one row per code; a code missing here does not compile). */
export const WIZARD_CODE_EXIT: { readonly [C in WizardCode]: WizardCodeExit } = Object.freeze(
  Object.fromEntries(
    (Object.entries(WIZARD_CODES_BY_EXIT) as Array<[string, readonly WizardCode[]]>).flatMap(
      ([exit, codes]) => codes.map((code) => [code, Number(exit) as WizardCodeExit] as const)
    )
  ) as { [C in WizardCode]: WizardCodeExit }
)

const WIZARD_CODE_SET: ReadonlySet<string> = new Set(WIZARD_CODES)

export function isWizardCode(value: unknown): value is WizardCode {
  return typeof value === "string" && WIZARD_CODE_SET.has(value)
}

/** §3d.5: the exit code for one WizardCode. Throws on a value that is not a WizardCode. */
export function exitCodeFor(code: WizardCode): WizardCodeExit {
  const exit = isWizardCode(code) ? WIZARD_CODE_EXIT[code] : undefined
  if (exit === undefined) {
    throw new Error(`Unknown WizardCode: ${JSON.stringify(code)}`)
  }
  return exit
}

/** Priority among the exit codes of the outcomes that halted or parked the run: 4 > 3 > 1 > 2 > 0. */
export const WIZARD_EXIT_PRIORITY: readonly (0 | WizardCodeExit)[] = [4, 3, 1, 2, 0]

/**
 * The run's exit code from the codes of the outcomes that HALTED or PARKED it (callers pass only
 * those; a `continue` outcome never sets the exit code). No codes → 0. SIGINT (130) is decided by the
 * signal handler, not here.
 */
export function runExitCode(haltingOrParkingCodes: readonly WizardCode[]): 0 | WizardCodeExit {
  const exits = new Set(haltingOrParkingCodes.map(exitCodeFor))
  for (const exit of WIZARD_EXIT_PRIORITY) {
    if (exit !== 0 && exits.has(exit)) return exit
  }
  return 0
}

/** `infinite-tag doctor` exit codes (§3d.5). */
export const DOCTOR_EXIT_CODES = {
  /** No problem and no undetermined. */
  clean: 0,
  /** At least one problem. */
  problem: 1,
  usage: 2,
  /** No problem, but at least one undetermined. */
  undetermined: 3
} as const

/** `doctor`'s exit code from its check states (`info` never changes it; undetermined never counts as pass). */
export function doctorExitCode(states: readonly ("pass" | "problem" | "undetermined" | "info")[]): 0 | 1 | 3 {
  if (states.includes("problem")) return DOCTOR_EXIT_CODES.problem
  if (states.includes("undetermined")) return DOCTOR_EXIT_CODES.undetermined
  return DOCTOR_EXIT_CODES.clean
}
