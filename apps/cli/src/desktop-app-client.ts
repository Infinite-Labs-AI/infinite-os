import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats
} from "node:fs";
import { dirname, join } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import { infiniteOsHome } from "@infinite-os/config";
import {
  APP_OPEN_CAPABILITY,
  CONFIRM_FIELDS_CAPABILITY,
  CONFIRM_STREAM_CAPABILITY,
  GENERAL_MARKETING_PROFILE,
  INTERACTIVE_WORKSPACE_CAPABILITY,
  LEGACY_GROWTH_OPERATOR_PROFILE,
  RESULT_VIEW_CAPABILITY,
  type AnswerViewV1,
  type AppOpenRequestV1,
  type ApprovalFieldAnswerV1,
  type InteractiveWorkspaceRequestV1,
  type InteractiveWorkspaceStatusV1,
} from "@infinite-os/types";
import {
  decodeAnswerView,
  isToolViewFrameData
} from "./desktop/answer-view-decode.js";
import {
  askConfirmDecision,
  askDismissOnly,
  confirmResultLines,
  leftForLaterLine
} from "./desktop/confirm-result-lines.js";
import {
  DISMISS_ONLY_QUESTION,
  needsTypedField,
  typedFieldLine
} from "./desktop/confirm-in-session.js";
import {
  STATUS_CONNECTIONS_CAPABILITY,
  decodeStatusConnections,
  type DesktopConnection
} from "./desktop/status-connections.js";
import { STEP_WORDS_CAPABILITY } from "./desktop/step-words.js";
import { negotiateInteractiveWorkspace } from "./desktop/interactive-protocol.js";
import { plainToolProgressLine } from "./formatting/progress.js";
import {
  boundedTerminalText,
  terminalOutputText,
  terminalText
} from "./desktop/terminal-text.js";

const PROTOCOL_VERSION = 1;
const DESCRIPTOR_SCHEMA_VERSION = 1;
const DESKTOP_SERVICE = "infinite-desktop-cmdl";
const REQUIRED_CAPABILITIES = [
  "status.v1",
  "turn.ndjson.v1",
  "confirm.v1"
] as const;
const CONFIRM_IDEMPOTENCY_CAPABILITY = "confirm.idempotency.v1";
const TURN_SESSION_CAPABILITY = "turn.session.v1";
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_CONFIRMATION_DETAILS = 12;
const MAX_CONFIRMATION_LABEL_CHARS = 80;
const MAX_CONFIRMATION_VALUE_CHARS = 240;
const MAX_CONFIRMATION_INPUT_DEPTH = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const HIERARCHICAL_URI_RE =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/gu;
const PARSER_NORMALIZED_URI_RE = /(?:ftp|https?|wss?):[^\s<>"'`]+/giu;
const CANONICAL_AUTHORITY_URI_RE =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\\]/u;
const URI_OBFUSCATING_CHAR_RE = /(?:[^\S ]|\p{Cc}|\p{Cf})/u;
const URI_OBFUSCATING_CHAR_RE_GLOBAL = /(?:[^\S ]|\p{Cc}|\p{Cf})/gu;

export class DesktopAppClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /**
     * The decoded receipt view a failed `/v1/confirm` answer carried (an
     * expired card, a write that was not sent, one that may have happened).
     * Only `confirm()` sets it, and only when the view decoded.
     */
    public readonly view?: AnswerViewV1,
    /**
     * Set only on a streamed confirm (confirm.stream.v1) that ended in an
     * `error` before any receipt that the app marked `notSent: true`, or
     * whose code is refused before anything resolves (`field_invalid`,
     * `receipt_view_unavailable`): the card was not done. Never set when the
     * outcome is unknown.
     */
    public readonly nothingRan?: true
  ) {
    super(message);
    this.name = "DesktopAppClientError";
  }
}

class ConfirmationResponseBodyLost extends Error {
  constructor() {
    super("Confirmation response body was interrupted.");
    this.name = "ConfirmationResponseBodyLost";
  }
}

class RequestDeadlineExceeded extends Error {
  constructor() {
    super("Desktop request deadline exceeded.");
    this.name = "RequestDeadlineExceeded";
  }
}

export interface DesktopBridgeDescriptor {
  schemaVersion: 1;
  service: typeof DESKTOP_SERVICE;
  protocol: { min: number; max: number };
  capabilities: string[];
  url: string;
  pid: number;
  bootId: string;
  desktopVersion: string;
  runtime: { variant: string; stateLabel: string };
  token: string;
  startedAt: string;
}

export interface DesktopStatus {
  service: typeof DESKTOP_SERVICE;
  bootId: string;
  protocol: { min: number; max: number };
  capabilities: string[];
  ready: boolean;
  contextRevision: string;
  provider?: { id: string; model?: string };
  workspace?: { id?: string; name: string };
  error?: { code: string; message: string };
  interactive?: InteractiveWorkspaceStatusV1;
  /**
   * The workspace's sources as the app names them, in the app's order. Present
   * only when the descriptor and this status both advertise
   * `status.connections.v1` and the status carries a list.
   */
  connections?: DesktopConnection[];
}

export interface DesktopProgressFrame {
  protocolVersion: 1;
  requestId: string;
  sequence: number;
  kind: "progress";
  data: unknown;
}

export interface DesktopTurnResult {
  turnId?: string;
  message: string;
  actionCalls: unknown[];
  provenance?: unknown[];
  sessionId?: string;
}

/**
 * The `/v1/confirm` JSON exactly as Desktop sent it (top-level `ok`,
 * `receipt`, …), with `view` replaced in place by the decoded receipt view.
 * A `view` that does not decode is removed, so `view` is then `undefined`.
 * There is no wrapper: callers read the same fields an old Desktop sends.
 */
export type DesktopConfirmResult = Record<string, unknown> & {
  ok: true;
  view?: AnswerViewV1;
  /**
   * confirm.stream.v1 only: the agent's follow-up after the receipt (its
   * `done` frame), in the same turn as the card. Absent on a plain confirm.
   */
  followUp?: DesktopTurnResult;
  /**
   * confirm.stream.v1 only: the follow-up failed or was cut off AFTER the
   * receipt. The receipt still stands (the write is done); this is only the
   * follow-up's error.
   */
  followUpError?: { code: string; message: string };
};

/** What `/v1/open` (app.open.v1) did with a place: the app-link router's status. */
export type AppOpenStatus = "opened" | "wrong_workspace" | "signed_out" | "unavailable";
export interface AppOpenResult {
  /** True only when the app opened the place (`status === "opened"`). */
  ok: boolean;
  status: AppOpenStatus;
}

export interface DesktopAppClient {
  /**
   * Whether the Desktop negotiated `turn.session.v1` (descriptor ∧ status
   * capabilities). Only meaningful after `status()` has resolved; false until
   * then. Callers gate `sessionId` resend on this — an incapable Desktop gets
   * a single-turn degrade, NOT a typed error.
   */
  readonly sessionCapable: boolean;
  /**
   * Whether the Desktop negotiated `result.view.v1` (descriptor ∧ status).
   * When true, `turn()` sends `accept: ["result.view.v1"]`, so the stream
   * carries `tool.view` frames and pending action calls carry `view`. False
   * until `status()` resolves; an old Desktop never gets `accept`.
   */
  readonly viewsCapable: boolean;
  /**
   * Whether the Desktop negotiated `step.words.v1` (descriptor ∧ status). When
   * true, `turn()` adds it to `accept`, so the turn's `tool.start` and
   * `tool.complete` frames carry the app's own words for each step. False
   * until `status()` resolves; an old Desktop is never asked.
   */
  readonly stepWordsCapable: boolean;
  /** Whether the Desktop negotiated `confirm.fields.v1` (descriptor ∧ status). */
  readonly confirmFieldsCapable: boolean;
  /**
   * Whether the Desktop negotiated `app.open.v1` (descriptor ∧ status): `o`
   * opens a place in the app through `/v1/open`. False until `status()`.
   */
  readonly appOpenCapable: boolean;
  /**
   * Whether the Desktop negotiated `confirm.stream.v1` (descriptor ∧ status):
   * a card's confirm can stream its receipt, then the agent's follow-up.
   */
  readonly confirmStreamCapable: boolean;
  /** Negotiated only when descriptor and status both advertise the v1 contract. */
  readonly interactiveWorkspace: InteractiveWorkspaceStatusV1 | undefined;
  status(): Promise<DesktopStatus>;
  turn(
    input: {
      message: string;
      expectedContextRevision: string;
      /** Prior session to continue; sent only when the Desktop is capable. */
      sessionId?: string;
      signal?: AbortSignal;
      interactive?: InteractiveWorkspaceRequestV1;
    },
    onProgress?: (frame: DesktopProgressFrame) => void
  ): Promise<DesktopTurnResult>;
  /**
   * Resolve a pending card. `fields` answers the card's `approval.fields`;
   * against a Desktop without `confirm.fields.v1` it throws
   * `desktop_update_required` before anything is sent.
   */
  confirm(input: {
    turnId: string;
    confirmationHandle: string;
    decision: "approve" | "decline";
    fields?: Record<string, ApprovalFieldAnswerV1>;
    signal?: AbortSignal;
    /**
     * Ask for the streamed confirm (confirm.stream.v1): sent only when the
     * Desktop negotiated it AND views (the bridge streams only a card from a
     * turn that accepted views). Otherwise the plain JSON confirm runs.
     */
    stream?: boolean;
    /** Streamed only: the receipt, the moment it arrives (before the follow-up). */
    onReceipt?: (receipt: DesktopConfirmResult) => void;
    /** Streamed only: each follow-up progress frame after the receipt, in order. */
    onProgress?: (frame: DesktopProgressFrame) => void;
  }): Promise<DesktopConfirmResult>;
  /**
   * Open a place in the app (`o`; app.open.v1): `{ protocolVersion: 1,
   * place, params }` and nothing else, never a URL. Navigation only. Throws
   * `desktop_update_required` before sending anything on a Desktop without
   * the capability.
   */
  openPlace(request: AppOpenRequestV1, options?: { signal?: AbortSignal }): Promise<AppOpenResult>;
}

