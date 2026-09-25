import { describe, expect, it } from "vitest";

import {
  META_ADS_ADSET_EFFECTIVE_STATUSES,
  META_ADS_AD_EFFECTIVE_STATUSES,
  META_ADS_CAMPAIGN_EFFECTIVE_STATUSES,
  META_ADS_HOT_ROLLUP_DERIVATION,
  metaAdsAllStatusAdFiltering,
  metaAdsAllStatusFiltering,
  metaAdsHotLaneRollsUpFromAds,
  rollUpMetaAdsAdInsights,
} from "./meta-ads-hot-rollup.js";

const day = "2026-09-23";

function ad(overrides: Record<string, unknown>) {
  return {
    campaign_id: "c1",
    campaign_name: "Campaign one",
    adset_id: "s1",
    adset_name: "Adset one",
    date_start: day,
    date_stop: day,
    account_currency: "USD",
    objective: "OUTCOME_SALES",
    optimization_goal: "OFFSITE_CONVERSIONS",
    reach: "999",
    frequency: "1.5",
    ...overrides,
  };
}

describe("rollUpMetaAdsAdInsights", () => {
  it("sums additive delivery, recomputes rates from the sums and never carries reach", () => {
    const { campaigns, adsets } = rollUpMetaAdsAdInsights([
      ad({ ad_id: "a1", spend: "10.10", clicks: "3", inline_link_clicks: "2", impressions: "1000", ctr: "0.3", cpc: "3.366667", cpm: "10.1" }),
      ad({ ad_id: "a2", spend: "20.20", clicks: "7", inline_link_clicks: "5", impressions: "3000", ctr: "0.233333", cpc: "2.885714", cpm: "6.733333" }),
      ad({ ad_id: "a3", adset_id: "s2", adset_name: "Adset two", spend: "0.1", clicks: "0", impressions: "10" }),
    ]);
    expect(campaigns).toHaveLength(1);
    const campaign = campaigns[0]!;
    expect(campaign).toMatchObject({ grain: "campaign", entityId: "c1", adRowCount: 3 });
    expect(campaign.row).toMatchObject({
      campaign_id: "c1",
      campaign_name: "Campaign one",
      date_start: day,
      spend: 30.4,
      clicks: 10,
      inline_link_clicks: 7,
      impressions: 4010,
      reach: null,
      frequency: null,
      account_currency: "USD",
      objective: "OUTCOME_SALES",
      optimization_goal: "OFFSITE_CONVERSIONS",
    });
    // Rates come from the SUMS (30.4 / 10 clicks), never an average of the ads' rates.
    expect(campaign.row.cpc).toBeCloseTo(3.04, 10);
    expect(campaign.row.ctr).toBeCloseTo((10 / 4010) * 100, 10);
    expect(campaign.row.cpm).toBeCloseTo((30.4 / 4010) * 1000, 10);
    expect(campaign.row).not.toHaveProperty("adset_id");

    expect(adsets.map((entry) => [entry.entityId, entry.row.spend, entry.adRowCount])).toEqual([
      ["s1", 30.3, 2],
      ["s2", 0.1, 1],
    ]);
    expect(adsets[0]!.row).toMatchObject({ campaign_id: "c1", adset_id: "s1", adset_name: "Adset one", reach: null });
    // A zero denominator is unmeasurable, not zero.
    expect(adsets[1]!.row).toMatchObject({ clicks: 0, cpc: null, ctr: 0 });
  });

  it("sums actions per action_type and per attribution window, keeping aliases separate", () => {
    const { campaigns } = rollUpMetaAdsAdInsights([
      ad({
        ad_id: "a1", spend: "1", clicks: "1", impressions: "1",
        actions: [
          { action_type: "purchase", value: "2", "7d_click": "2", "1d_view": "1", "1d_click": "1" },
          { action_type: "omni_purchase", value: "3", "7d_click": "3" },
        ],
        action_values: [{ action_type: "purchase", value: "40.5", "7d_click": "40.5", "1d_view": "9.5" }],
      }),
      ad({
        ad_id: "a2", spend: "1", clicks: "1", impressions: "1",
        // Legacy element without window keys: its `value` IS the 7d_click count.
        actions: [{ action_type: "purchase", value: "4" }, { action_type: "landing_page_view", value: "6", "7d_click": "6" }],
        action_values: [{ action_type: "purchase", value: "60", "7d_click": "60" }],
      }),
      ad({ ad_id: "a3", spend: "1", clicks: "1", impressions: "1" }),
    ]);
    const row = campaigns[0]!.row;
    expect(row.actions).toEqual([
      { action_type: "purchase", value: 6, "7d_click": 6, "1d_view": 1, "1d_click": 1 },
      { action_type: "omni_purchase", value: 3, "7d_click": 3 },
      { action_type: "landing_page_view", value: 6, "7d_click": 6 },
    ]);
    expect(row.action_values).toEqual([{ action_type: "purchase", value: 100.5, "7d_click": 100.5, "1d_view": 9.5 }]);
  });

  it("leaves actions ABSENT when no ad returned them (unknown stays unknown, never an empty measured array)", () => {
    const { campaigns } = rollUpMetaAdsAdInsights([ad({ ad_id: "a1", spend: "1", clicks: "0", impressions: "5" })]);
    expect(campaigns[0]!.row.actions).toBeUndefined();
    expect(campaigns[0]!.row.action_values).toBeUndefined();
  });

  it("keeps a campaign optimization_goal only when every child ad agrees", () => {
    const mixed = rollUpMetaAdsAdInsights([
      ad({ ad_id: "a1", spend: "1", impressions: "1", optimization_goal: "LANDING_PAGE_VIEWS" }),
      ad({ ad_id: "a2", adset_id: "s2", spend: "1", impressions: "1", optimization_goal: "LINK_CLICKS" }),
    ]);
    expect(mixed.campaigns[0]!.row.optimization_goal).toBeNull();
    expect(mixed.adsets.map((entry) => entry.row.optimization_goal)).toEqual(["LANDING_PAGE_VIEWS", "LINK_CLICKS"]);
  });

  it("refuses rows it cannot attribute instead of dropping their spend", () => {
    expect(() => rollUpMetaAdsAdInsights([ad({ ad_id: "a1", campaign_id: null, spend: "5" })])).toThrow(/campaign_id/);
    expect(() => rollUpMetaAdsAdInsights([ad({ ad_id: "a1", adset_id: "", spend: "5" })])).toThrow(/adset_id/);
    expect(() => rollUpMetaAdsAdInsights([
      ad({ ad_id: "a1", spend: "5" }),
      ad({ ad_id: "a2", spend: "5", date_start: "2026-09-22" }),
    ])).toThrow(/one reporting day/);
    expect(() => rollUpMetaAdsAdInsights([
      ad({ ad_id: "a1", spend: "5" }),
      ad({ ad_id: "a2", adset_id: "s1", campaign_id: "c2", spend: "5" }),
    ])).toThrow(/two campaigns/);
  });

  it("describes its derivation for the stored audit JSON", () => {
    expect(META_ADS_HOT_ROLLUP_DERIVATION).toEqual({ method: "sum_of_ad_insights", version: 1, source_grain: "ad" });
  });

  it("carries trial and sign-up action_types through the sum, including a name the engine cannot yet recognise", () => {
    // NOT a Meta value: it stands in for the StartTrial action_type, which Meta has not documented for
    // actions[]. Whatever the name, the derived ad set row must carry it so it can be confirmed.
    const HYPOTHETICAL_TRIAL_TYPE = "hypothetical.start_trial_type";
    const { adsets } = rollUpMetaAdsAdInsights([
      ad({
        ad_id: "a1", spend: "1", clicks: "1", impressions: "1",
        actions: [
          { action_type: HYPOTHETICAL_TRIAL_TYPE, value: "1", "7d_click": "1", "1d_view": "1" },
          { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "2", "7d_click": "2" },
        ],
      }),
      ad({
        ad_id: "a2", spend: "1", clicks: "1", impressions: "1",
        actions: [{ action_type: HYPOTHETICAL_TRIAL_TYPE, value: "2", "7d_click": "2" }],
      }),
    ]);
    expect(adsets[0]!.row.actions).toEqual([
      { action_type: HYPOTHETICAL_TRIAL_TYPE, value: 3, "7d_click": 3, "1d_view": 1 },
      { action_type: "offsite_conversion.fb_pixel_complete_registration", value: 2, "7d_click": 2 },
    ]);
    // No ad reported a Results entry, so the derived row carries none.
    expect(adsets[0]!.row.results).toBeNull();
  });

  const TRIAL = "conversions:start_trial_website";
  const trialEntry = (values?: Array<{ value?: string | number; attribution_windows?: string[] }>) =>
    ({ indicator: TRIAL, ...(values === undefined ? {} : { values }) });

  it("sums a requested Results indicator per attribution window across an ad set's ads", () => {
    const { adsets, campaigns } = rollUpMetaAdsAdInsights([
      ad({ ad_id: "a1", spend: "1", impressions: "1", results: [trialEntry([
        { value: "1", attribution_windows: ["7d_click"] },
        { value: "1", attribution_windows: ["1d_view"] },
        { value: "1", attribution_windows: ["default"] },
      ])] }),
      // An explicit 0, and a window this ad omits (1d_view): it counts 0 for this ad.
      ad({ ad_id: "a2", spend: "1", impressions: "1", results: [trialEntry([{ value: "0", attribution_windows: ["7d_click"] }])] }),
      ad({ ad_id: "a3", spend: "1", impressions: "1", results: [trialEntry([{ value: 2, attribution_windows: ["7d_click"] }])] }),
    ], { resultIndicators: [TRIAL] });
    const expected = [{ indicator: TRIAL, values: [
      { value: 3, attribution_windows: ["7d_click"] },
      { value: 1, attribution_windows: ["1d_view"] },
      { value: 1, attribution_windows: ["default"] },
    ] }];
    expect(adsets[0]!.row.results).toEqual(expected);
    expect(campaigns[0]!.row.results).toEqual(expected);
  });

  it("publishes the indicator with NO values (unknown) unless every ad reported it with summable values", () => {
    const counted = ad({ ad_id: "a1", spend: "1", impressions: "1", results: [trialEntry([{ value: "2", attribution_windows: ["7d_click"] }])] });
    for (const [label, other] of [
      ["an ad with no values", { results: [trialEntry()] }],
      ["an ad with empty values", { results: [trialEntry([])] }],
      ["an ad with no results", {}],
      ["an ad reporting another indicator", { results: [{ indicator: "conversions:start_trial_total", values: [{ value: "1", attribution_windows: ["7d_click"] }] }] }],
      ["an ad with a window-less value", { results: [trialEntry([{ value: "1" }])] }],
      ["an ad with a non-numeric value", { results: [trialEntry([{ value: "one", attribution_windows: ["7d_click"] }])] }],
      ["an ad repeating a window", { results: [trialEntry([{ value: "1", attribution_windows: ["7d_click"] }, { value: "1", attribution_windows: ["7d_click"] }])] }],
    ] as const) {
      const { adsets } = rollUpMetaAdsAdInsights(
        [counted, ad({ ad_id: "a2", spend: "1", impressions: "1", ...other })],
        { resultIndicators: [TRIAL] },
      );
      expect({ label, results: adsets[0]!.row.results }).toEqual({ label, results: [{ indicator: TRIAL }] });
    }
  });

  it("sums only the requested indicators: a purchase ad set's derived row keeps results null", () => {
    const purchaseResults = [{ indicator: "actions:offsite_conversion.fb_pixel_purchase", values: [{ value: "1", attribution_windows: ["7d_click"] }] }];
    const rows = [
      ad({ ad_id: "a1", spend: "1", impressions: "1", results: purchaseResults }),
      ad({ ad_id: "a2", spend: "1", impressions: "1", results: purchaseResults }),
    ];
    expect(rollUpMetaAdsAdInsights(rows, { resultIndicators: [TRIAL] }).adsets[0]!.row.results).toBeNull();
    // With no indicators requested, nothing is summed at all (the pre-B1 behaviour).
    expect(rollUpMetaAdsAdInsights([ad({ ad_id: "a1", spend: "1", impressions: "1", results: [trialEntry([{ value: "1", attribution_windows: ["7d_click"] }])] })]).adsets[0]!.row.results).toBeNull();
  });
});

