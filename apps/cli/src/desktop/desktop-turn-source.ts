import type { ChatProgressEvent } from "@infinite-os/llm-controller";
import type {
  InSessionConfirmationAction,
  InSessionConfirmationDetail
} from "./confirm-in-session.js";

/**
 * A normalized bridge frame emitted by the Desktop Cmd+L turn stream.
 *
 * Both provider planes flow through this one shape (Plan 1's contract):
 *   - Codex: `data` is ALREADY a typed `ChatProgressEvent` → passed through.
 *   - Claude: `progress` carries streamed text; `tool_result` / `action`
 *     carry a tool-trail step that we map into a `ChatProgressEvent`.
 *   - `done` / `error` are terminal; `done` carries the `sessionId` the caller
 *     resends on the next turn (either top-level or inside `data`).
 */
export interface BridgeFrame {
  kind: "progress" | "tool_result" | "action" | "done" | "error";
  data?: unknown;
  message?: string;
  actionCalls?: unknown[];
  sessionId?: string;
}

/** Turn input the turn-source hands to the client's `turn(...)`. */
export interface DesktopTurnSourceInput {
  message: string;
  /**
   * Prior session to continue. The turn-source only populates this when the
   * client negotiated `turn.session.v1`; against an incapable Desktop it is
   * omitted (deliberate single-turn degrade, NOT an error).
   */
  sessionId?: string;
  signal: AbortSignal;
}

/** Outcome a client's `turn(...)` may resolve with. */
export interface DesktopTurnOutcome {
  sessionId?: string;
}

/**
 * What a turn produces for the caller: the terminal `sessionId` to resend next
 * turn, plus any `requires_confirmation` actions parsed off the terminal frame
 * and REDACTED for display (mirrors the one-shot `parsePendingConfirmations`).
 * `pendingConfirmations` is omitted entirely when nothing is pending, so an
 * incapable turn never fires the in-session confirmation path.
 */
export interface DesktopTurnRunResult {
  sessionId?: string;
  pendingConfirmations?: InSessionConfirmationAction[];
}

/**
 * The narrow client contract the turn-source consumes. The real
 * `DesktopAppClient` is adapted onto this by the interactive wiring (Task 3);
 * tests inject a fake so no Desktop code is imported here.
 */
export interface DesktopTurnSourceClient {
  /** Negotiated `turn.session.v1` (descriptor ∧ status capabilities). */
  readonly sessionCapable: boolean;
  turn(
    input: DesktopTurnSourceInput,
    onFrame: (frame: BridgeFrame) => void
  ): Promise<DesktopTurnOutcome | void>;
}

