// Revision 7: CreativeRefV1.reader may name more picture stores (CREATIVE_REF_READERS). The terminal never draws a
// picture, so a view whose rows, record or change target name any reader, a rev 7 one or one it has never heard of,
// renders byte-identical to the same view with no picture at all, at every width. Synthetic views only.
import { CREATIVE_REF_READERS, type AnswerViewV1, type CreativeRefV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const scope = { workspaceName: "Demo", crossWorkspace: false };

const list = {
  v: 1, kind: "list", tool: "list_creatives", title: "3 saved creatives", state: "ready", asOf: "2026-01-15T18:30:00Z",
  scope, caveats: [],
  body: {
    layout: "rows", nameLabel: "Creative",
    columns: [{ key: "made", label: "Made", unit: "text" }],
    rows: [
      { id: "c1", title: "Sample creative one", cells: { made: { text: "Jan 14" } } },
      { id: "c2", title: "Sample creative two", cells: { made: { text: "Jan 13" } } },
      { id: "c3", title: "Sample creative three", cells: { made: { text: "Jan 12" } } }
    ],
    total: 3, shown: 3
  }
} satisfies AnswerViewV1;

const record = {
  v: 1, kind: "record", tool: "read_brand_photo", title: "Sample photo", state: "ready", asOf: null,
  scope, caveats: [],
  body: { title: "Sample photo", fields: [{ label: "Added", value: { text: "Jan 12" } }] }
} satisfies AnswerViewV1;

const change = {
  v: 1, kind: "change", tool: "delete_sample", title: "Delete this photo?", state: "needs_yes", asOf: null,
  scope, caveats: [],
  body: { target: { kind: "brand_photo", label: "Sample photo" }, rows: [{ label: "Photo", before: "kept", after: "deleted" }], warnings: [] }
} satisfies AnswerViewV1;

const ref = (reader: string, id: string): CreativeRefV1 => ({ archiveAssetId: id, reader: reader as CreativeRefV1["reader"], ratio: "4:5" });

/** The same views with a picture on every row, the record and the change target (and its group). */
function withPictures(reader: string): AnswerViewV1[] {
  return [
    { ...list, body: { ...list.body, rows: list.body.rows.map((row, i) => ({ ...row, creativeRef: ref(reader, `asset_${i + 1}`),
      group: { count: 2, words: "2 sizes", pictures: [ref(reader, `asset_${i + 1}a`), ref(reader, `asset_${i + 1}b`)] } })) } },
    { ...record, body: { ...record.body, creativeRef: ref(reader, "asset_r") } },
    { ...change, body: { ...change.body, target: { ...change.body.target, creativeRef: ref(reader, "asset_t"),
      group: { count: 3, words: "3 photos", pictures: [ref(reader, "asset_g1"), ref(reader, "asset_g2")] } } } }
  ] as AnswerViewV1[];
}

function decoded(view: AnswerViewV1): AnswerViewV1 {
  const out = decodeAnswerView(JSON.parse(JSON.stringify(view)));
  if (!out) throw new Error("test view does not decode");
  return out;
}

const ctx = (width: number): ViewRenderCtx => ({
  width, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC"
});

describe("the terminal ignores every picture reader (rev 7)", () => {
  it("rev 7 names fifteen readers, the rev 6 four first", () => {
    expect(CREATIVE_REF_READERS.slice(0, 4)).toEqual(["meta_archive", "reddit_ads", "youtube", "competitor"]);
    expect(CREATIVE_REF_READERS).toHaveLength(15);
  });
  const plain = [list, record, change] as AnswerViewV1[];
  for (const reader of [...CREATIVE_REF_READERS, "a_reader_from_a_later_revision"]) {
    for (const width of [60, 100, 140]) {
      it(`renders byte-identical with ${reader} pictures at ${width} columns`, () => {
        withPictures(reader).forEach((view, i) => {
          const out = renderView(decoded(view), ctx(width));
          expect(JSON.stringify(out)).toBe(JSON.stringify(renderView(decoded(plain[i]!), ctx(width))));
          expect([out.head, ...out.detail].map(stripAnsi).join("\n")).not.toContain("asset_");
        });
      });
    }
  }
});
