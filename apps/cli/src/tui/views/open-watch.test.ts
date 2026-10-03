// T12 (P3.3): `o` opens the place a view names in the app, through the
// desktop's /v1/open (app.open.v1), and `w` watches a job. Both come from
// negotiation: on an old desktop `o` is absent from the bar and types.
// `o` never opens a browser and never reads `appLink.url` (the bridge strips
// it): a link's `place` (and its string `params`) is the whole request.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Key } from "ink";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { DesktopAppClient, DesktopStatus } from "../../desktop-app-client.js";
import { createDesktopSessionTurnRunner } from "../../desktop/desktop-interactive.js";
import { keyBarText, type KeyContext } from "../keys/keymap.js";
import { resolveTheme } from "../theme.js";
import { approvalRender, cardKeyStep, cardOpenLink, cardUiStart } from "./approval.js";
import { resolveViewKey, viewFocusAfterTurnDone, viewKeyFacts, viewKeyHints, type ViewFocusState } from "./focus.js";
import { appOpenTarget } from "./open-target.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const OLD: KeyContext["caps"] = { open: false, watch: false, retry: false };
const NEW: KeyContext["caps"] = { open: true, watch: true, retry: false };

function raw(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as Record<string, unknown>;
}

function view(value: Record<string, unknown>): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, tool: "read_item", title: "Item", state: "ready", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], ...value
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (caps: KeyContext["caps"], overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 80, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps, timeZone: "UTC", ...overrides
});

/** The session's path: focus after the turn, facts from the render, then the keys pressed. */
function focus(v: AnswerViewV1, caps: KeyContext["caps"]): ViewFocusState {
  return viewFocusAfterTurnDone([v], caps);
}
function press(state: ViewFocusState, v: AnswerViewV1, input: string, key: Partial<Key> = {}): ViewFocusState {
  const render = renderView(v, ctx(state.caps, { selected: state.selected, engaged: state.engaged }));
  return resolveViewKey(input, state, key, viewKeyFacts(v, render));
}
function engaged(v: AnswerViewV1, caps: KeyContext["caps"]): ViewFocusState {
  const start = focus(v, caps);
  const next = press(start, v, "", { tab: true });
  return next.handled ? next : { ...start, engaged: true, focus: "rows" };
}
function hints(state: ViewFocusState, v: AnswerViewV1) {
  const render = renderView(v, ctx(state.caps, { selected: state.selected, engaged: state.engaged }));
  return viewKeyHints(state, viewKeyFacts(v, render), render.keys);
}

const images = () => view(raw("images-done"));
const job = () => view(raw("job-running"));

describe("the place `o` opens is place + params, never a URL", () => {
  it("reads place and string params only, dropping url and anything else", () => {
    expect(appOpenTarget({ place: "creative.library", label: "Library", params: { ids: "a,b", n: 3 }, url: "infinite://open/v1?x" }))
      .toEqual({ place: "creative.library", params: { ids: "a,b" } });
    expect(appOpenTarget({ place: "ads.meta", label: "Ads" })).toEqual({ place: "ads.meta" });
    expect(appOpenTarget({ label: "No place", url: "https://example.com" })).toBeNull();
    expect(appOpenTarget({ place: "   " })).toBeNull();
    expect(appOpenTarget("ads.meta")).toBeNull();
  });
});

describe("`o` on a view (app.open.v1)", () => {
  it("on an old desktop `o` is absent from the bar and types into the composer", () => {
    const v = images();
    const state = engaged(v, OLD);
    expect(hints(state, v).map((hint) => hint.key)).not.toContain("o");
    const next = press(state, v, "o");
    expect(next.effect).toBeNull();
    expect(next.focus).toBe("composer");
  });

  it("with the capability `o` is on the bar and opens the view's place with its params", () => {
    const v = images();
    const state = engaged(v, NEW);
    // r4 flow-images (keys `o open in Library`): a link that names its place keeps it, in the bar's lowercase.
    expect(hints(state, v)).toContainEqual(expect.objectContaining({ key: "o", label: "open in Library" }));
    const next = press(state, v, "o");
    expect(next.handled).toBe(true);
    expect(next.effect).toEqual({ type: "open", target: { place: "creative.library", params: { ids: "img_1,img_2,img_3" } } });
  });

  it("a view whose link has a place and no url is enough; a url on it is never read", () => {
    const withUrl = view({ ...raw("images-done"), appLink: { place: "creative.library", label: "Library", url: "https://example.com/x" } });
    const next = press(engaged(withUrl, NEW), withUrl, "o");
    expect(next.effect).toEqual({ type: "open", target: { place: "creative.library" } });
    expect(JSON.stringify(next.effect)).not.toContain("example.com");
  });

  it("before the view is engaged `o` is the first letter of a message (\"ok…\")", () => {
    const v = images();
    const state = focus(v, NEW);
    expect(state.engaged).toBe(false);
    expect(press(state, v, "o").effect).toBeNull();
  });

  it("a job opens where it lands", () => {
    const v = job();
    const next = press(engaged(v, NEW), v, "o");
    expect(next.effect).toEqual({ type: "open", target: { place: "content.posts" } });
  });

  it("a view with no app link has no `o`", () => {
    const v = view(raw("list-rows"));
    const state = engaged(v, NEW);
    expect(hints(state, v).map((hint) => hint.key)).not.toContain("o");
    expect(press(state, v, "o").effect).toBeNull();
  });
});

