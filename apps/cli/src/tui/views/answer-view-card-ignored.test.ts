// Revision 6: `card` (the verdict-first card face) and its optional words on
// rows, cells, columns and bodies are new to the contract. The terminal does
// not draw the card face yet: a view that carries `card` renders byte-identical
// to the same view without it, at every width, and a view that also carries
// the rev 6 row, cell and column words decodes and renders without throwing.
// Synthetic views only.
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

const card = {
  head: { source: "Demo ads", logos: ["meta"], window: "Last 7 days", chip: { words: "Working", tone: "good" } },
  verdict: { words: "Ad A is carrying the campaign", tone: "good", ruleId: "demo_rule", why: "Most clicks for the spend" },
  figure: {
    value: { value: 12.34, delta: { value: 8, unit: "percent", anchorLabel: "the week before", tone: "good" } },
    unit: "money", currency: "USD", words: "spent"
  },
  proof: "rows",
  foot: "Synced 6 hours ago",
  actions: [
    { role: "primary", do: "next", label: "Show more", step: { label: "Show more", ask: "Show every ad" } },
    { role: "secondary", do: "copy", label: "Copy", text: "Ad A" }
  ]
} satisfies NonNullable<AnswerViewV1["card"]>;

const withCard = { ...base, card } satisfies AnswerViewV1;

// The rev 6 words beyond `card`: column polarity/definition/bar, cell delta and
// benchmark, row verdict/age/rank/quietLine/group/action, body rankBy/lanes.
const withRev6Words = {
  ...base,
  card,
  body: {
    ...base.body,
    columns: [
      { key: "spend", label: "Spend", unit: "money", factGroup: "delivery", polarity: "neutral", bar: true },
      { key: "clicks", label: "Clicks", unit: "count", factGroup: "delivery", polarity: "up_good", definition: "Link clicks" }
    ],
    rankBy: "clicks",
    lanes: [{ key: "meta", label: "Meta", logo: "meta" }],
    legs: {
      settled: {
        ...base.body.legs.settled,
        rows: [
          {
            id: "ad_a", label: "Ad A", rank: 1, rankChange: { dir: "up", by: 1 },
            age: { days: 9, since: "2026-01-06", tooYoung: false },
            verdict: { words: "Best", tone: "good", ruleId: "demo_best" },
            group: { count: 3, words: "3 ads" },
            action: { role: "secondary", do: "expand", label: "Open" },
            cells: {
              spend: { value: 12.34, benchmark: { value: 10, kind: "usual", label: "usual", basis: "last 30 days", tone: "flat" } },
              clicks: { value: 5, delta: { value: null, unit: "percent", anchorLabel: "last week", tone: "flat", reason: { code: "new", words: "New", show: "words" } } }
            }
          },
          {
            id: "ad_b", label: "Ad B", quietLine: { code: "paused", words: "Paused · last spent Jan 9" },
            verdict: { words: "Off", tone: "neutral", ruleId: "demo_off", mark: "off" },
            cells: { spend: { value: 0 }, clicks: { value: null, reason: { code: "off", words: "off", show: "hide" } } }
          }
        ]
      }
    }
  }
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

const modes = [{ color: false }, { color: true }, { color: false, scrollback: true }, { color: false, explainOpen: true }];

describe("the terminal falls back cleanly on a rev 6 card", () => {
  for (const width of [60, 100, 140]) {
    for (const mode of modes) {
      it(`renders byte-identical with and without card at ${width} columns (${JSON.stringify(mode)})`, () => {
        const without = renderView(decoded(base), ctx(width, mode));
        const withIt = renderView(decoded(withCard), ctx(width, mode));
        expect(JSON.stringify(withIt)).toBe(JSON.stringify(without));
        const text = [without.head, without.source ?? "", ...without.detail, ...without.footnotes].map(stripAnsi).join("\n");
        expect(text).toContain("Ad A");
      });
      it(`renders a view with every rev 6 word without throwing at ${width} columns (${JSON.stringify(mode)})`, () => {
        const out = renderView(decoded(withRev6Words), ctx(width, mode));
        const text = [out.head, out.source ?? "", ...out.detail, ...out.footnotes].map(stripAnsi).join("\n");
        expect(text).toContain("Ad A");
      });
    }
  }
  it("the decoded view still holds the card (the terminal does not rewrite what the host sent)", () => {
    expect(decoded(withCard).card).toEqual(card);
  });
});
