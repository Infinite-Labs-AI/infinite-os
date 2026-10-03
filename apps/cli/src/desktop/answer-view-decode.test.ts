import { describe, expect, it } from "vitest";
import { ANSWER_VIEW_LIMITS, type AnswerViewV1 } from "@infinite-os/types";
import { decodeAnswerView, decodeToolViewFrame } from "./answer-view-decode.js";

// Synthetic fixture written from the contract (open-core: no real data).
function quietView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: "quiet",
    tool: "list_sources",
    title: "Sources",
    state: "ready",
    asOf: null,
    scope: { workspaceName: "Example Co", crossWorkspace: false },
    caveats: [],
    body: { stepLine: "Read 3 sources" },
    ...overrides
  };
}

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool.view",
    stage: "tool",
    message: "Sources",
    viewId: "view-1",
    name: "list_sources",
    view: quietView(),
    ...overrides
  };
}

describe("decodeAnswerView", () => {
  it("decodes a valid view", () => {
    const view = quietView();
    const decoded: AnswerViewV1 | null = decodeAnswerView(view);
    expect(decoded).toEqual(view);
    expect(decoded?.kind).toBe("quiet");
  });

  it("decodes an unknown kind to null", () => {
    expect(decodeAnswerView(quietView({ kind: "carousel" }))).toBeNull();
  });

  it.each([
    ["a newer contract version", { v: 2 }],
    ["an unknown state", { state: "exploded" }],
    ["an array kind", { kind: ["change"] }],
    ["an array state", { state: ["done"] }],
    ["an object state that stringifies to a known state", { state: { toString: (): string => "done" } }],
    ["a missing title", { title: undefined }],
    ["a non-string tool", { tool: 7 }],
    ["a missing body", { body: undefined }],
    ["an array body", { body: [] }],
    ["a missing scope", { scope: undefined }],
    ["non-array caveats", { caveats: "none" }]
  ])("decodes %s to null", (_label, overrides) => {
    expect(decodeAnswerView(quietView(overrides))).toBeNull();
  });

  it.each([null, undefined, "view", 1, [quietView()]])(
    "decodes a non-object (%j) to null",
    (value) => {
      expect(decodeAnswerView(value)).toBeNull();
    }
  );
});

describe("decodeToolViewFrame", () => {
  it("decodes a valid tool.view frame", () => {
    expect(decodeToolViewFrame(frame())).toEqual({
      type: "tool.view",
      stage: "tool",
      message: "Sources",
      viewId: "view-1",
      name: "list_sources",
      view: quietView()
    });
  });

  it("falls back to the view title when the frame has no message", () => {
    expect(decodeToolViewFrame(frame({ message: undefined }))?.message).toBe("Sources");
  });

  it("decodes a frame whose view has an unknown kind to null", () => {
    expect(decodeToolViewFrame(frame({ view: quietView({ kind: "carousel" }) }))).toBeNull();
  });

  it.each([
    ["another frame type", { type: "tool.complete" }],
    ["a missing viewId", { viewId: undefined }],
    ["a non-string name", { name: 3 }],
    ["a missing view", { view: undefined }]
  ])("decodes %s to null", (_label, overrides) => {
    expect(decodeToolViewFrame(frame(overrides))).toBeNull();
  });

  it("decodes a non-object to null", () => {
    expect(decodeToolViewFrame(null)).toBeNull();
    expect(decodeToolViewFrame("tool.view")).toBeNull();
  });
});