export interface DesktopTurnSource {
  runTurn(
    message: string,
    sessionId: string | undefined,
    onEvent: (event: ChatProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DesktopTurnRunResult>;
}

/**
 * Map one bridge frame to a `ChatProgressEvent` for the shared shell, or
 * `null` when the frame produces no renderable progress (terminal frames, or
 * an empty Claude delta).
 */
export function bridgeFrameToChatEvent(
  frame: BridgeFrame
): ChatProgressEvent | null {
  switch (frame.kind) {
    case "progress": {
      // Codex: `data` is already a typed ChatProgressEvent — pass it through
      // untouched so no shape drifts on the way to the shell.
      if (isTypedEvent(frame.data)) {
        return frame.data as unknown as ChatProgressEvent;
      }
      // Claude: streamed text arrives as a delta chunk (or a bare message).
      const text = firstString(
        isRecord(frame.data) ? frame.data.delta : undefined,
        isRecord(frame.data) ? frame.data.text : undefined,
        frame.message
      );
      if (text === undefined) return null;
      return { type: "message.delta", stage: "message", message: text, text };
    }
    case "tool_result": {
      const name = frameToolName(frame);
      const summary = firstString(
        isRecord(frame.data) ? frame.data.summary : undefined,
        frame.message
      );
      return {
        type: "tool.complete",
        stage: "tool",
        message: name,
        toolId: frameToolId(frame),
        name,
        durationMs: 0,
        ...(summary !== undefined ? { summary } : {})
      };
    }
    case "action": {
      const name = frameToolName(frame);
      const context = firstString(
        isRecord(frame.data) ? frame.data.context : undefined,
        frame.message
      );
      return {
        type: "tool.start",
        stage: "tool",
        message: name,
        toolId: frameToolId(frame),
        name,
        context: context ?? ""
      };
    }
    case "done":
    case "error":
      return null;
  }
}

/**
 * Create a turn-source over a session-negotiating Desktop client. Each turn:
 *   (a) sends `sessionId` ONLY when `client.sessionCapable` (silent degrade),
 *   (b) maps each bridge frame → a `ChatProgressEvent` for the shell,
 *   (c) returns the terminal `sessionId` for the caller to resend next turn.
 */
export function createDesktopTurnSource(
  client: DesktopTurnSourceClient
): DesktopTurnSource {
  return {
    async runTurn(message, sessionId, onEvent, signal) {
      let terminalSessionId = extractSessionId(undefined);
      let pendingConfirmations: InSessionConfirmationAction[] = [];
      const outcome = await client.turn(
        {
          message,
          // Capability-gated resend: omit against an incapable Desktop.
          sessionId: client.sessionCapable ? sessionId : undefined,
          signal
        },
        (frame) => {
          if (frame.kind === "done") {
            terminalSessionId =
              readSessionId(frame) ?? terminalSessionId;
            // Surface any `requires_confirmation` actions the terminal frame
            // carries, parsed + redacted for display, so the interactive loop can
            // drive the in-session confirmation seam. Redaction mirrors the
            // one-shot `parsePendingConfirmations` so no raw secret reaches the
            // transcript.
            pendingConfirmations = parsePendingConfirmations(
              frame.actionCalls,
              readTurnId(frame)
            );
          }
          const event = bridgeFrameToChatEvent(frame);
          if (event) onEvent(event);
        }
      );
      const finalSessionId =
        (outcome && extractSessionId(outcome.sessionId)) ?? terminalSessionId;
      return {
        ...(finalSessionId !== undefined ? { sessionId: finalSessionId } : {}),
        ...(pendingConfirmations.length > 0 ? { pendingConfirmations } : {})
      };
    }
  };
}

function readSessionId(frame: BridgeFrame): string | undefined {
  return (
    extractSessionId(frame.sessionId) ??
    (isRecord(frame.data)
      ? extractSessionId(frame.data.sessionId)
      : undefined)
  );
}

/** The turn's id (needed to scope any confirmation) rides on the done frame's data. */
function readTurnId(frame: BridgeFrame): string | undefined {
  return isRecord(frame.data) ? nonEmptyString(frame.data.turnId) : undefined;
}

function isTypedEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.length > 0
  );
}

function frameToolName(frame: BridgeFrame): string {
  return (
    firstString(
      isRecord(frame.data) ? frame.data.name : undefined,
      isRecord(frame.data) ? frame.data.tool : undefined,
      frame.message
    ) ?? "tool"
  );
}

