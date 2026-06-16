import spinners, { type BrailleSpinnerName } from "unicode-animations";

import { formatElapsedSeconds } from "../../formatting/progress.js";
import { FACES } from "../content/faces.js";
import { TOOL_VERBS, VERBS } from "../content/verbs.js";
import { toolTrailLabel } from "../lib/text.js";
import type { TurnState } from "../app/turn-store.js";

const THINK_SPINNERS: readonly BrailleSpinnerName[] = ["helix", "breathe", "orbit", "dna", "waverows", "snake", "pulse"];
const TOOL_SPINNERS: readonly BrailleSpinnerName[] = ["cascade", "scan", "diagswipe", "fillsweep"];

export const FACE_TICK_MS = 2_500;
export const SPINNER_TICK_MS = 100;
export const VERB_PAD_LEN = VERBS.reduce((max, verb) => Math.max(max, verb.length), 0) + 1;

export function padInfiniteVerb(verb: string): string {
  return `${verb}…`.padEnd(VERB_PAD_LEN, " ");
}

export function isInfiniteTurnBusy(state: TurnState): boolean {
  return Boolean(
    state.tools.length ||
    state.reasoningActive ||
    state.reasoningStreaming ||
    state.streaming.trim() ||
    state.subagents.some((subagent) => subagent.status === "running")
  );
}

export function formatInfiniteBusyIndicator({
  labelTick,
  nowMs,
  spinnerTick,
  state,
  tick,
  turnStartedAt
}: {
  labelTick?: number;
  nowMs: number;
  spinnerTick?: number;
  state: TurnState;
  tick?: number;
  turnStartedAt?: number;
}): string {
  const activeTool = state.tools.at(-1);
  const displayTick = labelTick ?? tick ?? 0;
  const spinner = spinnerFrame(spinnerTick ?? tick ?? displayTick, displayTick, activeTool ? "tool" : "think");
  const face = FACES[displayTick % FACES.length] ?? "*";
  const verb = padInfiniteVerb(activeTool ? toolVerb(activeTool.name) : VERBS[displayTick % VERBS.length] ?? "thinking");
  const subject = activeTool?.name
    ? toolTrailLabel(activeTool.name)
    : state.reasoningStreaming || state.reasoningActive
      ? "reasoning"
      : state.streaming
        ? "streaming"
        : "working";
  const startedAt = activeTool?.startedAt ?? turnStartedAt;
  const elapsed = startedAt ? ` · ${formatElapsedSeconds(nowMs - startedAt)}` : "";

  return `${spinner} ${face} ${verb} ${subject}${elapsed}`;
}

export function infiniteBusySpinnerIntervalMs(state: TurnState, labelTick = 0): number {
  const activeTool = state.tools.at(-1);
  const spinner = resolveSpinner(labelTick, activeTool ? "tool" : "think");

  return Math.max(60, spinner.interval || SPINNER_TICK_MS);
}

function toolVerb(name: string): string {
  return TOOL_VERBS[name] ?? TOOL_VERBS[name.replace(/-/g, "_")] ?? "running";
}

function spinnerFrame(spinnerTick: number, labelTick: number, variant: "think" | "tool"): string {
  const spinner = resolveSpinner(labelTick, variant);
  const frame = spinner.frames[spinnerTick % spinner.frames.length] ?? "⠋";

  return [...frame][0] ?? frame;
}

function resolveSpinner(labelTick: number, variant: "think" | "tool") {
  const names = variant === "tool" ? TOOL_SPINNERS : THINK_SPINNERS;
  const name = names[labelTick % names.length] ?? "helix";

  return spinners[name] ?? spinners.helix;
}
