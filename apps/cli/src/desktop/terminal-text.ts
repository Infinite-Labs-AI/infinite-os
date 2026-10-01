/**
 * Terminal-injection defense for the in-session confirmation surfaces (readline
 * and Ink): strip ANSI/OSC/C1 control sequences, other control characters and
 * bidi controls before any host-supplied string reaches the TTY.
 *
 * Moved out of `confirm-in-session.ts` (which re-exports it) so the receipt
 * renderer (`confirm-result-lines.ts`) can share it without an import cycle.
 */

const TRUNCATION_SUFFIX = " ... [truncated]";

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
