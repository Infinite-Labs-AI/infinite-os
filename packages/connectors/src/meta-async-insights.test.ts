import { describe, expect, it } from "vitest";

import {
  META_ADS_ASYNC_INSIGHTS_DEFAULT_POLICY,
  metaAdsFetchInsightsWindowWithNarrowing,
  metaAdsNarrowerWindows,
  metaAdsRunAsyncInsightsJob,
  type MetaAdsAsyncInsightsDeps,
  type MetaAdsAsyncInsightsStep,
  type MetaAdsInsightsWindow,
} from "./meta-async-insights.js";

const SYNC_URL = "https://graph.facebook.com/v25.0/act_9900000001/insights?fields=ad_id%2Cspend&level=ad&limit=500&time_increment=1&time_range=%7B%22since%22%3A%222026-06-01%22%2C%22until%22%3A%222026-06-01%22%7D";

class VolumeError extends Error {}
const isVolume = (error: unknown) => error instanceof VolumeError;
const urlFor = (range: MetaAdsInsightsWindow) => `sync:${range.since}:${range.until}`;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface Call { url: string; method: string; step: MetaAdsAsyncInsightsStep }

function fakeDeps(routes: (url: URL, method: string, step: MetaAdsAsyncInsightsStep) => Response, options: { now?: () => number } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const deps: MetaAdsAsyncInsightsDeps = {
    async fetch(url, init, step) {
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ url, method, step });
      return routes(new URL(url), method, step);
    },
    async sleep(ms) { sleeps.push(ms); },
    now: options.now ?? (() => 0),
    fail: (message) => Object.assign(new Error(message), { code: "provider_api_error", retryable: true }),
  };
  return { deps, calls, sleeps };
}

describe("metaAdsNarrowerWindows", () => {
  it("splits a month into 7-day weeks, a week into days, and has nothing narrower than one day", () => {
    const weeks = metaAdsNarrowerWindows({ since: "2026-03-01", until: "2026-03-31" });
    expect(weeks[0]).toEqual({ since: "2026-03-01", until: "2026-03-07" });
    expect(weeks.at(-1)).toEqual({ since: "2026-03-29", until: "2026-03-31" });
    expect(weeks).toHaveLength(5);
    const days = metaAdsNarrowerWindows({ since: "2026-06-01", until: "2026-06-07" });
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.since === d.until)).toBe(true);
    expect(metaAdsNarrowerWindows({ since: "2026-06-01", until: "2026-06-01" })).toEqual([]);
  });

  it("never returns the input window (the old week split re-issued a ≤7-day window verbatim)", () => {
    for (const window of [
      { since: "2026-06-01", until: "2026-06-07" },
      { since: "2026-06-01", until: "2026-06-02" },
      { since: "2026-06-01", until: "2026-06-08" },
    ]) {
      expect(metaAdsNarrowerWindows(window)).not.toContainEqual(window);
    }
  });
});

