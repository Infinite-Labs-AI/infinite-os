import { describe, expect, it, vi } from "vitest";
import {
  META_GRAPH_BATCH_MAX,
  MetaGraphBatchTransportError,
  executeMetaGraphReadBatch,
} from "./meta-graph-batch.js";

const token = "secret-meta-token";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

describe("executeMetaGraphReadBatch", () => {
  it("sends one bounded GET-only batch and preserves keyed item results", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(init?.method).toBe("POST");
      expect(form.get("access_token")).toBe(token);
      const batch = JSON.parse(form.get("batch") ?? "") as Array<Record<string, string>>;
      expect(batch).toEqual([
        { method: "GET", relative_url: "act_1/insights?level=campaign" },
        { method: "GET", relative_url: "act_1/insights?level=adset" },
      ]);
      expect(form.get("batch")).not.toContain(token);
      return response([
        { code: 200, headers: [{ name: "x-business-use-case-usage", value: "10" }], body: "{\"data\":[{\"id\":\"c1\"}]}" },
        { code: 400, headers: [], body: "{\"error\":{\"code\":17}}" },
      ], { headers: { "x-app-usage": "12" } });
    });

    const observed: Array<{ status: number; usage: string | null }> = [];
    const result = await executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [
        { key: "campaign", relativeUrl: "act_1/insights?level=campaign" },
        { key: "adset", relativeUrl: "act_1/insights?level=adset" },
      ],
      fetcher: fetcher as typeof fetch,
      onOuterResponse: ({ status, headers }) => {
        observed.push({ status, usage: headers.get("x-app-usage") });
      },
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v25.0/");
    expect(observed).toEqual([{ status: 200, usage: "12" }]);
    expect(result.outerStatus).toBe(200);
    expect(result.results).toEqual([
      expect.objectContaining({ key: "campaign", status: 200, body: { data: [{ id: "c1" }] } }),
      expect.objectContaining({ key: "adset", status: 400, body: { error: { code: 17 } } }),
    ]);
    expect(result.results[0]?.headers.get("x-business-use-case-usage")).toBe("10");
  });

  it("rejects invalid counts and unsafe relative URLs before fetch", async () => {
    const fetcher = vi.fn();
    for (const reads of [
      [],
      Array.from({ length: META_GRAPH_BATCH_MAX + 1 }, (_, index) => ({ key: String(index), relativeUrl: `act_1/${index}` })),
      [{ key: "write", relativeUrl: "https://graph.facebook.com/v25.0/act_1" }],
      [{ key: "token", relativeUrl: "act_1/insights?access_token=leak" }],
      [{ key: "encoded-token", relativeUrl: "act_1/insights?access%5Ftoken=leak" }],
      [{ key: "control", relativeUrl: "act_1/insights?x=ok\u0000bad" }],
      [{ key: "empty", relativeUrl: "" }],
      [{ key: "duplicate", relativeUrl: "act_1/a" }, { key: "duplicate", relativeUrl: "act_1/b" }],
    ]) {
      await expect(executeMetaGraphReadBatch({ apiVersion: "v25.0", accessToken: token, reads, fetcher: fetcher as typeof fetch }))
        .rejects.toBeInstanceOf(MetaGraphBatchTransportError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects missing subresponses instead of synthesizing status zero", async () => {
    await expect(executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }, { key: "ad", relativeUrl: "act_1/insights?level=ad" }],
      fetcher: (async () => response([{ code: 200, body: "{}" }])) as typeof fetch,
    })).rejects.toBeInstanceOf(MetaGraphBatchTransportError);
  });

  it.each([
    [{ body: "{}" }],
    [{ code: "200", body: "{}" }],
    [{ code: 200 }],
  ])("rejects malformed item code and body shapes", async (items) => {
    await expect(executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }],
      fetcher: (async () => response(items)) as typeof fetch,
    })).rejects.toBeInstanceOf(MetaGraphBatchTransportError);
  });

  it("retains safe sibling response observations when strict item validation fails", async () => {
    const error = await executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [
        { key: "campaign", relativeUrl: "act_1/insights?level=campaign" },
        { key: "adset", relativeUrl: "act_1/insights?level=adset" },
      ],
      fetcher: (async () => response([
        { code: 500, headers: [{ name: "x-app-usage", value: "{\"call_count\":10}" }] },
        { code: 400, headers: [{ name: "x-app-usage", value: "{\"call_count\":55}" }], body: "{\"error\":{\"code\":17}}" },
      ])) as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MetaGraphBatchTransportError);
    expect((error as MetaGraphBatchTransportError).itemObservations).toEqual([
      expect.objectContaining({ key: "campaign", status: 500, providerCode: null }),
      expect.objectContaining({ key: "adset", status: 400, providerCode: 17 }),
    ]);
    expect((error as MetaGraphBatchTransportError).itemObservations[1]?.headers.get("x-app-usage")).toContain("55");
  });

  it("rejects an oversized item body even when its item status is 200", async () => {
    const oversized = JSON.stringify({ error: { code: 17 }, padding: "x".repeat(8 * 1024 * 1024) });
    const error = await executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }],
      fetcher: (async () => response([{ code: 200, body: oversized }])) as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MetaGraphBatchTransportError);
    expect((error as MetaGraphBatchTransportError).itemObservations).toEqual([
      expect.objectContaining({ key: "campaign", status: 200, providerCode: null, providerSubcode: null }),
    ]);
  });

  it("observes and safely classifies outer failures without retaining secrets", async () => {
    const observer = vi.fn();
    const failing = response({ error: { message: `bad ${token}`, code: 17, error_subcode: 99 } }, {
      status: 429,
      headers: { "x-business-use-case-usage": "88" },
    });
    const error = await executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }],
      fetcher: (async () => failing) as typeof fetch,
      onOuterResponse: observer,
    }).catch((caught: unknown) => caught);
    expect(observer).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status: 429, providerCode: 17, providerSubcode: 99 });
    expect((error as Error).message).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it("turns invalid outer bodies and aborts into safe typed errors", async () => {
    for (const fetcher of [
      (async () => response("not-json")) as typeof fetch,
      (async () => { throw new DOMException(`aborted ${token}`, "AbortError"); }) as typeof fetch,
    ]) {
      const error = await executeMetaGraphReadBatch({
        apiVersion: "v25.0",
        accessToken: token,
        reads: [{ key: "campaign", relativeUrl: "act_1/insights" }],
        fetcher,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MetaGraphBatchTransportError);
      expect((error as Error).message).not.toContain(token);
    }
  });

  it("marks an aborted fetch without retaining the abort reason", async () => {
    const error = await executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }],
      fetcher: (async () => { throw new DOMException(`aborted ${token}`, "AbortError"); }) as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ aborted: true, status: null });
    expect((error as Error).message).toBe("Meta Graph batch transport was aborted");
  });

  it("cancels an outer response stream as soon as the byte cap is crossed", async () => {
    let cancelled = false;
    let pulls = 0;
    const chunk = new Uint8Array(9 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }],
      fetcher: (async () => new Response(body, { status: 200 })) as typeof fetch,
    })).rejects.toBeInstanceOf(MetaGraphBatchTransportError);
    expect(cancelled).toBe(true);
  });
});
