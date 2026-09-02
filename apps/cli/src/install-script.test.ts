import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const installShPath = join(repoRoot, "scripts", "install.sh");
const packageRoot = join(repoRoot, "packages", "desktop-installer");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
};
const installerVersion = packageJson.version;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownSection(markdown: string, heading: string): string {
  const header = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m").exec(markdown);
  if (!header) {
    throw new Error(`Missing markdown section: ${heading}`);
  }

  const bodyStart = header.index + header[0].length;
  const rest = markdown.slice(bodyStart);
  const nextHeader = /^##\s+/m.exec(rest);
  return nextHeader ? rest.slice(0, nextHeader.index) : rest;
}

describe("scripts/install.sh (Infinite Desktop installer)", () => {
  const script = readFileSync(installShPath, "utf8");
  const bundledInstaller = readFileSync(join(packageRoot, "install.sh"), "utf8");

  it("downloads the canonical Desktop product through an analytics-counted GET", () => {
    expect(script).toContain('DOWNLOAD_URL="https://infinite.fast/download"');
    expect(script).toContain(`INSTALLER_VERSION="${installerVersion}"`);
    expect(script).toContain('INSTALLER_USER_AGENT="Infinite-Installer/${INSTALLER_VERSION}"');
    expect(script).toContain('--user-agent "$INSTALLER_USER_AGENT"');
    expect(script).toContain('--output "$DMG_PATH" "$DOWNLOAD_REQUEST_URL"');
    expect(script).toContain('INFINITE_ONBOARDING_URI="infinite://onboarding"');
    expect(bundledInstaller).toBe(script);
    expect(script).not.toMatch(/curl[^\n]+(?:--head|\s-I(?:\s|$))/);
    expect(script).not.toMatch(/Content-Length|content-length|sleep[^\n]+%/i);
  });

  it("classifies the npm caller before Bash stdin turns into the installer pipe", () => {
    expect(script).toContain("INFINITE_INSTALL_INTERACTIVE");
    expect(script).toContain('case "${INFINITE_INSTALL_INTERACTIVE:-}" in');
    expect(script).toContain("INTERACTIVE_OUTPUT=true");
    expect(script).toContain("INTERACTIVE_OUTPUT=false");
    expect(script).toContain('OPEN_APP=false');
    expect(script).toContain('[ -t 0 ] && [ -t 1 ] && [ -t 2 ]');
  });

  it("shows truthful download education, receipts, and the exact onboarding handoff", () => {
    expect(script).toContain("print_download_education()");
    expect(script).toContain("While Infinite downloads");
    expect(script).toContain("Tell Infinite about your business");
    expect(script).toContain("Sign in with an email code");
    expect(script).toContain("Create or connect your workspace");
    expect(script).toContain("Connect Codex or Claude");
    expect(script).toContain('APP       Press ⌘L');
    expect(script).toContain('TERMINAL  Run infinite "…"');
    expect(script).toContain("Same account. Same workspace. Same agent.");
    expect(script).toContain("download_release()");
    expect(script).toContain('log_success "Download complete"');
    expect(script).toContain('log_success "Apple signature verified"');
    expect(script).toContain('log_success "Notarization verified"');
    expect(script).toContain('log_success "Infinite installed in Applications"');
    expect(script).toContain("supports_osc8()");
    expect(script).toContain("print_onboarding_handoff()");
    expect(script).toContain("Finish setup in the Infinite app");
    expect(script).toContain("Open Infinite");
    expect(script).toContain("Opening Infinite automatically");
    expect(script).toContain("Open it when you are ready.");
    expect(script).toContain("open 'infinite://onboarding'");
    expect(script).toContain('open -a "$TARGET_APP" "$INFINITE_ONBOARDING_URI"');
    expect(script).not.toMatch(/trial|self[- ]host|infinite local|local engine|Docker/i);
  });

  it("keeps interactive progress on the foreground GET and non-interactive output quiet", () => {
    expect(script).toMatch(/if \[ "\$INTERACTIVE_OUTPUT" = true \]; then[\s\S]*curl --fail --location --retry 3/);
    expect(script).toMatch(/else[\s\S]*curl --fail --location --silent --show-error --retry 3/);
    expect(script).not.toContain("& curl");
    expect(script).not.toContain("curl &");
  });

  it("is macOS-only and does not bootstrap the retired Docker lane", () => {
    expect(script).toContain('OS="$(uname -s)"');
    expect(script).toContain('if [ "$OS" != "Darwin" ]');
    expect(script).not.toContain("Linux)");
    expect(script).not.toContain("docker");
    expect(script).not.toContain("infinite local setup");
  });

  it("verifies the signed, notarized production app identity before installing", () => {
    expect(script).toContain(
      'EXPECTED_BUNDLE_ID="inc.ultima.infiniteos-desktop"'
    );
    expect(script).toContain('EXPECTED_TEAM_ID="4659K3678P"');
    expect(script).toMatch(/codesign.*--verify.*--deep.*--strict/);
    expect(script).toMatch(/spctl.*--assess.*--type execute/);
    expect(script).toContain('hdiutil verify "$DMG_PATH"');
    expect(script).toContain("--proto '=https'");
    expect(script).toContain("--proto-redir '=https'");
  });

  it("only migrates the legacy installer-owned CLI wrapper", () => {
    expect(script).toContain(
      "# Infinite launcher shim — installed by scripts/install.sh."
    );
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
    expect(script).toContain(
      'if [ "$UPGRADE" = true ]; then quit_running_infinite_apps; fi'
    );
  });

  it("rejects source and destination symlinks and cleans up on every terminating signal", () => {
    expect(script).toContain('[ -L "$SOURCE_APP" ]');
    expect(script).toContain('[ -L "$TARGET_APP" ]');
    expect(script).toContain("trap 'exit 129' HUP");
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 143' TERM");
  });

  it("documents npx as the sole customer install command in public repo surfaces", () => {
    const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const installSection = markdownSection(rootReadme, "## Install Infinite");
    const commandBlocks = [
      ...installSection.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)
    ].map((match) => match[1].trim());

    expect(commandBlocks).toEqual(["npx infinite-os@latest"]);
    expect(installSection).toContain(
      "[download the signed DMG directly](https://infinite.fast/download)"
    );
    expect(installSection).toMatch(/signed(?:\s+and\s+notarized)?\s+(?:Mac|macOS|Desktop)/i);
    expect(installSection).toContain("infinite-os@1.0.1");
    expect(installSection).toContain("release-gated");
    expect(installSection).not.toContain("then opens");
    expect(installSection).toMatch(/sign in/i);
    expect(installSection).toMatch(/setup|set up/i);
    expect(installSection).toMatch(/workspace/i);
    expect(installSection).toContain("⌘L");
    expect(installSection).toMatch(/Terminal/i);
    expect(installSection).toMatch(/`infinite(?: "[….]+"|`)/);
    expect(installSection).toContain("Same account. Same workspace. Same agent.");
    expect(installSection).not.toMatch(
      /curl\s+-fsSL|raw\.githubusercontent\.com|npm install infinite|infinite local|local engine|Docker|self[- ]host|trial/i
    );

    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const versioning = markdownSection(agents, "## Versioning & releases");
    expect(versioning).toContain("npx infinite-os@latest");
    expect(versioning).toMatch(/sole\s+customer\s+(?:install\s+)?command/i);
    expect(versioning).toMatch(/canonical internal shell/i);
    expect(versioning).toContain("scripts/install.sh");
    expect(versioning).toContain("packages/desktop-installer");
    expect(versioning).not.toMatch(
      /two installer entrypoints|two customer entrypoints|curl\s+-fsSL|raw\.githubusercontent\.com|npm install infinite/i
    );
  });
});

