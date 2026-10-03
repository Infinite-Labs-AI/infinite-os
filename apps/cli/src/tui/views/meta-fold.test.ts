// Wave 3 r1 (N27, terminal half; N26): two level reads of one ad account in one
// turn fold what the later one repeats into ONE dim line, worded exactly as
// the app words it (1bu-1 shared/meta-chat-view-shapes.ts metaRepeatLine);
// and our sign-ups' today leg draws as its own not-final block, never summed.
// Synthetic views only (`__fixtures__/meta-level-campaigns.json`, `meta-level-ads.json`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { renderCommittedTurn, renderLiveTurn } from "./layout.js";
import { metaRepeatLine, metaViewRepeats } from "./meta-fold.js";
import { renderView } from "./registry.js";
import type { ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), "utf8")) as Record<string, unknown>;
const RAW = { campaigns: read("meta-level-campaigns"), ads: read("meta-level-ads") };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function decode(raw: unknown): AnswerViewV1 {
  const view = decodeAnswerView(raw);
  if (!view) throw new Error("fixture does not decode");
  return view;
}
const campaigns = () => decode(clone(RAW.campaigns));
const ads = () => decode(clone(RAW.ads));
const edited = (edit: (raw: Record<string, any>) => void): AnswerViewV1 => {
  const raw = clone(RAW.ads) as Record<string, any>;
  edit(raw);
  return decode(raw);
};

const LINE = "Same as above: 6 of 6 days in · Oct 1 so far · By day · Prior 6 days · notes";

describe("what a later read repeats (N27, the app's rule)", () => {
  it("the account's parts repeat; the rows and our sign-ups are the level's own", () => {
    const repeats = metaViewRepeats(campaigns(), ads())!;
    expect(repeats).toEqual({
      settledSummary: true,
      today: true,
      sections: [0, 1],
      caveats: campaigns().caveats
    });
    expect(metaRepeatLine(ads(), repeats)).toBe(LINE);
  });

  it("only the same read folds: another window, workspace or tool never does", () => {
    expect(metaViewRepeats(campaigns(), edited((raw) => { raw.body.legs.settled.window.to = "2026-09-29"; }))).toBeNull();
    expect(metaViewRepeats(campaigns(), edited((raw) => { raw.body.legs.settled.final = false; }))).toBeNull();
    expect(metaViewRepeats(campaigns(), edited((raw) => { raw.scope = { workspaceName: "Other", crossWorkspace: true }; }))).toBeNull();
    expect(metaViewRepeats(campaigns(), edited((raw) => { raw.tool = "get_other_performance"; }))).toBeNull();
  });

  it("the host's account handles (rev 3 scope.account) take part in the same-read check: never drawn, but two accounts never fold", () => {
    const withAccount = (base: Record<string, unknown>, project: string, source: string): AnswerViewV1 => {
      const raw = clone(base) as Record<string, any>;
      raw.scope = { ...raw.scope, account: { project, source } };
      return decode(raw);
    };
    const same = metaViewRepeats(withAccount(RAW.campaigns, "proj_demo", "src_demo"), withAccount(RAW.ads, "proj_demo", "src_demo"));
    expect(same).toEqual(metaViewRepeats(campaigns(), ads()));
    expect(metaViewRepeats(withAccount(RAW.campaigns, "proj_demo", "src_demo"), withAccount(RAW.ads, "proj_demo", "src_other"))).toBeNull();
    expect(metaViewRepeats(withAccount(RAW.campaigns, "proj_demo", "src_demo"), withAccount(RAW.ads, "proj_other", "src_demo"))).toBeNull();
    expect(metaViewRepeats(withAccount(RAW.campaigns, "proj_demo", "src_demo"), ads())).toBeNull();
    expect(metaViewRepeats(campaigns(), withAccount(RAW.ads, "proj_demo", "src_demo"))).toBeNull();
  });

  it("a part read at another instant draws again: a refreshed today is not folded", () => {
    const refreshed = edited((raw) => { raw.body.legs.today.asOf = "2026-10-01T18:45:00Z"; });
    const repeats = metaViewRepeats(campaigns(), refreshed)!;
    expect(repeats.today).toBe(false);
    expect(metaRepeatLine(refreshed, repeats)).toBe("Same as above: 6 of 6 days in · By day · Prior 6 days · notes");
  });

  it("a section whose numbers differ draws again; nothing folded is no line", () => {
    const changed = edited((raw) => { raw.body.sections[0].body.currency = "EUR"; });
    expect(metaViewRepeats(campaigns(), changed)!.sections).toEqual([1]);
    expect(metaRepeatLine(ads(), { settledSummary: false, today: false, sections: [], caveats: [] })).toBeNull();
    expect(metaRepeatLine(ads(), { settledSummary: false, today: false, sections: [], caveats: ["x"] })).toBe("Same as above: notes");
  });

  it("a leg with no coverage folds as `totals`", () => {
    const strip = (raw: Record<string, any>) => { delete raw.body.legs.settled.coverage; };
    const earlier = decode((() => { const raw = clone(RAW.campaigns) as Record<string, any>; strip(raw); return raw; })());
    const later = edited(strip);
    expect(metaRepeatLine(later, metaViewRepeats(earlier, later)!)).toMatch(/^Same as above: totals · /u);
  });
});