interface DesktopAppEnv {
  GROWTH_OS_HOME?: string;
  GROWTH_OS_CLI_NONINTERACTIVE?: string;
  HOME?: string;
}

interface DesktopAppClientOptions {
  fetchImpl?: typeof fetch;
  randomId?: () => string;
  requestTimeoutMs?: number;
}

interface DesktopAppIo {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

interface RunDesktopAppCommandOptions extends DesktopAppClientOptions {
  io?: DesktopAppIo;
  /** Decide a card directly ("pending" leaves it unanswered). Overrides `promptAnswer`. */
  promptConfirmation?: (
    action: PendingConfirmation
  ) => Promise<"approve" | "decline" | "pending">;
  /** Ask one question on the TTY (defaults to a readline prompt on stdin). */
  promptAnswer?: (question: string) => Promise<string>;
  signal?: AbortSignal;
}

interface PendingConfirmation {
  actionId: string;
  confirmationHandle: string;
  summary: string;
  confirmationDetails: ConfirmationDetail[];
  /** The approval view's expiry, when the app sent a view. */
  expiresAt?: string;
  /**
   * Set when the card asks for a typed value (a required field) this prompt
   * cannot send: the words saying where to answer it. Such a card is never
   * approved here, only dismissed or left.
   */
  typedFieldWords?: string;
}

interface ConfirmationDetail {
  label: string;
  value: string;
}

export function readDesktopBridgeDescriptor(
  env: DesktopAppEnv
): DesktopBridgeDescriptor {
  const descriptorPath = join(
    infiniteOsHome(env as NodeJS.ProcessEnv),
    "desktop-cmdl",
    "bridge.json"
  );
  const bridgeDirectory = dirname(descriptorPath);
  let directoryStat: Stats;
  try {
    directoryStat = lstatSync(bridgeDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw desktopNotRunning();
    }
    throw new DesktopAppClientError(
      "desktop_descriptor_unsafe",
      "Infinite Desktop bridge discovery failed its local file safety checks."
    );
  }

  assertOwnerOnlyDirectory(directoryStat);
  let descriptorFd: number | undefined;
  try {
    descriptorFd = openSync(
      descriptorPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw desktopNotRunning();
    }
    throw new DesktopAppClientError(
      "desktop_descriptor_unsafe",
      "Infinite Desktop bridge descriptor is not a safe regular file."
    );
  }

  try {
    const descriptorStat = fstatSync(descriptorFd);
    assertOwnerOnlyRegularFile(descriptorStat);
    if (descriptorStat.size > MAX_DESCRIPTOR_BYTES) {
      throw new DesktopAppClientError(
        "desktop_descriptor_invalid",
        "Infinite Desktop bridge descriptor is too large."
      );
    }
    return parseDescriptor(JSON.parse(readFileSync(descriptorFd, "utf8")));
  } catch (error) {
    if (error instanceof DesktopAppClientError) throw error;
    throw new DesktopAppClientError(
      "desktop_descriptor_invalid",
      "Infinite Desktop bridge descriptor is malformed."
    );
  } finally {
    closeSync(descriptorFd);
  }
}

export function createDesktopAppClient(
  env: DesktopAppEnv,
  options: DesktopAppClientOptions = {}
): DesktopAppClient {
  return createClientFromDescriptor(readDesktopBridgeDescriptor(env), options);
}

export interface ResolveLiveBridgeOptions extends DesktopAppClientOptions {
  /**
   * Test seam: descriptor reader override. Returns `null` when no descriptor
   * is present. The default wraps {@link readDesktopBridgeDescriptor}, mapping
   * only the `desktop_not_running` miss to `null` — every other failure
   * (unsafe/malformed/incompatible descriptor) still throws its typed error.
   */
  readDescriptor?: (env: DesktopAppEnv) => DesktopBridgeDescriptor | null;
}

/** Module-level client cache keyed by the descriptor's bootId (one home per process). */
let liveBridgeCache:
  | { bootId: string; client: DesktopAppClient }
  | undefined;

/**
 * Per-turn live-bridge resolver (spec §6.8): RE-READ `bridge.json` on every
 * call — never trust a client captured at session start, because a Desktop
 * restart changes the port AND the bearer token, so `status()` on the stale
 * client can never reach the new bridge. When the freshly read descriptor
 * carries the same `bootId` as the cached client, the client is reused
 * (url/token cannot change within one Desktop boot); a new `bootId` constructs
 * a fresh client. Returns `null` when no descriptor is present (Desktop not
 * running) — callers surface guidance, never silently fall back to local.
 */
export function resolveLiveBridge(
  env: DesktopAppEnv,
  options: ResolveLiveBridgeOptions = {}
): { descriptor: DesktopBridgeDescriptor; client: DesktopAppClient } | null {
  const read = options.readDescriptor ?? readDescriptorOrNull;
  const descriptor = read(env);
  if (!descriptor) {
    return null;
  }
  if (liveBridgeCache?.bootId !== descriptor.bootId) {
    liveBridgeCache = {
      bootId: descriptor.bootId,
      client: createClientFromDescriptor(descriptor, options)
    };
  }
  return { descriptor, client: liveBridgeCache.client };
}

function readDescriptorOrNull(
  env: DesktopAppEnv
): DesktopBridgeDescriptor | null {
  try {
    return readDesktopBridgeDescriptor(env);
  } catch (error) {
    if (
      error instanceof DesktopAppClientError &&
      error.code === "desktop_not_running"
    ) {
      return null;
    }
    throw error;
  }
}

function createClientFromDescriptor(
  descriptor: DesktopBridgeDescriptor,
  options: DesktopAppClientOptions = {}
): DesktopAppClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const randomId = options.randomId ?? randomUUID;
  const requestTimeoutMs = positiveTimeout(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  let confirmationReplaySafe = false;
  let sessionCapable = false;
  let viewsCapable = false;
  let stepWordsCapable = false;
  let confirmFieldsCapable = false;
  let appOpenCapable = false;
  let confirmStreamCapable = false;
  let interactiveWorkspace: InteractiveWorkspaceStatusV1 | undefined;
  let statusCapabilities: string[] = [];
  const negotiated = (status: DesktopStatus, capability: string) =>
    descriptor.capabilities.includes(capability) && status.capabilities.includes(capability);

  return {
    get sessionCapable() {
      return sessionCapable;
    },
    get viewsCapable() {
      return viewsCapable;
    },
    get stepWordsCapable() {
      return stepWordsCapable;
    },
    get confirmFieldsCapable() {
      return confirmFieldsCapable;
    },
    get appOpenCapable() {
      return appOpenCapable;
    },
    get confirmStreamCapable() {
      return confirmStreamCapable;
    },
    get interactiveWorkspace() {
      return interactiveWorkspace;
    },

    async status() {
      confirmationReplaySafe = false;
      sessionCapable = false;
      viewsCapable = false;
      stepWordsCapable = false;
      confirmFieldsCapable = false;
      appOpenCapable = false;
      confirmStreamCapable = false;
      interactiveWorkspace = undefined;
      statusCapabilities = [];
      const deadline = createRequestDeadline(undefined, requestTimeoutMs);
      try {
        const response = await authenticatedFetch(
          descriptor,
          fetchImpl,
          "/v1/status",
          {
            method: "GET",
            signal: deadline.signal,
            headers: { accept: "application/json" }
          },
          deadline
        );
        const payload = await deadline.race(readJsonResponse(response));
        const status = parseStatus(unwrapData(payload), descriptor);
        statusCapabilities = status.capabilities;
        confirmationReplaySafe =
          descriptor.capabilities.includes(CONFIRM_IDEMPOTENCY_CAPABILITY) &&
          status.capabilities.includes(CONFIRM_IDEMPOTENCY_CAPABILITY);
        sessionCapable =
          descriptor.capabilities.includes(TURN_SESSION_CAPABILITY) &&
          status.capabilities.includes(TURN_SESSION_CAPABILITY);
        viewsCapable =
          descriptor.capabilities.includes(RESULT_VIEW_CAPABILITY) &&
          status.capabilities.includes(RESULT_VIEW_CAPABILITY);
        stepWordsCapable =
          descriptor.capabilities.includes(STEP_WORDS_CAPABILITY) &&
          status.capabilities.includes(STEP_WORDS_CAPABILITY);
        confirmFieldsCapable =
          descriptor.capabilities.includes(CONFIRM_FIELDS_CAPABILITY) &&
          status.capabilities.includes(CONFIRM_FIELDS_CAPABILITY);
        appOpenCapable = negotiated(status, APP_OPEN_CAPABILITY);
        confirmStreamCapable = negotiated(status, CONFIRM_STREAM_CAPABILITY);
        if (
          status.ready &&
          descriptor.capabilities.includes(INTERACTIVE_WORKSPACE_CAPABILITY) &&
          status.capabilities.includes(INTERACTIVE_WORKSPACE_CAPABILITY)
        ) {
          if (!status.interactive) throw invalidResponse();
          interactiveWorkspace = status.interactive;
        }
        return status;
      } catch (error) {
        throw mapDeadlineError(error, deadline);
      } finally {
        deadline.dispose();
      }
    },

    async turn(input, onProgress) {
      const message = input.message.trim();
      if (!message) {
        throw new DesktopAppClientError(
          "desktop_app_usage",
          "Usage: infinite app <message>"
        );
      }
      if (!input.expectedContextRevision.trim()) {
        throw new DesktopAppClientError(
          "desktop_response_invalid",
          "Infinite Desktop did not provide a usable context revision."
        );
      }
      const requestId = randomId();
      if (input.interactive) {
        const negotiation = negotiateInteractiveWorkspace({
          descriptorCapabilities: descriptor.capabilities,
          statusCapabilities,
          status: interactiveWorkspace,
          requestedProfile: input.interactive.profile,
        });
        if (!negotiation.ok) {
          throw new DesktopAppClientError(
            negotiation.reason === "profile_unsupported"
              ? "interactive_profile_unsupported"
              : "interactive_capability_unavailable",
            negotiation.reason === "profile_unsupported"
              ? "Infinite Desktop does not support the requested interactive profile."
              : "Infinite Desktop did not negotiate interactive workspace metadata.",
          );
        }
      }
      // Opt-ins are per turn: only what this Desktop advertised (descriptor ∧
      // status) is asked for. A bridge refuses an `accept` entry it does not
      // advertise, and an old Desktop sees the exact legacy body (no `accept`).
      const accept = [
        ...(viewsCapable ? [RESULT_VIEW_CAPABILITY] : []),
        ...(stepWordsCapable ? [STEP_WORDS_CAPABILITY] : [])
      ];
      const deadline = createRequestDeadline(input.signal, requestTimeoutMs);
      try {
        const response = await authenticatedFetch(
          descriptor,
          fetchImpl,
          "/v1/turn",
          {
            method: "POST",
            signal: deadline.signal,
            headers: {
              accept: "application/x-ndjson",
              "content-type": "application/json"
            },
            body: JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              message,
              expectedContextRevision: input.expectedContextRevision,
              ...(nonEmptyString(input.sessionId)
                ? { sessionId: nonEmptyString(input.sessionId) }
                : {}),
              ...(input.interactive ? { interactive: input.interactive } : {}),
              ...(accept.length ? { accept } : {})
            })
          },
          deadline
        );
        deadline.clearTimer();
        assertContentType(response, "application/x-ndjson");
        return await deadline.race(
          readTurnStream(response, requestId, onProgress)
        );
      } catch (error) {
        throw mapDeadlineError(error, deadline);
      } finally {
        deadline.dispose();
      }
    },

