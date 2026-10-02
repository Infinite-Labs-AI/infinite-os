// The job view (terminal-r4 "Job"): work that takes a while. Each step ticks
// off in place; where it runs and whether it outlives the turn are said
// plainly, and so is where the result lands. `w watch` is offered only when
// the job can say it finished (never with `noCompletionSignal`) and the session
// can watch; `o` only when the session can open the app.
//
// r4's look: the job's name bold white; each step's mark in its tone (✓ bold
// green, a bold cyan spinner for the one running, a dim dot for what is to
// come), the label in one column and its detail in dim; the running step
// carries a progress bar (cyan eighths over a `line` remainder); then where it
// runs in dim, and `Lands in:` with a link.
import type { AnswerViewEnvelopeV1 } from "@infinite-os/types";

import type { KeyHint } from "../keys/keymap.js";
import { displayWidth, padEndCells } from "../lib/display-width.js";
import { linkWords, paragraphIn } from "./card.js";
import { labelValueLines } from "./change.js";
import { afterwordLines, isSettledWithoutRunning } from "./outcome.js";
import { formatAsOf, formatSeconds, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** Lines of command output kept per stream (the tail the app already cut). */
const MAX_TAIL_LINES = 8;
const MAX_FILES = 12;

const STEP_MARK: Record<string, { glyph: string; token: "gb" | "cb" | "dim" | "red" | "amber" }> = {
  done: { glyph: "✓", token: "gb" },
  now: { glyph: "⠋", token: "cb" },
  todo: { glyph: "·", token: "dim" },
  failed: { glyph: "✗", token: "red" },
  held: { glyph: "◷", token: "amber" }
};
/** The step label column (r4 `padEnd(14)`), wider for a longer label, never past this. */
const STEP_LABEL_MIN = 12;
const STEP_LABEL_MAX = 24;
/** The eighths a progress bar ends in (r4 `bar()`). */
const EIGHTHS = " ▏▎▍▌▋▊▉";

const RUNS_WHERE: Record<string, string> = {
  this_mac_app_open: "Runs on this Mac while the app is open",
  this_mac: "Runs on this Mac",
  cloud: "Runs in the cloud"
};

export function renderJob(view: AnswerViewEnvelopeV1<"job">, ctx: ViewRenderCtx): KindRender {
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  const steps: unknown[] = Array.isArray(body.steps) ? body.steps : [];
  return {
    detail: isSettledWithoutRunning(view) ? afterwordLines(view, ctx) : jobLines(view.body, ctx),
    footnotes: [],
    keys: jobKeys(body, ctx),
    okKey: null,
    rowCount: steps.length
  };
}

/** `w watch` only with a completion signal and the watch capability; `o` only with open. */
export function jobKeys(body: Record<string, unknown>, ctx: ViewRenderCtx): KeyHint[] {
  const keys: KeyHint[] = [];
  if (ctx.caps.watch && body.noCompletionSignal !== true && isRecord(body.watch)) {
    keys.push({ key: "w", label: "watch" });
  }
  if (ctx.caps.open && isRecord(body.landsAt)) {
    keys.push({ key: "o", label: "open" });
  }
  return keys;
}

/** The job body as lines (shared with the approval card). */
export function jobLines(body: unknown, ctx: ViewRenderCtx): string[] {
  const record = isRecord(body) ? body : {};
  const lines: string[] = [];
  const steps = (Array.isArray(record.steps) ? record.steps : []).filter(isRecord);
  const progress = isRecord(record.progress) && isCount(record.progress.finished) && isCount(record.progress.of)
    ? { finished: record.progress.finished, of: record.progress.of }
    : null;
  const running = steps.find((step) => step.state === "now");
  const label = viewText(record.label);
  // The progress goes on the running step's bar; with no running step it follows the name.
  const head = [label, progress && !running ? `${progress.finished} of ${progress.of}` : ""].filter(Boolean).join(" · ");
  if (head) {
    lines.push(...paragraphIn(head, ctx.width, "b", ctx));
  }

  if (steps.length) {
    if (lines.length) lines.push("");
    lines.push(...stepLines(steps, progress, ctx));
  }

  // r4: how long it usually takes, and that it keeps going; where it runs only when that is this Mac
  // (it stops when the Mac or the app does), since the cloud is where a job runs by default.
  const where = record.runsWhere === "cloud" ? "" : RUNS_WHERE[String(record.runsWhere)] ?? "";
  const eta = isCount(record.etaMs) && record.etaMs > 0 ? `usually about ${minutesWords(record.etaMs)}` : "";
  // r4 `2:03 so far`: how long it has run, from its start, while it runs.
  const startedMs = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
  const soFar = record.phase === "running" && Number.isFinite(startedMs) && Date.now() >= startedMs
    ? `${formatSeconds(Math.floor((Date.now() - startedMs) / 1000))} so far`
    : "";
  const whereWords = [soFar, eta, record.outlivesTurn === true ? "keeps going while you chat" : "", where]
    .filter(Boolean)
    .join(" · ");
  if (whereWords) {
    lines.push("", ...paragraphIn(whereWords, ctx.width, "dim", ctx));
  }
  const landsAt = isRecord(record.landsAt) ? viewText(record.landsAt.label) : "";
  if (landsAt) {
    if (!whereWords) lines.push("");
    lines.push(fitLanding(`${paint("Lands in:", "dim", ctx)} ${linkWords(landsAt, ctx)}${ctx.caps.open ? `  ${paint("(o)", "dim", ctx)}` : ""}`, landsAt, ctx));
  }
  if (record.noCompletionSignal === true) {
    lines.push(...paragraphIn("It can't say when it finishes; check back later.", ctx.width, "dim", ctx));
  }
  if (record.autoPublish === true) {
    lines.push(paint("Publishes on its own when done.", "dim", ctx));
  }

  const command = isRecord(record.command) ? record.command : null;
  if (command) {
    lines.push(...commandLines(command, ctx));
  }
  const files: unknown[] = Array.isArray(record.files) ? record.files : [];
  const fileRows = files.filter(isRecord).slice(0, MAX_FILES).map((file) => ({
    label: viewText(file.name, "—"),
    value: isCount(file.bytes) ? bytesWords(file.bytes) : "size unknown"
  }));
  lines.push(...labelValueLines(fileRows, ctx));
  return lines;
}

/** One line per step: its mark, its label in one column, then its detail (or the running step's bar). */
function stepLines(
  steps: readonly Record<string, unknown>[],
  progress: { finished: number; of: number } | null,
  ctx: ViewRenderCtx
): string[] {
  const labels = steps.map((step) => viewText(step.label, "—"));
  // The column lines up the details; a step still to come has none, so it does not widen it.
  const columned = labels.filter((_, index) => steps[index]!.state !== "todo");
  const column = Math.min(STEP_LABEL_MAX, Math.max(STEP_LABEL_MIN, ...columned.map(displayWidth))) + 2;
  const room = Math.max(1, ctx.width - 2);
  return steps.flatMap((step, index) => {
    const mark = STEP_MARK[String(step.state)] ?? { glyph: "?", token: "dim" as const };
    const until = step.state === "held" ? formatAsOf(step.heldUntil, ctx.timeZone) : null;
    const own = [viewText(step.detail), until ? `until ${until}` : ""].filter(Boolean).join(" · ");
    const label = labels[index] ?? "—";
    // The head leaves the count to the running step: it says it on its bar, or after its detail.
    const counted = step.state === "now" && progress ? `${progress.finished} of ${progress.of}` : "";
    const glyph = paint(mark.glyph, mark.token, ctx);
    if (step.state === "todo") {
      // Still to come: the whole row is dim.
      return wrapText([label, own].filter(Boolean).join(" · "), room)
        .map((line, row) => row === 0 ? `${glyph} ${paint(line, "dim", ctx)}` : `  ${paint(line, "dim", ctx)}`);
    }
    const name = padEndCells(label, column);
    if (step.state === "now" && progress && progress.of > 0) {
      const gw = Math.max(10, Math.min(26, ctx.width - 40));
      const after = own || counted;
      const barCells = displayWidth(name) + gw + 2 + displayWidth(after);
      if (barCells <= room) {
        return [`${glyph} ${name}${progressBar(progress.finished / progress.of, gw, ctx)}${after ? `  ${after}` : ""}`.trimEnd()];
      }
    }
    // No bar: the count joins the detail, so the row still says how far.
    const detail = [own, counted].filter(Boolean).join(" · ");
    if (displayWidth(name) + displayWidth(detail) <= room) {
      return [`${glyph} ${name}${detail ? paint(detail, "dim", ctx) : ""}`.trimEnd()];
    }
    return wrapText([label, detail].filter(Boolean).join(" · "), room)
      .map((line, row) => (row === 0 ? `${glyph} ${line}` : `  ${line}`));
  });
}

/** r4 `bar()`: full cells, one eighth cell, then the remainder as `░` in the line colour. */
function progressBar(fraction: number, width: number, ctx: ViewRenderCtx): string {
  const frac = Math.max(0, Math.min(1, fraction));
  const full = frac * width;
  const whole = Math.floor(full);
  const eighth = Math.min(7, Math.round((full - whole) * 8));
  const filled = `${"█".repeat(whole)}${eighth > 0 && whole < width ? EIGHTHS[eighth] : ""}`;
  const rest = "░".repeat(Math.max(0, width - Math.ceil(full)));
  return `${filled ? paint(filled, "cyan", ctx) : ""}${rest ? paint(rest, "line", ctx) : ""}`;
}

/** `Lands in: <link>`, or the words alone when the line is too narrow for the link. */
function fitLanding(line: string, landsAt: string, ctx: ViewRenderCtx): string {
  return displayWidth(line) <= Math.max(1, ctx.width) ? line : paint(`Lands in: ${landsAt}`, "dim", ctx);
}

function minutesWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

function commandLines(command: Record<string, unknown>, ctx: ViewRenderCtx): string[] {
  const argv: unknown[] = Array.isArray(command.argv) ? command.argv : [];
  const lines: string[] = [];
  const line = argv.map((arg) => viewText(arg)).filter(Boolean).join(" ");
  if (line) {
    lines.push(...wrapText(`$ ${line}`, ctx.width));
  }
  const ended = command.endedBy === "timeout" ? "timed out"
    : command.endedBy === "cancelled" ? "cancelled"
      : typeof command.exitCode === "number" ? `exit ${command.exitCode}`
        : viewText(command.signal) ? `signal ${viewText(command.signal)}`
          : "";
  if (ended) {
    lines.push(paint(ended, command.exitCode === 0 ? "dim" : "amber", ctx));
  }
  for (const [stream, role] of [["stdoutTail", "dim"], ["stderrTail", "amber"]] as const) {
    const raw = typeof command[stream] === "string" ? command[stream] : "";
    const tail = raw.split(/\r?\n/u).map((part) => viewText(part)).filter(Boolean).slice(-MAX_TAIL_LINES);
    for (const part of tail) {
      lines.push(...wrapText(`│ ${part}`, ctx.width).map((wrapped) => paint(wrapped, role, ctx)));
    }
  }
  if (command.truncated === true) {
    lines.push(paint("│ …", "dim", ctx));
  }
  return lines;
}

function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
