import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import {
  DesktopAppClientError,
  type DesktopAppClient,
  type DesktopProgressFrame,
  type DesktopStatus
} from "../desktop-app-client.js";
import {
  createDesktopTurnSource,
  type BridgeFrame,
  type DesktopTurnOutcome,
  type DesktopTurnSourceClient,
  type DesktopTurnSourceInput
} from "./desktop-turn-source.js";
import {
  handleInSessionConfirmation,
  type InSessionConfirmationAction,
  type InSessionConfirmationClient,
  type InSessionConfirmationIo
} from "./confirm-in-session.js";

/**
 * Forked desktop interactive loop for the cloud brain.
 *
 * This is the desktop counterpart to the local `onSubmitLine` shell, deliberately
 * STRIPPED of the local-only session machinery: no `@`-pin resolution, no
 * `/project` switching, no `applySessionPin` / `resetAgentRuntime`, no
 * `NoActiveProjectError` fail-close, no `/resume`. The cloud brain owns its own
 * active workspace inside Desktop, so the CLI never picks a project here.
 *
 * Each line opens ONE Desktop turn through the injected turn-source, feeds every
 * bridge event to the SAME `turnController.recordProgressEvent` the shared shell
 * uses, and threads a single `sessionId` across turns — resent only when the
 * turn-source actually issued one (a capability-gated, single-turn degrade lives
 * inside the turn-source, never here).
 */

/** The narrow slice of the turn-controller this loop drives. */
export interface DesktopTurnControllerLike {
  recordProgressEvent(event: ChatProgressEvent): void;
}

/**
 * The turn result this loop reads. A superset of the leaf {@link DesktopTurnSource}
 * outcome (`{ sessionId }`): the real/adapter turn-source MAY also surface the
 * terminal frame's `requires_confirmation` actions as `pendingConfirmations`
 * (already redacted by the client parser). The leaf's `{ sessionId }` return is
 * assignable here because `pendingConfirmations` is optional — an incapable
 * turn-source simply omits it and no confirmation fires.
 */
export interface DesktopInteractiveTurnResult {
  sessionId?: string;
  pendingConfirmations?: InSessionConfirmationAction[];
}

