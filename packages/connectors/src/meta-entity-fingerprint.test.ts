import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  META_ADS_VOLATILE_FINGERPRINT_KEYS,
  canonicalMetaAdsJson,
  metaAdsEntityVersionFingerprint,
} from "./meta-entity-fingerprint.js";

// Shapes mirror the /act_<id>/ads read: `creative{id,name,title,body,thumbnail_url,image_url,
// image_hash,video_id,call_to_action_type,object_story_spec,asset_feed_spec}`. The rotating
// `emg1` preview is the exact pattern observed on a real dynamic-creative account: Meta mints a
// new path on nearly every read while nothing about the creative changed.
const EMG1_A = "https://external-dub4-1.xx.fbcdn.net/emg1/v/t13/8893140978873974957";
const EMG1_B = "https://external-dub4-1.xx.fbcdn.net/emg1/v/t13/15505404890301949775";

function dynamicCreative(overrides: { thumbnail?: string; feedThumbnail?: string; imageUrl?: string } = {}) {
  return {
    id: "120200000000000001",
    name: "DCO — summer hooks",
    thumbnail_url: overrides.thumbnail ?? EMG1_A,
    asset_feed_spec: {
      bodies: [{ text: "Charge anywhere." }, { text: "No cables. No excuses." }],
      titles: [{ text: "Summer sale" }],
      images: [{ hash: "a1b2c3d4e5f6", url_tags: "utm_source=meta" }],
      videos: [
        { video_id: "987654321098765", thumbnail_url: overrides.feedThumbnail ?? "https://scontent.xx.fbcdn.net/v/t15/111_n.jpg" },
      ],
      link_urls: [{ website_url: "https://shop.example.com/summer", display_url: "shop.example.com" }],
      call_to_action_types: ["SHOP_NOW"],
      ad_formats: ["AUTOMATIC_FORMAT"],
    },
    object_story_spec: {
      page_id: "100000000000001",
      link_data: {
        link: "https://shop.example.com/summer",
        image_hash: "a1b2c3d4e5f6",
        picture: overrides.imageUrl ?? "https://scontent.xx.fbcdn.net/v/t45/222_n.jpg",
        message: "Charge anywhere.",
      },
    },
    image_url: overrides.imageUrl ?? "https://scontent.xx.fbcdn.net/v/t45/222_n.jpg",
  };
}

function adNode(creative: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "120200000000000100",
    name: "Ad — summer hooks",
    campaign_id: "120200000000000010",
    adset_id: "120200000000000020",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    creative,
    ...overrides,
  };
}