// Contract revision 3: a change target may carry its picture by archive
// reference (never a URL; the terminal ignores it) and its parents, outermost
// first. The decoder keeps both bounded and drops anything malformed, so a
// renderer only ever sees a clean `string[]` and a `{ archiveAssetId }`.
describe("decodeAnswerView: change target picture and path (revision 3)", () => {
  function changeView(target: Record<string, unknown>): Record<string, unknown> {
    return {
      v: 1,
      kind: "change",
      tool: "propose_pause_entity",
      title: "Pause Example ad",
      state: "no_change",
      asOf: null,
      scope: { workspaceName: "Example Co", crossWorkspace: false },
      caveats: [],
      body: {
        target: { kind: "ad", id: "ad_1", label: "Example ad", ...target },
        rows: [{ label: "status", before: "on", after: "PAUSED" }],
        warnings: []
      }
    };
  }
  const targetOf = (value: unknown): Record<string, unknown> =>
    ((decodeAnswerView(value)?.body as { target: Record<string, unknown> }).target);

  it("keeps a well-formed path and picture reference", () => {
    const target = targetOf(changeView({ path: ["Example campaign", "Sample ad set"], creativeRef: { archiveAssetId: "asset_0a1b-2c" } }));
    expect(target.path).toEqual(["Example campaign", "Sample ad set"]);
    expect(target.creativeRef).toEqual({ archiveAssetId: "asset_0a1b-2c" });
  });

  it("decodes a revision 2 change view (no picture, no path) unchanged", () => {
    const view = changeView({});
    expect(decodeAnswerView(view)).toEqual(view);
    expect("path" in targetOf(view)).toBe(false);
    expect("creativeRef" in targetOf(view)).toBe(false);
  });

  it("never mutates what it was given", () => {
    const view = changeView({ path: ["  Example campaign  "], creativeRef: { archiveAssetId: "a1", url: "https://example.test/a.png" } });
    const before = JSON.stringify(view);
    decodeAnswerView(view);
    expect(JSON.stringify(view)).toBe(before);
  });

  it("scrubs each part: escapes, controls and bidi go, whitespace collapses, ends are trimmed", () => {
    const target = targetOf(changeView({ path: ["  Example\u001b[31m campaign\u0007 ", "Ad‮ set\n\tone"] }));
    expect(target.path).toEqual(["Example campaign", "Ad set one"]);
  });

  it("caps a long part at the contract's length with an ellipsis", () => {
    const max = ANSWER_VIEW_LIMITS.maxTargetPathPartChars;
    const target = targetOf(changeView({ path: ["x".repeat(max + 40), "Ad set"] }));
    const [first] = target.path as string[];
    expect(Array.from(first!)).toHaveLength(max);
    expect(first!.endsWith("…")).toBe(true);
  });

  it("keeps a path of exactly the contract's most parts", () => {
    const parts = ["One", "Two", "Three", "Four"].slice(0, ANSWER_VIEW_LIMITS.maxTargetPathParts);
    expect(targetOf(changeView({ path: parts })).path).toEqual(parts);
  });

  it.each([
    ["more parts than the contract allows", ["One", "Two", "Three", "Four", "Five"]],
    ["a non-array path", "Example campaign › Ad set"],
    ["a non-string part", ["Example campaign", 7]],
    ["a part that scrubs to nothing", ["Example campaign", " \u001b[0m‏ "]],
    ["an empty path", []],
    ["an object path", { 0: "Example campaign", length: 1 }]
  ])("drops the path for %s, keeping the rest of the target", (_label, path) => {
    const target = targetOf(changeView({ path }));
    expect("path" in target).toBe(false);
    expect(target).toMatchObject({ kind: "ad", id: "ad_1", label: "Example ad" });
  });

  it("rebuilds the picture reference from its one key: nothing else rides along", () => {
    const target = targetOf(changeView({ creativeRef: { archiveAssetId: "asset_1", url: "https://example.test/a.png", thumb: "data:image/png;base64,AA" } }));
    expect(target.creativeRef).toEqual({ archiveAssetId: "asset_1" });
  });

  it.each([
    ["a URL as the id", { archiveAssetId: "https://example.test/a.png" }],
    ["a data URI as the id", { archiveAssetId: "data:image/png;base64,AAAA" }],
    ["a path as the id", { archiveAssetId: "/Users/example/a.png" }],
    ["an empty id", { archiveAssetId: "" }],
    ["a non-string id", { archiveAssetId: 42 }],
    ["an over-long id", { archiveAssetId: "a".repeat(200) }],
    ["an id with controls", { archiveAssetId: "asset\u001b[31m1" }],
    ["a string reference", "asset_1"],
    ["an array reference", [{ archiveAssetId: "asset_1" }]]
  ])("drops a malformed picture reference (%s), keeping the rest of the target", (_label, creativeRef) => {
    const target = targetOf(changeView({ creativeRef, path: ["Example campaign"] }));
    expect("creativeRef" in target).toBe(false);
    expect(target.path).toEqual(["Example campaign"]);
  });

  it("only a change target is cleaned: another kind's body is left as it came", () => {
    const view = quietView({ body: { stepLine: "Read 3 sources", path: 7 } });
    expect(decodeAnswerView(view)).toEqual(view);
  });
});

