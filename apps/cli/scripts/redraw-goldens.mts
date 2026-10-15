// Re-draw frame goldens from the CLI's own renderer.
//
// The one-column default (V1, River 2026-10-15) re-drew every frame golden whose
// screen it changed from the CLI itself (`drawn_by` on the file): r4 draws only
// the two-column layout. When the CLI's drawing of such a frame changes on
// purpose (a T12 key landing, see `known-gaps.ts`), re-draw it here, review the
// diff, then run the golden test (`GOLDEN_RATCHET=update` records what newly
// matches).
//
//   pnpm exec tsx --tsconfig tests/model-picker.tsconfig.json apps/cli/scripts/redraw-goldens.mts <id>...  # report which differ
//   ... --drawn                                                  # every drawn_by frame
//   ... --write                                                  # write the re-drawn files
//
// Only frame goldens are re-drawn (region goldens are r4 slices, kept as
// exported). The screen is drawn as golden.test.ts draws it: truecolor, UTC,
// at the r4 data's clock. Synthetic data only.
const pins: Record<string, string | undefined> = {
  FORCE_COLOR: "3", COLORTERM: "truecolor", TERM: "xterm-256color", TZ: "UTC", INFINITE_COLOR: "truecolor",
  NO_COLOR: undefined, INFINITE_THEME: undefined, INFINITE_PLAIN_OUTPUT: undefined
};
for (const [key, value] of Object.entries(pins)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** The wall clock every screen is drawn at (golden.test.ts `FIXED_CLOCK`). */
const CLOCK = Date.parse("2026-10-01T10:44:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [CLOCK]) as [number]));
  }
  static override now() {
    return CLOCK;
  }
} as DateConstructor;

const { writeFileSync } = await import("node:fs");
const { homeInventoryData } = await import("../src/index.js");
const { ansiToSegmentLines } = await import("../src/tui/style/golden/ansi-to-segments.js");
const { ENTRY_SESSION_PROPS } = await import("../src/tui/style/golden/feed-chrome.js");
const { loadR4Fixture } = await import("../src/tui/style/golden/fixtures.js");
const { GOLDENS_DIR, goldenIds, loadGolden, screenOf } = await import("../src/tui/style/golden/goldens.js");
const { textOf } = await import("../src/tui/style/golden/normalize.js");
const { renderR4Screen } = await import("../src/tui/style/golden/screen.js");

const DRAWN_BY = "the CLI's one-column renderer (V1, River 2026-10-15)";
const args = process.argv.slice(2);
const write = args.includes("--write");
const all = goldenIds();
const asked = args.includes("--drawn")
  ? all.filter((id) => loadGolden(id).drawn_by)
  : args.filter((arg) => !arg.startsWith("--"));
if (!asked.length) {
  console.error("usage: redraw-goldens.mts <id>... | --drawn [--write]");
  process.exit(2);
}

const changed: string[] = [];
for (const id of asked) {
  if (!all.includes(id)) throw new Error(`${id}: no such golden`);
  const golden = loadGolden(id);
  if (golden.view_kind === "region") throw new Error(`${id}: a region golden is an r4 slice; re-draw frames only`);
  const { screen, cols } = screenOf(id, golden);
  const lines = ansiToSegmentLines(renderR4Screen(loadR4Fixture(screen), {
    cols, now: CLOCK, homeInventory: homeInventoryData, sessionProps: ENTRY_SESSION_PROPS
  }));
  const texts = lines.map((line) => textOf(line));
  // The frame: top bar, rule, body, [Steps rule, Steps], rule, composer, key bar.
  const keybar = lines.length - 1;
  const composer = keybar - 1;
  const ruleBottom = keybar - 2;
  if (!/^─+$/u.test(texts[ruleBottom] ?? "") || !/^─+$/u.test(texts[1] ?? "")) {
    throw new Error(`${id}: not a frame (no rule under the top bar or over the composer):\n${texts.join("\n")}`);
  }
  const stepsAt = texts.findIndex((text, row) => row > 1 && row < ruleBottom && /^─ Steps /u.test(text));
  const regions: Record<string, [number, number]> = { topbar: [0, 0], rule_top: [1, 1] };
  const bodyEnd = (stepsAt >= 0 ? stepsAt : ruleBottom) - 1;
  if (bodyEnd >= 2) regions.body = [2, bodyEnd];
  if (stepsAt >= 0) {
    regions.steps_header = [stepsAt, stepsAt];
    if (ruleBottom - 1 > stepsAt) regions.steps = [stepsAt + 1, ruleBottom - 1];
  }
  Object.assign(regions, { rule_bottom: [ruleBottom, ruleBottom], composer: [composer, composer], keybar: [keybar, keybar] });
  // Two columns: a body row carries the panes' separator.
  const wide = texts.slice(2, bodyEnd + 1).some((text) => text.includes(" │ "));
  const next = {
    id,
    view_kind: golden.view_kind,
    state: golden.state,
    cols,
    ...(golden.derived ? { derived: golden.derived } : {}),
    ...(golden.flow_kind ? { flow_kind: golden.flow_kind } : {}),
    ...(golden.flow_step !== undefined ? { flow_step: golden.flow_step } : {}),
    layout: wide ? golden.layout : { wide: false, answer_w: cols, separator: "", details_w: cols },
    drawn_by: golden.drawn_by ?? DRAWN_BY,
    regions,
    lines
  };
  if (JSON.stringify(next.lines) === JSON.stringify(golden.lines) && JSON.stringify(next.regions) === JSON.stringify(golden.regions)) continue;
  changed.push(id);
  if (write) writeFileSync(`${GOLDENS_DIR}${id}.json`, `${JSON.stringify(next)}\n`);
}
console.log(`${write ? "re-drew" : "would re-draw"} ${changed.length} of ${asked.length}${changed.length ? `: ${changed.join(" ")}` : ""}`);
