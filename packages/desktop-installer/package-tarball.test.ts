import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "../..");
const validator = join(repoRoot, "scripts/ci/validate-infinite-os-pack.mjs");

describe("infinite-os npm artifact", () => {
  it("contains only the reviewed installer and runs its installed bin", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "infinite-os-package-"));
    try {
      const receiptText = execFileSync(
        "npm",
        ["pack", "--json", "--pack-destination", tempRoot],
        { cwd: packageRoot, encoding: "utf8" }
      );
      const receiptPath = join(tempRoot, "receipt.json");
      writeFileSync(receiptPath, receiptText);
      const receipt = JSON.parse(receiptText) as Array<{
        files: Array<{ path: string; mode?: number }>;
      }>;
      expect(receipt[0]?.files.map((file) => file.path)).toEqual([
        "LICENSE",
        "README.md",
        "bin/infinite-os.mjs",
        "install.sh",
        "package.json"
      ]);
      expect(
        receipt[0]?.files.find((file) => file.path === "bin/infinite-os.mjs")
          ?.mode
      ).toBe(0o755);
      expect(
        receipt[0]?.files.find((file) => file.path === "install.sh")?.mode
      ).toBe(0o755);

      const tarballName = execFileSync(
        process.execPath,
        [validator, receiptPath],
        {
          encoding: "utf8"
        }
      ).trim();
      const tarball = join(tempRoot, tarballName);
      expect(existsSync(tarball)).toBe(true);

      const extracted = join(tempRoot, "extracted");
      mkdirSync(extracted);
      execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
      expect(readFileSync(join(extracted, "package/install.sh"), "utf8")).toBe(
        readFileSync(join(repoRoot, "scripts/install.sh"), "utf8")
      );

      const consumer = join(tempRoot, "consumer");
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"consumer","private":true}\n'
      );
      execFileSync("npm", ["install", "--ignore-scripts", tarball], {
        cwd: consumer
      });
      const installedBin = join(consumer, "node_modules/.bin/infinite-os");
      expect(existsSync(installedBin)).toBe(true);
      expect(
        execFileSync(installedBin, ["--help"], { encoding: "utf8" })
      ).toContain("Infinite for macOS installer");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
