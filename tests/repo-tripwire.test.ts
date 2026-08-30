import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const tripwire = readFileSync(join(repoRoot, "scripts", "ci", "repo-tripwire.sh"), "utf8");

describe("repo-tripwire public email allowlist", () => {
  it("allows public Infinite and GitHub noreply commit metadata only", () => {
    const match = tripwire.match(/grep -viE '([^']+)'/);
    expect(match).not.toBeNull();

    const allowlist = new RegExp(match![1], "i");
    expect("support@infinite.fast").toMatch(allowlist);
    expect("123456+agent@users.noreply.github.com").toMatch(allowlist);
    expect("noreply@github.com").toMatch(allowlist);
    expect("founder@example.com").not.toMatch(allowlist);
  });
});