    async confirm(input) {
      if (!input.turnId.trim() || !input.confirmationHandle.trim()) {
        throw new DesktopAppClientError(
          "desktop_confirmation_invalid",
          "Desktop returned an invalid confirmation reference."
        );
      }
      const fields =
        input.fields && Object.keys(input.fields).length > 0
          ? input.fields
          : undefined;
      if (fields && !confirmFieldsCapable) {
        // Never drop the answers and send a bare yes: an old Desktop would
        // run the card with its frozen values instead of the user's.
        throw new DesktopAppClientError(
          "desktop_update_required",
          "This answer needs a newer Infinite Desktop. Update Desktop and try again."
        );
      }
      const requestId = randomId();
      if (input.stream === true && confirmStreamCapable && viewsCapable) {
        return await streamConfirmation(
          descriptor,
          fetchImpl,
          requestTimeoutMs,
          requestId,
          { ...input, ...(fields ? { fields } : {}) }
        );
      }
      const sendConfirmation = async () => {
        const deadline = createRequestDeadline(input.signal, requestTimeoutMs);
        try {
          const response = await authenticatedFetch(
            descriptor,
            fetchImpl,
            "/v1/confirm",
            {
              method: "POST",
              signal: deadline.signal,
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "x-request-id": requestId
              },
              body: JSON.stringify({
                protocolVersion: PROTOCOL_VERSION,
                requestId,
                turnId: input.turnId,
                confirmationHandle: input.confirmationHandle,
                decision: input.decision,
                ...(fields ? { fields } : {})
              })
            },
            deadline
          );
          return await deadline.race(
            readConfirmationJsonResponse(response, input.signal)
          );
        } catch (error) {
          throw mapDeadlineError(error, deadline);
        } finally {
          deadline.dispose();
        }
      };
      let rawPayload: unknown;
      try {
        rawPayload = await sendConfirmation();
      } catch (error) {
        if (!isRetrySafeConfirmationResponseLoss(error, input.signal)) {
          throw error;
        }
        if (!confirmationReplaySafe) throw confirmationOutcomeUnknown();
        try {
          rawPayload = await sendConfirmation();
        } catch (retryError) {
          if (isRetrySafeConfirmationResponseLoss(retryError, input.signal)) {
            throw confirmationOutcomeUnknown();
          }
          throw retryError;
        }
      }
      const payload = selectConfirmationEnvelope(rawPayload);
      // A failed resolution keeps rejecting with its typed code, and carries
      // the receipt view (expired, not sent, not sure it happened) so a
      // renderer prints the same receipt Cmd+L shows.
      const failureView = isRecord(payload)
        ? decodeAnswerView(payload.view) ?? undefined
        : undefined;
      if (!isRecord(payload) || payload.ok !== true) {
        const error = remotePayloadError(
          payload,
          "desktop_confirmation_failed",
          "Desktop could not resolve the confirmation."
        );
        throw new DesktopAppClientError(error.code, error.message, failureView);
      }
      const executionFailure = findNestedExecutionFailure(payload);
      if (executionFailure) {
        throw new DesktopAppClientError(
          executionFailure.code ?? "desktop_confirmation_execution_failed",
          executionFailure.message ??
            "Desktop accepted the confirmation but could not execute the action.",
          failureView
        );
      }
      return decodeConfirmView(payload as DesktopConfirmResult);
    },

    async openPlace(request, options = {}) {
      if (!appOpenCapable) {
        throw new DesktopAppClientError(
          "desktop_update_required",
          "Opening places from the terminal needs a newer Infinite Desktop. Update Desktop and try again."
        );
      }
      const place = nonEmptyString(request.place);
      if (!place) {
        throw new DesktopAppClientError(
          "desktop_app_usage",
          "There is no app place to open here."
        );
      }
      // Only string params cross, and never a URL: the place and its params
      // are the whole request (the bridge strips app-link URLs and refuses
      // any other key).
      const params = isRecord(request.params)
        ? Object.fromEntries(
            Object.entries(request.params).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined;
      const requestId = randomId();
      const deadline = createRequestDeadline(options.signal, requestTimeoutMs);
      try {
        const response = await authenticatedFetch(
          descriptor,
          fetchImpl,
          "/v1/open",
          {
            method: "POST",
            signal: deadline.signal,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "x-request-id": requestId
            },
            body: JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              place,
              ...(params && Object.keys(params).length ? { params } : {})
            })
          },
          deadline
        );
        const payload = unwrapData(await deadline.race(readJsonResponse(response)));
        const status = isRecord(payload) && typeof payload.status === "string" && APP_OPEN_STATUSES.has(payload.status)
          ? (payload.status as AppOpenStatus)
          : "unavailable";
        return { ok: status === "opened", status };
      } catch (error) {
        throw mapDeadlineError(error, deadline);
      } finally {
        deadline.dispose();
      }
    }
  };
}

const APP_OPEN_STATUSES: ReadonlySet<string> = new Set<AppOpenStatus>([
  "opened",
  "wrong_workspace",
  "signed_out",
  "unavailable"
]);

