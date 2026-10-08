import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  detectPackageManager
} from "./package-manager.js";

const tempRoots: string[] = [];

function makeWorkspace(lockfiles: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "instrument-package-manager-"));
  tempRoots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  for (const filename of lockfiles) {
    writeFileSync(join(root, filename), "");
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("detectPackageManager", () => {
  it("prefers pnpm when only pnpm-lock.yaml is present", () => {
    const root = makeWorkspace(["pnpm-lock.yaml"]);

    expect(detectPackageManager(root)).toMatchObject({
      kind: "pnpm",
      reason: "lockfile",
      lockfiles: ["pnpm-lock.yaml"]
    });
  });

  it("reports an ambiguous result when multiple lockfiles exist", () => {
    const root = makeWorkspace(["pnpm-lock.yaml", "package-lock.json"]);

    expect(detectPackageManager(root)).toMatchObject({
      kind: "ambiguous",
      reason: "multiple-lockfiles",
      lockfiles: ["pnpm-lock.yaml", "package-lock.json"]
    });
  });

  it("reports unknown when no supported lockfile exists", () => {
    const root = makeWorkspace([]);

    expect(detectPackageManager(root)).toMatchObject({
      kind: "unknown",
      reason: "no-lockfile",
      lockfiles: []
    });
  });
});

