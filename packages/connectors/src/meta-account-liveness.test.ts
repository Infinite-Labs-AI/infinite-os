import { describe, expect, it } from "vitest";

import {
  META_ADS_ACCOUNT_LIVENESS_MAX_AGE_MS,
  metaAdsAccountLivenessCursorKey,
  metaAdsAccountLivenessDue,
} from "./meta-account-liveness.js";

describe("metaAdsAccountLivenessDue", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  it("is due with no, or an unparseable, cursor", () => {
    expect(metaAdsAccountLivenessDue(null, now)).toBe(true);
    expect(metaAdsAccountLivenessDue("", now)).toBe(true);
    expect(metaAdsAccountLivenessDue("not a date", now)).toBe(true);
  });
  it("is not due inside 24h and due at exactly 24h", () => {
    expect(metaAdsAccountLivenessDue("2026-09-23T11:59:00.000Z", now)).toBe(false);
    expect(metaAdsAccountLivenessDue(new Date(now.getTime() - META_ADS_ACCOUNT_LIVENESS_MAX_AGE_MS + 1).toISOString(), now)).toBe(false);
    expect(metaAdsAccountLivenessDue(new Date(now.getTime() - META_ADS_ACCOUNT_LIVENESS_MAX_AGE_MS).toISOString(), now)).toBe(true);
  });
  it("never trusts a future timestamp to suppress a read", () => {
    expect(metaAdsAccountLivenessDue("2026-09-23T12:00:01.000Z", now)).toBe(true);
  });
  it("keys the cursor per ad account", () => {
    expect(metaAdsAccountLivenessCursorKey("act_1")).toBe("meta_ads_account_liveness:act_1");
  });
});