describe("the composer bar's `o` and `w` read as r4 draws them", () => {
  const bar = (state: ViewFocusState, v: AnswerViewV1) => hints(state, v).map((hint) => `${hint.key} ${hint.label}`);

  it("a running job: `w watch` then `o open` (r4 view-08-job), never the place's raw label", () => {
    const v = job();
    expect(bar(engaged(v, NEW), v)).toEqual(["w watch", "o open", "tab switch side"]);
  });

  it("a fix or a link that does not name itself `Open in …` is plain `o open` on the bar", () => {
    const v = view(raw("health-connections"));
    const labels = bar(engaged(v, NEW), v).filter((hint) => hint.startsWith("o "));
    expect(labels).toEqual(["o open"]);
  });

  it("the bar never carries a link's capitalised words (`Open in …`, `Posts`)", () => {
    for (const v of [job(), images(), view(raw("health-connections"))]) {
      const o = hints(engaged(v, NEW), v).find((hint) => hint.key === "o");
      expect(o?.label).toMatch(/^open( in .+)?$/u);
    }
  });
});

describe("`w` watches a job (where the plan says: a job that can say it finished)", () => {
  it("sends the job's watch ask as a new turn", () => {
    const v = job();
    const state = engaged(v, NEW);
    expect(hints(state, v)).toContainEqual(expect.objectContaining({ key: "w", label: "watch" }));
    expect(press(state, v, "w").effect).toEqual({ type: "ask", text: "how is the blog post going?" });
  });

  it("a job with noCompletionSignal has no `w`", () => {
    const v = view({ ...raw("job-running"), body: { ...(raw("job-running").body as Record<string, unknown>), noCompletionSignal: true } });
    const state = engaged(v, NEW);
    expect(hints(state, v).map((hint) => hint.key)).not.toContain("w");
    expect(press(state, v, "w").effect).toBeNull();
  });

  it("without the capability there is no `w`", () => {
    const v = job();
    const state = engaged(v, OLD);
    expect(hints(state, v).map((hint) => hint.key)).not.toContain("w");
    expect(press(state, v, "w").effect).toBeNull();
  });
});

describe("`o` on an approval card", () => {
  const card = () => view({
    ...raw("images-done"),
    state: "needs_yes",
    approval: { kind: "card", title: "Save 3 images?", confirmLabel: "Save", dismissLabel: "Dismiss", rows: [] }
  });

  it("opens the card's place, and only with the capability", () => {
    const v = card();
    expect(cardOpenLink(v)).toEqual({ place: "creative.library", params: { ids: "img_1,img_2,img_3" } });
    const ui = cardUiStart(null);
    const withCaps = approvalRender(v, { ...ctx(NEW), ui, fieldsCapable: true });
    expect(withCaps.keyCtx.caps.open).toBe(true);
    expect(cardKeyStep({ type: "open" }, withCaps, ui).effect).toEqual({ type: "open" });
    const old = approvalRender(v, { ...ctx(OLD), ui, fieldsCapable: true });
    expect(old.keyCtx.caps.open).toBe(false);
    expect(old.keys.map((hint) => hint.key)).not.toContain("o");
  });
});

