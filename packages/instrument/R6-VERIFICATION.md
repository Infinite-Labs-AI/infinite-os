# Round 6 verification

## Founder ruling

The later founder ruling supersedes the original R6-1 structural-model design. Consent, banners,
CMP code, privacy policies and terms belong to the site owner. This patch deletes the structural
model, retains a strict consent-line/call-span hunk fence (including whitespace), and removes policy
editing and grading from jobs, planning, reviews and reports. It retains the recorded consent choice
and click-id capture reading the existing gate. The stronger review used the requested Astra model
with ultra reasoning. No customer repository or PR was changed or exercised by the wizard.

## Findings, changes and evidence

| Item | Reproduction | Change and verification |
| --- | --- | --- |
| R6-1 | Real `Fence.begin/end` probes on the original source accepted setTimeout wrapping, reorder below config and movement into an uncalled function. The block-bodied load callback probe already held; the expression-bodied variant is covered by the final regression. Original boundary probes also exposed missing shared-job claim warnings. | Removed structural exemptions. Changed consent lines and call-span lines, including indentation/quotes/reflow, are reverted per hunk. Ownership comes from runner events; unknown ownership warns all claimants. Consent-bearing guard files are conservatively left for the owner. Policy jobs/checks/questions are retired; workers/reviewers/README state the boundary. Fence, runner, owner-boundary, plan, report, review and offline wizard tests cover this. |
| R6-2 | Pending, cancelled, unreadable and absent base-green checks previously reached ready. A blocked hosting result could return before Actions registered. | A separate ready decision requires a green read for every base-green check and the registration grace period. Unresolved reads park the draft with a retry sentence. Tests cover each state, delayed Actions, blocked-but-base-green hosting, base-red checks and genuinely absent CI. |
| R6-3 | Baseline always used a detached tree; clean first runs lacked ignored environment files. Workspace/symlink probes exposed links back to edited source. | Clean base builds run in place. Changed trees clone dependencies, rebase and validate code/dependency links, and link ignored root/app environment files read-only. Marked dead baseline trees are swept and cleanup errors surface. Baseline, dependency and resume tests cover cleanup and unsafe links. A real Next 16.4.0/Turbopack fixture passed in place and detached; source environment writes were denied, original caches stayed unchanged, and only the source git worktree remained. |
| R6-4 | Stylish summaries introduced opaque count signatures; warning changes became new errors and duplicate diagnostics collapsed. | Ignore summaries/warnings, normalize fatal positions, count each identical diagnostic. Captured actual ESLint 8.57.1 and 9.39.4 outputs are fixtures. Signature format advances internally to v3; package version is unchanged. |
| R6-5 | Real pnpm 10 install recorded a temporary deleted store; a later normal add failed with unexpected-store. | Resolve a persistent cache with no credentials, pass it explicitly, retain sandbox protection of manifest/existing lock. Real pnpm 10, Yarn Berry 4.18.1 and Bun 1.4.2 installs followed by normal add commands passed. Configured pnpm paths have quote/comment regression coverage. |
| R6-6: resume | A manual pull after rejected refresh push made pending refresh reject the new descendant HEAD. | Accept descendants, update pending SHA, give exact pull/retry guidance. Real git fixture covers remote advancement, rejection, pull merge and successful resume. |
| R6-6: failed repair | Commit/stage/receipt failures retained edits and receipt changes. | Restore both and unstage scoped files when no commit was made; retain committed work after push failure. Three regression cases pass. |
| R6-6: CI log | Long setup output hid the trailing failure; brief mislabeled it. | Quote the error neighborhood or tail as CI check output. A real review-loop fixture asserts the trailing diagnostic reaches the worker. |
| R6-6: emitted lint | Core no-unused-vars disabled made the generated suppression itself fail lint. | Use a meaningful promise fallback function type, without eslint directives. Both emitted presets lint with the rule enabled/disabled and unused-directive reporting. |
| R6-6: redeploy | Two same-project deployment rows returned no preview. | Select newest same explicit project/environment, retain ambiguity refusal. Regression passes. |
| R6-6: partial install | Partial node_modules suppressed the next install question. | Persist in-progress/failed/succeeded attempts; interrupted and failed attempts ask again. Tests cover partial dependency state. |
| R6-6: no lock | npm ci was offered without a lockfile; workspace owner could be wrong. | Offer plain install with disclosure; detect workspace root, create only approved lock, never commit it. Unit tests cover all managers and workspace root. Actual npm, Yarn and Bun no-lock probes ran; Yarn requires a manifest it need not normalize, otherwise the read-only sandbox correctly refuses. Bun lock generation uses disposable manifest staging. Ship test excludes the generated lock. |
| R6-6: opaque build | Measured baseline followed by timeout/opaque working build printed a missing-prior-decision sentence. | Say the working-tree build/lint could not be measured and preserve its reason. Timeout and opaque regression cases pass. |