describe("infinite-os npm bootstrap package", () => {
  const bin = readFileSync(join(packageRoot, packageJson.bin["infinite-os"]), "utf8");
  const bundledInstaller = readFileSync(join(packageRoot, "install.sh"), "utf8");
  const canonicalInstaller = readFileSync(installShPath, "utf8");

  it("repurposes infinite-os at v1 with a single npx entrypoint", () => {
    expect(packageJson.name).toBe("infinite-os");
    expect(packageJson.version).toMatch(/^1\.\d+\.\d+$/);
    expect(packageJson.bin).toEqual({ "infinite-os": "bin/infinite-os.mjs" });
    expect(packageJson.files).toEqual([
      "bin",
      "README.md",
      "install.sh",
      "LICENSE"
    ]);
    expect(packageJson.engines.node).toBe(">=18.0.0");
    expect(packageJson).not.toHaveProperty("dependencies");
    expect(packageJson).not.toHaveProperty("scripts");
  });

  it("runs the reviewed installer bundled in the npm artifact", () => {
    expect(bin).toContain('new URL("../install.sh", import.meta.url)');
    expect(bin).not.toContain("raw.githubusercontent.com");
    expect(bin).not.toContain("fetch(");
    expect(bin).toContain("spawnSync");
    expect(bin).toContain("INFINITE_INSTALL_INTERACTIVE");
    expect(bin).toContain('INFINITE_INSTALL_SOURCE: "npm"');
    expect(bin).toContain('join(app, "Contents", "MacOS", "Infinite")');
    expect(bin).toContain(
      'join(app, "Contents", "Resources", "cli", "infinite.mjs")'
    );
    expect(bin).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(bin).toContain("await startCli");
    expect(bin).toContain("shouldStartEmbeddedCli");
    expect(bin).toContain("resolveAppDirectory");
    expect(bin).toContain("npx infinite-os@latest");
    expect(bin).not.toMatch(/https?:\/\//);
    expect(bin).not.toMatch(
      /\bDOWNLOAD_URL\b|hdiutil|codesign|spctl|notarytool/
    );
    expect(bundledInstaller).toBe(canonicalInstaller);
  });

  it("only publishes from main and runs the tarball test in both release gates", () => {
    const publishWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "publish-infinite-os.yml"),
      "utf8"
    );
    const ciWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "ci.yml"),
      "utf8"
    );
    expect(publishWorkflow).toContain("github.ref != 'refs/heads/main'");
    expect(publishWorkflow).toContain(
      "packages/desktop-installer/npm-wrapper.test.ts"
    );
    expect(publishWorkflow).toContain(
      "packages/desktop-installer/package-tarball.test.ts"
    );
    expect(ciWorkflow).toContain("packages/desktop-installer");
  });

  it("published installer smoke verifies the immutable npm artifact, not mutable main", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "published-installer-smoke.yml"),
      "utf8"
    );

    expect(workflow).toContain("scripts/ci/verify-published-infinite-os.mjs");
    expect(workflow).not.toContain(
      "raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh"
    );
    expect(workflow).not.toContain('Infinite-Installer/1.0.1');
  });

  it("documents setup through the app without trial, local-engine, or Docker fallback copy", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    expect(readme).toContain("npx infinite-os@latest");
    expect(readme).toContain(`infinite-os@${installerVersion}`);
    expect(readme).toContain("Desktop v0.3.20");
    expect(readme).toMatch(/must\s+not be published/);
    expect(readme).toContain("not live in `@latest`");
    expect(readme).toContain("Press `⌘L`");
    expect(readme).toContain('Run `infinite "…"`');
    expect(readme).toContain("Same account. Same workspace. Same agent.");
    expect(readme).not.toMatch(/trial|Docker|docker|self[- ]host|local engine|infinite local|npm install infinite/);
  });
});