describe("metaAdsEntityVersionFingerprint", () => {
  it("ignores a rotated top-level creative thumbnail_url", () => {
    expect(metaAdsEntityVersionFingerprint(dynamicCreative({ thumbnail: EMG1_A })))
      .toBe(metaAdsEntityVersionFingerprint(dynamicCreative({ thumbnail: EMG1_B })));
  });

  it("ignores a rotated thumbnail_url nested under the ad's creative expansion", () => {
    expect(metaAdsEntityVersionFingerprint(adNode(dynamicCreative({ thumbnail: EMG1_A }))))
      .toBe(metaAdsEntityVersionFingerprint(adNode(dynamicCreative({ thumbnail: EMG1_B }))));
  });

  it("ignores rendered media URLs at every depth (feed video thumbnail, image_url, link_data.picture)", () => {
    const before = adNode(dynamicCreative({ feedThumbnail: EMG1_A, imageUrl: "https://scontent.xx.fbcdn.net/v/t45/aaa_n.jpg" }));
    const after = adNode(dynamicCreative({ feedThumbnail: EMG1_B, imageUrl: "https://scontent.xx.fbcdn.net/v/t45/bbb_n.jpg" }));
    expect(metaAdsEntityVersionFingerprint(before)).toBe(metaAdsEntityVersionFingerprint(after));
  });

  it("treats a rendered URL that Meta omitted on one read as no change", () => {
    const { thumbnail_url: _omitted, ...withoutThumbnail } = dynamicCreative();
    expect(metaAdsEntityVersionFingerprint(withoutThumbnail)).toBe(metaAdsEntityVersionFingerprint(dynamicCreative()));
  });

  it.each([
    ["creative name", (c: ReturnType<typeof dynamicCreative>) => { c.name = "DCO — autumn hooks"; }],
    ["feed body text", (c: ReturnType<typeof dynamicCreative>) => { c.asset_feed_spec.bodies[0]!.text = "Charge everywhere."; }],
    ["feed image hash", (c: ReturnType<typeof dynamicCreative>) => { c.asset_feed_spec.images[0]!.hash = "ffffffffffff"; }],
    ["feed video id", (c: ReturnType<typeof dynamicCreative>) => { c.asset_feed_spec.videos[0]!.video_id = "111111111111111"; }],
    ["feed url_tags", (c: ReturnType<typeof dynamicCreative>) => { c.asset_feed_spec.images[0]!.url_tags = "utm_source=fb"; }],
    ["advertiser landing URL (asset_feed_spec.link_urls)", (c: ReturnType<typeof dynamicCreative>) => { c.asset_feed_spec.link_urls[0]!.website_url = "https://shop.example.com/autumn"; }],
    ["advertiser landing URL (object_story_spec.link_data.link)", (c: ReturnType<typeof dynamicCreative>) => { c.object_story_spec.link_data.link = "https://shop.example.com/autumn"; }],
    ["story image hash", (c: ReturnType<typeof dynamicCreative>) => { c.object_story_spec.link_data.image_hash = "ffffffffffff"; }],
  ])("changes when a stable creative field changes: %s", (_label, mutate) => {
    const changed = dynamicCreative();
    mutate(changed);
    expect(metaAdsEntityVersionFingerprint(changed)).not.toBe(metaAdsEntityVersionFingerprint(dynamicCreative()));
    // The same edit seen through the ad's creative expansion also re-versions the ad.
    expect(metaAdsEntityVersionFingerprint(adNode(changed))).not.toBe(metaAdsEntityVersionFingerprint(adNode(dynamicCreative())));
  });

  it("changes when the ad's own state or its creative assignment changes", () => {
    const base = metaAdsEntityVersionFingerprint(adNode(dynamicCreative()));
    expect(metaAdsEntityVersionFingerprint(adNode(dynamicCreative(), { status: "PAUSED", effective_status: "PAUSED" }))).not.toBe(base);
    expect(metaAdsEntityVersionFingerprint(adNode(dynamicCreative(), { name: "Ad — renamed" }))).not.toBe(base);
    expect(metaAdsEntityVersionFingerprint(adNode({ ...dynamicCreative(), id: "120200000000000002" }))).not.toBe(base);
  });

  it("is independent of provider key order and does not mutate the stored metadata", () => {
    const creative = dynamicCreative();
    const snapshot = JSON.stringify(creative);
    const reversed = Object.fromEntries(Object.entries(creative).reverse());
    expect(metaAdsEntityVersionFingerprint(reversed)).toBe(metaAdsEntityVersionFingerprint(creative));
    expect(JSON.stringify(creative)).toBe(snapshot);
  });

  it("hashes metadata with no volatile keys exactly as the pre-exclusion fingerprint did", () => {
    // Campaign/adset rows carry none of these keys, so their stored payload_hash stays valid and
    // the fix does not re-version them.
    const adset = { id: "s1", name: "UK buyers", status: "ACTIVE", targeting: { geo_locations: { countries: ["GB"] } } };
    expect(metaAdsEntityVersionFingerprint(adset)).toBe(
      createHash("sha256").update(canonicalMetaAdsJson(adset)).digest("hex"),
    );
  });

  it("pins the volatile key list", () => {
    expect([...META_ADS_VOLATILE_FINGERPRINT_KEYS].sort()).toEqual(["image_url", "picture", "thumbnail_url"]);
  });
});
