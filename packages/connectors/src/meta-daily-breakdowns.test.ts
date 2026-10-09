import { describe, expect, it } from "vitest";

import {
  isMetaAdsDailyBreakdownDimension,
  metaAdsDailyBreakdownParam,
  metaAdsDailyBreakdownValue,
  metaAdsHourFromBucket,
  metaAdsLocalHour,
  metaAdsWindowDayList,
} from "./meta-daily-breakdowns.js";

describe("meta daily breakdown helpers", () => {
  it("asks platform_position as the publisher_platform pair and keeps the platform as parent", () => {
    expect(metaAdsDailyBreakdownParam("device_platform")).toBe("device_platform");
    expect(metaAdsDailyBreakdownParam("platform_position")).toBe("publisher_platform,platform_position");
    expect(metaAdsDailyBreakdownValue("platform_position", { publisher_platform: "instagram", platform_position: "story" }))
      .toEqual({ parent: "instagram", value: "story" });
    expect(metaAdsDailyBreakdownValue("platform_position", { platform_position: "story" })).toBeNull();
    expect(metaAdsDailyBreakdownValue("publisher_platform", { publisher_platform: "facebook" })).toEqual({ parent: "", value: "facebook" });
    expect(isMetaAdsDailyBreakdownDimension("none")).toBe(false);
  });

  it("parses only whole-hour advertiser-time-zone buckets", () => {
    expect(metaAdsHourFromBucket("00:00:00 - 00:59:59")).toBe(0);
    expect(metaAdsHourFromBucket("23:00:00 - 23:59:59")).toBe(23);
    expect(metaAdsHourFromBucket("03:00:00 - 04:59:59")).toBeNull();
    expect(metaAdsHourFromBucket("24:00:00 - 24:59:59")).toBeNull();
    expect(metaAdsHourFromBucket(null)).toBeNull();
  });

  it("lists every day of a window and reads the local hour across DST", () => {
    expect(metaAdsWindowDayList("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(metaAdsLocalHour(new Date("2026-07-01T23:30:00.000Z"), "Europe/London")).toBe(0);
    expect(metaAdsLocalHour(new Date("2026-01-01T23:30:00.000Z"), "Europe/London")).toBe(23);
    expect(metaAdsLocalHour(new Date("2026-01-01T08:00:00.000Z"), "America/Los_Angeles")).toBe(0);
  });
});