// Live T4 (round 4): `o` was labelled with the state's fix sentence ("If it
// changed in Ads Manager since: Live refresh in Meta Ads"), and a card said
// `o Open in Meta Ads` while the bar said `o open in the app`. The o label is
// the app link's own label (`open in <place>` when it names itself so), else
// `open`; the card's key line and the bar say the same. What o opens is unchanged.
describe("one `o` label: the app link's own, never the fix sentence (live T4)", () => {
  const FIX_SENTENCE = "If it changed in Ads Manager since: Live refresh in Meta Ads";
  const stale = (appLink: Record<string, unknown>) => view({
    ...raw("numbers-ads"),
    state: "out_of_date",
    stateReason: { code: "out_of_date", words: "These numbers are from yesterday.", fix: { label: FIX_SENTENCE, appLink } }
  });
  // A chip without colour reads `[o] open in Meta Ads` (card.ts chipRows).
  const chipLabel = (lines: readonly string[]): string | null => {
    for (const row of lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""))) {
      const match = /\[o\] (.+?)(?:\s{2,}|\s*│|$)/u.exec(row);
      if (match) return match[1]!.trim();
    }
    return null;
  };

  it("a state fix with an app link: o reads the link's label, never the fix sentence, and opens the fix's place", () => {
    const v = stale({ place: "ads.meta", label: "Open in Meta Ads" });
    const render = renderView(v, ctx(NEW));
    expect(render.openLabel).toBe("Open in Meta Ads");
    const state = engaged(v, NEW);
    const o = hints(state, v).find((hint) => hint.key === "o");
    expect(o?.label).toBe("open in Meta Ads");
    expect(JSON.stringify(hints(state, v))).not.toContain("If it changed");
    expect(press(state, v, "o").effect).toEqual({ type: "open", target: { place: "ads.meta" } });
  });

  it("a fix link with no label of its own: plain `open`", () => {
    const v = stale({ place: "ads.meta" });
    const state = engaged(v, NEW);
    expect(hints(state, v).find((hint) => hint.key === "o")?.label).toBe("open");
    expect(JSON.stringify(renderView(v, ctx(NEW)))).not.toContain(`o  ${FIX_SENTENCE}`);
  });

  it("an approval card: its `o` chip and the key bar say the same label", () => {
    const v = view({
      ...raw("images-done"),
      state: "needs_yes",
      appLink: { place: "ads.meta", label: "Open in Meta Ads" },
      approval: { kind: "card", title: "Pause ad “Ad A”?", confirmLabel: "Pause", dismissLabel: "Dismiss", rows: [] }
    });
    const drawn = approvalRender(v, { ...ctx(NEW), ui: cardUiStart(null), fieldsCapable: true });
    const bar = drawn.keys.find((hint) => hint.key === "o");
    expect(bar?.label).toBe("open in Meta Ads");
    expect(chipLabel(drawn.lines)).toBe("open in Meta Ads");
    expect(keyBarText(drawn.keys)).not.toContain("open in the app");
  });

  it("an approval card whose link does not name itself `Open in …`: chip and bar both `open`", () => {
    const v = view({
      ...raw("images-done"),
      state: "needs_yes",
      appLink: { place: "creative.library", label: "Library" },
      approval: { kind: "card", title: "Save 3 images?", confirmLabel: "Save", dismissLabel: "Dismiss", rows: [] }
    });
    const drawn = approvalRender(v, { ...ctx(NEW), ui: cardUiStart(null), fieldsCapable: true });
    expect(drawn.keys.find((hint) => hint.key === "o")?.label).toBe("open");
    expect(chipLabel(drawn.lines)).toBe("open");
  });

  it("a settled change card: its `o` chip says what the bar says", () => {
    const v = view({ ...raw("change-pause-card"), state: "done", outcome: "applied", approval: undefined,
      appLink: { place: "ads.meta", label: "Open in Meta Ads" },
      receipt: { sentence: "Paused.", tone: "ok", revertible: false } });
    const render = renderView(v, ctx(NEW));
    const state = engaged(v, NEW);
    const bar = hints(state, v).find((hint) => hint.key === "o")?.label;
    expect(bar).toBe("open in Meta Ads");
    expect(chipLabel(render.detail)).toBe(bar);
  });
});

