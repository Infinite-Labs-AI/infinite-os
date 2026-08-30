/**
 * mode-router — pure engine selection for the `infinite` CLI entrypoint.
 *
 * Decides which brain a bare `infinite` invocation talks to BEFORE any session
 * is opened. This is a hard, up-front choice: a cloud session must never fall
 * back to local mid-flight (no silent downgrade). The developer-only local
 * engine is reachable only through the explicit `infinite local` namespace,
 * which bypasses this product router entirely.
 *
 * Cloud routing is LIVE-probe driven (spec §6.4): the caller probes the
 * `bridge.json` descriptor AND `/v1/status` (reachable + `ready`) and injects
 * the verdict as `liveBridgeAvailable`. The durable per-home `seen.json`
 * marker only proves a capable Desktop ONCE existed — it must never force
 * `cloud` on its own, or a stopped Desktop throws `desktop_not_running`
 * instead of being launched via onboarding.
 *
 * Pure function — all environment probing is injected via `deps`, so this file
 * performs no I/O and imports no Desktop code. Callers supply the fakes/real
 * probes (the live probe is async; callers pre-resolve it and pass a thunk).
 */

export type Mode = "cloud" | "onboarding" | "unsupported";

/** TTY-ness of the current process, probed by the caller. */
export interface ModeIo {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
}

/** Injected environment probes — the only source of side effects. */
export interface ModeDeps {
  /** Running on macOS (Desktop cloud brain is macOS-only today). */
  isMac: () => boolean;
  /** LIVE Desktop bridge probe: descriptor + reachable ready status. */
  liveBridgeAvailable: () => boolean;
}

/**
 * Resolve the engine for a bare `infinite` invocation.
 *
 * Decision table (first match wins):
 *  1. non-mac            → unsupported
 *  2. live ready bridge  → cloud  (BOTH TTY and non-TTY — a ready bridge
 *                                  serves piped one-shots too)
 *  3. otherwise          → onboarding
 *     (mac with no live bridge: launch/guide toward Desktop. Interactive
 *      callers launch + poll; non-interactive callers surface guidance and
 *      exit non-zero — NEVER a silent local product turn. Config `cloud`
 *      lands here too when the bridge is dead: onboarding launches Desktop,
 *      which is strictly better than routing to a dead cloud.)
 */
export function resolveMode(
  _env: NodeJS.ProcessEnv,
  _io: ModeIo,
  deps: ModeDeps
): Mode {
  if (!deps.isMac()) return "unsupported";
  return deps.liveBridgeAvailable() ? "cloud" : "onboarding";
}
