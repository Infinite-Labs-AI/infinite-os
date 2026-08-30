import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for the §6.6 namespacing: the self-host installer must bootstrap via
// `infinite local setup` — a bare `infinite setup` is now intercepted with
// "Use: infinite local setup" and would leave a fresh install unconfigured.
const here = dirname(fileURLToPath(import.meta.url));
const installShPath = join(here, "..", "..", "..", "scripts", "install.sh");

describe("scripts/install.sh (self-host bootstrap)", () => {
  const script = readFileSync(installShPath, "utf8");

  it("invokes and advertises `infinite local setup`", () => {
    expect(script).toContain("infinite local setup");
    // The actual invocation is namespaced too (both TTY branches).
    expect(script).toMatch(/"\$INSTALL_DIR\/infinite" local setup/);
  });

  it("never points at a bare top-level `infinite setup`", () => {
    // "infinite local setup" does not contain the substring "infinite setup",
    // so any hit is a stale un-namespaced pointer.
    expect(script).not.toContain("infinite setup");
    expect(script).not.toMatch(/"\$INSTALL_DIR\/infinite" setup/);
  });

  it("privately provisions the package-manager pin when pnpm is absent", () => {
    expect(script).toContain('PINNED_PNPM_VERSION="10.0.0"');
    expect(script).toContain('TOOLING_ROOT="$HOME/.infinite/tooling"');
    expect(script).toMatch(
      /npm install --global --prefix "\$TOOLING_ROOT" "pnpm@\$PINNED_PNPM_VERSION"/,
    );
    expect(script).not.toContain("npm install -g pnpm");
    expect(script).not.toContain("corepack enable pnpm");
  });

  it("opens the controlling terminal before selecting the interactive setup branch", () => {
    expect(script).toMatch(/can_open_controlling_tty\(\)/);
    expect(script).toMatch(/: < \/dev\/tty/);
    expect(script).not.toMatch(/elif \[ -r \/dev\/tty \]/);
  });

  it("puts private tooling on the installed launcher's PATH", () => {
    expect(script).toContain('export PATH="$TOOLING_BIN:$PATH"');
  });
});
