import { afterEach, expect, it, vi } from "vitest";
vi.mock("./commands/analytics.js", () => ({ runAnalyticsCommand: vi.fn() }));
vi.mock("@infinite-os/ink", async () => await import("ink"));
import { metaCommand } from "./index.js";
const env = {
  GROWTH_OS_API_URL: "http://127.0.0.1:9999",
  GROWTH_OS_OPERATOR_TOKEN: "operator-test",
  GROWTH_OS_WORKSPACE_ID: "workspace-test",
  GROWTH_OS_CLI_NONINTERACTIVE: "1"
};
afterEach(() => vi.unstubAllGlobals());
it("requires an explicit retry token before sending a local create", async () => {
  const fetcher = vi.fn(async () => new Response('{"ok":true}'));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    metaCommand(
      [
        "campaign",
        "create",
        "--source-id",
        "source-test",
        "--name",
        "fixture",
        "--objective",
        "OUTCOME_TRAFFIC",
        "--yes"
      ],
      env
    )
  ).rejects.toThrow(/client-token/);
  expect(fetcher).not.toHaveBeenCalled();
});
it("forwards URL, video and feed inputs plus a stable launch scope", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}');
    })
  );
  for (const [flag, value, key] of [
    ["--image-url", "https://example.test/image.png", "imageUrl"],
    ["--video-url", "https://example.test/video.mp4", "videoUrl"],
    [
      "--asset-feed-spec",
      '{"link_urls":[{"website_url":"https://example.test"}]}',
      "assetFeedSpec"
    ]
  ]) {
    await metaCommand(
      [
        "creative",
        "create",
        "--source-id",
        "source-test",
        "--name",
        "fixture",
        flag,
        value,
        ...(key === "assetFeedSpec"
          ? []
          : ["--link-url", "https://example.test"]),
        "--launch-id",
        "launch-a",
        "--client-token",
        `attempt-${key}`,
        "--yes"
      ],
      env
    );
    expect(requests.at(-1)).toMatchObject({
      actionId: "create_meta_creative",
      input: {
        [key]: key === "assetFeedSpec" ? JSON.parse(value) : value,
        launchId: "launch-a",
        clientToken: `attempt-${key}`
      }
    });
  }
});
it("preserves a structured HTTP diagnostic on the CLI error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "provider_rate_limited",
              message: "Limit",
              retryable: false,
              metaWrite: {
                version: 1,
                phase: "provider_response",
                outcome: "throttled",
                providerCode: 17,
                metaMessage: "Wait for account cooldown"
              }
            }
          }),
          { status: 400 }
        )
    )
  );
  await expect(
    metaCommand(
      [
        "ad",
        "create",
        "123",
        "--source-id",
        "source-test",
        "--name",
        "fixture",
        "--creative-id",
        "456",
        "--client-token",
        "attempt-a",
        "--yes"
      ],
      env
    )
  ).rejects.toMatchObject({
    code: "provider_rate_limited",
    retryable: false,
    metaMessage: "Wait for account cooldown",
    metaWrite: { outcome: "throttled" }
  });
});

it("keeps the exact final CLI error-output JSON useful to humans and structured callers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "provider_api_error",
              message: "Provider could not complete the create",
              retryable: false,
              metaWrite: {
                version: 1,
                phase: "dispatch_unknown",
                outcome: "unknown",
                providerCode: 2,
                metaMessage: "A readable provider reason"
              }
            }
          }),
          { status: 400 }
        )
    )
  );
  try {
    await metaCommand(
      [
        "ad",
        "create",
        "123",
        "--source-id",
        "source-test",
        "--name",
        "fixture",
        "--creative-id",
        "456",
        "--client-token",
        "attempt-a",
        "--yes"
      ],
      env
    );
    throw Error("expected failure");
  } catch (error) {
    const output = JSON.parse((error as Error).message);
    expect(output.error).toMatchObject({
      metaMessage: "A readable provider reason",
      metaWrite: { phase: "dispatch_unknown", outcome: "unknown" }
    });
  }
});
