import { describe, expect, it } from "vitest";

import {
  META_ADS_EXTENDED_INSIGHTS_FIELDS,
  metaAdsExtendedInsightsFieldSuffix,
  metaAdsExtendedInsightsLane,
  metaAdsLearningStageLane,
  metaAdsSplitLearningStage,
  metaAdsVideoActionsRaw,
  metaAdsWindowDays,
} from "./meta-extended-reads.js";

describe("extended reads switch (pure)", () => {
  it("is on only for an explicit true on a settled insights lane", () => {
    for (const lane of ["settled_history", "history_backfill"]) {
      expect(metaAdsExtendedInsightsLane(true, lane)).toBe(true);
      expect(metaAdsExtendedInsightsLane(undefined, lane)).toBe(false);
      expect(metaAdsExtendedInsightsLane(false, lane)).toBe(false);
    }
    for (const lane of ["hot_insights", "attended_refresh", "media_archive", "inventory_sync", undefined]) {
      expect(metaAdsExtendedInsightsLane(true, lane)).toBe(false);
    }
  });

  it("asks for the learning stage only on entity-scan lanes, never hot / attended / media / lane-less", () => {
    for (const lane of ["inventory_sync", "settled_history", "history_backfill"]) expect(metaAdsLearningStageLane(true, lane)).toBe(true);
    for (const lane of ["hot_insights", "attended_refresh", "media_archive", undefined]) expect(metaAdsLearningStageLane(true, lane)).toBe(false);
    expect(metaAdsLearningStageLane(undefined, "inventory_sync")).toBe(false);
  });

  it("appends exactly the eight video watch fields, in a fixed order", () => {
    expect(metaAdsExtendedInsightsFieldSuffix()).toBe(
      "video_play_actions,video_thruplay_watched_actions,video_avg_time_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions",
    );
  });

  it("stores a requested video list verbatim and an omitted one as [] (measured none)", () => {
    const thruplays = [{ action_type: "video_view", value: "9", "1d_view": "8" }];
    const raw = metaAdsVideoActionsRaw({ video_thruplay_watched_actions: thruplays, video_p25_watched_actions: "garbage" });
    expect(Object.keys(raw)).toEqual([...META_ADS_EXTENDED_INSIGHTS_FIELDS]);
    expect(raw.video_thruplay_watched_actions).toEqual(thruplays);
    expect(raw.video_p25_watched_actions).toEqual([]);
    expect(raw.video_play_actions).toEqual([]);
  });

  it("splits learning_stage_info off every node, and observes it only when requested", () => {
    const nodes = [
      { id: "s1", name: "A", learning_stage_info: { status: "LEARNING", conversions: 12, last_sig_edit_ts: 1_790_000_000, attribution_windows: ["7d_click"] } },
      { id: "s2", name: "B" },
    ];
    const requested = metaAdsSplitLearningStage(nodes, true);
    expect(requested.nodes).toEqual([{ id: "s1", name: "A" }, { id: "s2", name: "B" }]);
    expect(requested.observations).toEqual([
      { adsetId: "s1", status: "LEARNING", conversions: 12, lastSigEditAt: new Date(1_790_000_000 * 1000).toISOString(), attributionWindows: ["7d_click"] },
      // Asked, Meta said nothing: status null (unmeasured), never "not learning".
      { adsetId: "s2", status: null, conversions: null, lastSigEditAt: null, attributionWindows: null },
    ]);
    // The caller's nodes are not mutated.
    expect(nodes[0]).toHaveProperty("learning_stage_info");
    expect(metaAdsSplitLearningStage(nodes, false).observations).toEqual([]);
  });

  it("measures whole-day windows and refuses malformed or inverted ones", () => {
    expect(metaAdsWindowDays("2026-09-22", "2026-09-28")).toBe(7);
    expect(metaAdsWindowDays("2026-09-28", "2026-09-28")).toBe(1);
    expect(metaAdsWindowDays("2026-09-28", "2026-09-22")).toBeNull();
    expect(metaAdsWindowDays("2026-9-2", "2026-09-28")).toBeNull();
  });
});
