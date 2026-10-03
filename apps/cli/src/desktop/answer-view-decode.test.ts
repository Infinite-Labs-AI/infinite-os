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
    const target = targetOf(changeView({ path: ["Example campaign", "Broad · US · 25-54"], creativeRef: { archiveAssetId: "asset_0a1b-2c" } }));
    expect(target.path).toEqual(["Example campaign", "Broad · US · 25-54"]);
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