describe("metaAdsFetchInsightsWindowWithNarrowing", () => {
  it("keeps a window that succeeds fully synchronous — the async rung is never touched", async () => {
    const requested: string[] = [];
    const rows: string[] = [];
    let finalRungCalls = 0;
    await metaAdsFetchInsightsWindowWithNarrowing<string>({
      window: { since: "2026-06-01", until: "2026-06-07" },
      urlFor,
      isDataVolumeError: isVolume,
      async fetchPages(url, sink) { requested.push(url); sink("a"); sink("b"); },
      async finalRung() { finalRungCalls += 1; return []; },
      onRow: (row) => rows.push(row),
    });
    expect(requested).toEqual(["sync:2026-06-01:2026-06-07"]);
    expect(rows).toEqual(["a", "b"]);
    expect(finalRungCalls).toBe(0);
  });

  it("a 7-day slice that trips data-volume narrows to DAYS, and only a still-failing single day goes async", async () => {
    const requested: string[] = [];
    const rows: string[] = [];
    const asyncDays: string[] = [];
    await metaAdsFetchInsightsWindowWithNarrowing<string>({
      window: { since: "2026-06-01", until: "2026-06-07" },
      urlFor,
      isDataVolumeError: isVolume,
      async fetchPages(url, sink) {
        requested.push(url);
        sink(`partial:${url}`); // a first page lands, then the error — must be discarded
        if (url === "sync:2026-06-01:2026-06-07" || url === "sync:2026-06-03:2026-06-03") throw new VolumeError("1487534");
      },
      async finalRung(range, url) { asyncDays.push(`${range.since}|${url}`); return ["async-row"]; },
      onRow: (row) => rows.push(row),
    });
    expect(requested).toHaveLength(8); // the week once, then 7 days — never the same week twice
    expect(requested.filter((u) => u === "sync:2026-06-01:2026-06-07")).toHaveLength(1);
    expect(asyncDays).toEqual(["2026-06-03|sync:2026-06-03:2026-06-03"]);
    expect(rows).not.toContain("partial:sync:2026-06-01:2026-06-07");
    expect(rows).not.toContain("partial:sync:2026-06-03:2026-06-03");
    expect(rows).toContain("async-row");
    expect(rows.filter((r) => r.startsWith("partial:sync:2026-06-0"))).toHaveLength(6);
  });

  it("a month narrows month → weeks → days (recursively) before any async job", async () => {
    const requested: string[] = [];
    await metaAdsFetchInsightsWindowWithNarrowing<string>({
      window: { since: "2026-03-01", until: "2026-03-31" },
      urlFor,
      isDataVolumeError: isVolume,
      async fetchPages(url) {
        requested.push(url);
        if (url === "sync:2026-03-01:2026-03-31" || url === "sync:2026-03-08:2026-03-14") throw new VolumeError("1487534");
      },
      async finalRung() { throw new Error("no single day failed"); },
      onRow: () => undefined,
    });
    expect(requested).toHaveLength(1 + 5 + 7);
    expect(requested).toContain("sync:2026-03-10:2026-03-10");
  });

  it("a non-data-volume error propagates without narrowing or async", async () => {
    const requested: string[] = [];
    await expect(metaAdsFetchInsightsWindowWithNarrowing<string>({
      window: { since: "2026-06-01", until: "2026-06-07" },
      urlFor,
      isDataVolumeError: isVolume,
      async fetchPages(url) { requested.push(url); throw new Error("auth failed"); },
      async finalRung() { throw new Error("must not run"); },
      onRow: () => undefined,
    })).rejects.toThrow("auth failed");
    expect(requested).toHaveLength(1);
  });
});

