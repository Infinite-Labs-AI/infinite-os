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

  // 2026-10-16: the Mac download sits behind sign-up (infinite.fast/download serves the app only to a browser
  // that just signed up), so the installer opens the sign-up page instead of downloading a DMG. Behaviour is
  // proven end to end by scripts/ci/install-smoke.sh; these pin the contract in the source.
  it("opens the sign-up page and never downloads or installs anything itself", () => {
    expect(script).toContain(
      'SIGNUP_URL="https://infinite.fast/get-started?cta=cli&utm_source=${UTM_SOURCE}&utm_medium=cli&utm_campaign=infinite_os_install"'
    );
    expect(script).toContain('printf "Sign up to download Infinite: opening infinite.fast/get-started…\\n"');
    expect(script).toContain('open "$SIGNUP_URL"');
    expect(script).toContain('printf "Sign up to download Infinite: %s\\n" "$SIGNUP_URL"');
    expect(script).toContain(`INSTALLER_VERSION="${installerVersion}"`);
    expect(bundledInstaller).toBe(script);
    expect(script).not.toMatch(/\bcurl\b|hdiutil|codesign|spctl|ditto|Infinite-Installer|DMG_PATH/);
    expect(script).not.toMatch(/https:\/\/infinite\.fast\/download/);
  });

  it("classifies the npm caller before Bash stdin turns into the installer pipe", () => {
    expect(script).toContain("INFINITE_INSTALL_INTERACTIVE");
    expect(script).toContain('case "${INFINITE_INSTALL_INTERACTIVE:-}" in');
    expect(script).toContain("INTERACTIVE_OUTPUT=true");
    expect(script).toContain("INTERACTIVE_OUTPUT=false");
    expect(script).toContain('[ "$INTERACTIVE_OUTPUT" = true ] || OPEN_BROWSER=false');
    expect(script).toContain('[ -t 0 ] && [ -t 1 ] && [ -t 2 ]');
  });

  it("attributes the npm and GitHub entry points, and keeps --app-dir / --no-open / --help", () => {
    expect(script).toContain('npm) UTM_SOURCE="npm" ;;');
    expect(script).toContain('*) UTM_SOURCE="github" ;;');
    expect(script).toContain("--app-dir PATH");
    expect(script).toContain("--no-open) OPEN_BROWSER=false; shift ;;");
    expect(script).toContain("Infinite for macOS installer");
  });

  it("leaves an installed app alone so the npm wrapper can start its bundled CLI", () => {
    expect(script).toContain('if [ -d "$APP_DIR/Infinite.app" ] && [ ! -L "$APP_DIR/Infinite.app" ]; then');
    expect(script).toContain("Infinite is already installed at");
    expect(script).not.toMatch(/trial|self[- ]host|infinite local|local engine|Docker|docker/i);
  });

  it("documents npx as the sole customer install command in public repo surfaces", () => {
    const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const installSection = markdownSection(rootReadme, "## Install Infinite");
    const commandBlocks = [
      ...installSection.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)
    ].map((match) => match[1].trim());

    expect(commandBlocks).toEqual(["npx infinite-os@latest"]);
    expect(installSection).toContain(
      "[sign up and download the signed app in your browser](https://infinite.fast/get-started)"
    );
    expect(installSection).not.toContain("infinite.fast/download");
    expect(installSection).toMatch(/signed(?:\s+and\s+notarized)?\s+(?:Mac|macOS|Desktop)/i);
    expect(installSection).toContain("infinite-os@1.0.2");
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
    expect(readme).toContain("infinite-os@1.0.2");
    expect(readme).toContain("https://infinite.fast/get-started");
    expect(readme).toContain("not promised by `@latest`");
    expect(readme).not.toContain("open 'infinite://onboarding'");
    expect(readme).toContain("Press `⌘L`");
    expect(readme).toContain('Run `infinite "…"`');
    expect(readme).toContain("Same account. Same workspace. Same agent.");
    expect(readme).not.toMatch(/trial|Docker|docker|self[- ]host|local engine|infinite local|npm install infinite/);
  });
});
