import { describe, expect, it } from "vitest";
import {
  appNameForHome,
  CANONICAL_HOMES,
  desktopTargetForHome
} from "./canonical-home.js";

describe("desktopTargetForHome", () => {
  it("maps canonical homes to their exact app and URI schemes", () => {
    expect(desktopTargetForHome("/Users/x/.growth-os")).toEqual({
      appName: "Infinite",
      scheme: "infinite",
      variant: "prod"
    });
    expect(desktopTargetForHome("/Users/x/.growth-os-dev6")).toEqual({
      appName: "Infinite Dev 6",
      scheme: "infinite-dev-6",
      variant: "dev6"
    });
    expect(desktopTargetForHome("/Users/x/.growth-os-clean")).toEqual({
      appName: "Infinite Clean",
      scheme: "infinite-clean",
      variant: "clean"
    });
  });

  it("does not invent an unregistered numbered Desktop scheme", () => {
    expect(desktopTargetForHome("/Users/x/.growth-os-dev1000")).toBeNull();
  });
});

describe("appNameForHome", () => {
  it("maps the prod home to Infinite", () => {
    expect(appNameForHome("/Users/x/.growth-os")).toBe("Infinite");
  });
  it("maps a dev-N home to its variant app", () => {
    expect(appNameForHome("/Users/x/.growth-os-dev2")).toBe("Infinite Dev 2");
  });
  it("returns null for a non-canonical home", () => {
    expect(appNameForHome("/Users/x/.growth-os-random")).toBeNull();
  });
  it("maps the bare dev home to instance 1 (no number)", () => {
    expect(appNameForHome("/Users/x/.growth-os-dev")).toBe("Infinite Dev");
  });
  it("maps the clean sandbox home", () => {
    expect(appNameForHome("/Users/x/.growth-os-clean")).toBe("Infinite Clean");
  });
  it("rejects dev0/dev1 — instance 1 is the BARE -dev home, numbered slots start at 2", () => {
    expect(appNameForHome("/Users/x/.growth-os-dev0")).toBeNull();
    expect(appNameForHome("/Users/x/.growth-os-dev1")).toBeNull();
  });
  it("rejects leading-zero dev homes — Desktop never creates padded homes", () => {
    // runtime-identity's parseDevInstance rejects "dev01"-style tokens, so no
    // such home ever exists; mapping it to an app would launch the WRONG app.
    expect(appNameForHome("/Users/x/.growth-os-dev02")).toBeNull();
  });
  it("supports dev instances beyond the enumerated manifest (pattern, not a cap)", () => {
    expect(appNameForHome("/Users/x/.growth-os-dev12")).toBe("Infinite Dev 12");
  });
});

describe("CANONICAL_HOMES", () => {
  it("enumerates prod, dev instance 1, and clean", () => {
    const byVariant = new Map(CANONICAL_HOMES.map((e) => [e.variant, e]));
    expect(byVariant.get("prod")).toMatchObject({
      home: ".growth-os",
      appName: "Infinite"
    });
    expect(byVariant.get("dev")).toMatchObject({
      home: ".growth-os-dev",
      appName: "Infinite Dev"
    });
    expect(byVariant.get("clean")).toMatchObject({
      home: ".growth-os-clean",
      appName: "Infinite Clean"
    });
  });
  it("every manifest entry round-trips through appNameForHome", () => {
    for (const entry of CANONICAL_HOMES) {
      expect(appNameForHome(`/Users/x/${entry.home}`)).toBe(entry.appName);
    }
  });
});
