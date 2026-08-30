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
    expect(script).toContain('--user-agent "$INSTALLER_USER_AGENT"');
    expect(script).toContain('--output "$DMG_PATH" "$DOWNLOAD_REQUEST_URL"');
    expect(script).toContain('INSTALLER_USER_AGENT="Infinite-Installer/1.0.1"');
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
    expect(script).toContain('hdiutil verify "$DMG_PATH"');
    expect(script).toContain("--proto '=https'");
    expect(script).toContain("--proto-redir '=https'");
  });

  it("only migrates the legacy installer-owned CLI wrapper", () => {
    expect(script).toContain("# Infinite launcher shim — installed by scripts/install.sh.");
    expect(script).toContain("legacy installer-owned");
    expect(script).toContain("preserving it");
  });

  it("upgrades only older verified apps with no-clobber commit and rollback", () => {
    expect(script).toContain('MIN_SAFE_DESKTOP_VERSION="');
    expect(script).toContain("CFBundleShortVersionString");
    expect(script).toContain('mv -n "$STAGED_APP" "$APP_DIR/"');
    expect(script).toContain("rollback_upgrade");
    expect(script).toContain("quit_running_infinite_apps");
    expect(script).toContain("Contents/Resources/daemon/daemon.mjs");
    expect(script).toContain('if [ "$UPGRADE" = true ]; then quit_running_infinite_apps; fi');
  });

  it("rejects source and destination symlinks and cleans up on every terminating signal", () => {
    expect(script).toContain('[ -L "$SOURCE_APP" ]');
    expect(script).toContain('[ -L "$TARGET_APP" ]');
    expect(script).toContain("trap 'exit 129' HUP");
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 143' TERM");
  });

  it("does not advertise command installers while the patch release is staged", () => {
    const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(rootReadme).not.toContain("npx infinite-os@latest");
    expect(rootReadme).not.toContain("raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/");
    expect(rootReadme).not.toContain("raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main");
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
    expect(packageJson.version).toBe("1.0.1");
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

  it("only publishes from main and runs the tarball test in both release gates", () => {
    const publishWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "publish-infinite-os.yml"),
      "utf8",
    );
    const ciWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    expect(publishWorkflow).toContain("github.ref != 'refs/heads/main'");
    expect(publishWorkflow).toContain(
      "packages/desktop-installer/package-tarball.test.ts",
    );
    expect(ciWorkflow).toContain("packages/desktop-installer");
  });
});