// Contract revision 3, scheme ids: a picture reference whose id starts with a
// URL scheme is withheld like any other non-archive id.
describe("decodeAnswerView: archive ids never start with a URL scheme (revision 3)", () => {
  function changeWith(creativeRef: unknown): Record<string, unknown> {
    return {
      v: 1, kind: "change", tool: "propose_pause_entity", title: "Pause Example ad", state: "needs_yes", asOf: null,
      scope: { workspaceName: "Example Co", crossWorkspace: false }, caveats: [],
      body: { target: { kind: "ad", label: "Example ad", creativeRef }, rows: [], warnings: [] }
    };
  }
  it.each(["https:example.test", "javascript:void", "mailto:a", "JavaScript:void", "HTTP:a"])("withholds %s", (archiveAssetId) => {
    const target = (decodeAnswerView(changeWith({ archiveAssetId }))?.body as { target: Record<string, unknown> }).target;
    expect("creativeRef" in target).toBe(false);
    expect(target.label).toBe("Example ad");
  });
  it.each(["asset_1", "meta:1202:thumb.v2", "https_asset"])("keeps a real-shaped id %s", (archiveAssetId) => {
    const target = (decodeAnswerView(changeWith({ archiveAssetId }))?.body as { target: Record<string, unknown> }).target;
    expect(target.creativeRef).toEqual({ archiveAssetId });
  });
});

