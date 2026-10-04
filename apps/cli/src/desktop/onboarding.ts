import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { infiniteOsHome } from "@infinite-os/config";
import {
  desktopTargetForHome,
  type CanonicalDesktopTarget
} from "./canonical-home.js";

/**
 * No-Desktop onboarding for the public `infinite` CLI.
 *
 * When the mode-router picks `onboarding` (bare interactive invocation that asked
 * for the cloud brain but has no per-home rollout marker yet), this flow decides
 * whether it can hand off to the Desktop app or must guide the user elsewhere. It
 * carries NO cloud login and makes NO network call — the sign-up/download link is
 * hardcoded and the only "launch" is a local `open -a <appName>` via the injected
 * `launch` dep. Local is always reachable via `infinite local`.
 */

// state.json lifecycle values (<home>/desktop-cmdl/state.json .state).
// Desktop writes the precise not-ready reason on every authority change
// (auth/workspace/provider/billing — spec §6.4), so each maps to exact guidance.
export type OnboardingState =
  | "booting"
  | "signed_out"
  | "no_provider"
  | "no_linked_workspace"
  | "subscription_required"
  | "other_not_ready"
  | "ready";

export function normalizeOnboardingState(
  value: unknown
): OnboardingState | null {
  if (typeof value !== "string" || value.length === 0) return null;
  switch (value) {
    case "booting":
    case "signed_out":
    case "no_provider":
    case "no_linked_workspace":
    case "subscription_required":
    case "ready":
      return value;
    default:
      return "other_not_ready";
  }
}

/**
 * Structured onboarding outcome. On `ready` the CALLER continues straight into
 * the proxied chat session (spec §6.2) — onboarding must complete into a
 * session, not dead-end. Every other value means guidance was already printed
 * and the caller exits non-zero.
 */
export interface OnboardingResult {
  result:
    | "ready"
    | "not_installed"
    | "unsupported_home"
    | "timed_out"
    | "interrupted";
}

