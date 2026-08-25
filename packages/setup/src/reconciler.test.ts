import { describe, expect, it } from "vitest";

import { reconcile } from "./reconciler.js";
import type { DetectionState } from "./types.js";

const base: DetectionState = { accountExists: false, assetExists: false };

describe("reconcile (§9 matrix)", () => {
  it("nothing exists -> full pipeline", () => {
    expect(reconcile(base)).toEqual({ setup: "run", connect: "run", sync: "run", implement: "run" });
  });

  it("asset exists, no source -> skip setup", () => {
    expect(reconcile({ ...base, assetExists: true, assetId: "p1" })).toEqual({
      setup: "skip", connect: "run", sync: "run", implement: "run"
    });
  });

  it("source exists, credential invalid -> repair connect, run sync", () => {
    const s = { ...base, assetExists: true, assetId: "p1", sourceId: "src", credentialValid: false };
    expect(reconcile(s)).toMatchObject({ setup: "skip", connect: "repair", sync: "run" });
  });

  it("tag installed but not firing -> repair implement", () => {
    const s = { ...base, assetExists: true, assetId: "p1", sourceId: "src", credentialValid: true, tagInstalled: true, tagFiring: false };
    expect(reconcile(s)).toMatchObject({ connect: "skip", sync: "skip", implement: "repair" });
  });

  it("everything green -> all skip", () => {
    const s = { ...base, accountExists: true, assetExists: true, assetId: "p1", sourceId: "src", credentialValid: true, tagInstalled: true, tagFiring: true };
    expect(reconcile(s)).toEqual({ setup: "skip", connect: "skip", sync: "skip", implement: "skip" });
  });

  it("skipImplement forces implement:skip regardless of tag state", () => {
    expect(reconcile(base, { skipImplement: true })).toMatchObject({ implement: "skip" });
    const green = { ...base, assetExists: true, assetId: "p1" };
    expect(reconcile(green, { skipImplement: true }).implement).toBe("skip");
  });
});
