import { describe, expect, it } from "vitest";
import type { AnswerViewV1 } from "@infinite-os/types";
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
