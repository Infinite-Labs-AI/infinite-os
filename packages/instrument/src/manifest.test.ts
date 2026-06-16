import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { InstallManifest } from "./types.js";
import {
  readInstallManifest,
  writeInstallManifest
} from "./manifest.js";

const tempRoots: string[] = [];

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "instrument-manifest-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("install manifest", () => {
  it("round-trips non-secret install state through .infinite/install.json", async () => {
    const root = makeWorkspace();
    const manifest: InstallManifest = {
      workspaceId: "ws_123",
      appRoot: "apps/web",
      framework: "vite-react",
      providers: ["ga4", "posthog"],
      files: ["src/main.tsx", "src/lib/analytics.ts"],
      envKeys: ["VITE_GA4_MEASUREMENT_ID", "VITE_POSTHOG_KEY"],
      contentHashes: {
        "src/main.tsx": "abc123"
      },
      wiringVersion: 1,
      verifiedAt: null
    };

    const manifestPath = await writeInstallManifest(root, manifest);
    const diskJson = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(diskJson).toMatchObject(manifest);
    expect(readInstallManifest(root)).toEqual(manifest);
  });
});

describe("corrupt install manifests", () => {
  it("throws a clear error when the manifest is not valid JSON", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), "{ not json")

    expect(() => readInstallManifest(root)).toThrow(
      "Corrupt .infinite/install.json — cannot parse manifest. Remove it manually to reset."
    )
  })

  it("throws a clear error when the manifest parses but is not a manifest object", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify([1, 2, 3]))

    expect(() => readInstallManifest(root)).toThrow(
      "Corrupt .infinite/install.json — manifest is missing expected fields. Remove it manually to reset."
    )
  })

  it("throws a clear error when expected manifest keys are missing", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, ".infinite"), { recursive: true })
    writeFileSync(join(root, ".infinite/install.json"), JSON.stringify({ workspaceId: "ws_123" }))

    expect(() => readInstallManifest(root)).toThrow(/missing expected fields/)
  })
})

describe("manifest write safety", () => {
  it("refuses to write the manifest through a symlink", () => {
    const root = makeWorkspace()
    mkdirSync(join(root, ".infinite"), { recursive: true })
    const decoyPath = join(root, "decoy.json")
    writeFileSync(decoyPath, "{}\n")
    symlinkSync(decoyPath, join(root, ".infinite/install.json"))

    const manifest: InstallManifest = {
      workspaceId: "ws_123",
      appRoot: ".",
      framework: "static-html",
      providers: ["ga4"],
      files: ["index.html"],
      envKeys: [],
      contentHashes: {},
      wiringVersion: 1,
      verifiedAt: null
    }

    expect(() => writeInstallManifest(root, manifest)).toThrow(/symlink/)
    expect(readFileSync(decoyPath, "utf8")).toBe("{}\n")
  })
})
