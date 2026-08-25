/**
 * mode-router — pure engine selection for the `infinite` CLI entrypoint.
 *
 * Decides which brain a bare `infinite` invocation talks to BEFORE any session
 * is opened. This is a hard, up-front choice: a cloud session must never fall
 * back to local mid-flight (no silent downgrade), and local is only reachable
 * intentionally (either an explicit `infinite local`, config `default_target`,
 * or a non-mac host).
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

export type Mode = "cloud" | "local" | "onboarding";

/** TTY-ness of the current process, probed by the caller. */
export interface ModeIo {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
}

/** Injected environment probes — the only source of side effects. */
export interface ModeDeps {
  /** Running on macOS (Desktop cloud brain is macOS-only today). */
  isMac: () => boolean;
  /**
   * LIVE Desktop bridge probe: a readable `bridge.json` descriptor AND a
   * reachable `/v1/status` reporting `ready`. This — never the durable
   * `seen.json` marker — is the ONLY trigger for `cloud`.
   */
  liveBridgeAvailable: () => boolean;
  /**
   * @deprecated Per-home rollout marker (seen.json). Retained so callers can
   * still express the legacy probe, but NEVER consulted for routing — a
   * historical marker must not route `cloud` (spec §6.4 / invariant 10).
   */
  markerExists?: (home?: string) => boolean;
  /** Config `default_target` for this home, if the user set one. */
  readConfigTarget: (env: NodeJS.ProcessEnv) => "local" | "cloud" | undefined;
}

/**
 * Resolve the engine for a bare `infinite` invocation.
 *
 * Decision table (first match wins):
 *  1. config `local`     → local  (explicit opt-out, beats a live bridge)
 *  2. non-mac            → local  (Desktop cannot be summoned)
 *  3. live ready bridge  → cloud  (BOTH TTY and non-TTY — a ready bridge
 *                                  serves piped one-shots too)
 *  4. otherwise          → onboarding
 *     (mac with no live bridge: launch/guide toward Desktop. Interactive
 *      callers launch + poll; non-interactive callers surface guidance and
 *      exit non-zero — NEVER a silent local product turn. Config `cloud`
 *      lands here too when the bridge is dead: onboarding launches Desktop,
 *      which is strictly better than routing to a dead cloud.)
 */
export function resolveMode(
  env: NodeJS.ProcessEnv,
  _io: ModeIo,
  deps: ModeDeps
): Mode {
  const configTarget = deps.readConfigTarget(env);

  // 1. Explicit config opt-out wins over everything, including a live bridge.
  if (configTarget === "local") {
    return "local";
  }

  // 2. The cloud brain requires macOS (there is no Desktop elsewhere).
  if (!deps.isMac()) {
    return "local";
  }

  // 3. A LIVE ready bridge → cloud, for interactive AND non-interactive
  //    invocations alike. TTY-ness gates only the launch/poll hand-off, not
  //    turn eligibility.
  if (deps.liveBridgeAvailable()) {
    return "cloud";
  }

  // 4. Mac with no live bridge: onboarding (launch or guide toward Desktop).
  //    Never local — a product turn must not silently downgrade.
  return "onboarding";
}