/**
 * Stream errors before any receipt that prove nothing was sent by their code
 * alone: a card's answer refused before anything resolves (`field_invalid`)
 * and a receipt view that could not be built before anything resolves
 * (`receipt_view_unavailable`). Every other code proves nothing by itself.
 * The bridge's refusal frame passes ANY no-receipt result's own code through,
 * and the app trusts each of its not-sent codes (its ledger's
 * NOT_SENT_OUTCOME_CODES: `stale_turn_context`, `local_provider_busy`, …) only
 * together with its own pre-send mark, which can come after the write was
 * handed to the executor. So the terminal says "Not done" only when the frame
 * carries that mark (`notSent: true`, see `streamRefusalNotSent`) or the code
 * is one of these; anything else keeps the neutral `! <app's words>` (not sure
 * it happened). An older desktop never sends the mark, so its refusals read as
 * unsure, which is the honest answer. This is an allowlist, never a denylist.
 */
const STREAM_NOT_RUN_CODES: ReadonlySet<string> = new Set([
  "field_invalid",
  "receipt_view_unavailable"
]);

/** The app's own pre-send mark on a refusal frame (`notSent: true`, beside its code, or on its `error`). */
function streamRefusalNotSent(data: unknown): boolean {
  const source = isRecord(data) && isRecord(data.error) ? data.error : data;
  return isRecord(source) && source.notSent === true;
}

/**
 * confirm.stream.v1: `/v1/confirm` with `stream: true` answers NDJSON. The
 * first frame that counts is the `action.receipt` (`{ ...result, view }` is
 * exactly what a plain confirm answers); then the agent's follow-up frames;
 * then one terminal frame. An `error` after the receipt never undoes it; an
 * `error` with no receipt before it means nothing ran only when the app marks
 * it `notSent` or its code proves it (STREAM_NOT_RUN_CODES); any other is unsure. A stream lost
 * before its receipt is an unknown outcome, never a retry.
 */
async function streamConfirmation(
  descriptor: DesktopBridgeDescriptor,
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
  requestId: string,
  input: Parameters<DesktopAppClient["confirm"]>[0]
): Promise<DesktopConfirmResult> {
  let receipt: DesktopConfirmResult | undefined;
  let receiptFailure: DesktopAppClientError | undefined;
  const onFrame = (frame: DesktopProgressFrame) => {
    const data = frame.data;
    if (!receipt && !receiptFailure) {
      // Only the first receipt counts; anything before it (a queued note) is not the follow-up.
      if (isRecord(data) && data.type === "action.receipt") {
        const outcome = receiptOutcome(data);
        if (outcome instanceof DesktopAppClientError) {
          receiptFailure = outcome;
        } else {
          receipt = outcome;
          input.onReceipt?.(outcome);
        }
      }
      return;
    }
    input.onProgress?.(frame);
  };
  const deadline = createRequestDeadline(input.signal, requestTimeoutMs);
  let terminal: { kind: "done" | "error"; data: unknown } | undefined;
  let lost: unknown;
  try {
    const response = await authenticatedFetch(
      descriptor,
      fetchImpl,
      "/v1/confirm",
      {
        method: "POST",
        signal: deadline.signal,
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "x-request-id": requestId
        },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          turnId: input.turnId,
          confirmationHandle: input.confirmationHandle,
          decision: input.decision,
          ...(input.fields ? { fields: input.fields } : {}),
          stream: true
        })
      },
      deadline
    );
    // The write keeps a plain confirm's lack of a deadline once accepted; the
    // bridge bounds the follow-up itself.
    deadline.clearTimer();
    assertContentType(response, "application/x-ndjson");
    terminal = await deadline.race(readFrames(response, requestId, onFrame));
  } catch (error) {
    lost = mapDeadlineError(error, deadline);
  } finally {
    deadline.dispose();
  }

  const settled = receipt ?? receiptFailure;
  if (!settled) {
    if (lost !== undefined) {
      // Nothing was answered: a typed refusal before the stream (4xx) keeps its code; a lost stream is unknown.
      if (lost instanceof DesktopAppClientError && !STREAM_LOSS_CODES.has(lost.code)) throw lost;
      throw confirmationOutcomeUnknown();
    }
    if (terminal?.kind === "error") {
      const error = remotePayloadError(
        terminal.data,
        "desktop_confirmation_failed",
        "Desktop could not resolve the confirmation."
      );
      throw new DesktopAppClientError(
        error.code,
        error.message,
        undefined,
        streamRefusalNotSent(terminal.data) || STREAM_NOT_RUN_CODES.has(error.code) ? true : undefined
      );
    }
    // A `done` with no receipt before it: the bridge never sends one, so what happened is not known.
    throw confirmationOutcomeUnknown();
  }

  let followUp: DesktopTurnResult | undefined;
  let followUpError: { code: string; message: string } | undefined;
  if (lost !== undefined) {
    followUpError = errorWords(lost, "desktop_stream_invalid", "The follow-up stopped before it finished.");
  } else if (terminal?.kind === "error") {
    const error = remotePayloadError(terminal.data, "desktop_turn_failed", "The follow-up could not finish.");
    followUpError = { code: error.code, message: error.message };
  } else if (terminal?.kind === "done") {
    try {
      followUp = parseDoneData(terminal.data);
    } catch (error) {
      followUpError = errorWords(error, "desktop_response_invalid", "The follow-up's answer could not be read.");
    }
  }
  if (receiptFailure) throw receiptFailure;
  return {
    ...receipt!,
    ...(followUp ? { followUp } : {}),
    ...(followUpError ? { followUpError } : {})
  };
}

/** Transport losses (no answer at all), as opposed to a typed refusal the bridge sent. */
const STREAM_LOSS_CODES: ReadonlySet<string> = new Set([
  "desktop_unreachable",
  "desktop_stream_invalid",
  "desktop_stream_missing_terminal",
  "desktop_stream_sequence",
  "desktop_stream_request_mismatch",
  "desktop_stream_trailing_frame",
  "desktop_protocol_incompatible",
  "desktop_response_invalid"
]);

function errorWords(error: unknown, code: string, message: string): { code: string; message: string } {
  return error instanceof DesktopAppClientError
    ? { code: error.code, message: error.message }
    : { code, message };
}

/**
 * A receipt frame as a plain confirm's answer: `{ ...result, view }`, checked
 * the same way (a failed resolution carries its code and view).
 */
function receiptOutcome(data: Record<string, unknown>): DesktopConfirmResult | DesktopAppClientError {
  const payload: Record<string, unknown> = { ...(isRecord(data.result) ? data.result : {}), view: data.view };
  const view = decodeAnswerView(payload.view) ?? undefined;
  if (payload.ok !== true) {
    const error = remotePayloadError(payload, "desktop_confirmation_failed", "Desktop could not resolve the confirmation.");
    return new DesktopAppClientError(error.code, error.message, view);
  }
  const executionFailure = findNestedExecutionFailure(payload);
  if (executionFailure) {
    return new DesktopAppClientError(
      executionFailure.code ?? "desktop_confirmation_execution_failed",
      executionFailure.message ?? "Desktop accepted the confirmation but could not execute the action.",
      view
    );
  }
  return decodeConfirmView(payload as DesktopConfirmResult);
}

export async function runDesktopAppCommand(
  args: string[],
  env: DesktopAppEnv,
  options: RunDesktopAppCommandOptions = {}
): Promise<void> {
  const io = options.io ?? {
    inputIsTTY: Boolean(stdin.isTTY),
    outputIsTTY: Boolean(stdout.isTTY),
    writeOut: (text: string) => {
      stdout.write(text);
    },
    writeErr: (text: string) => {
      stderr.write(text);
    }
  };

  if (args.length === 0 || args.every((arg) => !arg.trim())) {
    throw new DesktopAppClientError(
      "desktop_app_usage",
      "Usage: infinite app <message> | infinite app status"
    );
  }

  const client = createDesktopAppClient(env, options);
  const desktopStatus = await client.status();
  if (args.length === 1 && args[0] === "status") {
    renderStatus(desktopStatus, io);
    return;
  }
  if (!desktopStatus.ready) {
    throw new DesktopAppClientError(
      desktopStatus.error?.code ?? "desktop_not_ready",
      desktopStatus.error?.message ?? "Infinite Desktop Cmd+L is not ready."
    );
  }

  const message = args.join(" ").trim();
  if (!message) {
    throw new DesktopAppClientError(
      "desktop_app_usage",
      "Usage: infinite app <message>"
    );
  }
  const result = await client.turn(
    {
      message,
      expectedContextRevision: desktopStatus.contextRevision,
      signal: options.signal
    },
    (frame) => renderProgress(frame.data, io, client.stepWordsCapable)
  );
  io.writeOut(
    `${terminalOutputText(result.message, "Desktop returned an empty answer.")}\n`
  );

  const pending = parsePendingConfirmations(result.actionCalls);
  for (const action of pending) {
    renderPendingConfirmation(action, io);
  }
  if (pending.length === 0) {
    return;
  }

  const interactive =
    env.GROWTH_OS_CLI_NONINTERACTIVE !== "1" && io.inputIsTTY && io.outputIsTTY;
  if (!interactive) {
    io.writeOut(
      `${pending.length === 1 ? "Action was" : "Actions were"} not executed (non-interactive terminal).\n`
    );
    return;
  }
  if (!result.turnId) {
    throw new DesktopAppClientError(
      "desktop_confirmation_invalid",
      "Desktop returned confirmations without an originating turn id."
    );
  }

  for (const action of pending) {
    // Only y/yes approves and only n/no declines. Bare Enter or any other
    // answer re-prompts once, then leaves the card pending: nothing is sent.
    let decision: "approve" | "decline" | "pending";
    if (action.typedFieldWords) {
      // A card that needs a typed value: never approved on this prompt.
      io.writeOut(`${action.typedFieldWords}\n`);
      const asked = options.promptConfirmation
        ? await options.promptConfirmation(action)
        : await promptForDismissal(options.promptAnswer);
      decision = asked === "approve" ? "pending" : asked;
    } else {
      decision = options.promptConfirmation
        ? await options.promptConfirmation(action)
        : await promptForConfirmation(action, options.promptAnswer);
    }
    if (decision === "pending") {
      io.writeOut(`${leftForLaterLine(action.expiresAt)}\n`);
      continue;
    }
    // A failed confirm keeps rejecting with its typed code (non-zero exit).
    const confirmed = await client.confirm({
      turnId: result.turnId,
      confirmationHandle: action.confirmationHandle,
      decision,
      signal: options.signal
    });
    for (const line of confirmResultLines(confirmed, decision)) {
      io.writeOut(`${line.text}\n`);
    }
  }
}

