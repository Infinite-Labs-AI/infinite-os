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
const TRUNCATION_SUFFIX = " ... [truncated]";
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
    message: string
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

export interface DesktopAppClient {
  /**
   * Whether the Desktop negotiated `turn.session.v1` (descriptor ∧ status
   * capabilities). Only meaningful after `status()` has resolved; false until
   * then. Callers gate `sessionId` resend on this — an incapable Desktop gets
   * a single-turn degrade, NOT a typed error.
   */
  readonly sessionCapable: boolean;
  status(): Promise<DesktopStatus>;
  turn(
    input: {
      message: string;
      expectedContextRevision: string;
      /** Prior session to continue; sent only when the Desktop is capable. */
      sessionId?: string;
      signal?: AbortSignal;
    },
    onProgress?: (frame: DesktopProgressFrame) => void
  ): Promise<DesktopTurnResult>;
  confirm(input: {
    turnId: string;
    confirmationHandle: string;
    decision: "approve" | "decline";
    signal?: AbortSignal;
  }): Promise<unknown>;
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
  promptConfirmation?: (
    action: PendingConfirmation
  ) => Promise<"approve" | "decline">;
  signal?: AbortSignal;
}

interface PendingConfirmation {
  actionId: string;
  confirmationHandle: string;
  summary: string;
  confirmationDetails: ConfirmationDetail[];
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

  return {
    get sessionCapable() {
      return sessionCapable;
    },

    async status() {
      confirmationReplaySafe = false;
      sessionCapable = false;
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
        confirmationReplaySafe =
          descriptor.capabilities.includes(CONFIRM_IDEMPOTENCY_CAPABILITY) &&
          status.capabilities.includes(CONFIRM_IDEMPOTENCY_CAPABILITY);
        sessionCapable =
          descriptor.capabilities.includes(TURN_SESSION_CAPABILITY) &&
          status.capabilities.includes(TURN_SESSION_CAPABILITY);
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
                : {})
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
      const requestId = randomId();
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
                decision: input.decision
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
      if (!isRecord(payload) || payload.ok !== true) {
        throw remotePayloadError(
          payload,
          "desktop_confirmation_failed",
          "Desktop could not resolve the confirmation."
        );
      }
      const executionFailure = findNestedExecutionFailure(payload);
      if (executionFailure) {
        throw new DesktopAppClientError(
          executionFailure.code ?? "desktop_confirmation_execution_failed",
          executionFailure.message ??
            "Desktop accepted the confirmation but could not execute the action."
        );
      }
      return payload;
    }
  };
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
    (frame) => renderProgress(frame.data, io)
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
    const decision = options.promptConfirmation
      ? await options.promptConfirmation(action)
      : await promptForConfirmation(action);
    await client.confirm({
      turnId: result.turnId,
      confirmationHandle: action.confirmationHandle,
      decision,
      signal: options.signal
    });
    io.writeOut(
      `Confirmation ${decision === "approve" ? "approved" : "declined"}: ${terminalText(action.summary, "action")}\n`
    );
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
  return {
    service: DESKTOP_SERVICE,
    bootId: descriptor.bootId,
    protocol,
    capabilities,
    ready: value.ready,
    contextRevision: nonEmptyString(value.contextRevision)!,
    ...(provider ? { provider } : {}),
    ...(workspace ? { workspace } : {}),
    ...(error ? { error } : {})
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
  if (terminal.kind === "error") {
    throw remotePayloadError(
      terminal.data,
      "desktop_turn_failed",
      "Infinite Desktop could not complete the turn."
    );
  }
  return parseDoneData(terminal.data);
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
    pending.push({
      actionId,
      confirmationHandle,
      summary,
      confirmationDetails
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

function renderProgress(value: unknown, io: DesktopAppIo): void {
  if (!isRecord(value)) return;
  const type = nonEmptyString(value.type);
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
    nonEmptyString(value.summary) ??
    (type?.startsWith("tool.") ? nonEmptyString(value.name) : undefined);
  if (text) {
    io.writeErr(`${boundedTerminalText(text, MAX_CONFIRMATION_VALUE_CHARS)}\n`);
  }
}

async function promptForConfirmation(
  action: PendingConfirmation
): Promise<"approve" | "decline"> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await prompt.question(
        `Approve "${boundedTerminalText(action.summary, MAX_CONFIRMATION_VALUE_CHARS, "action")}"? [y/N] `
      )
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes" ? "approve" : "decline";
  } finally {
    prompt.close();
  }
}

function terminalText(value: string, fallback = ""): string {
  return (
    scanTerminalText(value, false).replace(/\s+/gu, " ").trim() || fallback
  );
}

function terminalOutputText(value: string, fallback = ""): string {
  return scanTerminalText(value, true).trim() || fallback;
}

function scanTerminalText(value: string, preserveLineBreaks: boolean): string {
  const output: string[] = [];
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = skipControlSequence(value, index + 2);
      } else if (
        next === 0x5d ||
        next === 0x50 ||
        next === 0x58 ||
        next === 0x5e ||
        next === 0x5f
      ) {
        index = skipControlString(value, index + 2);
      } else {
        index += Number.isNaN(next) ? 1 : 2;
      }
      continue;
    }
    if (code === 0x9b) {
      index = skipControlSequence(value, index + 1);
      continue;
    }
    if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9d ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = skipControlString(value, index + 1);
      continue;
    }
    if (code === 0x0a) {
      output.push(preserveLineBreaks ? "\n" : " ");
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      output.push(preserveLineBreaks ? "\n" : " ");
      index += value.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (code === 0x09) {
      output.push(preserveLineBreaks ? "  " : " ");
      index += 1;
      continue;
    }
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      output.push(" ");
      index += 1;
      continue;
    }
    output.push(value[index]!);
    index += 1;
  }
  return output.join("");
}

function skipControlSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length;
}

function skipControlString(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return value.length;
}

function boundedTerminalText(
  value: string,
  maxChars: number,
  fallback = ""
): string {
  const sanitized = terminalText(value, fallback);
  const characters = Array.from(sanitized);
  if (characters.length <= maxChars) return sanitized;
  const visibleChars = Math.max(
    0,
    maxChars - Array.from(TRUNCATION_SUFFIX).length
  );
  return `${characters.slice(0, visibleChars).join("")}${TRUNCATION_SUFFIX}`;
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
