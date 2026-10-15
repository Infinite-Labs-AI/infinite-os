import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANSWER_VIEW_CONTRACT_REVISION, ANSWER_VIEW_KINDS, ANSWER_VIEW_LIMITS, ANSWER_VIEW_STATES, ARCHIVE_ASSET_ID_PATTERN,
  CHANNEL_LOGOS, CREATIVE_REF_READERS, VERDICT_TONES,
  type AgeV1, type AnswerViewEnvelopeV1, type AnswerViewV1, type BenchmarkV1, type CardActionV1, type CardFaceV1, type ChangeBodyV1,
  type ChannelLogoV1, type ColumnV1, type CreativeRefReaderV1, type CreativeRefV1, type DeltaV1, type DocumentBodyV1, type ImagesBodyV1, type LaneV1, type LeaderV1, type ListBodyV1,
  type ListRowV1, type NumbersBodyV1, type NumbersRowV1, type PostV1, type QuietLineV1, type RankChangeV1, type RecordBodyV1,
  type RowCardExtrasV1, type SectionHeadV1, type SectionV1, type StateReasonV1, type StepV1, type TodayLegV1, type VerdictToneV1,
  type VerdictV1
} from "./answer-view.js";
const stripped = (k: string) => { const n = k.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.endsWith("token") || n.includes("credential") || n === "confirmationid"; };
describe("answer view contract v1", () => {
  it("revision 7: the rev line names the readers and keeps every earlier revision", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 7 as const;\s+\/\/ rev 7: .*; rev 6: the verdict-first card \(AnswerViewEnvelopeV1\.card\); VerdictV1, AgeV1, DeltaV1, BenchmarkV1, QuietLineV1, LaneV1, RankChangeV1, PostV1, CardActionV1; .*ChangeBodyV1\.target extras \(incl\. group\)\/\.context; rev 5: NumbersRowV1\.creativeRef; NumbersBodyV1\.face; rev 4: ImagesBodyV1\.drawRunIds; rev 3: /);
    expect(src).toMatch(/card\?: CardFaceV1;\s+\/\/ rev 6: present = drawn as a verdict-first card; absent = drawn as before$/m);
  });
  it("revision 7: the rev line opens with the readers", () => {
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 7 as const;\s+\/\/ rev 7: CREATIVE_REF_READERS, CreativeRefReaderV1 \(CreativeRefV1\.reader names the host's own picture stores too\); rev 6: the verdict-first card/);
    expect(src).toMatch(/reader\?: CreativeRefReaderV1;\s+\/\/ rev 6; rev 7 widens it to CREATIVE_REF_READERS$/m);
  });
  it("revision 7: a picture names one of twelve readers; the rev 6 four keep their names and order", () => {
    expect([...CREATIVE_REF_READERS]).toEqual([
      "meta_archive", "reddit_ads", "youtube", "competitor",
      "creative_library", "brand_photo", "product_photo", "video_library", "packaging_thumbnail", "social_media", "inspiration",
      "review_media",
    ]);
    expect(new Set(CREATIVE_REF_READERS).size).toBe(CREATIVE_REF_READERS.length);
    for (const reader of CREATIVE_REF_READERS) expect(reader, reader).toMatch(/^[a-z][a-z_]{1,30}$/);
    const reader = "brand_photo" satisfies CreativeRefReaderV1;
    // A rev 6 ref is still a valid ref, and so is one with no reader at all.
    const rev6 = { archiveAssetId: "asset_1", reader: "meta_archive", ratio: "4:5" } satisfies CreativeRefV1;
    const rev7 = { archiveAssetId: "0f8e2a4c-5b6d-4e7f-8a9b-0c1d2e3f4a5b", reader } satisfies CreativeRefV1;
    const bare = { archiveAssetId: "asset_2" } satisfies CreativeRefV1;
    expect([rev6.reader, rev7.reader, "reader" in bare]).toEqual(["meta_archive", "brand_photo", false]);
    for (const ref of [rev6, rev7, bare]) expect(ARCHIVE_ASSET_ID_PATTERN.test(ref.archiveAssetId)).toBe(true);
  });
  it("revision 7: a store's compound id still passes the one archive id pattern", () => {
    // Hosts name a picture inside a parent by joining the two with ':' (a job and its thumbnail, a post and its file).
    for (const id of ["job_1:thumb_2", "post:0f8e2a4c-5b6d-4e7f-8a9b-0c1d2e3f4a5b:0", "screenshot:asset_1", "review-asset:asset_1"]) {
      expect(ARCHIVE_ASSET_ID_PATTERN.test(id), id).toBe(true);
    }
  });
  it("revision 6: channel logos and verdict tones are closed lists", () => {
    expect([...CHANNEL_LOGOS]).toEqual(["meta", "instagram", "reddit", "youtube", "google_ads", "google", "x", "tiktok", "linkedin",
      "stripe", "posthog", "ga4", "shopify", "email", "site"]);
    expect([...VERDICT_TONES]).toEqual(["good", "bad", "warn", "neutral", "accent"]);
    const logo = "reddit" satisfies ChannelLogoV1;
    const tone = "accent" satisfies VerdictToneV1;
    expect([CHANNEL_LOGOS.includes(logo), VERDICT_TONES.includes(tone)]).toEqual([true, true]);
  });
  it("revision 6: the card limits", () => {
    expect(ANSWER_VIEW_LIMITS.maxCardLineChars).toBe(160);
    expect(ANSWER_VIEW_LIMITS.maxCardActions).toBe(2);
    expect(ANSWER_VIEW_LIMITS.maxGroupPictures).toBe(3);
    expect(ANSWER_VIEW_LIMITS.maxCardLogos).toBe(4);
    expect(ANSWER_VIEW_LIMITS.maxCardRows).toBe(10);
    // Every earlier key is unchanged.
    expect(ANSWER_VIEW_LIMITS.maxShortTextChars).toBe(80);
    expect(ANSWER_VIEW_LIMITS.maxHostHandleChars).toBe(128);
    expect(ANSWER_VIEW_LIMITS.maxRows).toBe(200);
  });
  it("revision 6: the card's words are host data (verdict, age, delta, benchmark, quiet line, lane, rank change)", () => {
    const verdict = { words: "Too new · 1 day", tone: "neutral", ruleId: "gate.too_new", why: "Judged after 7 days.", mark: "age" } satisfies VerdictV1;
    const age = { days: 1, since: "2026-10-13", tooYoung: true } satisfies AgeV1;
    const censored = { days: 30, since: "2026-09-14", tooYoung: false, censored: true } satisfies AgeV1;
    const delta = { value: 12, unit: "percent", anchorLabel: "vs Sep 30 – Oct 6", tone: "good" } satisfies DeltaV1;
    const noDelta = { value: null, unit: "percent", anchorLabel: "vs Sep 30 – Oct 6", tone: "flat",
      reason: { code: "not_comparable", words: "not comparable", show: "hide" } } satisfies DeltaV1;
    const benchmark = { value: 4.62, kind: "usual", label: "your usual $4.62", basis: "median of your last 3 full weeks", tone: "bad" } satisfies BenchmarkV1;
    const quiet = { code: "all_paused", words: "Paused · last spent Oct 9" } satisfies QuietLineV1;
    const lane = { key: "site", label: "On the site", logo: "posthog" } satisfies LaneV1;
    const rankChange = { dir: "up", by: 2 } satisfies RankChangeV1;
    expect(ARCHIVE_ASSET_ID_PATTERN.test(verdict.ruleId)).toBe(true);
    expect([age.tooYoung, censored.censored, delta.value, noDelta.reason.show, benchmark.kind, quiet.words, lane.logo, rankChange.dir])
      .toEqual([true, true, 12, "hide", "usual", "Paused · last spent Oct 9", "posthog", "up"]);
  });
  it("revision 6: card actions (confirm, dismiss, next, open, copy, expand)", () => {
    const actions = [
      { role: "primary", do: "confirm" },
      { role: "secondary", do: "dismiss" },
      { role: "secondary", do: "next", label: "Show all 24 ads", step: { label: "Show all 24 ads", ask: "Show all 24 ads" } },
      { role: "secondary", do: "open", label: "Open Ads", appLink: { place: "ads", label: "Ads" } },
      { role: "primary", do: "copy", label: "Copy post", text: "the post" },
      { role: "secondary", do: "expand", label: "Open full screen" },
    ] satisfies CardActionV1[];
    expect(actions.map((a) => a.do)).toEqual(["confirm", "dismiss", "next", "open", "copy", "expand"]);
    // @ts-expect-error a next action carries its label
    const unlabelled: CardActionV1 = { role: "secondary", do: "next", step: { label: "x", ask: "x" } };
    expect(unlabelled.do).toBe("next");
  });
  it("revision 6: rows, cells, columns, steps and sections carry the card extras", () => {
    const extras = { rawName: "inf_r3_webinar_us", rank: 1, rankChange: { dir: "new" }, age: { days: 9, since: "2026-10-05", tooYoung: false },
      verdict: { words: "Converting", tone: "good", ruleId: "outcome.converting" }, logo: "meta", note: "First spent Oct 5.",
      pictureWord: "Video", group: { count: 15, words: "15 ads", pictures: [{ archiveAssetId: "asset_1", reader: "reddit_ads", ratio: "16:9" }] },
      emphasis: true, labelled: true, action: { role: "secondary", do: "open", label: "Open Ads", appLink: { place: "ads", label: "Ads" } },
    } satisfies RowCardExtrasV1;
    const row = { id: "ad_1", label: "Webinar · US", cells: { spend: { value: 11.3, benchmark: { value: 4.62, kind: "usual", label: "usual", basis: "3 weeks", tone: "flat" },
      delta: { value: 3, unit: "same", anchorLabel: "vs last week", tone: "flat" } } }, face: ["spend", "clicks"], ...extras } satisfies NumbersRowV1;
    const quietRow = { id: "ch_reddit", label: "Reddit", cells: {}, quietLine: { code: "all_paused", words: "Paused · last spent Oct 9" } } satisfies NumbersRowV1;
    const listRow = { id: "c1", title: "Catalogue ad", cells: {}, rank: 1, creativeRef: { archiveAssetId: "lib_1", reader: "competitor", ratio: "4:5" },
      action: { role: "secondary", do: "next", label: "Clone this ad", step: { label: "Clone this ad", ask: "Clone this ad" } } } satisfies ListRowV1;
    const column = { key: "cpc", label: "Cost a click", unit: "money", factGroup: "meta", polarity: "down_good", definition: "Spend over clicks.", lane: "meta", bar: true } satisfies ColumnV1;
    const step = { key: "app_signup", label: "App signup", count: 11, lane: "site", rate: 23.4, note: "+$200 MRR",
      drop: { words: "36 didn't sign up in the app", tone: "bad" }, verdict: { words: "Leak", tone: "bad", ruleId: "funnel.leak" }, definition: "Signed up in the app." } satisfies StepV1;
    const settled = { window: { from: "2026-10-07", to: "2026-10-13", tz: "UTC", label: "Oct 7–13" }, final: true, asOf: null, rows: [row, quietRow] };
    const section = { title: "Meta", kind: "numbers", head: { logo: "meta", verdict: { words: "Too new · 1 day", tone: "neutral", ruleId: "gate.too_new", mark: "age" },
      age: { days: 1, since: "2026-10-13", tooYoung: true }, face: ["spend"], folded: true },
      body: { layout: "table", currency: "USD", columns: [column], legs: { settled } } } satisfies SectionV1;
    const head = section.head satisfies SectionHeadV1;
    const pictured = { logo: "youtube", creativeRef: { archiveAssetId: "youtube-video:YUkn0keVtOs", reader: "youtube", ratio: "16:9" }, pictureWord: "Video" } satisfies SectionHeadV1;
    expect(pictured.creativeRef.reader).toBe("youtube");
    expect([row.face, listRow.creativeRef.reader, column.bar, step.rate, head.folded, quietRow.quietLine.code])
      .toEqual([["spend", "clicks"], "competitor", true, 23.4, true, "all_paused"]);
  });
  it("revision 6: bodies carry lanes, rankBy, endToEnd, list sections, a post, context and a change target's group", () => {
    const window = { from: "2026-10-07", to: "2026-10-13", tz: "UTC", label: "Oct 7–13" };
    const numbers = { layout: "steps", currency: "USD", columns: [], lanes: [{ key: "store", label: "At checkout", logo: "shopify" }], rankBy: "Meta's order",
      endToEnd: { value: 0.2, fromKey: "visits", toKey: "paid", words: "0.2% start to finish" },
      legs: { settled: { window, final: true, asOf: null, rows: [], steps: [{ key: "visits", label: "Visits", count: 3507, lane: "store" }] } } } satisfies NumbersBodyV1;
    const list = { layout: "rows", columns: [], rows: [], total: 0, shown: 0, rankBy: "Meta's order at our Oct 12 check",
      sections: [{ title: "Longest running", kind: "list", body: { layout: "rows", columns: [], rows: [], total: 0, shown: 0 } }] } satisfies ListBodyV1;
    const post = { network: "x", author: { name: "Infinite", handle: "infiniteOS_", picture: { archiveAssetId: "logo_mark" } }, chars: 404,
      limit: { max: 280, basis: "standard X limit" }, overflowAt: 281 } satisfies PostV1;
    const doc = { meta: [], sections: [{ text: "the post", format: "plain" }], post,
      context: [{ title: "Inspired by @fin465", kind: "record", body: { fields: [] } }] } satisfies DocumentBodyV1;
    const change = { target: { kind: "adgroup", label: "All devices · US", rawName: "inf_r3_webinar_us", age: { days: 1, since: "2026-10-13", tooYoung: true },
      verdict: { words: "Too new to call · 1 day", tone: "neutral", ruleId: "gate.too_new", mark: "age" }, pictureWord: "Ad group",
      group: { count: 15, words: "15 ads", pictures: [{ archiveAssetId: "a1" }, { archiveAssetId: "a2" }, { archiveAssetId: "a3" }] } },
      rows: [], warnings: [], context: [{ title: "This ad group", kind: "record", body: { fields: [] } }] } satisfies ChangeBodyV1;
    expect(change.target.group.pictures.length).toBeLessThanOrEqual(ANSWER_VIEW_LIMITS.maxGroupPictures);
    // @ts-expect-error a group carries the host's words for what it folds (the renderer names no noun)
    const wordless: ChangeBodyV1["target"]["group"] = { count: 4 };
    expect(wordless?.count).toBe(4);
    expect([numbers.endToEnd.value, list.sections[0].kind, doc.post.overflowAt, change.context.length]).toEqual([0.2, "list", 281, 1]);
  });
  it("revision 6: a view may carry the verdict-first card face", () => {
    const card = { head: { source: "Ads, all channels", logos: ["meta", "reddit", "youtube", "google_ads"], window: "Oct 7–13",
      chip: { words: "Needs your OK", tone: "warn" } },
      verdict: { words: "Nothing on fire", tone: "good", ruleId: "ads.all_clear" },
      figure: { value: { value: 50 }, unit: "money", currency: "USD", words: "budget it stops",
        benchmark: { value: 4.62, kind: "usual", label: "usual", basis: "3 weeks", tone: "flat" } },
      proof: "rows", foot: "Today is not final.",
      actions: [{ role: "secondary", do: "open", label: "Open Ads", appLink: { place: "ads", label: "Ads" } }] } satisfies CardFaceV1;
    const view = { v: 1, kind: "quiet", tool: "t", title: "T", state: "ready", asOf: null,
      scope: { workspaceName: "W", crossWorkspace: false }, caveats: [], body: { stepLine: "x" }, card } satisfies AnswerViewV1;
    expect(view.card.head.logos!.length).toBeLessThanOrEqual(ANSWER_VIEW_LIMITS.maxCardLogos);
    expect(view.card.actions.length).toBeLessThanOrEqual(ANSWER_VIEW_LIMITS.maxCardActions);
  });
  it("revision 6: a rev-5 view still type-checks (every rev 6 field is optional)", () => {
    const rev5 = { v: 1, kind: "numbers", tool: "get_ads_performance", title: "T", state: "ready", asOf: null,
      scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
      body: { layout: "table", currency: "USD", face: ["spend"], columns: [{ key: "spend", label: "Spend", unit: "money", factGroup: "meta" }],
        legs: { settled: { window: { from: "2026-10-07", to: "2026-10-13", tz: "UTC", label: "Oct 7–13" }, final: true, asOf: null,
          rows: [{ id: "a", label: "A", cells: { spend: { value: null, reason: { code: "not_synced", words: "not synced yet", show: "dash" } } },
            creativeRef: { archiveAssetId: "asset_1" } }],
          steps: [{ key: "s", label: "S", count: 1, ofPrevious: true }] } },
        sections: [{ title: "Old", kind: "list", body: { layout: "rows", columns: [], rows: [], total: 0, shown: 0 } }] },
    } satisfies AnswerViewV1;
    expect("card" in rev5).toBe(false);
  });
  it("revision 5: a numbers row may name its picture by archive reference (optional; the terminal ignores it)", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    const row: NumbersRowV1 = { id: "ad_1", label: "Demo B", cells: { spend: { value: 12.5 } }, creativeRef: { archiveAssetId: "asset_1" } };
    expect(row.creativeRef).toEqual({ archiveAssetId: "asset_1" });
    expect(ARCHIVE_ASSET_ID_PATTERN.test(row.creativeRef!.archiveAssetId)).toBe(true);
    const bare: NumbersRowV1 = { id: "ad_2", label: "Demo C", cells: {} };
    expect("creativeRef" in bare).toBe(false);
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 7 as const;\s+\/\/ rev 7: .*; rev 6: the verdict-first card .*; rev 5: NumbersRowV1\.creativeRef; NumbersBodyV1\.face; rev 4: /);
    expect(src).toMatch(/creativeRef\?: CreativeRefV1;.*the terminal ignores it; rev 5$/m);
  });
  it("revision 5: a numbers body may name its row face, the column keys a compact row shows (optional; the terminal ignores it)", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    const body: NumbersBodyV1 = {
      layout: "table", currency: "USD", face: ["clicks", "ctr", "spend"],
      columns: [
        { key: "spend", label: "Spent", unit: "money", factGroup: "a" },
        { key: "clicks", label: "Clicks", unit: "count", factGroup: "a" },
        { key: "ctr", label: "CTR", unit: "percent", factGroup: "a" },
      ],
      legs: { settled: { window: { from: "2026-10-12", to: "2026-10-13", tz: "UTC", label: "Oct 12–13" }, final: true, asOf: null, rows: [] } },
    };
    expect(body.face).toEqual(["clicks", "ctr", "spend"]);
    expect(body.face!.every((key) => body.columns.some((column) => column.key === key))).toBe(true);
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/face\?: string\[\];.*the terminal ignores it; rev 5$/m);
  });
  it("revision 4: an images run made of other runs may name their run ids (optional; host-only)", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    const body: ImagesBodyV1 = { runId: "clone-1", requested: 2, ready: 2, failed: 0, items: [], format: "png", aspectRatio: "4:5", model: "m", madeWith: "your_codex", drawRunIds: ["draw-1", "draw-2"] };
    expect(body.drawRunIds).toEqual(["draw-1", "draw-2"]);
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 7 as const;\s+\/\/ rev 7: .*; rev 6: the verdict-first card .*; rev 5: NumbersRowV1\.creativeRef; NumbersBodyV1\.face; rev 4: ImagesBodyV1\.drawRunIds; rev 3: /);
    expect(src).toMatch(/drawRunIds\?: string\[\];.*host-only; the terminal ignores it; rev 4$/m);
  });
  it("has 12 kinds and 24 states", () => {
    expect(ANSWER_VIEW_KINDS).toHaveLength(12); expect(ANSWER_VIEW_STATES).toHaveLength(24);
  });
  it("revision 3: a change target may name its picture by reference and its parents (both optional)", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    expect(ANSWER_VIEW_LIMITS.maxTargetPathParts).toBe(4);
    expect(ANSWER_VIEW_LIMITS.maxTargetPathPartChars).toBeGreaterThan(0);
    const rev3 = { target: { kind: "ad", id: "ad_1", label: "Demo B", creativeRef: { archiveAssetId: "asset_1" },
      path: ["Example campaign", "Example ad set"] }, rows: [{ label: "status", before: "on", after: "PAUSED" }], warnings: [] } satisfies ChangeBodyV1;
    // A revision 2 body (no picture, no path) is still a valid body.
    const rev2 = { target: { kind: "ad", label: "Demo B" }, rows: [], warnings: [] } satisfies ChangeBodyV1;
    expect(rev3.target.path).toHaveLength(2);
    expect("path" in rev2.target).toBe(false);
  });
  it("revision 3: an archive id is one shared pattern, never a URL, a data URI or a path", () => {
    for (const id of ["asset_1", "asset_0a1b-2c", "a1", "arch:v2.3"]) expect(ARCHIVE_ASSET_ID_PATTERN.test(id)).toBe(true);
    for (const id of ["", "https://example.test/a.png", "data:image/png;base64,AA", "/Users/example/a.png",
      "a/b", "_lead", "a".repeat(129), "asset\u001b[31m1", "asset 1"]) expect(ARCHIVE_ASSET_ID_PATTERN.test(id)).toBe(false);
    expect(ARCHIVE_ASSET_ID_PATTERN.test("a".repeat(128))).toBe(true);
  });
  it("revision 3: an archive id never starts with a URL scheme, in any case", () => {
    for (const id of ["https:example.test", "javascript:void", "mailto:a", "http:a", "HTTPS:example.test", "Javascript:void",
      "data:a", "file:a", "blob:a", "vbscript:a", "ftp:a", "MailTo:a"]) expect(ARCHIVE_ASSET_ID_PATTERN.test(id), id).toBe(false);
    // Real-shaped archive ids still pass, including ones that hold a ':' or start with a scheme's letters.
    for (const id of ["asset_gallery_hook_b", "meta:1202:thumb.v2", "thumb-1", "asset_c4", "asset-1",
      "0f8e2a4c-5b6d-4e7f-8a9b-0c1d2e3f4a5b", "https_asset", "datastore:a", "files:a", "mailtox:a", "blob1:a"]) {
      expect(ARCHIVE_ASSET_ID_PATTERN.test(id), id).toBe(true);
    }
  });
  it("revision 3: a list may name its row-name column, a record its own status, a leader its context line", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    expect(ANSWER_VIEW_LIMITS.maxShortTextChars).toBe(80);
    const list = { layout: "rows", nameLabel: "Ad", columns: [], rows: [], total: 0, shown: 0 } satisfies ListBodyV1;
    const record = { title: "Demo B", status: { word: "Paused", tone: "muted" }, fields: [] } satisfies RecordBodyV1;
    const leader = { measure: { key: "ctr", label: "CTR" }, rowId: "ad_1", rowLabel: "Demo B", value: { value: 2.1 },
      detail: "5 of 40 impressions" } satisfies LeaderV1;
    // All three are optional: a body without them is still valid.
    const oldList = { layout: "rows", columns: [], rows: [], total: 0, shown: 0 } satisfies ListBodyV1;
    const oldRecord = { fields: [] } satisfies RecordBodyV1;
    const oldLeader = { measure: { key: "ctr", label: "CTR" }, rowId: "ad_1", rowLabel: "Demo B", value: { value: null } } satisfies LeaderV1;
    expect([list.nameLabel, record.status.word, leader.detail]).toEqual(["Ad", "Paused", "5 of 40 impressions"]);
    expect(["nameLabel" in oldList, "status" in oldRecord, "detail" in oldLeader]).toEqual([false, false, false]);
  });
  it("revision 3: the contract source documents the new fields and the short-text rule", () => {
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 7 as const;.*ListBodyV1\.nameLabel; RecordBodyV1\.status; LeaderV1\.detail/);
    expect(src).toMatch(/nameLabel\?: string;.*rev 3/);
    expect(src).toMatch(/status\?: StatusWordV1;.*rev 3/);
    expect(src).toMatch(/detail\?: string;.*rev 3/);
  });
  it("revision 3: an answer may name its host's account handles and a state reason its step word (both optional)", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(7);
    expect(ANSWER_VIEW_LIMITS.maxHostHandleChars).toBe(128);
    const scope = { workspaceName: "Demo", crossWorkspace: false,
      account: { project: "proj_demo", source: "src_demo" } } satisfies AnswerViewEnvelopeV1["scope"];
    const reason = { code: "role_needed", words: "Only an owner or admin can do this.", short: "Not allowed",
      step: "not allowed" } satisfies StateReasonV1;
    // A view built without them is unchanged: both are optional.
    const oldScope = { workspaceName: "Demo", crossWorkspace: false } satisfies AnswerViewEnvelopeV1["scope"];
    const oldReason = { code: "role_needed", words: "Only an owner or admin can do this." } satisfies StateReasonV1;
    expect(["account" in oldScope, "step" in oldReason]).toEqual([false, false]);
    expect(reason.step.length).toBeLessThanOrEqual(ANSWER_VIEW_LIMITS.maxShortTextChars);
    // The handles share the archive id's character rule (one pattern, no second regex) and its bound.
    for (const handle of [scope.account.project, scope.account.source, "0f8e2a4c-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
      "a".repeat(ANSWER_VIEW_LIMITS.maxHostHandleChars)]) expect(ARCHIVE_ASSET_ID_PATTERN.test(handle), handle).toBe(true);
    for (const handle of ["", "proj demo", "proj/demo", "https://example.com/p", "a".repeat(ANSWER_VIEW_LIMITS.maxHostHandleChars + 1)]) {
      expect(ARCHIVE_ASSET_ID_PATTERN.test(handle), handle).toBe(false);
    }
    // A full view carries both and still holds no stripped key.
    const view = { v: 1, kind: "quiet", tool: "t", title: "T", state: "blocked", stateReason: reason, asOf: null,
      scope, caveats: [], body: { stepLine: "not allowed" } } satisfies AnswerViewV1;
    expect(view.scope.account).toEqual({ project: "proj_demo", source: "src_demo" });
  });
  it("revision 3: the contract source documents the account handles and the step word", () => {
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 7 as const;.*AnswerViewEnvelopeV1\.scope\.account; StateReasonV1\.step/);
    expect(src).toMatch(/account\?: \{ project: string; source: string \};.*host-only; the terminal ignores it.*rev 3$/m);
    expect(src).toMatch(/step\?: string;.*rev 3$/m);
    expect(src).toMatch(/maxHostHandleChars: 128/);
    expect(src).toMatch(/Short host words; rev 3:.*StateReasonV1\.step/);
  });
  it("a numbers view keeps today out of the settled leg", () => {
    const view = { v: 1, kind: "numbers", tool: "t", title: "T", state: "ready", asOf: null,
      scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
      body: { layout: "kpis", currency: "USD", columns: [{ key: "spend", label: "Spend", unit: "money", factGroup: "meta" }],
        legs: { settled: { window: { from: "2026-09-24", to: "2026-09-30", tz: "America/Los_Angeles", label: "Sep 24–30" }, final: true, asOf: null,
          rows: [{ id: "a", label: "All", cells: { spend: { value: null, reason: { code: "not_synced", words: "not synced yet" } } } }] },
          today: { window: { from: "2026-10-01", to: "2026-10-01", tz: "America/Los_Angeles", label: "Today" }, final: false, asOf: "2026-10-01T18:30:00Z", rows: [] } } },
    } satisfies AnswerViewV1;
    const keys: string[] = []; const walk = (v: unknown): void => { if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(view); expect(keys.filter(stripped)).toEqual([]);
  });
  it("no key declared anywhere in the contract source carries a token, credential or confirmation id", () => {
    const keysIn = (src: string): string[] => [
      ...src.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm),
      ...src.matchAll(/[{;,]\s*([A-Za-z_][A-Za-z0-9_]*)\??:/g),
    ].map((m) => m[1]);
    // The scan must be able to fail: a leaked key in a body interface is caught.
    expect(keysIn("export interface X { label: string; accessToken?: string }").filter(stripped)).toEqual(["accessToken"]);
    const keys = keysIn(readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8"));
    // Not vacuous: the scan sees the real contract keys.
    expect(keys).toEqual(expect.arrayContaining(["final", "asOf", "confirmationHandle", "archiveAssetId"]));
    expect(keys.filter(stripped)).toEqual([]);
  });
});

// Type-level pins, compiled by `tsc -b` (the CI typecheck), not by vitest:
// today is never final, and today always carries asOf.
const pinWindow = { from: "2026-10-01", to: "2026-10-01", tz: "America/Los_Angeles", label: "Today" };
const finalToday = { window: pinWindow, final: true, asOf: "2026-10-01T18:30:00Z", rows: [] };
// @ts-expect-error today is never final
export const _todayNeverFinal: TodayLegV1 = finalToday;
const undatedToday = { window: pinWindow, final: false as const, asOf: null, rows: [] };
// @ts-expect-error today needs asOf
export const _todayNeedsAsOf: TodayLegV1 = undatedToday;
