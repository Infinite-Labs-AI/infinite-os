/**
 * mode-router — pure engine selection for the `infinite` CLI entrypoint.
 *
 * Decides which brain a bare `infinite` invocation talks to BEFORE any session
 * is opened. This is a hard, up-front choice: a cloud session must never fall
 * back to local mid-flight (no silent downgrade). The developer-only local
 * engine is reachable only through the explicit `infinite local` namespace,
 * which bypasses this product router entirely.
 *
 * Cloud routing is readiness driven (spec §6.4): the caller injects a single
 * `desktopReady` verdict that requires BOTH durable `state.json.state ===
 * "ready"` and a fresh live `bridge.json` + `/v1/status.ready` probe. Neither
 * signal can force `cloud` on its own: a stopped Desktop can leave stale ready
 * state behind, and a live bridge can briefly report ready before the app has
 * persisted the matching durable state.
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
  /** Durable state.json ready AND fresh live Desktop bridge ready. */
  desktopReady: () => boolean;
}

/**
 * Resolve the engine for a bare `infinite` invocation.
 *
 * Decision table (first match wins):
 *  1. non-mac            → unsupported
 *  2. ready Desktop      → cloud  (BOTH TTY and non-TTY — a ready Desktop
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
  return deps.desktopReady() ? "cloud" : "onboarding";
}