function parseDescriptor(value: unknown): DesktopBridgeDescriptor {
  if (!isRecord(value)) {
    throw invalidDescriptor();
  }
  if (value.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    throw new DesktopAppClientError(
      "desktop_protocol_incompatible",
      "This Infinite CLI requires a newer compatible Infinite Desktop."
    );
  }
  if (value.service !== DESKTOP_SERVICE) {
    throw invalidDescriptor();
  }
  const protocol = parseProtocol(value.protocol);
  assertProtocolOverlap(protocol);
  const capabilities = parseCapabilities(value.capabilities);
  assertRequiredCapabilities(capabilities);
  const url = parseLoopbackUrl(value.url);
  const pid = value.pid;
  const bootId = nonEmptyString(value.bootId);
  const desktopVersion = nonEmptyString(value.desktopVersion);
  const token = nonEmptyString(value.token);
  const startedAt = nonEmptyString(value.startedAt);
  const runtime = value.runtime;
  if (
    !Number.isSafeInteger(pid) ||
    (pid as number) <= 0 ||
    !bootId ||
    !desktopVersion ||
    !token ||
    !startedAt ||
    Number.isNaN(Date.parse(startedAt)) ||
    !isRecord(runtime) ||
    !nonEmptyString(runtime.variant) ||
    !nonEmptyString(runtime.stateLabel)
  ) {
    throw invalidDescriptor();
  }
  return {
    schemaVersion: 1,
    service: DESKTOP_SERVICE,
    protocol,
    capabilities,
    url,
    pid: pid as number,
    bootId,
    desktopVersion,
    runtime: {
      variant: nonEmptyString(runtime.variant)!,
      stateLabel: nonEmptyString(runtime.stateLabel)!
    },
    token,
    startedAt
  };
}

function parseStatus(
  value: unknown,
  descriptor: DesktopBridgeDescriptor
): DesktopStatus {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const protocol = parseProtocol(value.protocol, "desktop_response_invalid");
  assertProtocolOverlap(protocol);
  const capabilities = parseCapabilities(
    value.capabilities,
    "desktop_response_invalid"
  );
  assertRequiredCapabilities(capabilities);
  if (value.service !== DESKTOP_SERVICE || value.bootId !== descriptor.bootId) {
    throw new DesktopAppClientError(
      "desktop_identity_mismatch",
      "Infinite Desktop changed while the CLI was connecting. Try the command again."
    );
  }
  if (
    typeof value.ready !== "boolean" ||
    !nonEmptyString(value.contextRevision)
  ) {
    throw invalidResponse();
  }
  const provider = parseProvider(value.provider);
  const workspace = parseWorkspace(value.workspace);
  const error = parseRemoteError(value.error);
  const interactive = parseInteractiveWorkspaceStatus(value.interactive);
  // Additive and capability-gated: an old Desktop sends none, and a list that
  // does not decode is left out (the top bar then draws no dots) rather than
  // failing the status.
  const connections =
    descriptor.capabilities.includes(STATUS_CONNECTIONS_CAPABILITY) &&
    capabilities.includes(STATUS_CONNECTIONS_CAPABILITY)
      ? decodeStatusConnections(value.connections)
      : undefined;
  return {
    service: DESKTOP_SERVICE,
    bootId: descriptor.bootId,
    protocol,
    capabilities,
    ready: value.ready,
    contextRevision: nonEmptyString(value.contextRevision)!,
    ...(provider ? { provider } : {}),
    ...(workspace ? { workspace } : {}),
    ...(error ? { error } : {}),
    ...(interactive ? { interactive } : {}),
    ...(connections ? { connections } : {})
  };
}

function parseInteractiveWorkspaceStatus(
  value: unknown,
): InteractiveWorkspaceStatusV1 | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidResponse();
  if (
    !Array.isArray(value.supportedProfiles) ||
    !value.supportedProfiles.every((profile) =>
      profile === GENERAL_MARKETING_PROFILE ||
      profile === LEGACY_GROWTH_OPERATOR_PROFILE) ||
    !Array.isArray(value.availableFeatures) ||
    !value.availableFeatures.every((feature) => typeof feature === "string") ||
    value.workspaceAccess !== "metadata-only"
  ) {
    throw invalidResponse();
  }
  return {
    supportedProfiles: [...value.supportedProfiles],
    availableFeatures: [
      ...value.availableFeatures
    ] as InteractiveWorkspaceStatusV1["availableFeatures"],
    workspaceAccess: "metadata-only"
  };
}

async function authenticatedFetch(
  descriptor: DesktopBridgeDescriptor,
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit,
  deadline: RequestDeadline
): Promise<Response> {
  let response: Response;
  try {
    response = await deadline.race(
      fetchImpl(`${descriptor.url}${path}`, {
        ...init,
        headers: {
          ...headersToRecord(init.headers),
          authorization: `Bearer ${descriptor.token}`
        }
      })
    );
  } catch (error) {
    const mapped = mapDeadlineError(error, deadline);
    if (mapped !== error) throw mapped;
    throw new DesktopAppClientError(
      "desktop_unreachable",
      "Infinite Desktop stopped responding. Start or restart Desktop and try again."
    );
  }
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await deadline.race(readOptionalJson(response));
    } catch (error) {
      throw mapDeadlineError(error, deadline);
    }
    if (response.status === 401 || response.status === 403) {
      throw new DesktopAppClientError(
        "desktop_auth_failed",
        "Infinite Desktop rejected this runtime's bridge credentials. Try the command again."
      );
    }
    throw remotePayloadError(
      unwrapData(payload),
      "desktop_request_failed",
      `Infinite Desktop request failed (${response.status}).`
    );
  }
  return response;
}

type RequestDeadline = {
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  didTimeout: () => boolean;
  race: <T>(operation: Promise<T>) => Promise<T>;
  clearTimer: () => void;
  dispose: () => void;
};

function createRequestDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): RequestDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abortFromCaller = () => {
    const reason =
      callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error("Desktop request aborted by caller.");
    controller.abort(reason);
    rejectCancellation(reason);
  };
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    const error = new RequestDeadlineExceeded();
    controller.abort(error);
    rejectCancellation(error);
  }, timeoutMs);
  timer.unref?.();
  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    ...(callerSignal ? { callerSignal } : {}),
    didTimeout: () => timedOut,
    race: <T>(operation: Promise<T>) => Promise.race([operation, cancellation]),
    clearTimer,
    dispose: () => {
      clearTimer();
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

function mapDeadlineError(error: unknown, deadline: RequestDeadline): unknown {
  if (deadline.didTimeout() || error instanceof RequestDeadlineExceeded) {
    return new DesktopAppClientError(
      "desktop_unreachable",
      "Infinite Desktop stopped responding. Start or restart Desktop and try again."
    );
  }
  if (deadline.callerSignal?.aborted) {
    return new DesktopAppClientError(
      "desktop_turn_detached",
      "Detached from the Desktop turn. Provider work may still continue."
    );
  }
  return error;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

async function readTurnStream(
  response: Response,
  requestId: string,
  onProgress?: (frame: DesktopProgressFrame) => void
): Promise<DesktopTurnResult> {
  const terminal = await readFrames(response, requestId, onProgress);
  if (terminal.kind === "error") {
    throw remotePayloadError(
      terminal.data,
      "desktop_turn_failed",
      "Infinite Desktop could not complete the turn."
    );
  }
  return parseDoneData(terminal.data);
}

/**
 * Read an NDJSON stream (a turn, or a streamed confirm): every frame checked
 * (protocol, request id, sequence, size), progress handed on in order, and
 * exactly one terminal frame returned.
 */
async function readFrames(
  response: Response,
  requestId: string,
  onProgress?: (frame: DesktopProgressFrame) => void
): Promise<{ kind: "done" | "error"; data: unknown }> {
  if (!response.body) {
    throw new DesktopAppClientError(
      "desktop_stream_invalid",
      "Infinite Desktop returned an empty turn stream."
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  let expectedSequence = 1;
  let terminal:
    | { kind: "done"; data: unknown }
    | { kind: "error"; data: unknown }
    | undefined;

  const consumeLine = (line: string) => {
    if (!line.trim()) {
      throw new DesktopAppClientError(
        "desktop_stream_invalid",
        "Infinite Desktop returned a blank NDJSON frame."
      );
    }
    if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES) {
      throw new DesktopAppClientError(
        "desktop_stream_invalid",
        "Infinite Desktop returned an oversized stream frame."
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new DesktopAppClientError(
        "desktop_stream_invalid",
        "Infinite Desktop returned malformed NDJSON."
      );
    }
    if (!isRecord(parsed)) {
      throw new DesktopAppClientError(
        "desktop_stream_invalid",
        "Infinite Desktop returned a malformed stream frame."
      );
    }
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      throw new DesktopAppClientError(
        "desktop_protocol_incompatible",
        "Infinite Desktop returned an incompatible stream protocol."
      );
    }
    if (parsed.requestId !== requestId) {
      throw new DesktopAppClientError(
        "desktop_stream_request_mismatch",
        "Infinite Desktop returned a frame for a different request."
      );
    }
    if (parsed.sequence !== expectedSequence) {
      throw new DesktopAppClientError(
        "desktop_stream_sequence",
        "Infinite Desktop returned an out-of-order stream."
      );
    }
    expectedSequence += 1;
    if (terminal) {
      throw new DesktopAppClientError(
        "desktop_stream_trailing_frame",
        "Infinite Desktop returned data after the terminal frame."
      );
    }
    if (parsed.kind === "progress") {
      onProgress?.({
        protocolVersion: 1,
        requestId,
        sequence: parsed.sequence as number,
        kind: "progress",
        data: parsed.data
      });
      return;
    }
    if (parsed.kind === "done" || parsed.kind === "error") {
      terminal = { kind: parsed.kind, data: parsed.data };
      return;
    }
    throw new DesktopAppClientError(
      "desktop_stream_invalid",
      "Infinite Desktop returned an unknown stream frame."
    );
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_STREAM_BYTES) {
      throw new DesktopAppClientError(
        "desktop_stream_invalid",
        "Infinite Desktop returned an oversized turn stream."
      );
    }
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_STREAM_LINE_BYTES) {
      throw new DesktopAppClientError(
        "desktop_stream_invalid",
        "Infinite Desktop returned an oversized stream frame."
      );
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeLine(buffer.replace(/\r$/, ""));
  }
  if (!terminal) {
    throw new DesktopAppClientError(
      "desktop_stream_missing_terminal",
      "Infinite Desktop ended the turn without a terminal frame."
    );
  }
  return terminal;
}

function parseDoneData(value: unknown): DesktopTurnResult {
  if (
    !isRecord(value) ||
    typeof value.message !== "string" ||
    !Array.isArray(value.actionCalls)
  ) {
    throw invalidResponse();
  }
  const turnId = nonEmptyString(value.turnId);
  const sessionId = nonEmptyString(value.sessionId);
  return {
    ...(turnId ? { turnId } : {}),
    message: value.message,
    actionCalls: value.actionCalls,
    ...(Array.isArray(value.provenance)
      ? { provenance: value.provenance }
      : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

function parsePendingConfirmations(
  actionCalls: unknown[]
): PendingConfirmation[] {
  const pending: PendingConfirmation[] = [];
  for (const value of actionCalls) {
    if (!isRecord(value)) continue;
    const requiresConfirmation =
      value.requiresConfirmation === true ||
      value.status === "requires_confirmation";
    if (!requiresConfirmation) continue;
    const confirmationHandle = nonEmptyString(value.confirmationHandle);
    if (!confirmationHandle) {
      throw new DesktopAppClientError(
        "desktop_confirmation_invalid",
        "Desktop returned a pending action without an opaque confirmation handle."
      );
    }
    const actionId = boundedTerminalText(
      nonEmptyString(value.actionId) ?? "action",
      MAX_CONFIRMATION_LABEL_CHARS,
      "action"
    );
    const summary = boundedTerminalText(
      redactSensitiveTerminalText(
        nonEmptyString(value.summary) ?? actionId.replaceAll("_", " ")
      ),
      MAX_CONFIRMATION_VALUE_CHARS,
      "action"
    );
    const suppliedDetails = parseSuppliedConfirmationDetails(
      value.confirmationDetails
    );
    const confirmationDetails =
      suppliedDetails.length > 0
        ? suppliedDetails
        : buildGenericConfirmationDetails(value.input);
    const view = decodeAnswerView(value.view) ?? undefined;
    const expiresAt = view?.approval?.expiresAt;
    pending.push({
      actionId,
      confirmationHandle,
      summary,
      confirmationDetails,
      ...(typeof expiresAt === "string" ? { expiresAt } : {}),
      ...(needsTypedField(view) ? { typedFieldWords: typedFieldLine(view) } : {})
    });
  }
  return pending;
}

function parseSuppliedConfirmationDetails(
  value: unknown
): ConfirmationDetail[] {
  if (!Array.isArray(value)) return [];
  const details: ConfirmationDetail[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rawLabel = nonEmptyString(item.label);
    const rawValue = nonEmptyString(item.value);
    if (!rawLabel || !rawValue) continue;
    const label = boundedTerminalText(rawLabel, MAX_CONFIRMATION_LABEL_CHARS);
    const redactedValue = isSensitiveFieldName(rawLabel)
      ? "[redacted]"
      : redactSensitiveTerminalText(rawValue);
    details.push({
      label,
      value: boundedTerminalText(
        redactedValue,
        MAX_CONFIRMATION_VALUE_CHARS,
        "[empty]"
      )
    });
    if (details.length > MAX_CONFIRMATION_DETAILS) break;
  }
  return boundConfirmationDetails(details);
}

function buildGenericConfirmationDetails(value: unknown): ConfirmationDetail[] {
  if (value === undefined) return [];
  const details: ConfirmationDetail[] = [];
  let overflowed = false;

  const addDetail = (label: string, detailValue: string) => {
    if (details.length > MAX_CONFIRMATION_DETAILS) {
      overflowed = true;
      return;
    }
    details.push({
      label: boundedTerminalText(label, MAX_CONFIRMATION_LABEL_CHARS, "Input"),
      value: boundedTerminalText(
        detailValue,
        MAX_CONFIRMATION_VALUE_CHARS,
        "[empty]"
      )
    });
  };

  const visit = (
    current: unknown,
    path: string,
    depth: number,
    sensitive: boolean
  ) => {
    if (details.length > MAX_CONFIRMATION_DETAILS) {
      overflowed = true;
      return;
    }
    const label = path || "Input";
    if (sensitive) {
      addDetail(label, "[redacted]");
      return;
    }
    if (current === null) {
      addDetail(label, "null");
      return;
    }
    if (typeof current === "string") {
      addDetail(label, redactSensitiveTerminalText(current));
      return;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      addDetail(label, String(current));
      return;
    }
    if (Array.isArray(current)) {
      if (current.length === 0) {
        addDetail(label, "[]");
        return;
      }
      if (depth >= MAX_CONFIRMATION_INPUT_DEPTH) {
        addDetail(label, "[nested value truncated]");
        return;
      }
      for (let index = 0; index < current.length; index += 1) {
        visit(current[index], `${label}[${index}]`, depth + 1, false);
        if (overflowed) return;
      }
      return;
    }
    if (isRecord(current)) {
      const keys = Object.keys(current).sort(compareStrings);
      if (keys.length === 0) {
        addDetail(label, "{}");
        return;
      }
      if (depth >= MAX_CONFIRMATION_INPUT_DEPTH) {
        addDetail(label, "[nested value truncated]");
        return;
      }
      for (const key of keys) {
        visit(
          current[key],
          path ? `${path}.${key}` : key,
          depth + 1,
          isSensitiveFieldName(key)
        );
        if (overflowed) return;
      }
      return;
    }
    addDetail(label, "[unsupported value]");
  };

  visit(value, "", 0, false);
  return boundConfirmationDetails(details, overflowed);
}

function boundConfirmationDetails(
  details: ConfirmationDetail[],
  overflowed = false
): ConfirmationDetail[] {
  if (!overflowed && details.length <= MAX_CONFIRMATION_DETAILS) return details;
  return [
    ...details.slice(0, MAX_CONFIRMATION_DETAILS - 1),
    { label: "Additional fields", value: "[truncated]" }
  ];
}

function renderPendingConfirmation(
  action: PendingConfirmation,
  io: DesktopAppIo
): void {
  io.writeOut(
    `Pending confirmation: ${terminalText(action.summary, "action")}\n`
  );
  for (const detail of action.confirmationDetails) {
    io.writeOut(`  ${detail.label}: ${detail.value}\n`);
  }
}

function renderStatus(status: DesktopStatus, io: DesktopAppIo): void {
  io.writeOut(`Desktop Cmd+L: ${status.ready ? "ready" : "not ready"}\n`);
  if (status.provider) {
    const providerId = boundedTerminalText(
      status.provider.id,
      MAX_CONFIRMATION_VALUE_CHARS,
      "unknown"
    );
    const model = status.provider.model
      ? boundedTerminalText(status.provider.model, MAX_CONFIRMATION_VALUE_CHARS)
      : "";
    io.writeOut(`Provider: ${providerId}${model ? ` (${model})` : ""}\n`);
  }
  if (status.workspace) {
    io.writeOut(
      `Workspace: ${boundedTerminalText(status.workspace.name, MAX_CONFIRMATION_VALUE_CHARS, "unknown")}\n`
    );
  }
  if (status.error) {
    io.writeOut(
      `Blocker: ${boundedTerminalText(status.error.message, MAX_CONFIRMATION_VALUE_CHARS, "Unavailable")}\n`
    );
  }
}

function renderProgress(value: unknown, io: DesktopAppIo, stepWords = false): void {
  if (!isRecord(value)) return;
  // This command draws no views: a `tool.view` frame is not a progress line.
  if (isToolViewFrameData(value)) return;
  const type = nonEmptyString(value.type);
  // A tool frame prints the step in words: the app's own when the turn asked
  // for them, else generic words from the tool's name. Never the raw tool id.
  if (type?.startsWith("tool.")) {
    const line = plainToolProgressLine(value, stepWords);
    if (line) {
      io.writeErr(`${boundedTerminalText(line, MAX_CONFIRMATION_VALUE_CHARS)}\n`);
    }
    return;
  }
  if (
    type === "message.delta" ||
    type === "reasoning.delta" ||
    type === "message.complete"
  ) {
    return;
  }
  const text =
    nonEmptyString(value.message) ??
    nonEmptyString(value.text) ??
    nonEmptyString(value.summary);
  if (text) {
    io.writeErr(`${boundedTerminalText(text, MAX_CONFIRMATION_VALUE_CHARS)}\n`);
  }
}

async function promptForDismissal(
  promptAnswer?: (question: string) => Promise<string>
): Promise<"decline" | "pending"> {
  if (promptAnswer) {
    return askDismissOnly(promptAnswer, DISMISS_ONLY_QUESTION);
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await askDismissOnly((text) => prompt.question(text), DISMISS_ONLY_QUESTION);
  } finally {
    prompt.close();
  }
}

async function promptForConfirmation(
  action: PendingConfirmation,
  promptAnswer?: (question: string) => Promise<string>
): Promise<"approve" | "decline" | "pending"> {
  const question = `Approve "${boundedTerminalText(action.summary, MAX_CONFIRMATION_VALUE_CHARS, "action")}"? [y/n] `;
  if (promptAnswer) {
    return askConfirmDecision(promptAnswer, question);
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await askConfirmDecision((text) => prompt.question(text), question);
  } finally {
    prompt.close();
  }
}

function redactSensitiveTerminalText(value: string): string {
  // If removing terminal/format separators reveals URI credentials, fail closed for this display
  // value. Ordinary multiline public URLs remain ordinary text because they expose no credentials.
  if (containsControlObfuscatedCredentialUri(value)) return "[redacted]";
  let redacted = terminalText(value);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(redacted)) {
    return "[redacted]";
  }
  redacted = redactUrlSecrets(redacted);
  redacted = redacted.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]");
  redacted = redacted.replace(
    /\b((?:access|refresh|id)[ _-]?token|(?:api|access|signing|private)[ _-]?key|password|passwd|secret|auth(?:orization)?|code|sig(?:nature)?|cookie|client[ _-]?secret)\b(\s*[:=]\s*)[^\s,;&]+/giu,
    "$1$2[redacted]"
  );
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    "[redacted]"
  );
  return redacted;
}

function redactUrlSecrets(value: string): string {
  return value
    .replace(PARSER_NORMALIZED_URI_RE, redactParserNormalizedCredentialUri)
    .replace(HIERARCHICAL_URI_RE, (candidate) =>
      redactHierarchicalUri(candidate)
    );
}

function revealsCredentialUri(value: string): boolean {
  if (
    value.replace(
      PARSER_NORMALIZED_URI_RE,
      redactParserNormalizedCredentialUri
    ) !== value
  ) {
    return true;
  }
  for (const uri of value.match(HIERARCHICAL_URI_RE) ?? []) {
    if (redactHierarchicalUri(uri) !== uri) return true;
  }
  return false;
}

function containsControlObfuscatedCredentialUri(value: string): boolean {
  if (!URI_OBFUSCATING_CHAR_RE.test(value)) return false;
  // Fail closed ONLY when the obfuscating chars actually HID a credential: removing them
  // (concatenating the surrounding text) exposes a redactable credential URI that replacing them
  // with spaces — the normalization terminalText() already performs for display — does NOT expose.
  // That gap is the signature of a control/format char spliced INSIDE a credential URI. When both
  // forms expose the same credential, the ordinary in-place redactor already neutralizes it, so a
  // whole-value blank would over-redact legitimate multiline text (e.g. a public URL on its own line
  // carrying a sensitive-named query param).
  const compact = value.replace(URI_OBFUSCATING_CHAR_RE_GLOBAL, "");
  if (!revealsCredentialUri(compact)) return false;
  const spaced = value.replace(URI_OBFUSCATING_CHAR_RE_GLOBAL, " ");
  return !revealsCredentialUri(spaced);
}

function redactHierarchicalUri(candidate: string): string {
  let uri = candidate;
  let trailing = "";
  for (;;) {
    try {
      new URL(uri);
      break;
    } catch {
      if (!/[),.;!?\]}]$/u.test(uri)) return `[redacted]${trailing}`;
      trailing = `${uri.at(-1)}${trailing}`;
      uri = uri.slice(0, -1);
    }
  }

  const authorityStart = uri.indexOf("://") + 3;
  const authorityEnd = firstDelimiterIndex(uri, authorityStart, [
    "/",
    "?",
    "#"
  ]);
  const authority = uri.slice(authorityStart, authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  let redacted =
    userinfoEnd >= 0
      ? `${uri.slice(0, authorityStart)}[redacted]@${uri.slice(
          authorityStart + userinfoEnd + 1
        )}`
      : uri;

  redacted = redactUriParameters(redacted, authorityStart);

  return `${redacted}${trailing}`;
}