export interface OnboardingIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface OnboardingDeps {
  /** Locate this exact Desktop identity's app bundle. */
  resolveAppPath: (target: CanonicalDesktopTarget) => string | null;
  /** Launch the exact app bundle and its registered onboarding URI. */
  launch: (target: DesktopLaunchTarget) => void;
  /** Read <home>/desktop-cmdl/state.json .state, or null when absent. */
  readState: () => OnboardingState | null;
  /**
   * LIVE bridge probe (spec §6.4): a readable `bridge.json` descriptor AND
   * `/v1/status` reachable + `ready`. Loopback-only — no cloud call. Ready is
   * NEVER concluded from `state.json` alone: onboarding only runs after the
   * live probe already failed, so a `ready` state file at that point is almost
   * always stale (a crashed/SIGKILLed Desktop leaves `state.json="ready"`
   * behind with a dead bridge). Sync-injectable for tests; the real wiring is
   * the async status probe.
   */
  liveBridgeReady: () => boolean | Promise<boolean>;
  /** Poll interval while waiting for `ready` (ms). */
  pollMs?: number;
  /**
   * Total budget to reach `ready` before giving up (ms). Defaults to
   * {@link DEFAULT_READY_TIMEOUT_MS} — deliberately LONG: sign-up (OTP),
   * workspace creation, and payment routinely exceed the old 60s cap.
   */
  timeoutMs?: number;
  /**
   * One-shot (piped / non-interactive) invocation: never launch a GUI app and
   * block a pipe on it. With no live bridge this becomes an error + guidance.
   */
  oneShot?: boolean;
  /** Cancels the ready wait (e.g. Ctrl-C). An abort ends the poll early. */
  signal?: AbortSignal;
  /** Injectable clock/sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface OnboardingEnv {
  GROWTH_OS_HOME?: string;
  HOME?: string;
}

/** Single source for the sign-up/download link (no site is served at the root). */
export const INFINITE_DOWNLOAD_URL = "https://infinite.fast/download";
export const INFINITE_INSTALL_COMMAND = "npx infinite-os@latest";
export const INFINITE_ONBOARDING_URI = "infinite://onboarding";

export interface DesktopLaunchTarget extends CanonicalDesktopTarget {
  appPath: string;
  onboardingUri: string;
}

const DEFAULT_POLL_MS = 500;
/**
 * Default budget for the ready wait: 30 minutes. Long by design — the wait
 * spans Desktop sign-up (email OTP), workspace creation, and payment, which
 * routinely exceed the previous 60s cap. It is progress-aware (guidance per
 * state change) and cancellable (`deps.signal`), so a long cap never means a
 * silent hang.
 */
export const DEFAULT_READY_TIMEOUT_MS = 30 * 60_000;

export class OnboardingError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

/**
 * The variant→home→app-name map itself is single-sourced in
 * `./canonical-home.ts` (the `infinite-os` mirror of Desktop's
 * `runtime-identity.ts`). This wrapper only adds the LAUNCH policy: canonical
 * ONLY when the home sits directly under the user's HOME. A custom path
 * elsewhere is never canonical even if it happens to end in `.growth-os`.
 */
function canonicalDesktopTarget(
  home: string,
  userHome: string
): CanonicalDesktopTarget | null {
  if (dirname(home) !== userHome) return null;
  return desktopTargetForHome(home);
}

export async function runOnboarding(
  env: OnboardingEnv,
  io: OnboardingIo,
  deps: OnboardingDeps
): Promise<OnboardingResult> {
  const home = infiniteOsHome(env as NodeJS.ProcessEnv);
  const userHome = resolve(
    env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir()
  );
  const target = canonicalDesktopTarget(home, userHome);

  // Custom (non-canonical) GROWTH_OS_HOME → GUIDE ONLY, never launch. Electron
  // keys the Desktop's userData off `productName`, not our env, and we must
  // NEVER forward GROWTH_OS_HOME to the launched app — so `open -a` would attach
  // to the app's DEFAULT home, not this custom one. There is no app we can fill.
  if (!target) {
    io.writeOut(
      `The requested Desktop identity for GROWTH_OS_HOME ${home} cannot be launched.\n` +
        `Run \`${INFINITE_INSTALL_COMMAND}\`, then open ${INFINITE_ONBOARDING_URI}.\n`
    );
    return { result: "unsupported_home" };
  }

  const appPath = deps.resolveAppPath(target);
  if (!appPath) {
    io.writeOut(
      "Infinite Desktop is missing or moved.\n" +
        `Run \`${INFINITE_INSTALL_COMMAND}\`, then open ${INFINITE_ONBOARDING_URI}.\n`
    );
    return { result: "not_installed" };
  }

  // One-shot with no live bridge: we cannot block a pipe on a GUI launch.
  // Ready requires BOTH the state file AND a live bridge (never state alone).
  if (deps.oneShot) {
    if (deps.readState() === "ready" && (await deps.liveBridgeReady())) {
      return { result: "ready" };
    }
    io.writeOut(
      `Open ${INFINITE_ONBOARDING_URI}, or run \`${INFINITE_INSTALL_COMMAND}\`.\n`
    );
    throw new OnboardingError(
      "desktop_bridge_absent",
      `Infinite Desktop is not ready. Open ${INFINITE_ONBOARDING_URI}, or run \`${INFINITE_INSTALL_COMMAND}\`.`
    );
  }

  // Interactive: launch the matching app and wait for it to become ready.
  // NEVER pass GROWTH_OS_HOME to the launched app (see the custom-home note).
  const launchTarget: DesktopLaunchTarget = {
    ...target,
    appPath,
    onboardingUri: `${target.scheme}://onboarding`
  };
  try {
    deps.launch(launchTarget);
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(
      "desktop_launch_failed",
      `Could not open ${launchTarget.onboardingUri}. Run: open '${launchTarget.onboardingUri}'`
    );
  }
  io.writeOut(
    "Complete setup in the app\n\n" +
      "This terminal will wait and become ready automatically.\n" +
      "You can close it safely and run `infinite` again later.\n"
  );
  return pollToReady(io, deps);
}

async function pollToReady(
  io: OnboardingIo,
  deps: OnboardingDeps
): Promise<OnboardingResult> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  let lastGuided: OnboardingState | null = null;

  for (;;) {
    const state = deps.readState();
    // Ready requires BOTH state.json AND a live bridge: a stale "ready" left
    // by a crashed Desktop must keep polling until the bridge actually answers
    // (or the deadline/abort ends the wait) — never a false ready that then
    // dies on ECONNREFUSED in the session.
    if (state === "ready" && (await deps.liveBridgeReady())) {
      return { result: "ready" };
    }
    // Progress-aware wait: precise guidance for every distinct state, once per
    // transition. No state.json yet reads as booting (Desktop still starting).
    const guidedState = state ?? "booting";
    if (guidedState !== lastGuided) {
      renderStateGuidance(io, guidedState);
      lastGuided = guidedState;
    }
    if (deps.signal?.aborted) {
      io.writeOut(
        `Stopped waiting for Infinite Desktop. Open ${INFINITE_ONBOARDING_URI}, or run \`infinite\` again later.\n`
      );
      return { result: "interrupted" };
    }
    if (now() >= deadline) {
      io.writeOut(
        `Infinite Desktop did not become ready in time. Open ${INFINITE_ONBOARDING_URI}, or run \`${INFINITE_INSTALL_COMMAND}\`.\n`
      );
      return { result: "timed_out" };
    }
    await sleep(pollMs);
  }
}

function renderStateGuidance(io: OnboardingIo, state: OnboardingState): void {
  const line =
    state === "signed_out"
      ? "→ Sign in to Infinite Desktop to continue."
      : state === "no_linked_workspace"
        ? "→ Create or link your workspace in Infinite Desktop to continue."
        : state === "no_provider"
          ? "→ Connect Codex or Claude in Infinite Desktop to continue."
          : state === "booting"
            ? "◌ Waiting for Infinite…"
            : state === "ready"
              ? null
              : "→ Finish setup in Infinite Desktop to continue.";
  if (line) io.writeOut(`${line}\n`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
