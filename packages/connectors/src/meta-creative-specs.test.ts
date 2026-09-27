import { describe, expect, it } from "vitest";
import {
  META_CREATIVE_ENHANCEMENT_FEATURES,
  META_CREATIVE_WRITE_FEATURES,
  MetaCreativeSpecError,
  metaAssetFeedHasVideo,
  metaCreativeEnhancementsAllOff,
  normalizeMetaAssetFeedSpec,
  normalizeMetaDegreesOfFreedomSpec
} from "./meta-creative-specs.js";

const OFF = { enroll_status: "OPT_OUT" } as const;

describe("META_CREATIVE_WRITE_FEATURES", () => {
  it("names both raw creative objects a host may send (the host fails closed on a missing one)", () => {
    expect([...META_CREATIVE_WRITE_FEATURES]).toEqual(["degrees_of_freedom_spec", "asset_feed_spec"]);
  });
});

describe("metaCreativeEnhancementsAllOff (create_meta_creative's default)", () => {
  it("switches every documented feature OFF, never the deprecated standard_enhancements bundle", () => {
    const spec = metaCreativeEnhancementsAllOff();
    expect(Object.keys(spec.creative_features_spec)).toEqual([...META_CREATIVE_ENHANCEMENT_FEATURES]);
    expect(META_CREATIVE_ENHANCEMENT_FEATURES).toHaveLength(23);
    expect(Object.values(spec.creative_features_spec).every((feature) => feature.enroll_status === "OPT_OUT")).toBe(true);
    expect(spec.creative_features_spec).not.toHaveProperty("standard_enhancements");
    // It is exactly what the transport validator accepts, and a fresh object every call.
    expect(normalizeMetaDegreesOfFreedomSpec(spec)).toEqual(spec);
    expect(metaCreativeEnhancementsAllOff()).not.toBe(spec);
  });
});

describe("normalizeMetaDegreesOfFreedomSpec", () => {
  it("returns a rebuilt copy of a valid per-feature spec", () => {
    const input = { creative_features_spec: { text_optimizations: OFF, image_touchups: { enroll_status: "OPT_IN" } } };
    const out = normalizeMetaDegreesOfFreedomSpec(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it.each([
    ["a non-object", "OPT_OUT"],
    ["an array", [OFF]],
    ["no creative_features_spec", {}],
    ["an empty feature map", { creative_features_spec: {} }],
    ["a legacy member next to the feature map", { creative_features_spec: { text_optimizations: OFF }, degrees_of_freedom_type: "USER_ENROLLED_AUTOFLOW" }],
    ["a non-snake_case key", { creative_features_spec: { "Text Optimizations": OFF } }],
    ["an unknown enroll status", { creative_features_spec: { text_optimizations: { enroll_status: "OFF" } } }],
    ["a lowercase enroll status", { creative_features_spec: { text_optimizations: { enroll_status: "opt_out" } } }],
    ["an extra field on a feature", { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT", customizations: {} } } }],
    ["a bare string feature", { creative_features_spec: { text_optimizations: "OPT_OUT" } }]
  ])("refuses %s with a typed invalid_creative_spec", (_label, value) => {
    expect(() => normalizeMetaDegreesOfFreedomSpec(value)).toThrow(MetaCreativeSpecError);
    try {
      normalizeMetaDegreesOfFreedomSpec(value);
    } catch (error) {
      expect((error as MetaCreativeSpecError).code).toBe("invalid_creative_spec");
    }
  });
});

describe("normalizeMetaAssetFeedSpec", () => {
  const feed = {
    ad_formats: ["SINGLE_IMAGE"],
    optimization_type: "PLACEMENT",
    images: [
      { url: "https://media.example.com/4x5.png", adlabels: [{ name: "r_4x5" }] },
      { hash: "abc123", adlabels: [{ name: "r_9x16" }] }
    ],
    bodies: [{ text: "Primary one" }, { text: "Primary two" }],
    titles: [{ text: "Headline" }],
    asset_customization_rules: [{ customization_spec: {}, image_label: { name: "r_4x5" }, priority: 2 }]
  };

  it("passes a valid feed through verbatim as a deep copy", () => {
    const out = normalizeMetaAssetFeedSpec(feed);
    expect(out).toEqual(feed);
    expect(out).not.toBe(feed);
    expect(out.images).not.toBe(feed.images);
  });

  it("accepts a video feed referenced by video_id and reports it as video", () => {
    const videoFeed = { videos: [{ video_id: "123", thumbnail_url: "https://x.example/t.jpg" }], bodies: [{ text: "b" }] };
    expect(metaAssetFeedHasVideo(normalizeMetaAssetFeedSpec(videoFeed))).toBe(true);
    expect(metaAssetFeedHasVideo(normalizeMetaAssetFeedSpec(feed))).toBe(false);
  });

  it.each([
    ["a non-object", []],
    ["no media at all", { bodies: [{ text: "b" }] }],
    ["an image with neither hash nor url", { images: [{ adlabels: [{ name: "r_4x5" }] }] }],
    ["an image url that is not https", { images: [{ url: "http://media.example.com/a.png" }] }],
    ["an image url that is a loopback file Meta cannot fetch", { images: [{ url: "file:///tmp/a.png" }] }],
    ["a video without video_id", { videos: [{ thumbnail_url: "https://x.example/t.jpg" }] }],
    ["images that are not a list", { images: { url: "https://x.example/a.png" } }],
    ["an empty body list", { images: [{ hash: "h" }], bodies: [] }],
    ["a blank title", { images: [{ hash: "h" }], titles: [{ text: "  " }] }]
  ])("refuses %s", (_label, value) => {
    expect(() => normalizeMetaAssetFeedSpec(value)).toThrow(MetaCreativeSpecError);
  });

  it("refuses an oversized feed instead of handing Meta a megabyte of JSON", () => {
    const huge = { images: [{ hash: "h" }], bodies: [{ text: "x".repeat(70 * 1024) }] };
    expect(() => normalizeMetaAssetFeedSpec(huge)).toThrow(/larger than/);
  });
});