function redactParserNormalizedCredentialUri(candidate: string): string {
  if (CANONICAL_AUTHORITY_URI_RE.test(candidate)) return candidate;

  let uri = candidate;
  let trailing = "";
  for (;;) {
    try {
      const parsed = new URL(uri);
      return parsed.username ||
        parsed.password ||
        redactUriParameters(uri, uri.indexOf(":") + 1) !== uri
        ? `[redacted]${trailing}`
        : candidate;
    } catch {
      if (!/[),.;!?\]}]$/u.test(uri)) return `[redacted]${trailing}`;
      trailing = `${uri.at(-1)}${trailing}`;
      uri = uri.slice(0, -1);
    }
  }
}

function redactUriParameters(value: string, authorityStart: number): string {
  const fragmentStart = value.indexOf("#", authorityStart);
  const beforeFragment =
    fragmentStart < 0 ? value : value.slice(0, fragmentStart);
  const queryStart = beforeFragment.indexOf("?", authorityStart);
  const redactedBase =
    queryStart < 0
      ? beforeFragment
      : `${beforeFragment.slice(0, queryStart + 1)}${redactParameterList(
          beforeFragment.slice(queryStart + 1)
        )}`;
  if (fragmentStart < 0) return redactedBase;

  const fragment = value.slice(fragmentStart + 1);
  const fragmentQueryStart = fragment.indexOf("?");
  const redactedFragment =
    fragmentQueryStart < 0
      ? redactParameterList(fragment)
      : `${fragment.slice(
          0,
          fragmentQueryStart + 1
        )}${redactParameterList(fragment.slice(fragmentQueryStart + 1))}`;
  return `${redactedBase}#${redactedFragment}`;
}