/** The turn-source this loop drives — a widened view of {@link DesktopTurnSource}. */
export interface DesktopInteractiveTurnSource {
  runTurn(
    message: string,
    sessionId: string | undefined,
    onEvent: (event: ChatProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DesktopInteractiveTurnResult>;
}

/** The TTY + client seam used to resolve an in-session confirmation. */
export interface DesktopInteractiveConfirmation {
  io: InSessionConfirmationIo;
  client: InSessionConfirmationClient;
}

/** Output sink for the loop's own system lines (help / turn errors). */
export interface DesktopInteractiveIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface DesktopInteractiveDeps {
  /** Session-negotiating turn-source (real client adapted, or a test fake). */
  turnSource: DesktopInteractiveTurnSource;
  /** Shared turn-controller — the same render/state sink the local shell feeds. */
  turnController: DesktopTurnControllerLike;
  /**
   * TTY + client seam for in-session confirmations. When a turn surfaces
   * `requires_confirmation` actions and this is provided, each is rendered,
   * prompted, and (on approval) confirmed in-session. Omit to skip confirmation
   * handling entirely.
   */
  confirmation?: DesktopInteractiveConfirmation;
  /**
   * Test seam: a fixed list of input lines to replay instead of a live readline
   * loop. Exactly one of `lines` / `readLines` is supplied by production wiring.
   */
  lines?: string[];
  /** Production line source: yields user input lines until EOF. */
  readLines?: () => AsyncIterable<string>;
  /** Abort signal shared across turns (Ctrl-C / detach). */
  signal?: AbortSignal;
}

const HELP_TEXT =
  "Infinite (cloud brain). Type a message to run a turn.\n" +
  "  /help   show this help\n" +
  "  /exit   leave the session\n";

const NEVER_ABORT = new AbortController().signal;

/**
 * Run the forked desktop interactive loop. Resolves when the line source is
 * exhausted or the user types `/exit` (or `/quit`).
 */
export async function runDesktopInteractive(
  _env: NodeJS.ProcessEnv,
  io: DesktopInteractiveIo,
  deps: DesktopInteractiveDeps
): Promise<void> {
  const signal = deps.signal ?? NEVER_ABORT;
  let sessionId: string | undefined;

  for await (const raw of resolveLines(deps)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line === "/exit" || line === "/quit") {
      return;
    }
    if (line === "/help") {
      io.writeOut(HELP_TEXT);
      continue;
    }

    try {
      const result = await deps.turnSource.runTurn(
        line,
        sessionId,
        (event) => deps.turnController.recordProgressEvent(event),
        signal
      );
      // Thread the session forward ONLY when Desktop issued one. An incapable
      // Desktop returns none; we must not fabricate/resend a stale id.
      if (result.sessionId) {
        sessionId = result.sessionId;
      }
      // A terminal frame may carry `requires_confirmation` actions. Render +
      // prompt + confirm each in-session, in order, when a confirmation seam is
      // wired. Without one (or with none pending), this is a no-op.
      if (deps.confirmation && result.pendingConfirmations?.length) {
        for (const action of result.pendingConfirmations) {
          await handleInSessionConfirmation(
            action,
            deps.confirmation.io,
            deps.confirmation.client,
            signal
          );
        }
      }
    } catch (error) {
      io.writeErr(`${errorText(error)}\n`);
    }
  }
}

async function* resolveLines(
  deps: DesktopInteractiveDeps
): AsyncIterable<string> {
  if (deps.lines) {
    for (const line of deps.lines) {
      yield line;
    }
    return;
  }
  if (deps.readLines) {
    yield* deps.readLines();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adapt the real {@link DesktopAppClient} onto the narrow
 * {@link DesktopTurnSourceClient} the turn-source consumes.
 *
 * The two contracts differ deliberately: the turn-source expects a normalized
 * 5-kind {@link BridgeFrame} stream whose terminal `done` frame carries the
 * `sessionId`, while the real client streams progress-ONLY frames and folds the
 * terminal outcome into its `turn(...)` RETURN value. This adapter bridges that
 * gap by (a) forwarding each progress frame as `{ kind: "progress" }`, and
 * (b) surfacing the terminal result BOTH as a synthetic `done` frame AND as the
 * `turn(...)` outcome — the turn-source reads either, so both are populated.
 *
 * `contextRevision` is captured from the `status()` call the interactive entry
 * makes before any turn (it also negotiates `sessionCapable`).
 */
export function adaptDesktopClientToTurnSource(
  client: DesktopAppClient,
  contextRevision: string
): DesktopTurnSourceClient {
  return {
    get sessionCapable() {
      return client.sessionCapable;
    },
    async turn(
      input: DesktopTurnSourceInput,
      onFrame: (frame: BridgeFrame) => void
    ): Promise<DesktopTurnOutcome> {
      const result = await client.turn(
        {
          message: input.message,
          expectedContextRevision: contextRevision,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          signal: input.signal
        },
        (frame: DesktopProgressFrame) => {
          onFrame({ kind: "progress", data: frame.data });
        }
      );
      // Synthesize the terminal frame the turn-source's contract expects. The
      // `actionCalls` ride along for in-session confirmation (Task 4); the
      // sessionId is what this task threads across turns.
      onFrame({
        kind: "done",
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.message ? { message: result.message } : {}),
        actionCalls: result.actionCalls,
        data: {
          ...(result.turnId ? { turnId: result.turnId } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {})
        }
      });
      return result.sessionId ? { sessionId: result.sessionId } : {};
    }
  };
}

// ── Per-turn revalidation (spec §6.8) ────────────────────────────────────────

/** The slice of a live-bridge resolution the runner consumes (Task 2.2). */
export interface LiveBridgeResolution {
  descriptor: { bootId: string };
  client: DesktopAppClient;
}

export interface DesktopSessionTurnDeps {
  /**
   * Per-turn live-bridge resolver: RE-READS `bridge.json` (never a client
   * captured at session start — a Desktop restart changes port AND token) and
   * returns a bootId-matched client, or `null` when Desktop is not running.
   * Production wiring passes `() => resolveLiveBridge(env)`.
   */
  resolveBridge: () => LiveBridgeResolution | null;
  /** Test seam: build the turn-source over a client + fresh contextRevision. */
  createTurnSource?: (
    client: DesktopAppClient,
    contextRevision: string
  ) => DesktopInteractiveTurnSource;
}

/**
 * A submitted line's outcome: `{ busy: true }` when a turn is already in
 * flight (the line is NOT sent — no corrupt interleave), otherwise the turn
 * result. A failed turn REJECTS with the transport/remote error and is never
 * auto-resent — a possibly-accepted turn could double a write, so replay is
 * user-initiated only.
 */
export type DesktopSessionTurnOutcome =
  | { busy: true }
  | ({ busy?: false } & DesktopInteractiveTurnResult);

export interface DesktopSessionTurnRunner {
  /** Run one turn with a full status preflight. See {@link DesktopSessionTurnOutcome}. */
  turn(
    message: string,
    onEvent?: (event: ChatProgressEvent) => void,
    signal?: AbortSignal
  ): Promise<DesktopSessionTurnOutcome>;
  /** The session threading across turns (reset on any scope change). */
  sessionId(): string | undefined;
  /** Confirm against the client that ran the LAST turn (handles are per-boot). */
  confirm: InSessionConfirmationClient["confirm"];
}

/**
 * Session-owning turn runner with a PER-TURN preflight. Every submitted line:
 *  1. rejects immediately with `{ busy: true }` while a turn is in flight;
 *  2. re-resolves the live bridge (fresh `bridge.json`; bootId-matched client);
 *  3. calls `/v1/status` and surfaces the precise not-ready state as a typed
 *     error (never a hang, never a silent local fallback);
 *  4. resets `sessionId` when the turn SCOPE changed since the last turn —
 *     boot id, `contextRevision`, workspace, or provider/model. (Auth-context
 *     changes surface through readiness + `contextRevision`, which Desktop
 *     bumps on every authority change.) A switch starts a fresh conversation
 *     instead of leaking the old one into a new scope;
 *  5. runs the turn against the FRESH `contextRevision`, threading the
 *     Desktop-issued session forward on success.
 * A failed turn propagates its error with the in-flight flag cleared and is
 * NEVER automatically replayed.
 */
export function createDesktopSessionTurnRunner(
  deps: DesktopSessionTurnDeps
): DesktopSessionTurnRunner {
  const buildTurnSource =
    deps.createTurnSource ??
    ((client: DesktopAppClient, contextRevision: string) =>
      createDesktopTurnSource(
        adaptDesktopClientToTurnSource(client, contextRevision)
      ));
  let inFlight = false;
  let sessionId: string | undefined;
  let lastScope: string | undefined;
  let lastClient: DesktopAppClient | undefined;

  return {
    sessionId: () => sessionId,

    confirm(input) {
      // Confirmation handles are minted by the boot that ran the turn; resolve
      // them against that same client, never a re-read one.
      if (!lastClient) {
        return Promise.reject(
          new DesktopAppClientError(
            "desktop_confirmation_invalid",
            "No Desktop turn has run in this session to confirm."
          )
        );
      }
      return lastClient.confirm(input);
    },

    async turn(message, onEvent, signal) {
      if (inFlight) {
        return { busy: true };
      }
      inFlight = true;
      try {
        const resolved = deps.resolveBridge();
        if (!resolved) {
          throw new DesktopAppClientError(
            "desktop_not_running",
            "Infinite Desktop is not running for this runtime. Start Desktop and try again."
          );
        }
        const status = await resolved.client.status();
        if (!status.ready) {
          throw new DesktopAppClientError(
            status.error?.code ?? "desktop_not_ready",
            status.error?.message ?? "Infinite Desktop Cmd+L is not ready."
          );
        }
        const scope = turnScopeFingerprint(resolved.descriptor.bootId, status);
        if (lastScope !== undefined && scope !== lastScope) {
          sessionId = undefined;
        }
        lastScope = scope;
        lastClient = resolved.client;
        const source = buildTurnSource(resolved.client, status.contextRevision);
        const result = await source.runTurn(
          message,
          sessionId,
          onEvent ?? (() => {}),
          signal ?? NEVER_ABORT
        );
        if (result.sessionId) {
          sessionId = result.sessionId;
        }
        return result;
      } finally {
        inFlight = false;
      }
    }
  };
}

/**
 * The identity of a turn's scope. Any component changing between turns means
 * the prior conversation belongs to a different context and its session id
 * must not be resent.
 */
function turnScopeFingerprint(bootId: string, status: DesktopStatus): string {
  return JSON.stringify([
    bootId,
    status.contextRevision,
    status.workspace?.id ?? null,
    status.workspace?.name ?? null,
    status.provider?.id ?? null,
    status.provider?.model ?? null
  ]);
}