// TJ-3 + W3-list-ready (plan owner's decision): the engagement gate stays, as
// in a normal coding harness an empty prompt never captures a letter. Before
// the view is engaged `o`, `w`, `m` and `c` are the first letter of a message;
// the resting bar says so honestly: `tab` with what it then unlocks, in place
// of `tab switch side`. (r4 view-01/08/10 and flow-pause-03 draw `o open` at
// rest; this deviation goes to the visual eval.)
describe("the resting bar names what tab unlocks (TJ-3)", () => {
  const tabChip = (state: ViewFocusState, v: AnswerViewV1) => hints(state, v).filter((hint) => hint.key === "tab");

  it("a finished turn with an openable view: one tab chip naming `o`, and the drawn bar says it", () => {
    const v = images();
    const state = focus(v, NEW);
    expect(state.engaged).toBe(false);
    expect(tabChip(state, v)).toEqual([{ key: "tab", label: "then o open in Library" }]);
    const bar = keyBarText(hints(state, v));
    expect(bar).toContain(" tab  then o open in Library");
    expect(bar).not.toContain("switch side");
  });

  it("`o` typed unengaged goes into the composer; after tab, `o` opens the place", () => {
    const v = images();
    const start = focus(v, NEW);
    const typed = press(start, v, "o");
    expect(typed.effect).toBeNull();
    expect(typed.focus).toBe("composer");
    const tabbed = press(start, v, "", { tab: true });
    expect(tabbed.engaged).toBe(true);
    expect(press(tabbed, v, "o").effect).toEqual({ type: "open", target: { place: "creative.library", params: { ids: "img_1,img_2,img_3" } } });
  });

  it("in composer focus (a letter typed, then cleared) the chip says the same", () => {
    const v = images();
    const composer = press(focus(v, NEW), v, "x");
    expect(composer.focus).toBe("composer");
    expect(hints(composer, v)).toEqual([{ key: "tab", label: "then o open in Library" }]);
  });

  it("priority o > w > m > c: a running job names `o` first, then `w` without an app place", () => {
    const v = job();
    expect(tabChip(focus(v, NEW), v)).toEqual([{ key: "tab", label: "then o open" }]);
    const { landsAt: _landsAt, ...bodyWithoutPlace } = raw("job-running").body as Record<string, unknown>;
    const noPlace = view({ ...raw("job-running"), body: bodyWithoutPlace });
    expect(tabChip(focus(noPlace, NEW), noPlace)).toEqual([{ key: "tab", label: "then w watch" }]);
  });

  it("once engaged the bar is the keys themselves and `tab switch side` again", () => {
    const v = images();
    expect(tabChip(engaged(v, NEW), v)).toEqual([{ key: "tab", label: "switch side" }]);
  });

  it("a view with nothing behind the gate keeps `tab switch side`", () => {
    for (const name of ["list-rows", "numbers-ads"]) {
      const v = view(raw(name));
      expect(tabChip(focus(v, OLD), v)).toEqual([{ key: "tab", label: "switch side" }]);
    }
    // Without app.open.v1 the images' place is not behind the gate: no `o` is named.
    const v = images();
    expect(hints(focus(v, OLD), v).map((hint) => hint.label).join(" ")).not.toContain("then o");
  });
});

// P33-N2: a Wave 2 desktop (views, but neither app.open.v1 nor confirm.stream.v1)
// gains `w watch` on a job: caps.watch is viewsCapable. Pinned on purpose; the
// PR body says so. It sends the job's own watch ask as a new turn; no `o`.
describe("`w` on a views-only (Wave 2) desktop", () => {
  it("the runner offers watch without open or a stream, and the job's `w` sends its ask", async () => {
    const status = {
      service: "infinite-desktop-cmdl", bootId: "boot-1", protocol: { min: 1, max: 1 },
      capabilities: ["status.v1", "turn.ndjson.v1", "confirm.v1"], ready: true, contextRevision: "rev-1",
      provider: { id: "codex", model: "model-x" }, workspace: { id: "ws-1", name: "Demo" }
    } as unknown as DesktopStatus;
    const client = {
      sessionCapable: true,
      viewsCapable: true,
      appOpenCapable: false,
      confirmStreamCapable: false,
      status: vi.fn(async () => status),
      turn: vi.fn(async () => ({ message: "ok", actionCalls: [] })),
      confirm: vi.fn(async () => ({ ok: true }))
    } as unknown as DesktopAppClient;
    const runner = createDesktopSessionTurnRunner({ resolveBridge: () => ({ descriptor: { bootId: "boot-1" }, client }) as never });
    await runner.turn("hello");
    const caps = runner.caps();
    expect(caps).toEqual({ open: false, watch: true, retry: false });
    expect(runner.streamCapable()).toBe(false);
    const v = job();
    const state = engaged(v, caps);
    expect(hints(state, v).map((hint) => `${hint.key} ${hint.label}`)).toEqual(["w watch", "tab switch side"]);
    expect(press(state, v, "w").effect).toEqual({ type: "ask", text: "how is the blog post going?" });
    expect(press(state, v, "o").effect).toBeNull();
    // At rest the chip names `w` (nothing to open on this desktop).
    expect(hints(focus(v, caps), v).filter((hint) => hint.key === "tab")).toEqual([{ key: "tab", label: "then w watch" }]);
  });
});
