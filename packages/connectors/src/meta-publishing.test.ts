import { describe, expect, it, vi } from "vitest";
import {
  resolveMetaPublishingIdentity,
  metaPublishingTracking,
  safeMetaWriteErrorFields,
  assertMetaAdTrackingName,
  verifyMetaCreativeTracking
} from "./meta-publishing.js";

describe("public Meta publishing policy", () => {
  it("resolves a selected Page with a Page token and keeps tokens out of its result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "222", access_token: "page-secret" }] })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "222",
            connected_page_backed_instagram_account: { id: "333" }
          })
        )
      );
    const result = await resolveMetaPublishingIdentity(
      { accessToken: "user-secret", pageId: "222" },
      fetcher
    );
    expect(result).toEqual({
      pageId: "222",
      instagramUserId: "333",
      kind: "page_backed"
    });
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe(
      "Bearer page-secret"
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("accepts verified Page-only identity and rejects malformed association data", async () => {
    for (const association of [null, { id: 333 }, false, []]) {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "222",
              instagram_business_account: association
            })
          )
        );
      const operation = resolveMetaPublishingIdentity(
        { accessToken: "user-secret", pageId: "222" },
        fetcher
      );
      if (association === null)
        await expect(operation).resolves.toEqual({
          pageId: "222",
          instagramUserId: null,
          kind: "page_only"
        });
      else
        await expect(operation).rejects.toMatchObject({
          code: "meta_identity_unavailable"
        });
    }
  });
  it("only falls back on recognized edge refusal; a throttle stops immediately", async () => {
    const denied = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 200 } }), { status: 400 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "222" })));
    await expect(
      resolveMetaPublishingIdentity(
        { accessToken: "user-secret", pageId: "222" },
        denied
      )
    ).resolves.toMatchObject({ kind: "page_only" });
    const throttled = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 17, message: "user-secret" } }),
          { status: 400 }
        )
      );
    await expect(
      resolveMetaPublishingIdentity(
        { accessToken: "user-secret", pageId: "222" },
        throttled
      )
    ).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryable: false
    });
    expect(throttled).toHaveBeenCalledOnce();
  });
  it("generates tags for clean destinations, validates explicit tags, and never tags media", () => {
    expect(
      metaPublishingTracking({
        linkUrl: "https://example.test/product",
        imageUrl: "https://cdn.test/image.png"
      })
    ).toContain("utm_content={{ad.name}}");
    expect(
      metaPublishingTracking({
        assetFeedSpec: {
          link_urls: [{ website_url: "https://example.test/product" }],
          images: [{ url: "https://cdn.test/image.png?utm_source=media" }]
        }
      })
    ).toContain("utm_source=facebook");
    expect(() =>
      metaPublishingTracking({
        linkUrl: "https://example.test/?utm_source=bad"
      })
    ).toThrow(/clean/i);
    expect(() =>
      metaPublishingTracking({ imageUrl: "https://cdn.test/image.png" })
    ).toThrow(/destination/i);
    expect(() => metaPublishingTracking({ linkUrl: "not a url" })).toThrow(
      /URL/i
    );
    expect(() =>
      metaPublishingTracking({
        linkUrl: "https://example.test",
        urlTags: "utm_content=someone@example.test"
      })
    ).toThrow(/tracking/i);
    expect(() => assertMetaAdTrackingName("Summer Sale")).toThrow(
      /utm_content/
    );
  });
  it("refuses encoded or forbidden macros and missing join keys", () => {
    const url = "https://example.test/product",
      tags = metaPublishingTracking({ linkUrl: url })!;
    for (const value of [
      tags.replace("{{campaign.id}}", "{{campaign.name}}"),
      tags.replace("{{adset.id}}", "{{adset.name}}"),
      tags.replace("{{placement}}", "{{site_source_name}}"),
      tags.replace("{{ad.name}}", "%7B%7Bad.name%7D%7D"),
      tags.replace("&ad_id={{ad.id}}", ""),
      tags + "&ad_id={{ad.id}}"
    ])
      expect(() =>
        metaPublishingTracking({ linkUrl: url, urlTags: value })
      ).toThrow(/tracking/i);
  });
  it("verifies tracking when reusing an existing creative and refuses untagged or foreign creatives", async () => {
    const tags = metaPublishingTracking({ linkUrl: "https://example.test" })!;
    for (const body of [
      {
        id: "444",
        account_id: "123",
        url_tags: tags,
        object_story_spec: { link_data: { link: "https://example.test" } }
      },
      {
        id: "444",
        account_id: "123",
        object_story_spec: { link_data: { link: "https://example.test" } }
      },
      {
        id: "444",
        account_id: "999",
        url_tags: tags,
        object_story_spec: { link_data: { link: "https://example.test" } }
      }
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
      const operation = verifyMetaCreativeTracking(
        { accessToken: "test-token", accountId: "123", creativeId: "444" },
        fetcher
      );
      if (body.account_id === "123" && body.url_tags)
        await expect(operation).resolves.toBeUndefined();
      else
        await expect(operation).rejects.toMatchObject({
          code: "meta_creative_tracking_unverified"
        });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("never lets an ignored scalar link stand in for missing feed destinations", () => {
    expect(() =>
      metaPublishingTracking({
        assetFeedSpec: { images: [{ url: "https://cdn.test/image.png" }] },
        linkUrl: "https://example.test"
      })
    ).toThrow(/destination/i);
  });
  it("refuses only configured owned short-link hosts without a blanket third-party ban", () => {
    vi.stubEnv("SHORT_LINK_HOST", "OwnLinks.example.test.");
    vi.stubEnv("SHORT_LINK_HOSTS", "go.infinite.fast, another.example.test");
    try {
      expect(() =>
        metaPublishingTracking({
          linkUrl: "https://OWNLINKS.example.test./offer"
        })
      ).toThrow(/short.link/i);
      expect(() =>
        metaPublishingTracking({ linkUrl: "https://go.infinite.fast/offer" })
      ).toThrow(/short.link/i);
      expect(
        metaPublishingTracking({ linkUrl: "https://bit.ly/example" })
      ).toContain("utm_content={{ad.name}}");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("preserves only bounded sanitized diagnostics across HTTP", () => {
    const result = safeMetaWriteErrorFields({
      metaWrite: {
        version: 1,
        phase: "dispatch_unknown",
        outcome: "unknown",
        metaMessage: "Bearer hidden-secret",
        providerCode: 2,
        secret: "do-not-return"
      }
    });
    expect(result.metaWrite).toMatchObject({
      version: 1,
      phase: "dispatch_unknown",
      outcome: "unknown",
      providerCode: 2
    });
    expect(result.metaMessage).not.toContain("hidden-secret");
    expect(JSON.stringify(result)).not.toContain("do-not-return");
  });
});
