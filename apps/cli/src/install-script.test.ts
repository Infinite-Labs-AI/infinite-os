import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const installShPath = join(repoRoot, "scripts", "install.sh");

describe("scripts/install.sh (Infinite Desktop installer)", () => {
  const script = readFileSync(installShPath, "utf8");

  it("downloads the canonical Desktop product through an analytics-counted GET", () => {
    expect(script).toContain('DOWNLOAD_URL="https://infinite.fast/download"');
    expect(script).toContain('--user-agent "$INSTALLER_USER_AGENT" --output "$DMG_PATH" "$DOWNLOAD_REQUEST_URL"');
    expect(script).toContain('INSTALLER_USER_AGENT="Infinite-Installer/1.0.0"');
    expect(script).not.toMatch(/curl[^\n]+(?:--head|\s-I(?:\s|$))/);
  });

  it("is macOS-only and does not bootstrap the retired Docker lane", () => {
    expect(script).toContain('OS="$(uname -s)"');
    expect(script).toContain('if [ "$OS" != "Darwin" ]');
    expect(script).not.toContain("Linux)");
    expect(script).not.toContain("docker");
    expect(script).not.toContain("infinite local setup");
  });

  it("verifies the signed, notarized production app identity before installing", () => {
    expect(script).toContain('EXPECTED_BUNDLE_ID="inc.ultima.infiniteos-desktop"');
    expect(script).toContain('EXPECTED_TEAM_ID="4659K3678P"');
    expect(script).toMatch(/codesign.*--verify.*--deep.*--strict/);
    expect(script).toMatch(/spctl.*--assess.*--type execute/);
  });

  it("only migrates the legacy installer-owned CLI wrapper", () => {
    expect(script).toContain("# Infinite launcher shim — installed by scripts/install.sh.");
    expect(script).toContain("legacy-installer");
    expect(script).toContain("preserving it");
  });
});

describe("infinite-os npm bootstrap package", () => {
  const packageRoot = join(repoRoot, "packages", "desktop-installer");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    files: string[];
    engines: { node: string };
  };
  const bin = readFileSync(join(packageRoot, packageJson.bin["infinite-os"]), "utf8");
  const bundledInstaller = readFileSync(join(packageRoot, "install.sh"), "utf8");
  const canonicalInstaller = readFileSync(installShPath, "utf8");

  it("repurposes infinite-os at v1 with a single npx entrypoint", () => {
    expect(packageJson.name).toBe("infinite-os");
    expect(packageJson.version).toBe("1.0.0");
    expect(packageJson.bin).toEqual({ "infinite-os": "bin/infinite-os.mjs" });
    expect(packageJson.files).toEqual(["bin", "README.md", "install.sh", "LICENSE"]);
    expect(packageJson.engines.node).toBe(">=18.0.0");
  });

  it("runs the reviewed installer bundled in the npm artifact", () => {
    expect(bin).toContain('new URL("../install.sh", import.meta.url)');
    expect(bin).not.toContain("raw.githubusercontent.com");
    expect(bin).not.toContain("fetch(");
    expect(bin).toContain("spawnSync");
    expect(bundledInstaller).toBe(canonicalInstaller);
  });
});
