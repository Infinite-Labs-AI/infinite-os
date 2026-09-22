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
      [{ key: "empty", relativeUrl: "" }],
    ]) {
      await expect(executeMetaGraphReadBatch({ apiVersion: "v25.0", accessToken: token, reads, fetcher: fetcher as typeof fetch }))
        .rejects.toBeInstanceOf(MetaGraphBatchTransportError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps malformed subresponses keyed instead of fabricating success", async () => {
    const result = await executeMetaGraphReadBatch({
      apiVersion: "v25.0",
      accessToken: token,
      reads: [{ key: "campaign", relativeUrl: "act_1/insights" }, { key: "ad", relativeUrl: "act_1/insights?level=ad" }],
      fetcher: (async () => response([{ code: 200, body: "not-json" }])) as typeof fetch,
    });
    expect(result.results).toEqual([
      expect.objectContaining({ key: "campaign", status: 200, body: null }),
      expect.objectContaining({ key: "ad", status: 0, body: null }),
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
});
