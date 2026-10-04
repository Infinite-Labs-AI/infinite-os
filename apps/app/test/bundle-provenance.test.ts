import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const helperPath = fileURLToPath(
  new URL("../scripts/bundle-provenance.mjs", import.meta.url)
);

describe("daemon bundle provenance", () => {
  it("binds BUILD_INFO to the exact daemon bytes with lowercase SHA-256", async () => {
    expect(
      await import("node:fs/promises").then(({ access }) =>
        access(helperPath).then(
          () => true,
          () => false
        )
      )
    ).toBe(true);

    const { createBundleProvenance, sha256File } = (await import(
      pathToFileURL(helperPath).href
    )) as {
      createBundleProvenance: (options: {
        daemonPath: string;
        appRoot: string;
        builtAt: string;
        runGit: (args: string[]) => string;
      }) => Record<string, unknown>;
      sha256File: (path: string) => string;
    };
    const directory = mkdtempSync(
      join(tmpdir(), "infinite-bundle-provenance-")
    );
    try {
      const daemonPath = join(directory, "daemon.mjs");
      writeFileSync(daemonPath, "daemon bytes\n", "utf8");

      expect(sha256File(daemonPath)).toBe(
        "a4c63f9564fe883b0f31687c087774e857ae6bf03951847c8aa566ea79fa4b55"
      );
      const runGit = vi.fn((args: string[]) => {
        if (args.join(" ") === "rev-parse HEAD") return "a".repeat(40);
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
          return "feature/provenance";
        }
        if (args.join(" ") === "status --porcelain") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      });
      expect(
        createBundleProvenance({
          daemonPath,
          appRoot: directory,
          builtAt: "2026-07-31T00:00:00.000Z",
          runGit
        })
      ).toEqual({
        engineCommit: "a".repeat(40),
        engineBranch: "feature/provenance",
        engineDirty: false,
        bundleSha256:
          "a4c63f9564fe883b0f31687c087774e857ae6bf03951847c8aa566ea79fa4b55",
        builtAt: "2026-07-31T00:00:00.000Z"
      });
      expect(runGit).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stamps unknown and dirty when Git provenance cannot be established", async () => {
    const { createBundleProvenance } = (await import(
      pathToFileURL(helperPath).href
    )) as {
      createBundleProvenance: (options: {
        daemonPath: string;
        appRoot: string;
        builtAt: string;
        runGit: () => string;
      }) => Record<string, unknown>;
    };
    const directory = mkdtempSync(
      join(tmpdir(), "infinite-bundle-provenance-")
    );
    try {
      const daemonPath = join(directory, "daemon.mjs");
      writeFileSync(daemonPath, "daemon bytes\n", "utf8");

      expect(
        createBundleProvenance({
          daemonPath,
          appRoot: directory,
          builtAt: "2026-07-31T00:00:00.000Z",
          runGit: () => {
            throw new Error("git unavailable");
          }
        })
      ).toEqual({
        engineCommit: "unknown",
        engineDirty: true,
        bundleSha256:
          "a4c63f9564fe883b0f31687c087774e857ae6bf03951847c8aa566ea79fa4b55",
        builtAt: "2026-07-31T00:00:00.000Z"
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
