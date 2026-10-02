// One fixture per r4 golden SCREEN (`tui/views/__fixtures__/r4/<screen>.json`):
// what the session knows when it draws that screen — the workspace and its
// connections (the top bar), the question, the answer, the turn's views, its
// steps with start and end (the Steps strip), and whether it is still running.
// The `--c60/--c100/--c160` goldens of one screen share its fixture.
//
// The data is SYNTHETIC (spec §2.2): the same values the synthetic goldens print.
// Views are typed against the answer view contract, so a contract change that
// breaks a fixture fails the typecheck-free decode in `golden.test.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";

export const R4_FIXTURES_DIR = fileURLToPath(new URL("../../views/__fixtures__/r4/", import.meta.url));

/** r4's step statuses (terminal-r4 `frame()` Steps glyph table). */
export type R4StepStatus = "ok" | "wait" | "run" | "fail" | "unk" | "off" | "bg" | "part" | "old";

export interface R4Step {
  label: string;
  /** Start and end on the turn's own clock (any unit; the strip scales by the latest end). */
  start: number;
  end: number;
  result: string;
  status: R4StepStatus;
}

export interface R4Connection {
  name: string;
  /** connected = green ●; broken = red ⊘; missing = amber ⊘ (the asked source is not connected). */
  status: "connected" | "broken" | "missing";
}

export interface R4Turn {
  question: string;
  answer: string;
  /** The turn's answer views, in arrival order. */
  views: AnswerViewV1[];
  /** Index into `views` of an approval that is waiting on this turn (drawn as the write card), if any. */
  pending?: number;
  steps: R4Step[];
  /** The composer's busy note while the turn still runs (r4 `o.busy`); absent = idle. */
  busy?: string;
  /**
   * The key focus the screen is drawn in, when not the default: the selected
   * row (`view-02-list` selects Hook B), or a write card opened on its
   * documents (`flow-email-02`, `v` pressed). `screen.ts` applies what the
   * session lets a render take today; see its header.
   */
  focus?: { selected?: number; viewOpen?: boolean };
}

export interface R4ScreenFixture {
  screen: string;
  session: { workspace: string; connections: R4Connection[] };
  /** null = the boot screen, before the first turn. */
  turn: R4Turn | null;
  /**
   * What r4 prints on this screen that the answer view contract has no field
   * for (or that a binding decision changes), so a lane knows where a golden
   * row's words must come from. Notes for people; the test never reads them.
   */
  gaps?: string[];
}

export function r4FixtureIds(): string[] {
  return readdirSync(R4_FIXTURES_DIR).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort();
}

export function loadR4Fixture(screen: string): R4ScreenFixture {
  return JSON.parse(readFileSync(`${R4_FIXTURES_DIR}${screen}.json`, "utf8")) as R4ScreenFixture;
}