const messages: Msg[] = [
  { role: "user", text: "how are my campaigns and ads doing?" },
  { role: "assistant", text: "Here are both levels." }
];
const text = (lines: readonly string[]) => lines.map(stripAnsi).join("\n");

describe("the terminal draws the fold (N27)", () => {
  for (const width of [48, 60, 80, 100, 140]) {
    it(`the later view keeps its rows and our sign-ups, drops the repeats, and says so once (${width} columns)`, () => {
      for (const lines of [
        renderLiveTurn({ messages, views: [campaigns(), ads()], focus: null, width, color: false, theme, timeZone: "UTC" }).lines,
        renderCommittedTurn({ messages, views: [campaigns(), ads()], focus: null, width, color: false, theme, timeZone: "UTC" })
      ]) {
        const out = text(lines);
        // The line may wrap at a narrow width: it is still ONE line of words, said once.
        expect(out.replace(/\n(?=\S)/gu, " ").split(LINE).length - 1, out).toBe(1);
        const later = out.slice(out.indexOf("Ads by ad"));
        // Its own rows and our sign-ups stay.
        expect(later).toContain("Demo A");
        expect(later).toContain("Our sign-ups");
        // The repeats are gone from it: the day strip, the funnel, today's block, By day, Prior, the caveats.
        expect(later).not.toMatch(/Days Sep 25|\nBy day\n|\nPrior 6 days\n|Spend +\$12\.50|Trials come from|of 120/u);
        // The earlier view is whole.
        const earlier = out.slice(0, out.indexOf("Ads by ad"));
        expect(earlier).toMatch(/Days Sep 25/u);
        expect(earlier).toContain("Trials come from the payments sync.");
        for (const line of lines) expect(stripAnsi(line).length, line).toBeLessThanOrEqual(width);
      }
    });
  }

  it("a lone view never folds", () => {
    const out = text(renderLiveTurn({ messages, views: [ads()], focus: null, width: 100, color: false, theme, timeZone: "UTC" }).lines);
    expect(out).not.toContain("Same as above");
    expect(out).toMatch(/Days Sep 25/u);
  });

  it("the latest earlier view of the same tool is the one compared", () => {
    const refreshed = edited((raw) => { raw.body.legs.today.asOf = "2026-10-01T18:45:00Z"; });
    const out = text(renderLiveTurn({ messages, views: [campaigns(), refreshed, ads()], focus: null, width: 100, color: false, theme, timeZone: "UTC" }).lines);
    // The third view is compared with the refreshed second: its today differs, so today is not folded.
    expect(out).toContain("Same as above: 6 of 6 days in · By day · Prior 6 days · notes");
  });
});

describe("our sign-ups' today leg is its own block, never summed (N26)", () => {
  const ctx = (width: number): ViewRenderCtx => ({
    width, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false,
    caps: { open: false, watch: false, retry: false }, timeZone: "UTC"
  });
  for (const width of [60, 100, 140]) {
    it(`settled rows, then today's rows under a not-final title (${width} columns)`, () => {
      const render = renderView(ads(), ctx(width));
      const out = [...render.detail].map(stripAnsi);
      const head = out.findIndex((line) => line.startsWith("Our sign-ups"));
      expect(head).toBeGreaterThan(0);
      const after = out.slice(head);
      const today = after.findIndex((line) => /Oct 1 so far · not final · as of 18:30/u.test(line));
      expect(today).toBeGreaterThan(0);
      // Settled Demo B has 4 registrations, today 0: never a summed 4 + 0 shown as today's, never 3 + 2 = 5 for Demo A.
      const settledBlock = after.slice(0, today).join("\n");
      const todayBlock = after.slice(today).join("\n");
      expect(settledBlock).toMatch(/Demo A[^\n]*3[^\n]*2/u);
      expect(todayBlock).toMatch(/Demo A[^\n]*2[^\n]*0/u);
      expect(out.join("\n")).not.toMatch(/Demo A[^\n]*\b5\b/u);
      expect(todayBlock).not.toContain("Total");
    });
  }
});
