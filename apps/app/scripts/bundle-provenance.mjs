import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createBundleProvenance({
  daemonPath,
  appRoot,
  builtAt = new Date().toISOString(),
  runGit = (args) =>
    execFileSync("git", args, { cwd: appRoot, encoding: "utf8" }).trim()
}) {
  const bundleSha256 = sha256File(daemonPath);
  try {
    return {
      engineCommit: runGit(["rev-parse", "HEAD"]),
      engineBranch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      engineDirty: runGit(["status", "--porcelain"]).length > 0,
      bundleSha256,
      builtAt
    };
  } catch {
    return {
      engineCommit: "unknown",
      engineDirty: true,
      bundleSha256,
      builtAt
    };
  }
}