// Contract revision 3, short host words: a list's row-name header, a record's
// own status and a leader's context line. Each is scrubbed for the TTY, cut to
// ANSWER_VIEW_LIMITS.maxShortTextChars ending in "…", and withheld (the field
// dropped) when it is not a string, scrubs to nothing, or (status) has a tone
// the contract does not name. A view without them decodes exactly as before.
describe("decodeAnswerView: nameLabel, record status and leader detail (revision 3)", () => {
  const MAX = ANSWER_VIEW_LIMITS.maxShortTextChars;
  function view(kind: string, body: Record<string, unknown>): Record<string, unknown> {
    return {
      v: 1, kind, tool: "example_read", title: "Example", state: "ready", asOf: null,
      scope: { workspaceName: "Example Co", crossWorkspace: false }, caveats: [], body
    };
  }
  const listBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    layout: "rows", columns: [{ key: "spend", label: "Spend", unit: "money" }],
    rows: [{ id: "r1", title: "Example ad", cells: { spend: { value: 12.5 } } }], total: 1, shown: 1, ...extra
  });
  const recordBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: "Example ad", fields: [{ label: "Spend", value: { value: 12.5 }, unit: "money" }], ...extra
  });
  const leader = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    measure: { key: "ctr", label: "CTR" }, rowId: "r1", rowLabel: "Example ad", value: { value: 2.1 }, ...extra
  });
  const numbersBody = (leaders: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    layout: "table", currency: "USD", columns: [{ key: "ctr", label: "CTR", unit: "percent", factGroup: "ads" }],
    legs: { settled: { window: { from: "2026-09-24", to: "2026-09-30", tz: "UTC", label: "Sep 24–30" }, final: true, asOf: null, rows: [] } },
    leaders, ...extra
  });
  const bodyOf = (value: Record<string, unknown>): Record<string, unknown> =>
    decodeAnswerView(value)?.body as unknown as Record<string, unknown>;

  it("keeps well-formed short words as they came", () => {
    expect(bodyOf(view("list", listBody({ nameLabel: "Ad" }))).nameLabel).toBe("Ad");
    expect(bodyOf(view("record", recordBody({ status: { word: "Paused", tone: "muted" } }))).status).toEqual({ word: "Paused", tone: "muted" });
    const leaders = bodyOf(view("numbers", numbersBody([leader({ detail: "5 of 40 impressions" })]))).leaders as Record<string, unknown>[];
    expect(leaders[0]!.detail).toBe("5 of 40 impressions");
  });

  it.each([
    ["list", listBody()],
    ["record", recordBody()],
    ["numbers", numbersBody([leader()])],
    ["numbers", numbersBody([leader()], { layout: "composite", sections: [{ title: "Ads", kind: "list", body: listBody() }] })]
  ])("decodes a %s view without the fields exactly as before (same object)", (kind, body) => {
    const value = view(kind, body);
    const snapshot = JSON.stringify(value);
    expect(decodeAnswerView(value)).toBe(value);
    expect(JSON.stringify(value)).toBe(snapshot);
  });

  it("cuts each at the contract's length, ending in …", () => {
    const long = "word ".repeat(40);
    const label = bodyOf(view("list", listBody({ nameLabel: long }))).nameLabel as string;
    const status = bodyOf(view("record", recordBody({ status: { word: long, tone: "ok" } }))).status as { word: string };
    const detail = (bodyOf(view("numbers", numbersBody([leader({ detail: long })]))).leaders as { detail: string }[])[0]!.detail;
    for (const words of [label, status.word, detail]) {
      expect(Array.from(words)).toHaveLength(MAX);
      expect(words.endsWith("…")).toBe(true);
    }
    // Exactly the limit is kept whole.
    expect(bodyOf(view("list", listBody({ nameLabel: "x".repeat(MAX) }))).nameLabel).toBe("x".repeat(MAX));
  });

  it("scrubs controls and bidi characters and collapses whitespace", () => {
    expect(bodyOf(view("list", listBody({ nameLabel: " Ad\u001b[31m set‮ \n" }))).nameLabel).toBe("Ad set");
    expect((bodyOf(view("record", recordBody({ status: { word: "\u0007Active⁦", tone: "ok" } }))).status as { word: string }).word).toBe("Active");
    expect((bodyOf(view("numbers", numbersBody([leader({ detail: "$12.34\tspent‏" })]))).leaders as { detail: string }[])[0]!.detail).toBe("$12.34 spent");
  });

  it.each([
    ["a number", 7], ["null", null], ["an object", { text: "Ad" }], ["an empty string", ""], ["a string that scrubs to nothing", " \u001b[0m‏ "]
  ])("withholds a nameLabel or leader detail that is %s, keeping the rest", (_label, bad) => {
    const list = bodyOf(view("list", listBody({ nameLabel: bad })));
    expect("nameLabel" in list).toBe(false);
    expect(list.rows).toEqual(listBody().rows);
    const leaders = bodyOf(view("numbers", numbersBody([leader({ detail: bad }), leader({ rowId: "r2", detail: "ok words" })]))).leaders as Record<string, unknown>[];
    expect("detail" in leaders[0]!).toBe(false);
    expect(leaders[0]).toMatchObject({ rowId: "r1", rowLabel: "Example ad" });
    expect(leaders[1]!.detail).toBe("ok words");
  });

  it.each([
    ["a bad tone", { word: "Active", tone: "green" }],
    ["a missing tone", { word: "Active" }],
    ["a non-string word", { word: 1, tone: "ok" }],
    ["an empty word", { word: "  ", tone: "ok" }],
    ["a string status", "Active"],
    ["an array status", [{ word: "Active", tone: "ok" }]]
  ])("withholds a record status with %s, keeping the rest", (_label, status) => {
    const record = bodyOf(view("record", recordBody({ status })));
    expect("status" in record).toBe(false);
    expect(record.title).toBe("Example ad");
  });

  it("rebuilds a status from its two keys: nothing else rides along", () => {
    expect(bodyOf(view("record", recordBody({ status: { word: "Active", tone: "ok", url: "https://example.test" } }))).status)
      .toEqual({ word: "Active", tone: "ok" });
  });

  it("cleans the fields in a composite's sections, one level deep", () => {
    const body = numbersBody([], {
      layout: "composite",
      sections: [
        { title: "Ads", kind: "list", body: listBody({ nameLabel: "x".repeat(MAX + 5) }) },
        { title: "Ad", kind: "record", body: recordBody({ status: { word: "Active", tone: "loud" } }) },
        { title: "Leaders", kind: "numbers", body: numbersBody([leader({ detail: 3 })]) }
      ]
    });
    const sections = bodyOf(view("numbers", body)).sections as { body: Record<string, unknown> }[];
    expect(Array.from(sections[0]!.body.nameLabel as string)).toHaveLength(MAX);
    expect("status" in sections[1]!.body).toBe(false);
    expect("detail" in (sections[2]!.body.leaders as Record<string, unknown>[])[0]!).toBe(false);
  });

  it("never mutates what it was given", () => {
    const value = view("numbers", numbersBody([leader({ detail: "x".repeat(MAX + 9) })], {
      sections: [{ title: "Ads", kind: "list", body: listBody({ nameLabel: 7 }) }]
    }));
    const snapshot = JSON.stringify(value);
    decodeAnswerView(value);
    expect(JSON.stringify(value)).toBe(snapshot);
  });

  it("leaves a field of the same name on another kind alone", () => {
    const value = view("document", { meta: [], sections: [], nameLabel: 7, status: "x" });
    expect(decodeAnswerView(value)).toBe(value);
  });
});
