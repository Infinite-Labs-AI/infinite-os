// T12 (P3.3): `o` opens the place a view names in the app, through the
// desktop's /v1/open (app.open.v1), and `w` watches a job. Both come from
// negotiation: on an old desktop `o` is absent from the bar and types.
// `o` never opens a browser and never reads `appLink.url` (the bridge strips
// it): a link's `place` (and its string `params`) is the whole request.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Key } from "ink";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { KeyContext } from "../keys/keymap.js";
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
