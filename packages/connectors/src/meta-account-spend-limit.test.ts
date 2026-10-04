import { describe, expect, it } from "vitest";

import { META_ADS_ACCOUNT_NODE_FIELDS, metaAdsAccountSpendLimitRead } from "./meta-account-spend-limit.js";

describe("META_ADS_ACCOUNT_NODE_FIELDS", () => {
  it("adds the spending limit to the account read the sync already makes — the same request, no new one", () => {
    expect(META_ADS_ACCOUNT_NODE_FIELDS.split(",")).toEqual([
      "id", "account_id", "currency", "timezone_name", "spend_cap", "amount_spent",
    ]);
  });
});

describe("metaAdsAccountSpendLimitRead", () => {
  it("keeps Meta's basic-unit numeric strings exactly as returned (cents for USD)", () => {
    expect(metaAdsAccountSpendLimitRead({ spend_cap: "500000", amount_spent: "123456" }))
      .toEqual({ kind: "measured", spendCap: "500000", amountSpent: "123456" });
  });

  it("keeps a 0 limit as 0 and an absent one as null — both mean no limit set, and they stay distinguishable", () => {
    expect(metaAdsAccountSpendLimitRead({ spend_cap: "0", amount_spent: "98765" }))
      .toEqual({ kind: "measured", spendCap: "0", amountSpent: "98765" });
    expect(metaAdsAccountSpendLimitRead({ id: "act_1", amount_spent: "98765" }))
      .toEqual({ kind: "measured", spendCap: null, amountSpent: "98765" });
    expect(metaAdsAccountSpendLimitRead({ spend_cap: null }))
      .toEqual({ kind: "measured", spendCap: null, amountSpent: null });
  });

  it("accepts a JSON number that is a whole, non-negative amount", () => {
    expect(metaAdsAccountSpendLimitRead({ spend_cap: 2500, amount_spent: 0 }))
      .toEqual({ kind: "measured", spendCap: "2500", amountSpent: "0" });
  });

  it("marks a value that is not a whole number of basic units unreadable — naming the field, never guessing its unit", () => {
    for (const bad of ["23.50", "-100", "", " 100", "1e5", "abc", 23.5, -1, Number.NaN, true, {}, ["100"], "1234567890123456789"]) {
      expect(metaAdsAccountSpendLimitRead({ spend_cap: bad, amount_spent: "1" })).toEqual({ kind: "unreadable", field: "spend_cap" });
      expect(metaAdsAccountSpendLimitRead({ spend_cap: "1", amount_spent: bad })).toEqual({ kind: "unreadable", field: "amount_spent" });
    }
  });
});