describe("hot-lane ad read shape", () => {
  it("asks Meta for every ad effective_status, including ARCHIVED and DELETED", () => {
    expect(META_ADS_AD_EFFECTIVE_STATUSES).toEqual([
      "ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED",
      "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES",
    ]);
    expect(JSON.parse(metaAdsAllStatusAdFiltering())).toEqual([
      { field: "ad.effective_status", operator: "IN", value: META_ADS_AD_EFFECTIVE_STATUSES },
    ]);
  });

  it("filters each settled grain on ITS OWN object's documented statuses (an unknown value fails the request)", () => {
    // facebook-python-business-sdk AdSet.EffectiveStatus / Campaign.EffectiveStatus.
    expect(META_ADS_ADSET_EFFECTIVE_STATUSES).toEqual(["ACTIVE", "PAUSED", "DELETED", "CAMPAIGN_PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"]);
    expect(META_ADS_CAMPAIGN_EFFECTIVE_STATUSES).toEqual(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"]);
    expect(JSON.parse(metaAdsAllStatusFiltering("adset"))).toEqual([
      { field: "adset.effective_status", operator: "IN", value: META_ADS_ADSET_EFFECTIVE_STATUSES },
    ]);
    expect(JSON.parse(metaAdsAllStatusFiltering("campaign"))).toEqual([
      { field: "campaign.effective_status", operator: "IN", value: META_ADS_CAMPAIGN_EFFECTIVE_STATUSES },
    ]);
    expect(metaAdsAllStatusFiltering("ad")).toBe(metaAdsAllStatusAdFiltering());
  });

  it("rolls up ONLY for the hot open-day lane", () => {
    expect(metaAdsHotLaneRollsUpFromAds("hot_insights")).toBe(true);
    for (const lane of ["settled_history", "history_backfill", "attended_refresh", "inventory_sync", "media_archive", undefined]) {
      expect(metaAdsHotLaneRollsUpFromAds(lane)).toBe(false);
    }
  });
});