function redactParameterList(value: string): string {
  return value
    .split(/([&;])/u)
    .map((parameter) => {
      if (parameter === "&" || parameter === ";") return parameter;
      const separator = parameter.indexOf("=");
      const rawKey = separator >= 0 ? parameter.slice(0, separator) : parameter;
      const decodedKey = decodeUriComponent(rawKey.replaceAll("+", " "));
      if (decodedKey === null) return "[redacted]";
      if (separator < 0 && decodedKey.includes("=")) return "[redacted]";
      if (!isSensitiveFieldName(decodedKey)) return parameter;
      if (separator < 0) return "[redacted]";
      return `${rawKey}=[redacted]`;
    })
    .join("");
}

function firstDelimiterIndex(
  value: string,
  start: number,
  delimiters: string[]
): number {
  let result = value.length;
  for (const delimiter of delimiters) {
    const index = value.indexOf(delimiter, start);
    if (index >= 0 && index < result) result = index;
  }
  return result;
}

function decodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSensitiveFieldName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const markers = [
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "privatekey",
    "accesskey",
    "signingkey",
    "clientsecret",
    "encryptionkey",
    "auth",
    "code",
    "signature"
  ];
  if (normalized === "sig" || normalized.endsWith("sig")) return true;
  return markers.some(
    (marker) =>
      normalized === marker ||
      normalized.startsWith(marker) ||
      normalized.endsWith(marker)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertOwnerOnlyDirectory(stat: Stats): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    hasGroupOrWorldPermissions(stat) ||
    isForeignOwner(stat)
  ) {
    throw new DesktopAppClientError(
      "desktop_descriptor_unsafe",
      "Infinite Desktop bridge directory is not owner-only."
    );
  }
}

function assertOwnerOnlyRegularFile(stat: Stats): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    hasGroupOrWorldPermissions(stat) ||
    (stat.mode & 0o400) === 0 ||
    isForeignOwner(stat)
  ) {
    throw new DesktopAppClientError(
      "desktop_descriptor_unsafe",
      "Infinite Desktop bridge descriptor is not an owner-only regular file."
    );
  }
}

function hasGroupOrWorldPermissions(stat: Stats): boolean {
  return (stat.mode & 0o077) !== 0;
}

function isForeignOwner(stat: Stats): boolean {
  return typeof process.getuid === "function" && stat.uid !== process.getuid();
}

function parseLoopbackUrl(value: unknown): string {
  const raw = nonEmptyString(value);
  if (!raw) throw invalidDescriptor();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidDescriptor();
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw invalidDescriptor();
  }
  return parsed.origin;
}

function parseProtocol(
  value: unknown,
  invalidCode = "desktop_descriptor_invalid"
): { min: number; max: number } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.min) ||
    !Number.isSafeInteger(value.max) ||
    (value.min as number) < 1 ||
    (value.max as number) < (value.min as number)
  ) {
    throw new DesktopAppClientError(
      invalidCode,
      "Infinite Desktop returned an invalid protocol range."
    );
  }
  return { min: value.min as number, max: value.max as number };
}

function assertProtocolOverlap(protocol: { min: number; max: number }): void {
  if (protocol.min > PROTOCOL_VERSION || protocol.max < PROTOCOL_VERSION) {
    throw new DesktopAppClientError(
      "desktop_protocol_incompatible",
      "This Infinite CLI and Infinite Desktop do not share a compatible Cmd+L protocol."
    );
  }
}

function parseCapabilities(
  value: unknown,
  invalidCode = "desktop_descriptor_invalid"
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new DesktopAppClientError(
      invalidCode,
      "Infinite Desktop returned invalid capabilities."
    );
  }
  return [...value];
}

function assertRequiredCapabilities(capabilities: string[]): void {
  if (
    !REQUIRED_CAPABILITIES.every((capability) =>
      capabilities.includes(capability)
    )
  ) {
    throw new DesktopAppClientError(
      "desktop_protocol_incompatible",
      "Infinite Desktop does not support all Cmd+L capabilities required by this CLI."
    );
  }
}

function parseProvider(value: unknown): DesktopStatus["provider"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !nonEmptyString(value.id)) throw invalidResponse();
  const model = nonEmptyString(value.model);
  return { id: nonEmptyString(value.id)!, ...(model ? { model } : {}) };
}

function parseWorkspace(value: unknown): DesktopStatus["workspace"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !nonEmptyString(value.name)) throw invalidResponse();
  const id = nonEmptyString(value.id);
  return { ...(id ? { id } : {}), name: nonEmptyString(value.name)! };
}

function parseRemoteError(value: unknown): DesktopStatus["error"] {
  if (value === undefined || value === null) return undefined;
  const error = parseLooseRemoteError(value);
  if (!error?.code || !error.message) {
    throw invalidResponse();
  }
  return { code: error.code, message: error.message };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  assertContentType(response, "application/json");
  try {
    return await response.json();
  } catch {
    throw invalidResponse();
  }
}

async function readConfirmationJsonResponse(
  response: Response,
  signal: AbortSignal | null | undefined
): Promise<unknown> {
  assertContentType(response, "application/json");
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw new DesktopAppClientError(
        "desktop_turn_detached",
        "Detached from the Desktop turn. Provider work may still continue."
      );
    }
    throw new ConfirmationResponseBodyLost();
  }
  try {
    return JSON.parse(body);
  } catch {
    throw invalidResponse();
  }
}

async function readOptionalJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function assertContentType(response: Response, expected: string): void {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes(expected)) {
    throw invalidResponse();
  }
}

function remotePayloadError(
  value: unknown,
  fallbackCode: string,
  fallbackMessage: string
): DesktopAppClientError {
  const source = isRecord(value) && isRecord(value.error) ? value.error : value;
  const error = parseLooseRemoteError(source);
  return new DesktopAppClientError(
    error?.code ?? fallbackCode,
    error?.message ?? fallbackMessage
  );
}

function parseLooseRemoteError(
  value: unknown
): { code?: string; message?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const code = safeErrorCode(value.code);
  const rawMessage = nonEmptyString(value.message);
  const message = rawMessage
    ? boundedTerminalText(rawMessage, MAX_CONFIRMATION_VALUE_CHARS)
    : undefined;
  return code || message
    ? { ...(code ? { code } : {}), ...(message ? { message } : {}) }
    : undefined;
}

/** Replace `view` in place by its decoded form; drop a `view` that does not decode. */
function decodeConfirmView(payload: DesktopConfirmResult): DesktopConfirmResult {
  if (!("view" in payload)) return payload;
  const { view: rawView, ...rest } = payload;
  const view = decodeAnswerView(rawView);
  return (view ? { ...rest, view } : rest) as DesktopConfirmResult;
}

function selectConfirmationEnvelope(value: unknown): unknown {
  if (isRecord(value) && typeof value.ok === "boolean") return value;
  if (
    isRecord(value) &&
    isRecord(value.data) &&
    typeof value.data.ok === "boolean"
  ) {
    return value.data;
  }
  return value;
}

function findNestedExecutionFailure(
  envelope: Record<string, unknown>
): { code?: string; message?: string } | undefined {
  const queue: Array<{ value: unknown; depth: number }> = [];
  for (const key of ["data", "result", "envelope"] as const) {
    queue.push({ value: envelope[key], depth: 1 });
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!isRecord(current.value)) continue;
    if (current.value.ok === false) {
      const source = isRecord(current.value.error)
        ? current.value.error
        : current.value;
      return parseLooseRemoteError(source) ?? {};
    }
    if (current.depth >= 4) continue;
    for (const key of ["data", "result", "envelope"] as const) {
      queue.push({ value: current.value[key], depth: current.depth + 1 });
    }
  }
  return undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  const code = nonEmptyString(value);
  return code && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(code)
    ? code
    : undefined;
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && isRecord(value.data) ? value.data : value;
}

function headersToRecord(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function invalidDescriptor(): DesktopAppClientError {
  return new DesktopAppClientError(
    "desktop_descriptor_invalid",
    "Infinite Desktop bridge descriptor is invalid."
  );
}

function desktopNotRunning(): DesktopAppClientError {
  return new DesktopAppClientError(
    "desktop_not_running",
    "Infinite Desktop is not running for this runtime. Start Desktop and try again."
  );
}

function confirmationOutcomeUnknown(): DesktopAppClientError {
  return new DesktopAppClientError(
    "desktop_confirmation_outcome_unknown",
    "Infinite Desktop may have resolved this confirmation, but its response was lost. Check Desktop before trying again."
  );
}

function invalidResponse(): DesktopAppClientError {
  return new DesktopAppClientError(
    "desktop_response_invalid",
    "Infinite Desktop returned an invalid response."
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isAbortError(value: unknown): boolean {
  return (
    value instanceof Error &&
    (value.name === "AbortError" || value.name === "TimeoutError")
  );
}

function isRetrySafeConfirmationResponseLoss(
  value: unknown,
  signal: AbortSignal | null | undefined
): boolean {
  return (
    !signal?.aborted &&
    (value instanceof ConfirmationResponseBodyLost ||
      (value instanceof DesktopAppClientError &&
        value.code === "desktop_unreachable"))
  );
}
