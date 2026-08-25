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
});
