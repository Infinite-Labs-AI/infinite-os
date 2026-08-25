/**
 * In-session confirmation for the forked desktop interactive loop.
 *
 * When a Desktop turn's terminal frame carries a `requires_confirmation` action,
 * the interactive loop pauses, renders the (already-redacted) confirm card into
 * the transcript, prompts the operator on the TTY, and — only on an explicit
 * approval — calls `client.confirm(...)` and renders the JSON result back into
 * the transcript as a synthetic segment. Decline (`n` / bare Enter) calls
 * nothing.
 *
 * The card detail values are redacted UPSTREAM (the desktop-app-client parser
 * fills `confirmationDetails` with redacted label/value pairs), so the renderer
 * here is the same minimal `label: value` layout the one-shot `app` command
 * uses — it never re-derives or exposes raw input.
 *
 * The `summary`, however, is NOT covered by that upstream redaction contract, so
 * — exactly as the reference `renderPendingConfirmation` / `promptForConfirmation`
 * do — every place we write it to the terminal runs it through {@link terminalText}
 * (strip ANSI/OSC/control sequences, collapse whitespace) and, at the prompt,
 * {@link boundedTerminalText} (bound length). A summary carrying escape/control
 * sequences must never reach the raw TTY: that is a terminal-injection defense the
 * one-shot path keeps, and the in-session path must keep it too.
 *
 * {@link terminalText} is exported so the Ink confirmation overlay (the default
 * TTY surface's in-session write gate) can apply the SAME summary sanitization
 * before rendering — the Ink `<Text>` child ultimately reaches the terminal, so
 * a summary carrying escape/control sequences must be scrubbed there too. The
 * (already-redacted) detail values are rendered verbatim, exactly as this file's
 * `renderConfirmationCard` writes them.
 */

/** Upper bound on the summary length echoed into the TTY prompt (reference parity). */
const MAX_CONFIRMATION_VALUE_CHARS = 240;
const TRUNCATION_SUFFIX = " ... [truncated]";

/** A single redacted label/value line of the confirm card. */
export interface InSessionConfirmationDetail {
  label: string;
  value: string;
}

/**
 * The pending action to confirm. `confirmationDetails` are ALREADY redacted by
 * the client parser; `turnId` scopes the confirmation to its originating turn.
 */
export interface InSessionConfirmationAction {
  turnId: string;
  confirmationHandle: string;
  summary: string;
  confirmationDetails: InSessionConfirmationDetail[];
}

/** The TTY seam: readiness flags, a line prompt, and a transcript writer. */
export interface InSessionConfirmationIo {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  prompt(question: string): Promise<string>;
  write(text: string): void;
}

/** The narrow client contract this handler drives (the real client's `confirm`). */
export interface InSessionConfirmationClient {
  confirm(input: {
    turnId: string;
    confirmationHandle: string;
    decision: "approve" | "decline";
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Render the redacted confirm card, prompt `Approve "…"? [y/N]`, and — on an
 * explicit `y`/`yes` — call `client.confirm(...)` and render the JSON result.
 * Any other answer (including bare Enter) declines and calls nothing.
 */
export async function handleInSessionConfirmation(
  action: InSessionConfirmationAction,
  io: InSessionConfirmationIo,
  client: InSessionConfirmationClient,
  signal?: AbortSignal
): Promise<void> {
  renderConfirmationCard(action, io);

  // Never prompt on a non-interactive terminal — surface the pending action and
  // leave it unexecuted rather than blocking on an absent TTY.
  if (!io.inputIsTTY || !io.outputIsTTY) {
    io.write("Action was not executed (non-interactive terminal).\n");
    return;
  }

  const promptSummary = boundedTerminalText(
    action.summary,
    MAX_CONFIRMATION_VALUE_CHARS,
    "action"
  );
  const answer = (await io.prompt(`Approve "${promptSummary}"? [y/N] `))
    .trim()
    .toLowerCase();
  const approved = answer === "y" || answer === "yes";
  if (!approved) {
    io.write(`Confirmation declined: ${terminalText(action.summary, "action")}\n`);
    return;
  }

  const result = await client.confirm({
    turnId: action.turnId,
    confirmationHandle: action.confirmationHandle,
    decision: "approve",
    ...(signal ? { signal } : {})
  });

  renderConfirmationResult(result, io);
}

function renderConfirmationCard(
  action: InSessionConfirmationAction,
  io: InSessionConfirmationIo
): void {
  io.write(`Pending confirmation: ${terminalText(action.summary, "action")}\n`);
  for (const detail of action.confirmationDetails) {
    io.write(`  ${detail.label}: ${detail.value}\n`);
  }
}

function renderConfirmationResult(
  result: unknown,
  io: InSessionConfirmationIo
): void {
  io.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Strip ANSI/OSC/C1 control sequences and other terminal-control characters from
 * a display string, then collapse whitespace to single spaces. This is a port of
 * the file-private `terminalText` in `desktop-app-client.ts` (which is out of this
 * task's editable scope), kept behavior-identical so the in-session path matches
 * the one-shot renderer's terminal-injection defense.
 */
export function terminalText(value: string, fallback = ""): string {
  return scanTerminalText(value).replace(/\s+/gu, " ").trim() || fallback;
}

/** {@link terminalText} plus a length bound with a truncation suffix. */
export function boundedTerminalText(
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

/**
 * Walk the string dropping escape/control sequences; every stripped control byte
 * and whitespace char becomes a single space so nothing re-flows the cursor.
 */
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

/** Consume a CSI control sequence up to its final byte (0x40–0x7e). */
function skipControlSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length;
}

/** Consume an OSC/DCS/etc. control string up to its ST/BEL terminator. */
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