## Legacy report honesty

Saved job edit references and same-run receipt metadata can prove that an earlier release already
edited a policy page. Those resumes receive a factual exception to the new-run “changed neither”
sentence: the earlier version recorded policy edits and this continuation left them alone. This
uses provenance only; no policy text is read, evaluated or reversed. New runs use the founder's exact
sentence. Report, PR and final-comment regressions ensure the two claims cannot appear together.

## Checks

Only affected tests and named integration cases were run, not the repository-wide suite.

- `pnpm exec vitest run <affected test files>`: targeted fence/runner/jobs/planning/report/review,
  baseline/cache/build/sandbox/resume, emitted lint and PR-loop regression groups.
- Two named offline wizard end-to-end cases: full flow and policy-edit refusal passed.
- `pnpm exec tsc -p packages/instrument/tsconfig.json --noEmit --pretty false`: passed.
- `pnpm lint`: passed.
- `pnpm exec vitest run packages/instrument/src/package-tarball.test.ts packages/instrument/src/pack-receipt.test.ts --reporter=dot`:
  24 passed; pack receipt 638 files, 1,363,836 packed bytes at this check, unchanged 0.12.2 version.
- `git diff --check`: passed.

Runtime package-manager and Next probes used generated local fixtures. They did not run against a
customer project. No publish, version bump or PR creation was performed. Branch push uses the renamed
`fix/2026-10-06-tag-first-customer-run` upstream.

### Targeted command groups

The main targeted batch used:

```sh
pnpm exec vitest run packages/instrument/src/checks/{build,package-cache,baseline-tree,registry}.test.ts packages/instrument/src/t0/sandbox.test.ts packages/instrument/src/github/{checks,preview-failure,github}.test.ts packages/instrument/src/review/{ship-gate,fix-verdict,review-fixes}.test.ts packages/instrument/src/wizard/steps/{before,pr-loop}.test.ts packages/instrument/src/wizard/{prepare-resume,deps,deps-census}.test.ts packages/instrument/src/frameworks/managed-files-lint.test.ts --reporter=dot
```

The PR-loop assertions affected by removal of consent grading were updated and rerun. The full
PR-loop file plus focused follow-ups covered all 100 current cases successfully. Additional named
checks included:

```sh
pnpm exec vitest run packages/instrument/src/agents/fence-consent-boundary.test.ts --reporter=dot
pnpm exec vitest run packages/instrument/src/wizard/steps/pr-loop.test.ts -t 'waits for Actions to register' --reporter=dot
pnpm exec vitest run packages/instrument/src/wizard/steps/pr-loop.test.ts -t 'commits only the allowed set|posts ONE COMMENT review' --reporter=dot
```

The final assertion in the last command was corrected to expect no consent-review decline entry;
its focused rerun passed. The boundary file has 11 passing strict-fence cases.

Legacy-history regressions: 3 failed before the change; the final report/review/owner-history/PostHog/ownership group finished 124/124 passing. TypeScript and diff checks passed. Receipt metadata reuses the existing parsed receipt and its existing unreadable-receipt protection.