function frameToolId(frame: BridgeFrame): string {
  return (
    firstString(
      isRecord(frame.data) ? frame.data.toolId : undefined,
      isRecord(frame.data) ? frame.data.id : undefined
    ) ?? ""
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function extractSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Pending-confirmation parsing + redaction.
//
// This is a FAITHFUL PORT of the file-private `parsePendingConfirmations` (and
// its redaction helpers) in `desktop-app-client.ts`, which the public CLI cannot
// import. Kept behavior-identical so the in-session confirmation path applies the
// SAME terminal-injection + secret redaction defenses the one-shot `app` command
// does before any label/value or summary reaches the transcript. If the parser
// there changes, mirror it here. The confirm-card RENDERER (confirm-in-session.ts)
// deliberately writes detail values verbatim — it trusts THIS parser to redact.
// ---------------------------------------------------------------------------

const MAX_CONFIRMATION_DETAILS = 12;
const MAX_CONFIRMATION_LABEL_CHARS = 80;
const MAX_CONFIRMATION_VALUE_CHARS = 240;
const MAX_CONFIRMATION_INPUT_DEPTH = 4;
const TRUNCATION_SUFFIX = " ... [truncated]";
const HIERARCHICAL_URI_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/gu;
const PARSER_NORMALIZED_URI_RE = /(?:ftp|https?|wss?):[^\s<>"'`]+/giu;
const CANONICAL_AUTHORITY_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\\]/u;
const URI_OBFUSCATING_CHAR_RE = /(?:[^\S ]|\p{Cc}|\p{Cf})/u;
const URI_OBFUSCATING_CHAR_RE_GLOBAL = /(?:[^\S ]|\p{Cc}|\p{Cf})/gu;

/**
 * Parse a terminal frame's `actionCalls` into redacted in-session confirmations.
 * Non-confirmation actions are dropped. A pending action without a confirmation
 * handle, or a batch with no originating `turnId`, is a protocol violation and
 * throws (mirrors the one-shot parser — a confirmation is unresolvable without
 * both), so the caller surfaces the error rather than a partial/unsafe card.
 */
function parsePendingConfirmations(
  actionCalls: unknown[] | undefined,
  turnId: string | undefined
): InSessionConfirmationAction[] {
  if (!Array.isArray(actionCalls)) return [];
  const pending: InSessionConfirmationAction[] = [];
  for (const value of actionCalls) {
    if (!isRecord(value)) continue;
    const requiresConfirmation =
      value.requiresConfirmation === true ||
      value.status === "requires_confirmation";
    if (!requiresConfirmation) continue;
    const confirmationHandle = nonEmptyString(value.confirmationHandle);
    if (!confirmationHandle) {
      throw new Error(
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
      turnId: turnId ?? "",
      confirmationHandle,
      summary,
      confirmationDetails
    });
  }
  if (pending.length > 0 && !turnId) {
    throw new Error(
      "Desktop returned confirmations without an originating turn id."
    );
  }
  return pending;
}

function parseSuppliedConfirmationDetails(
  value: unknown
): InSessionConfirmationDetail[] {
  if (!Array.isArray(value)) return [];
  const details: InSessionConfirmationDetail[] = [];
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

function buildGenericConfirmationDetails(
  value: unknown
): InSessionConfirmationDetail[] {
  if (value === undefined) return [];
  const details: InSessionConfirmationDetail[] = [];
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
  details: InSessionConfirmationDetail[],
  overflowed = false
): InSessionConfirmationDetail[] {
  if (!overflowed && details.length <= MAX_CONFIRMATION_DETAILS) return details;
  return [
    ...details.slice(0, MAX_CONFIRMATION_DETAILS - 1),
    { label: "Additional fields", value: "[truncated]" }
  ];
}

function terminalText(value: string, fallback = ""): string {
  return scanTerminalText(value).replace(/\s+/gu, " ").trim() || fallback;
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

function scanTerminalText(value: string): string {
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
    if (code === 0x0d) {
      output.push(" ");
      index += value.charCodeAt(index + 1) === 0x0a ? 2 : 1;
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

function redactSensitiveTerminalText(value: string): string {
  // If removing terminal/format separators reveals URI credentials, fail closed
  // for this display value. Ordinary multiline public URLs remain ordinary text
  // because they expose no credentials.
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
  // Fail closed ONLY when the obfuscating chars actually HID a credential:
  // removing them (concatenating the surrounding text) exposes a redactable
  // credential URI that replacing them with spaces — the normalization
  // terminalText() already performs for display — does NOT expose. That gap is
  // the signature of a control/format char spliced INSIDE a credential URI.
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
  const authorityEnd = firstDelimiterIndex(uri, authorityStart, ["/", "?", "#"]);
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
      : `${fragment.slice(0, fragmentQueryStart + 1)}${redactParameterList(
          fragment.slice(fragmentQueryStart + 1)
        )}`;
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
