import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const ciDir = join(repoRoot, "scripts", "ci");
const read = (name: string) => readFileSync(join(ciDir, name), "utf8");

describe("repo-tripwire public email allowlist", () => {
  it("allows public Infinite and GitHub noreply commit metadata only", () => {
    const match = read("public-email-allowlist.sh").match(/PUBLIC_EMAIL_ALLOWLIST_ERE='([^']+)'/);
    expect(match).not.toBeNull();

    const allowlist = new RegExp(match![1], "i");
    expect("support@infinite.fast").toMatch(allowlist);
    expect("123456+agent@users.noreply.github.com").toMatch(allowlist);
    expect("noreply@github.com").toMatch(allowlist);
    expect("founder@example.com").not.toMatch(allowlist);
  });

  it("is the one rule both the CI tripwire and the pre-push gate read", () => {
    for (const script of ["repo-tripwire.sh", "check-push-emails.sh"]) {
      const source = read(script);
      expect(source).toContain("public-email-allowlist.sh");
      expect(source).toContain('grep -viE "$PUBLIC_EMAIL_ALLOWLIST_ERE"');
      expect(source).not.toContain("noreply\\.github\\.com");
    }
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    expect(hook).toContain("scripts/ci/check-push-emails.sh");
  });
});

describe("pre-push email gate (check-push-emails.sh)", () => {
  const ZERO = "0".repeat(40);
  const OK = "123456+agent@users.noreply.github.com";
  const BAD = "founder@example.com";
  let repo: string;

  const git = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env }
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  const commit = (message: string, author: string, committer = author) => {
    git(["commit", "-q", "--allow-empty", "-m", message], {
      GIT_AUTHOR_NAME: "a",
      GIT_AUTHOR_EMAIL: author,
      GIT_COMMITTER_NAME: "c",
      GIT_COMMITTER_EMAIL: committer
    });
    return git(["rev-parse", "HEAD"]);
  };

  const prePush = (localSha: string, remoteSha: string) =>
    spawnSync("bash", [join(ciDir, "check-push-emails.sh")], {
      cwd: repo,
      encoding: "utf8",
      input: `refs/heads/topic ${localSha} refs/heads/topic ${remoteSha}\n`,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
    });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "push-email-gate-"));
    git(["init", "-q"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("refuses a new branch carrying a non-public author email and names the commit", () => {
    const base = commit("base", OK);
    git(["update-ref", "refs/remotes/origin/main", base]);
    const bad = commit("leak", BAD);

    const result = prePush(bad, ZERO);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(bad.slice(0, 7));
    expect(result.stderr).toContain(`author=${BAD}`);
    expect(result.stderr).toContain("--reset-author");
  });

  it("refuses a non-public committer even when the author is public", () => {
    const base = commit("base", OK);
    git(["update-ref", "refs/remotes/origin/main", base]);
    const bad = commit("rebased by a personal identity", OK, BAD);

    const result = prePush(bad, ZERO);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`committer=${BAD}`);
  });

  it("checks only the pushed commits, not history the remote already has", () => {
    const old = commit("already public", BAD);
    git(["update-ref", "refs/remotes/origin/main", old]);
    const fresh = commit("new work", OK);

    expect(prePush(fresh, ZERO).status).toBe(0);
    expect(prePush(fresh, old).status).toBe(0);
  });

  it("starts at the remote tip when git has it, else at every remote-tracking ref", () => {
    const old = commit("already on the pushed-to branch", BAD);
    const fresh = commit("new work", OK);

    expect(prePush(fresh, old).status).toBe(0);
    // A new branch, or a remote tip never fetched, is checked against the
    // remote-tracking refs, and none of them has `old` here.
    expect(prePush(fresh, ZERO).status).toBe(1);
    expect(prePush(fresh, "deadbeef".repeat(5)).status).toBe(1);
  });

  it("refuses a bad commit in an update of an existing branch", () => {
    const base = commit("base", OK);
    git(["update-ref", "refs/remotes/origin/main", base]);
    const bad = commit("leak", BAD);
    const tip = commit("later", OK);

    const result = prePush(tip, base);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(bad.slice(0, 7));
    expect(result.stderr).not.toContain(tip.slice(0, 7) + "  author");
  });

  it("refuses an annotated tag whose tagger email is not public", () => {
    const base = commit("base", OK);
    git(["update-ref", "refs/remotes/origin/main", base]);
    const tag = (name: string, tagger: string) => {
      git(["tag", "-a", name, "-m", name, base], { GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: tagger });
      return git(["rev-parse", name]);
    };
    const run = (name: string, sha: string) =>
      spawnSync("bash", [join(ciDir, "check-push-emails.sh")], {
        cwd: repo,
        encoding: "utf8",
        input: `refs/tags/${name} ${sha} refs/tags/${name} ${ZERO}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
      });

    const bad = run("v-bad", tag("v-bad", BAD));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(`tagger=${BAD}`);
    expect(run("v-ok", tag("v-ok", OK)).status).toBe(0);
  });

  it("lets a branch deletion through", () => {
    commit("base", BAD);
    expect(prePush(ZERO, git(["rev-parse", "HEAD"])).status).toBe(0);
  });
});

describe("CI email check on a pull request (repo-tripwire.sh check 6)", () => {
  const OK = "123456+agent@users.noreply.github.com";
  const BAD = "founder@example.com";
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  let root: string;

  const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...gitEnv, ...env } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const as = (email: string, committer = email) => ({
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "c",
    GIT_COMMITTER_EMAIL: committer
  });
  const tripwire = (cwd: string) =>
    spawnSync("bash", [join(ciDir, "repo-tripwire.sh")], {
      cwd,
      encoding: "utf8",
      // A canary list that matches nothing in the test repo: this group tests the email check, and CI now fails
      // the canary check when the list is missing (covered below).
      env: { ...gitEnv, PUBLIC_SURFACE: "1", IP_CANARIES: "a-canary-never-found-in-a-test-repo" }
    });

  // The shape GitHub checks out for a pull_request run: a synthetic merge of
  // the PR head into main, authored by the PR opener's noreply address and
  // committed by noreply@github.com. The PR's first commit has `prEmail`; its
  // tip is clean, as on #90.
  const prMergeRepo = (prEmail: string) => {
    const repo = join(root, `repo-${prEmail.split("@")[0].replace(/\W/g, "")}`);
    git(root, ["init", "-q", repo]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "main"], as(OK));
    const base = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "pr: first"], as(prEmail));
    git(repo, ["commit", "-q", "--allow-empty", "-m", "pr: clean tip"], as(OK));
    const head = git(repo, ["rev-parse", "HEAD"]);
    const merge = git(
      repo,
      ["commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "Merge PR into main"],
      as(OK, "noreply@github.com")
    );
    git(repo, ["reset", "-q", "--hard", merge]);
    return repo;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tripwire-pr-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("CI checks out full history", () => {
    const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0\n/);
  });

  it("fails on a PR whose earlier commit has a non-public email, and names it", () => {
    const repo = prMergeRepo(BAD);
    const bad = git(repo, ["rev-parse", "--short", "HEAD^2^"]);

    const result = tripwire(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${bad}  author=${BAD}`);
  });

  it("passes on a PR whose commits are all public", () => {
    expect(tripwire(prMergeRepo(OK)).status).toBe(0);
  });

  it("fails on a shallow clone instead of passing on the merge commit alone", () => {
    const repo = prMergeRepo(OK);
    const shallow = join(root, "shallow");
    git(root, ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);

    const result = tripwire(shallow);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shallow clone");
  });
});

describe("canary list in CI (repo-tripwire.sh check 3)", () => {
  const run = (env: Record<string, string>) =>
    spawnSync("bash", [join(ciDir, "repo-tripwire.sh")], {
      cwd: join(ciDir, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PUBLIC_SURFACE: "1", ...env }
    });

  it("fails in this repo's CI when IP_CANARIES is missing (it skipped silently on every run before 2026-10-04)", () => {
    const result = run({ CI: "true", IS_FORK_PR: "false", IP_CANARIES: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("IP_CANARIES is not set in CI");
  });

  it("skips with a warning on a fork PR and on a local run, where the secret never arrives", () => {
    for (const env of [{ CI: "true", IS_FORK_PR: "true", IP_CANARIES: "" }, { CI: "", IS_FORK_PR: "", IP_CANARIES: "" }]) {
      const result = run(env);
      expect(result.stderr).not.toContain("IP_CANARIES is not set in CI");
      expect(result.stdout).toContain("IP canary check skipped");
    }
  });
});
