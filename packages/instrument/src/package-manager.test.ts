import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPackageManagerCommands,
  detectPackageManager
} from "./package-manager.js";

const tempRoots: string[] = [];
const instrumentPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as {
  name: string;
  version: string;
  private?: boolean;
};

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

describe("buildPackageManagerCommands", () => {
  it("matches the instrument package publishability for current one-off guidance", () => {
    const commands = buildPackageManagerCommands("pnpm", {
      pinnedVersion: instrumentPackage.version,
      workspaceId: "ws_test"
    });

    if (instrumentPackage.private) {
      expect(commands.oneOff).toContain("pnpm --dir ");
      expect(commands.oneOff).toContain("--filter infinite-tag build");
      expect(commands.oneOff).toContain("node ");
      expect(commands.oneOff).toContain("packages/instrument/dist/src/cli.js");
      expect(commands.oneOff).toContain("install --root");
      expect(commands.oneOff).toContain("--workspace ws_test");
      expect(commands.repeatableInstall).toBe(
        "After publishing infinite-tag, install it with: pnpm add -D infinite-tag@0.1.2"
      );
      expect(commands.repeatableRun).toBe(
        "After publishing infinite-tag, re-run it with: pnpm exec infinite-tag install --workspace ws_test"
      );
      return;
    }

    expect(commands).toMatchObject({
      packageManager: "pnpm",
      oneOff: "pnpm dlx infinite-tag@0.1.2 install --workspace ws_test",
      repeatableInstall: "pnpm add -D infinite-tag@0.1.2",
      repeatableRun: "pnpm exec infinite-tag install --workspace ws_test"
    });
  });

  it("keeps future package-manager-specific publish commands accurate", () => {
    const npmCommands = buildPackageManagerCommands("npm", {
      pinnedVersion: instrumentPackage.version,
      workspaceId: "ws_test"
    });
    const yarnCommands = buildPackageManagerCommands("yarn", {
      pinnedVersion: instrumentPackage.version,
      workspaceId: "ws_test"
    });
    const bunCommands = buildPackageManagerCommands("bun", {
      pinnedVersion: instrumentPackage.version,
      workspaceId: "ws_test"
    });

    if (instrumentPackage.private) {
      expect(npmCommands.repeatableInstall).toBe(
        "After publishing infinite-tag, install it with: npm install -D infinite-tag@0.1.2"
      );
      expect(yarnCommands.repeatableRun).toBe(
        "After publishing infinite-tag, re-run it with: yarn infinite-tag install --workspace ws_test"
      );
      expect(bunCommands.repeatableInstall).toBe(
        "After publishing infinite-tag, install it with: bun add -d infinite-tag@0.1.2"
      );
      return;
    }

    expect(npmCommands.oneOff).toBe(
      "npm exec infinite-tag@0.1.2 -- install --workspace ws_test"
    );
    expect(yarnCommands.repeatableRun).toBe(
      "yarn infinite-tag install --workspace ws_test"
    );
    expect(bunCommands.repeatableInstall).toBe(
      "bun add -d infinite-tag@0.1.2"
    );
  });
});
