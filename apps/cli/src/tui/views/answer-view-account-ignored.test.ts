// Revision 3: `scope.account` holds the host's own opaque handles for the
// account an answer's numbers came from. It is host-only: the terminal never
// draws or reads it, so a view with it renders byte-identical to the same view
// without it, at every width. Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});

const base = {
  v: 1, kind: "numbers", tool: "read_ads", title: "Sample campaign", state: "ready", asOf: "2026-01-15T18:30:00Z",
  provenance: { source: "Demo ads", via: "our_db" },
  scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
  body: {
    layout: "table", currency: "USD", rowLabel: "Ad",
    columns: [
      { key: "spend", label: "Spend", unit: "money", factGroup: "delivery" },
      { key: "clicks", label: "Clicks", unit: "count", factGroup: "delivery" }
    ],
    legs: {
      settled: {
        window: { from: "2026-01-08", to: "2026-01-14", tz: "UTC", label: "Last 7 days" }, final: true, asOf: "2026-01-15T06:00:00Z",
        rows: [
          { id: "ad_a", label: "Ad A", cells: { spend: { value: 12.34 }, clicks: { value: 5 } } },
          { id: "ad_b", label: "Ad B", cells: { spend: { value: 0 }, clicks: { value: null, reason: { code: "not_synced", words: "not synced yet", show: "dash" } } } }
        ]
      }
    }
  }
} satisfies AnswerViewV1;
const withAccount = {
  ...base, scope: { ...base.scope, account: { project: "proj_demo", source: "src_demo" } }
} satisfies AnswerViewV1;

function decoded(view: AnswerViewV1): AnswerViewV1 {
  const out = decodeAnswerView(JSON.parse(JSON.stringify(view)));
  if (!out) throw new Error("test view does not decode");
  return out;
}

const ctx = (width: number, overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});

describe("the terminal ignores scope.account (rev 3, host-only)", () => {
  for (const width of [60, 100, 140]) {
    for (const mode of [{ color: false }, { color: true }, { color: false, scrollback: true }, { color: false, explainOpen: true }]) {
      it(`renders byte-identical with and without it at ${width} columns (${JSON.stringify(mode)})`, () => {
        const without = renderView(decoded(base), ctx(width, mode));
        const withIt = renderView(decoded(withAccount), ctx(width, mode));
        expect(JSON.stringify(withIt)).toBe(JSON.stringify(without));
        // Not vacuous: the render draws the rows, and never the handles.
        const text = [without.head, without.source ?? "", ...without.detail, ...without.footnotes].map(stripAnsi).join("\n");
        expect(text).toContain("Ad A");
        expect(JSON.stringify(withIt)).not.toMatch(/proj_demo|src_demo/);
      });
    }
  }
  it("the decoded view still holds the slot (the terminal does not rewrite what the host sent)", () => {
    expect(decoded(withAccount).scope).toEqual({ workspaceName: "Demo", crossWorkspace: false,
      account: { project: "proj_demo", source: "src_demo" } });
  });
});
