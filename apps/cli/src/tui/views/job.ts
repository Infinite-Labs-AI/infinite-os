// The job view (terminal-r4 "Job"): work that takes a while. Each step ticks
// off in place; where it runs and whether it outlives the turn are said
// plainly, and so is where the result lands. `w watch` is offered only when
// the job can say it finished (never with `noCompletionSignal`) and the session
// can watch; `o` only when the session can open the app.
import type { AnswerViewEnvelopeV1 } from "@infinite-os/types";

import type { KeyHint } from "../keys/keymap.js";
import { labelValueLines } from "./change.js";
import { formatAsOf, isRecord, paint, viewText, wrapText } from "./primitives.js";
import type { KindRender, ViewRenderCtx } from "./types.js";

/** Lines of command output kept per stream (the tail the app already cut). */
const MAX_TAIL_LINES = 8;
const MAX_FILES = 12;

const STEP_MARK: Record<string, { glyph: string; role: "success" | "primary" | "muted" | "error" | "warning" }> = {
  done: { glyph: "✓", role: "success" },
  now: { glyph: "◑", role: "primary" },
  todo: { glyph: "·", role: "muted" },
  failed: { glyph: "✗", role: "error" },
  held: { glyph: "◷", role: "warning" }
};

const RUNS_WHERE: Record<string, string> = {
  this_mac_app_open: "Runs on this Mac while the app is open",
  this_mac: "Runs on this Mac",
  cloud: "Runs in the cloud"
};

export function renderJob(view: AnswerViewEnvelopeV1<"job">, ctx: ViewRenderCtx): KindRender {
  const body: Record<string, unknown> = isRecord(view.body) ? view.body : {};
  const steps: unknown[] = Array.isArray(body.steps) ? body.steps : [];
  return {
    detail: jobLines(view.body, ctx),
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
  const progress = isRecord(record.progress) ? record.progress : null;
  const progressWords = progress && isCount(progress.finished) && isCount(progress.of)
    ? `${progress.finished} of ${progress.of}`
    : "";
  const head = [viewText(record.label), progressWords].filter(Boolean).join(" · ");
  if (head) {
    lines.push(...wrapText(head, ctx.width).map((line) => paint(line, "text", ctx, { bold: true })));
  }

  const steps: unknown[] = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps.filter(isRecord)) {
    const mark = STEP_MARK[String(step.state)] ?? { glyph: "?", role: "muted" as const };
    const until = step.state === "held" ? formatAsOf(step.heldUntil, ctx.timeZone) : null;
    const words = [viewText(step.label, "—"), viewText(step.detail), until ? `until ${until}` : ""]
      .filter(Boolean)
      .join(" · ");
    wrapText(words, Math.max(1, ctx.width - 2)).forEach((line, index) => {
      lines.push(index === 0 ? `${paint(mark.glyph, mark.role, ctx)} ${line}` : `  ${line}`);
    });
  }

  const where = RUNS_WHERE[String(record.runsWhere)];
  const whereWords = [where ?? "", record.outlivesTurn === true ? "keeps going after this turn" : ""]
    .filter(Boolean)
    .join(" · ");
  if (whereWords) {
    lines.push(...wrapText(whereWords, ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  const landsAt = isRecord(record.landsAt) ? viewText(record.landsAt.label) : "";
  if (landsAt) {
    lines.push(...wrapText(`↗ Lands in ${landsAt}${ctx.caps.open ? " (o)" : ""}`, ctx.width).map((line) => paint(line, "primary", ctx)));
  }
  if (record.noCompletionSignal === true) {
    lines.push(...wrapText("It can't say when it finishes; check back later.", ctx.width).map((line) => paint(line, "muted", ctx)));
  }
  if (record.autoPublish === true) {
    lines.push(paint("Publishes on its own when done.", "muted", ctx));
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
    const role = command.exitCode === 0 ? "muted" : "warning";
    lines.push(paint(ended, role, ctx));
  }
  for (const [stream, role] of [["stdoutTail", "muted"], ["stderrTail", "warning"]] as const) {
    const raw = typeof command[stream] === "string" ? command[stream] : "";
    const tail = raw.split(/\r?\n/u).map((part) => viewText(part)).filter(Boolean).slice(-MAX_TAIL_LINES);
    for (const part of tail) {
      lines.push(...wrapText(`│ ${part}`, ctx.width).map((wrapped) => paint(wrapped, role, ctx)));
    }
  }
  if (command.truncated === true) {
    lines.push(paint("│ …", "muted", ctx));
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