describe("metaAdsRunAsyncInsightsJob", () => {
  function happyRoutes(statuses: Array<Record<string, unknown>>) {
    let poll = 0;
    return (url: URL, method: string): Response => {
      if (method === "POST") return json({ report_run_id: "6021000000001" });
      if (url.pathname === "/v25.0/6021000000001") return json(statuses[Math.min(poll++, statuses.length - 1)]);
      if (url.pathname === "/v25.0/6021000000001/insights") {
        return url.searchParams.get("after") === "p2"
          ? json({ data: [{ ad_id: "3" }], paging: {} })
          : json({ data: [{ ad_id: "1" }, { ad_id: "2" }], paging: { next: `${url.toString()}&after=p2` } });
      }
      return new Response("unexpected", { status: 500 });
    };
  }

  it("submit → 2 polls → 2 result pages; POSTs the SAME query (paging moved to the result edge)", async () => {
    const { deps, calls, sleeps } = fakeDeps(happyRoutes([
      { async_status: "Job Running", async_percent_completion: 40 },
      { async_status: "Job Completed", async_percent_completion: 100 },
    ]));
    const rows = await metaAdsRunAsyncInsightsJob<{ ad_id: string }>(SYNC_URL, deps);
    expect(rows.map((r) => r.ad_id)).toEqual(["1", "2", "3"]);
    expect(calls.map((c) => `${c.method}:${c.step}`)).toEqual([
      "POST:submit", "GET:poll", "GET:poll", "GET:results", "GET:results",
    ]);
    const submitted = new URL(calls[0]!.url);
    const sync = new URL(SYNC_URL);
    expect(submitted.pathname).toBe(sync.pathname);
    for (const key of ["fields", "level", "time_increment", "time_range"]) {
      expect(submitted.searchParams.get(key)).toBe(sync.searchParams.get(key));
    }
    expect(submitted.searchParams.has("limit")).toBe(false);
    expect(new URL(calls[3]!.url).searchParams.get("limit")).toBe("500");
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  it("keeps polling while Job Completed reports < 100% (Meta: wait for BOTH)", async () => {
    const { deps, calls } = fakeDeps(happyRoutes([
      { async_status: "Job Completed", async_percent_completion: 99 },
      { async_status: "Job Completed", async_percent_completion: 100 },
    ]));
    await metaAdsRunAsyncInsightsJob(SYNC_URL, deps);
    expect(calls.filter((c) => c.step === "poll")).toHaveLength(2);
  });

  it.each(["Job Failed", "Job Skipped"])("%s fails retryably, carries Meta's error code, and fetches no results", async (state) => {
    const { deps, calls } = fakeDeps(happyRoutes([
      { async_status: "Job Running", async_percent_completion: 10 },
      { async_status: state, async_percent_completion: 0, error_code: 100, error_subcode: 1487534 },
    ]));
    const failure = metaAdsRunAsyncInsightsJob(SYNC_URL, deps);
    await expect(failure).rejects.toMatchObject({ retryable: true, code: "provider_api_error" });
    await expect(failure).rejects.toThrow(`ended ${state} (100/1487534)`);
    expect(calls.filter((c) => c.step === "results")).toHaveLength(0);
  });

  it("times out after maxPolls — every poll counted, then a retryable failure", async () => {
    const { deps, calls } = fakeDeps(happyRoutes([{ async_status: "Job Running", async_percent_completion: 50 }]));
    await expect(metaAdsRunAsyncInsightsJob(SYNC_URL, deps)).rejects.toThrow(/did not complete within 10 polls/);
    expect(calls.filter((c) => c.step === "poll")).toHaveLength(META_ADS_ASYNC_INSIGHTS_DEFAULT_POLICY.maxPolls);
    expect(calls).toHaveLength(1 + META_ADS_ASYNC_INSIGHTS_DEFAULT_POLICY.maxPolls);
  });

  it("times out on the wall clock before spending another poll", async () => {
    let clock = 0;
    const { deps, calls } = fakeDeps(happyRoutes([{ async_status: "Job Not Started" }]), { now: () => clock });
    const originalFetch = deps.fetch;
    deps.fetch = async (url, init, step) => { clock += 90_000; return originalFetch(url, init, step); };
    await expect(metaAdsRunAsyncInsightsJob(SYNC_URL, deps)).rejects.toThrow(/did not complete/);
    // The job clock starts after submit; each poll advances 90s: 0 → 90 → 180 → 270s ≥ 240s → stop
    // before a fourth poll (well under maxPolls = 10, so the wall clock is what fired).
    expect(calls.map((c) => c.step)).toEqual(["submit", "poll", "poll", "poll"]);
  });

  it("fails loud on an unknown status or a missing report_run_id", async () => {
    const unknown = fakeDeps(happyRoutes([{ async_status: "Job Exploded" }]));
    await expect(metaAdsRunAsyncInsightsJob(SYNC_URL, unknown.deps)).rejects.toThrow(/unknown status/);
    const missing = fakeDeps(() => json({}));
    await expect(metaAdsRunAsyncInsightsJob(SYNC_URL, missing.deps)).rejects.toThrow(/no report_run_id/);
    expect(missing.calls).toHaveLength(1);
  });

  it("refuses a non-insights submit URL before spending a request", async () => {
    const { deps, calls } = fakeDeps(() => json({}));
    await expect(metaAdsRunAsyncInsightsJob("https://graph.facebook.com/v25.0/act_1/ads", deps)).rejects.toThrow(/unexpected submit URL/);
    expect(calls).toHaveLength(0);
  });

  it("propagates a budget/throttle refusal from the fetch chokepoint mid-poll (fail closed)", async () => {
    let n = 0;
    const { deps } = fakeDeps(happyRoutes([{ async_status: "Job Running", async_percent_completion: 5 }]));
    const inner = deps.fetch;
    deps.fetch = async (url, init, step) => {
      if (++n === 3) throw Object.assign(new Error("Meta Ads request budget exhausted"), { code: "provider_rate_budget_exhausted" });
      return inner(url, init, step);
    };
    await expect(metaAdsRunAsyncInsightsJob(SYNC_URL, deps)).rejects.toMatchObject({ code: "provider_rate_budget_exhausted" });
  });
});
