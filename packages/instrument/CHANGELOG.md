# Changelog — infinite-tag

All notable changes to the `infinite-tag` npm package (`packages/instrument`). Versions before
0.5.0 are recorded in git history only (`git log -- packages/instrument`).

## 0.13.1 — 2026-10-10

### A later install never takes an installed tool off the page

- A later install merges into `.infinite/install.json` instead of replacing it. Adding the server lane after the
  browser tag keeps the tag's files, hashes, edits and ids on record, and `uninstall` reverses both installs byte
  for byte (#15).
- `install --server-lane` with no browser input of its own installs the lane only and leaves the browser tag as it
  is. The saved artifacts file only configures the lane. On a repo with no tag yet, run `install` to add the tag.
- A browser re-run that would drop a tool the receipt records (for example a saved file holding only Infinite
  over a wizard install with GA4, PostHog and Meta) is refused before anything is written, naming the tools and how
  to keep them. `uninstall` is the only way to remove a tool (#16).
- The wizard's plan screen and preflight refuse what its apply would refuse, including an X pixel it cannot keep.
- A lane-only run over an existing tag says "Browser tag left as it is (…)" instead of "Browser pixel NOT installed."

## 0.13.0 — 2026-10-09

### One outcome helper on every host, with Stripe and lead reports built in

- Next.js sites (Pages and App Router), and sites with no known host, now get the same `lib/infinite-outcome` helper
  as Vercel, Netlify, Cloudflare Pages and Node. The Next module no longer exports its own `sendInfiniteServerEvent`,
  and the Node target no longer ships a separate twin: one API everywhere. The `.ts` helper passes `tsc --strict`
  (with `noUncheckedIndexedAccess` too) and the lint presets a Next site runs.
- `reportInfiniteOutcome(outcome)` resolves Infinite's HTTP status, or `null` when nothing reached Infinite; it
  never throws (an outcome with no `type` or `eventId` resolves `400` without a send). `reportInfiniteOutcomeForMirror`
  resolves the full answer (`metaEventId`, `metaEventName`) for a page that mirrors. `postInfiniteOutcome` is gone.
- New: `reportStripeCheckoutStarted`, `reportStripeCheckoutPurchase` (the webhook's answer: 500 only when a retry
  can deliver the report; test-mode events, other integrations' sessions and anything before setup answer 200),
  `reportInfiniteLead`, `reportInfiniteOutcomeInBackground` (the site's own `waitUntil` or Next `after()`, else a
  bounded 800 ms wait; no dependency is ever added), `buyerContext` / `contextMetadata` / `contextFromMetadata`
  (the buyer's device data carried from checkout to the webhook on the session's metadata, one field per value),
  `personMatch`, `stripeCheckoutPayer`, `stripeAmountToMajor`, `infiniteContentIds`, `infiniteLeadId`.
- `ln` is every word after the first, joined, as Infinite's own sender splits a name. A Stripe buyer's address is
  the payer's, taken whole from one place: the shipping address only when billing has no city and it is addressed
  to the payer by name. Zero-decimal currencies are no longer divided by 100. `content_ids` is capped to Infinite's
  120-character value limit by dropping whole ids; any other value Infinite would refuse drops itself instead of
  losing the outcome. `path` is optional for recording (only Meta needs it), a query string is cut.
- Infinite's relay is the Meta path for server conversions with or without PostHog; turn PostHog's own Meta
  destination off for those events.
- The wizard writes the site owner's steps for server conversions into the pull request
  (`docs/infinite-server-events.md` and a section of the description).

### Store events reach the right tools exactly once

- `infiniteTrack` and `infiniteTrackThenNavigate` take `destinations` as a list (`["meta"]` = Meta only), so a call
  site adds only the tools that miss an event. `infiniteTrackThenNavigate` takes the same options, waits for a
  browser-only Meta event's request (at most 400 ms) even when GA4 is left out, ignores a second click while it is
  leaving, and frees the button again on Back.
- Meta ViewContent and AddToCart carry only Meta's content keys (`content_ids`, `content_name`, `content_type`,
  `contents`, `value`, `currency`). A value never goes without a currency: the caller's, else the site's.
- Events recorded to Infinite from the page carry only the event name, which Infinite's browser ingest accepts; product
  keys made it reject the whole event before.
- New `infiniteAdMatchAllowed()`: the tag's "visitor allowed tracking" signal, for pages to pass to their own API routes.
- The wizard turns browser match data on by default when Meta is connected (`infiniteMetaMirror` with `identity`), on
  the site's own pixel too.
- The tag no longer hides PostHog's sensitive pages from Infinite. In follow mode, on the routes where the site keeps
  its pixels off (a cart, a success page), the tag records the visit when the site's pixels ran for that visitor
  earlier in the same tab, and nothing otherwise.
- The pixel infinite-tag installs sends one Meta PageView per client-side route change, unless the site's code already
  sends its own. An existing pixel whose id comes from an environment variable also gets Meta's automatic events and
  history PageViews turned off.

## 0.12.2 — 2026-10-05

### Page views carry the Meta ad they came from

- The first page view of a visit records `ad_id`, `adset_id`, `campaign_id` and `utm_placement` from the landing URL
  when present, so a signup can be traced to the exact Meta ad. Each value must match its pattern exactly (digits for
  the ids; letters, digits and `_` for the placement) and pass the same personal-data rule as the UTM fields; anything
  else is omitted, never rewritten. Other events, consent and delivery are unchanged. The browser-collect-v1 contract
  is byte-identical to the server's.

## 0.12.1 — 2026-10-04

Fixes from six live end-to-end runs on a real customer-style site, with real Claude Code and Codex, a real pull
request, merge and deploy, and one real visit checked against each tool's own data.

### Proof that each tool received the visit

- GA4 connected in Infinite: the report says GA4 **received** the visit only when GA4's own realtime report counted
  a page view in the visit's minute and none in the quiet minutes before. Otherwise it says sent, busy, pending or
  could not be checked.
- The real visit uses a normal browser, so Meta's pixel no longer drops it as a bot.
- A fresh workspace can prove its site: the wizard writes a site file that claims the domain for the workspace.
- Only custom domains count as the production site; a `*.vercel.app` address is never treated as live.
- A receipt counts only with its own timestamp from after the deploy.

### Honest results

- The headline names every tool that confirmed the visit ("Infinite's tag and GA4 received this run's real
  visit"). A visit that was only seen leaving reads "sent, but receipt is not confirmed".
- An earlier problem that wasn't fixed keeps the verdict at "problem", and every installed tool is checked after
  the deploy.
- A job is ticked done only after a check of the wizard's ran and passed. After the deploy, every job is proven,
  failed, or marked "not checked after the deploy". None is left "waiting for deploy".
- The final pull request comment rebuilds its checklist from the final results, in plain words (no check ids), and
  counts a review read back from the printed brief.
- No false "GA4 sends nothing on a page change" (the test window now waits out GA4's batched events), no false
  "approved fix is not in the code", and no false "edits were undone".

### Agents and review

- The agents' turns are checked against what changed. A correct edit is no longer refused, and each job can be
  undone on its own.
- Agent time limits match measured runs (jobs 20 minutes, review fixes 10 minutes), and the brief is about half
  the size.
- Review findings are sorted by who owns the code, and an ask nobody answered stays with the repo owner.
- `--reviewer` is remembered on a re-run. The wizard edits its own pull request comment instead of posting a new
  one each run.
- New job: GA4 page views on client-side page changes.

## 0.12.0 — 2026-10-03

### Setup wizard: the terminal round

- The plan screen shows the full text of every line you approve: a long line wraps under its own text instead of
  ending in "…", the box uses the terminal's width, and on a short terminal the plan scrolls by whole lines and
  says how many are above and below. After you choose the consent setting, its line says what you chose.
- The before/after table never cuts a cell: from 140 columns it is a 3-column table whose cells wrap, below that
  each row is stacked. It opens with one verdict line (what the live check supports, the run id, how long it took).
- The closing screen stays up until you press a key (ENTER, Q, ESC or Ctrl+C). Never under `--json`, never
  without a terminal. The table is still printed into your scrollback when it closes.
- The merge prompt says each sentence once and shows the branch and how many files changed.
- "Before:" in the step list is the same count as the table's "Checks passing" cell for the live site.
- A problem the live test finds is said in words ("GA4 counts every page twice", not "GA4 a problem"), and the
  table counts it as a problem instead of "unknown".
- Agent jobs that were not done are named, with why. The review step says what the reviewer found, and the
  headline names the agent that is working now. The job count is the same on every line.
- The Learn cards name your site, your workspace and the two agents once the run knows them. Step descriptions
  wrap instead of being cut. One run id is shown everywhere.

### Setup wizard: the I1/I2 follow-up

- The env-target read asks Infinite only about public build-time names (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`; at
  most 10). A server-side name is never sent and its check reads unknown; a refused or failed read leaves the
  check unknown instead of stopping the run.
- A site linked to Infinite's own workspace stops with one plain line ("Link it to its own workspace") and exit 4;
  when Infinite cannot tell its own workspace apart yet, the run parks with a plain line (exit 3).
- Sensitive pages (decision 17) now reach the plan: the login, checkout and similar routes the detector finds
  give the "no session replay and no autocapture there" line for a new PostHog, and for an existing one.
- A build the installer could not run is "not checked", never "already red" and never a rolled-back install.
- The before/after table says "Checks passing" with cells counted out of all 14 ("4 pass · 8 problems · 2 not
  testable of 14"), and a raw count below 50 page views is footnoted once as shown, never as "—".
- A form whose handler calls `postInfiniteOutcome` is no longer reported as silent.

### Setup wizard: review I1 fixes

- A site whose home page redirects (apex → www, `/` → `/en`) is proved and reported; a check's free text never
  goes in a report cell, and an unexpected error after the proof claim still settles the proof.
- A Next.js site with its own `next.config.*` installs: the installer never edits it, the plan says so, and the
  collect rewrite becomes a job the wizard checks. An install that cannot be applied stops before anything is
  written in Infinite.
- The wizard checks jobs 1, 2, 3, 8, 9, 12 and 14 itself (server-lane mount, app shell, Next rewrites, server
  conversions, identify/reset, CSP hosts, the privacy paragraph); a job it could not check is named in the PR.
- Code the wizard's own build runs is gated (network, DNS, file writes, computed globals), the build may write
  only its output folders, and the gate runs again before every commit.
- The second reviewer can read its worktree; Ctrl+C mid-turn waits until the agent's edits are undone; check
  reasons are secret-scanned; downloads are declared once per event; the report refuses what the cloud refuses.

### Setup wizard: one wired run

- `npx infinite-tag` now runs the whole 13-step wizard (link, agent, before, keys, plan, install, jobs,
  settings, rehearsal, review, merge, prove, done) on the real modules: the Infinite app bridge, your own
  Claude Code or Codex, git and `gh`, the checks, the job registry, the installer and the report.
  `npx infinite-tag --version` prints the version.
- A failed bridge call ends a step the same way everywhere: Infinite unreachable, the site locked and a running
  dev server park the run (exit 3), and an agent that fails ends it with `INF_WIZ_AGENT_FAILED` (exit 1).
- Resume: after `link`, a resumed run asks Infinite for its run once; a run that belongs to another
  workspace stops with "run npx infinite-tag --fresh". On a fresh clone, an open wizard pull request's
  marker rebuilds the run, and `before` switches a resumed run back to its branch when the tree is clean.
- Agents: Opus 4.8 or Sol 6.1 at extra-high effort, with one retry on the fallback model; the model, the
  effort and any fallback are recorded in the run state, the plan's cost line and the report. Codex runs
  under a permission profile (never `-s`), Claude Code with `--restricted`.
- Nested mode has one implementation: on `--resume` every rejected edit is undone before any check, your
  agent's versions are kept beside the snapshot, and refs are never reset. Inside another sandbox the
  build and the offline tests read undetermined and the run asks you to finish the checks in your own
  terminal.
- A build that could not run is undetermined, never a pass. The plan reads one count of Meta's automatic
  events (the grader's), shows that a 7-day check-in follows the deploy, and the wizard's `.gitignore`
  fence is a receipted edit the uninstall reverses.
- Live reads (the wizard's checks and `doctor`) honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.

### Setup wizard: fixes from the offline end-to-end run

- The managed GA4, PostHog and Meta tags now carry the preview guard the plan showed and you approved
  (it was dropped on the way to the installer), and the guard's host list no longer stops the agent jobs.
- A Meta pixel already on the page inside a `<Script>{`…`}</Script>` block is improved in place, never
  installed a second time.
- An agent's claim on a job whose check this version cannot run yet (or whose offline test cannot be set
  up for that job) leaves the job "claimed" for a later test instead of stopping the run; the offline tests
  get the site's production host and the guard's production hosts.
- On a Next site without a `next.config`, the PostHog `/ingest` job may write the config the rewrite needs.
- `uninstall --pr` no longer refuses a finished install because of the wizard's own untracked
  `.infinite/harness.json`.

### Setup wizard foundation

- Bare `npx infinite-tag`, `npx infinite-tag wizard …` and any flag-first argv (other than `--help`, `-h`,
  `--version`) now open the setup wizard; `doctor` and `uninstall --pr` get their own entry points. Every
  classic command is unchanged.
- The postinstall line now says: "Next: run npx infinite-tag in your website repo."
- New public contracts under `contracts/`: `host-deny-v1.json` (the preview-guard deny list) and
  `tag-wizard-v1/` (the desktop bridge descriptor, every bridge verb with an example of every error code,
  test-engine grading cases, receipts, a report v2, a run state, and the review and claims JSON Schemas).
- The packed LICENSE now carries PostHog's MIT notice for the wizard patterns adapted from the PostHog
  wizard (v2.74.1).

### Setup wizard runtime

- The wizard runs its 13 steps in order and can be resumed: `npx infinite-tag` again picks up at the first
  step that is not done, skipping finished steps whose inputs did not change. A run that needs you parks
  with exit 3 and says what to do next.
- One wizard run per repo at a time (`.infinite/wizard/run.lock`). Ctrl+C, a crash or a step that runs
  out of time stops the agent and undoes its unsaved edits before the lock is released; Ctrl+C exits 130.
- If the run's pull request was closed, the wizard offers a fresh run; `--fresh` sets an unfinished run
  aside (it is kept) and starts over.
- `--json` streams one event per line; without a terminal and without `--json` the wizard says how agents
  and CI should run it and exits 2. When an agent starts the wizard, it hands the agent the jobs instead of
  starting another agent, and asks you (never the agent) about consent, conversion names, privacy text and
  changes to existing tags. An agent cannot pass `--consent-mode`; edits the agent made outside its jobs'
  files are undone (and kept aside) before the wizard checks anything.
- `--yes` approves only plan lines that add the wizard's own code; it never approves a change to an
  existing tag, conversion names or the consent mode.
- After the merge is deployed, the wizard makes ONE real test visit and reports per tool, with receipts from
  that visit; it prints the PostHog visitor id to filter out. The before/after report (live site today, in
  this pull request, proven live) goes to the terminal, the pull request and the Infinite app; an
  unmeasured value shows "—", never 0.
- `npx infinite-tag uninstall --pr` reverses the install on a new branch and opens a pull request; the
  Infinite settings for the site are removed after that merge by default. On a machine with no saved link
  it links first; the link is removed last, and a piece that failed is retried on the next run.
- The `.gitignore` block now also ignores `.infinite/wizard/`, the harness report and its brief; an old
  one-line block is upgraded in place.

### Setup wizard: terminal UI, the Infinite app bridge, link / keys / settings

- The wizard's terminal screen: the 13 steps with a Learn card beside them (dropped below 80 columns), a few
  live updates per step, the agent's narration, one pop-up per question (link code, plan, choices, text, merge,
  agent questions, teammate comments) and the before/after outro, whose table keeps its columns on screen and
  in scrollback. It runs in the alternate screen and always gives the terminal back (also after Ctrl+C); a
  `read EIO` no longer stops the keyboard. It leaves one line with the run id, the PR and the report path.
  `NO_COLOR` / `FORCE_COLOR` are honoured. `--json` streams the events as NDJSON and reads `ask.answer` lines.
- The Infinite app bridge client: finds the app's owner-only bridge file (`$GROWTH_OS_HOME/desktop-tag`),
  refuses anything unsafe, speaks only to `127.0.0.1`, decodes every answer strictly, and follows an app
  restart (never a different Infinite variant). After a restart it re-sends a request only when that cannot
  repeat an effect (a read, or a request the old app never received). If the app quits or its cloud fails
  mid-run, the step stops with "open Infinite" / "try again" instead of crashing.
- Step `link`: a 4-digit code shown in the terminal and on the app's approval card; remembered links skip the
  card; approval has one 5-minute window, and a retry with a new code fits inside it; a run linked through one
  Infinite variant (or started in another workspace) never continues against another; an unsubscribed
  workspace stops with a clear message. A credentialed git remote never leaves the machine.
- Step `keys`: keys come only from your Infinite connections (never a flag, a file or `.env`); a GA4 property
  with several web streams asks which one is this site; IDs the live site uses that differ from the
  connection become a plan line, never an overwrite; "the live site uses the same IDs" is said only when the
  live site was measured in this run; Infinite's own Meta dataset is never installed.
- Step `settings`: declares the approved conversions, saves the server-lane settings on Vercel through
  Infinite only when you approved that plan line (no redeploy; they go live with your merge; `vercel` is never
  run), marks GA4 key events only for approved conversions whose offline click test passed, and switches on
  Meta server events only when you approved it and Infinite has it available (a relay already on for another
  pixel is flagged, not reported as on).

### Setup wizard: your own agent, fenced

- The wizard finds your own Claude Code or Codex, checks you are logged in and which plan or key pays, and
  spends no prompt doing it. Claude Code does the work and Codex reviews when both are there; with one agent
  the wizard prints a review brief; with none the code jobs still run and the agent jobs are listed for you.
- The agent can only claim a job is done. It claims over a local checklist channel (`infinite_tag`, a
  loopback-only MCP server with a per-run token); the wizard then runs its own checks before it ticks
  anything, and a failed check goes back to the agent with the reason (at most 30 turns or 10 minutes).
- Every agent turn is fenced: a snapshot is taken outside the repo first, and any change outside the job's
  files, any deleted file, any edit to `.env*`, `.git`, `.infinite`, `.claude`, `.codex`, `package.json` or
  a lockfile, and any change inside a consent call (a Consent Mode key on its own line included) is undone.
  An agent that runs git (commits, branches, staging, git config or hooks) has that undone too, before the
  wizard runs git itself. A write inside `node_modules`, `.next`, `dist`, `build` or `out`, or any change to
  the files after the turn ended, stops the run before anything is built. Kept edits are recorded exactly so
  uninstall can reverse them; the edits of a job whose check failed are undone instead of shipped.
- A job counts as done in code only when at least one of the wizard's own checks ran and passed; a job with
  nothing to check before deploy waits for the later tests. If the wizard is killed mid-turn, the next run
  undoes that unfinished turn first.
- Claude runs `--restricted` (files outside the repo cannot be read) with no shell and no web tools, and
  cannot read the repo's `.env*`, `.git` or `.npmrc`/`.netrc`; Codex
  runs under a read-confinement profile that denies your home folder, with browser, computer-use, image and
  app features off. Neither can read `~/.growth-os` or the Infinite app's data.
- Out of usage: the agent's edits are undone and the run parks; run `npx infinite-tag` again after the reset
  to resume the same session. The wizard never switches you to Infinite-paid inference.

### Setup wizard: the pull request, its rehearsal, the second review and your merge

- The wizard ships its work as a draft pull request on `infinite/tag/<date>-<run>`, branched from your production
  branch (Vercel's, else the repo's default branch, else `origin/HEAD`, the last two labelled "fallback"). It
  commits only the files the plan covers, its own managed files, the npm job's `package.json` and lockfile, the
  edit receipt and its `.gitignore` block, with an `Infinite-Tag-Run` trailer. It never force-pushes, amends,
  rebases, skips hooks or signing, pushes to the base, or merges.
- Every commit, pull request text, review, reply and agent note is scanned first: secrets, tokens, private paths
  and personal data are redacted in posts and held back from commits.
- The rehearsal loads the pull request's Vercel preview under your production hostname with nothing sent, plus the
  preview's own link, and grades each tool. A protected preview, a non-Vercel host or no preview within 10 minutes
  reads "undetermined", never pass.
- A second agent (the other of Claude Code or Codex) reviews read-only; the wizard posts ONE comment review,
  acts only on its own reviewer's and (with your OK) your teammates' comments, declines anything against a
  standing ruling, asks you about conversion names, privacy text and anything outside the plan, fixes the rest in
  at most 2 rounds, and readies the pull request with a final comment. With one agent it writes a review brief.
- You merge. The wizard waits (ESC parks it; a re-run picks the pull request back up) and records the merge commit
  for the live proof. GitLab gets a draft merge request by push options; Bitbucket and other hosts get the branch
  and a link.

### Site code for the setup wizard (ported from infinite.fast)

- **Preview guard** (decision 3; decision 8 for Meta). With a `hostGuard` on the artifacts, the managed GA4,
  PostHog and Meta bootstraps start only on production hosts (always exempt) and on hosts no rule denies;
  loopback, `.local` and preview platforms (`*.vercel.app`, `*.netlify.app`, `*.pages.dev`, from
  `contracts/host-deny-v1.json`) stay silent. Each guarded snippet is its own IIFE. On a silenced host the
  site's own calls cannot throw: PostHog's methods are queue-only, `gtag`/`dataLayer` are a queue-only stub
  and `fbq` is an inert, flagged stand-in (nothing loads, nothing is sent). The `_fbc` landing capture is
  never guarded. A plan whose guard would silence a known production host (including one in the guard's
  own deny list) is blocked.
- **One host normaliser** (trim, lowercase, strip one trailing dot) in the browser runtime, the Next server
  lane, the generated Vercel/Netlify/Cloudflare/Node lanes and the production-host artifact:
  `ACME.com.` is `acme.com`.
- **Per-provider isolation on Next.js**: each provider in the shared inline script runs in its own `try`, so
  one that throws no longer stops the others.
- **PostHog**: new installs get `defaults: '2026-01-30'`; a re-install keeps the bundle its managed snippet
  already carries (`2025-05-24` before this release) until `defaults` is set explicitly, and the plan then
  says "measurement changed". `sensitivePaths` turns session replay and autocapture off on listed pages
  (decision 17), re-decided at every PostHog page view so single-page-app route changes are honoured;
  `/x/*` covers a path and everything under it.
- **Managed conversion helpers** (decisions 9 and 13), emitted only when `conversions.helpers` is set:
  `infiniteTrack`, `infiniteTrackThenNavigate`, `infiniteIdentify`, `infiniteReset`, `infiniteMetaMirror`
  and `infiniteCampaign`, as window globals in the managed block and as typed, no-op-safe exports of the
  managed Next module. They are written even when every requested tool was adopted.
  `infiniteTrackThenNavigate` navigates by itself whenever the browser would not (a button, a different
  href, a prevented click, before hydration), and holds a click for GA4 at most 1 s. The GA4/PostHog helpers
  follow the visitor's recorded consent decision and the consent mode, not the DNT/GPC default. The Meta
  mirror fires only with the `metaEventId` the server returned, once per id, never for `Purchase`, and holds
  the page at most 400 ms. First-touch campaign attribution is captured at landing (tab + 7-day cookie,
  both scrubbed of emails, phone numbers, URLs and click ids at write time).
- **`reportInfiniteOutcome`** in the generated outcome helper (TS, JS and Node): returns Infinite's 202
  `{ accepted, duplicate, metaEventId, metaEventName }` and requires a stable `eventId`.
  `postInfiniteOutcome` now resolves the 202's `accepted` (it resolved `response.ok`). Campaign context is
  added only within the 16-property limit. The Node helper gains `adMatchFromRequest` and re-exports
  `infiniteVisitKey`.
- **Meta for adopted pixels**: a capture-only block (`captureOnly`, written beside a detected pixel; without
  one it is a plan blocker) and the job-7 guard recipe (`ADOPTED_META_GUARD_RECIPE`).
- The runtime exposes its own consent check (`window.__infiniteConsentAllowed`) on verified hosts; the
  managed helpers ask it first.
- `contracts/server-lane-v1.vectors.json` gains the 202 response cases and a mixed-case `external_id`.
- The plain installer's output is unchanged when the wizard options are absent (except the GA4 lane marker
  line, the silenced-host stand-ins inside a guard, and `defaults: '2026-01-30'` on a FRESH PostHog install);
  `install --server-lane` copy is byte-identical.

### Setup wizard: offline checks (T0), census, build check, the grader

- **T0, the offline test engine.** The wizard runs the analytics bytes it installs (and any page code an
  agent edited) in a throwaway browser model, never in its own process: a separate Node child with a
  minimal environment and a temporary home, and on macOS inside the built-in `sandbox-exec` with no
  network, no read access to the Infinite session, agent credentials, `~/.ssh`, `~/.aws`, `~/.npmrc`,
  `~/.netrc` and common CLI credential stores, and no writes outside its temporary home. The child
  refuses code generation from strings in its own realm and freezes its built-ins, so page code cannot
  reach the child's process or tamper with what it records. Nothing is ever sent: every request is
  recorded and cancelled. Scenarios: previews stay
  silent while production fires, the consent rule, one `_fbc` holding the last click, attribution
  surviving a storage wipe, the test click id never leaving, the Meta mirror firing only with the
  server's id, the conversion request leaving before the page does, CTAs that still work with the tags
  blocked, replay off on sensitive pages, one tag per page, and click tests. A crash or timeout is
  "undetermined", never a pass.
- **Census.** Every place the site starts GA4, PostHog, the Meta pixel or a tag manager, with file and
  line and no dedupe, plus the provider ids read from environment variables.
- **Build check.** The site's own build runs behind the same boundary (it may write only inside the repo,
  never to `.git`, `.husky` or `.infinite`); a failure that was already there before the run is
  reported, never blamed on the change. A timeout stops the whole build, including the processes it
  started.
- **The grader.** One place turns the desktop test engine's facts into pass, problem, undetermined or
  info per tool. Consent holding a tool back is never a problem.
- `inspect` now reports every PostHog init (with file and line), skips Infinite's own managed bytes, and
  reads PostHog's `defaults`.

### Setup wizard: the plan and the install

- The wizard's **plan** step shows one plan screen. It asks only four things: the consent mode, the
  conversion names, the privacy paragraph and the npm line. Everything else is a line you approve or
  decline. A run without a consent answer stops at the plan (exit 3) and resumes with
  `npx infinite-tag --resume` or `--consent-mode`.
- The **install** step writes the tags for the tools connected in Infinite (ids come only from your
  connections, never from a default), adds the preview guard, installs the server-lane package when you
  approve that line, runs the build, and undoes everything if the build breaks on something new.
- Tags you already have are **improved in place, never reinstalled**. Each improvement is its own plan
  line, and none is applied without your approval (not even with `--yes`): the PostHog `/ingest` proxy,
  page changes in single-page apps, the PostHog `defaults` date, the Meta ad-click capture beside an
  existing pixel, turning off Meta automatic events, preview silence, and duplicate removal.
- When your live site is served on a preview-style host that Infinite does not list (for example
  `acme.vercel.app`), no preview guard is added. The plan says to add the host in Infinite first, so the
  guard can never silence production.
- `.infinite/install.json` now records every edit the wizard or your agent makes, with exact
  before/after hashes and text edits, plus the public ids the install emitted. `uninstall` reverses those
  edits newest first, and only when a file is still exactly as the wizard left it. A file that changed
  since is left as it is, with a warning. A corrupt receipt is rebuilt from the managed markers, and the
  wizard says what could not be recovered.
- A page the installer cannot edit (for example a Vite `index.html` with no `</head>`) is now an open
  job, never reported as installed. This also applies to `infinite-tag harness`.
- Monorepos: the app root comes from your Vercel project's root directory, then from the workspace globs.
  A scan that hits the 2,000-file cap now says so.
- Re-running the wizard keeps what earlier runs did: their recorded edits stay in the receipt (and
  `uninstall` still reverses them), and a tool whose "Update" line you decline keeps the tag and ids it
  already had instead of being removed.
- A static or Vite site that Vercel does not serve installs PostHog straight to its region (an `/ingest`
  path there would have no rewrite behind it), and Infinite's tag becomes a line telling you what is
  needed, so the other tools still install. Adopted tags in a static site's `public/` pages are found, so
  they are never given a second managed copy.
- The Meta ad-click capture is never inserted beside a pixel a consent manager holds, and the automatic
  events opt-out is never added in front of a pixel start that runs under a condition: both become jobs
  for your agent instead. The measured automatic-events count counts only Meta's own automatic events,
  and shows "—" when the pixel did not fire.
- Declining a duplicate-removal line, the server lane or the agent's cost line is always honoured: no job
  of a declined line runs, the npm line runs only with the server lane, and the privacy paragraph
  describes only the tools and lanes you approved.

### Setup wizard: the checklist and "Check the live site"

- The wizard's "Check the live site" step branches from your production branch first, reads your
  Infinite connections for the IDs it expects (never your repo's `.env`), and loads your live site once in
  the Infinite app's hidden window with every tag request cancelled (no clicks, no test click id), before
  it counts what passes, what is a problem and what it could not tell.
- The agent checklist (jobs 1–16): detectors find what each job needs (a server entry or middleware, an
  unusual layout, signup / lead / download / payment / booking handlers beyond Stripe, logins and every
  logout, the CSP and redirect owners, the privacy page, a hand-written host-only `_fbc` writer, duplicate
  tags, adopted tags with no preview guard). A job is only suggested; your plan decides which run.
- Agents only claim a job; the wizard's own checks decide its state, and proof needs this run's receipts.
  Agents never touch `.env` files, lockfiles, `package.json`, build output or a cookie-banner / consent
  manager file, and never a consent call.
- The agent is handed your decisions, never asked to make them: each conversion job carries the conversion
  name you approved (a type you removed from the plan gets no job), the privacy job carries your approved
  paragraph word for word, and the preview-guard and improve jobs carry the guard expression and your
  connections' public IDs. Text from your repo reaches the agent quoted, so a file name cannot pose as an
  instruction.
- The middleware job runs only where the installer cannot wire the server lane itself, and only when you
  approved the server lane; the Tag Manager + gtag duplicate job may touch only the hand-written gtag.
- A job is "waiting for a real event" only after its click test passed, and a live check counts only when
  it was taken in this run, after the change could be live.
- "Check the live site" keeps going when the Infinite app is busy with another test or your analytics
  history cannot be read right now (those stay unknown), and a resumed run checks it is on its own branch.

### Live checks, setup checks, the post-turn gate and `doctor`

- **`infinite-tag doctor`** is built: the setup checks over your source plus, with `--url`, the live checks
  (no browser). Ids come from `--expect-ga4` / `--expect-posthog` + `--posthog-api-host` / `--expect-meta`,
  or from the `ids` block of `.infinite/install.json` — never a default; with no ids it exits 2. Exit codes:
  0 clean, 1 a problem, 3 nothing wrong but something could not be determined, 2 usage. `--json` for CI.
  `--probe-server-lane` sends one test request to the server lane, and only with this repo linked to the
  Infinite app; otherwise an installed server lane reads "not probed".
- **Live checks** (ported from infinite.fast's live guardrail): the tags and ids your pages serve (the
  managed Next bootstrap is decoded out of the bundles), duplicate tags per page, the PostHog `/ingest`
  proxy, campaign tags through every redirect hop, the Content-Security-Policy, Meta's Traffic Permissions
  per domain (and for preview hosts), and provider ids set on Vercel Preview/Development. Every request
  sends `Purpose: prefetch`, so a check is never counted as a visit. An expected pixel that is missing is a
  problem, not a skip.
- **New setup checks**: the same provider started twice on a page (or by infinite-tag and the site
  together), the site's own PostHog config (proxy, SPA page views, region), tags that start on preview
  hosts, PostHog replay on login/checkout/confirmation pages, and Meta event ids built in the page or
  standard Meta conversions fired from a click. The silent-form check now recognises infinite-tag's
  conversion helpers.
- **Post-turn gate** for the wizard's agent jobs: every agent turn's added lines are checked for code
  that would run something during the build or the offline test (child processes, sockets, `eval`, …)
  and for the Meta never-list, before anything is executed.

### Harness: setup-correctness checks

Setup-correctness checks: the harness now catches wiring that was never going to fire, not only
deliveries that failed.

Verification is receipt-based — each lane asks a backend whether an event arrived. That question can
only be asked about an event something TRIED to send, so a page that was never wired up correctly
verifies exactly as quietly as a page with no conversions at all. A new `Setup correctness` step
runs straight after `mark`, in every mode including `--check`, and asks the other question: from the
markup, should something have fired?

- **`data-conversion` placement.** Catches the attribute on an element the runtime will not treat
  the way the author meant — most sharply a `<button data-conversion="signup">` inside a `<form>`,
  which the click lane counts the moment the button is pressed instead of when the form submits, and
  which `mark` then skips forever as "already marked". Also catches a value the runtime does not
  read at all. The rule is DERIVED from `runtime/infinite-browser.ts` (parsed from the runtime's own
  source, which cannot import a shared constant because it ships via `toString()`), so a selector
  change in the runtime changes what the check says. A second copy of the rule is how the original
  bug survived.
- **A submitting form with no conversion event.** Flags a form that submits, looks like a lead
  capture (an email input, or its own name), and emits nothing. Deliberately conservative: it
  requires a positive lead signal, excludes search / filter / login / newsletter / comment / cart /
  GET forms, reports `undetermined` rather than a problem when the file already calls an analytics
  API directly, and is worded as "Worth checking", never as an accusation.
- **`_fbc` not captured at the landing page.** Catches a Meta pixel that initialises only in
  page-scoped files, or only on some of a multi-page site's pages. `fbclid` exists on the landing
  URL and nowhere else, so a pixel that boots later has no click id to save and the conversions it
  sends cannot be attributed to the ad that paid for them.

Every check has a third state. `undetermined` — a computed attribute value, a pixel that may live in
a tag manager, a runtime contract this build could not read — is reported as a check that did not
run, never folded into a pass. The five verification lanes are unchanged; this is a separate class
of finding printed alongside them, and it can neither mint nor deny a receipt. The findings are
local: they carry a file and a line, never an attribute value, never a field's contents, and
`buildHarnessReportPayload` does not send them anywhere.

Meta Manual Advanced Matching, as a customer-controlled option that is OFF by default.

- **`--meta-advanced-matching on|off` (default off).** On, the Meta snippet defines
  `window.infiniteMetaAdvancedMatch({ email, externalId })` for the site's OWN code to call once a
  visitor identifies themselves. It hashes those raw values (sha256, lowercase hex, exactly once,
  Meta's normalisation) before anything reaches Meta, so a conversion can be matched to the ad click
  that caused it instead of guessed at. It reads no DOM, binds no listeners and never fires on its
  own.
- **Off by default, deliberately.** Sending a visitor's contact details — even hashed — from a
  customer's pages is the customer's decision, the same reasoning behind the `autoConfig` opt-out it
  sits beside. Absent means absent: with the flag off, the accessor is not on the page at all.
  Automatic Advanced Matching (Meta scraping the customer's forms) stays off on every install.
- **Raw in, always — one hashing contract.** An input that is already a 64-character hex digest is
  refused rather than hashed again, because "sometimes hashed" is how double-hashing ships, and a
  double-hashed value is accepted by Meta and matches nobody. Nothing raw is ever transmitted, and a
  value that is not a digest never reaches `fbq`.
- **The privacy disclosure notice names the lane** when, and only when, it was actually installed.

Fixes ported from infinite.fast: ways a customer site silently collected the wrong data.

- **The server lane now sends Meta the visitor's newest ad click, not their oldest.** A browser can
  hold two `_fbc` click-id cookies (one per domain scope) and lists the older one first;
  `adMatchFromRequest` used to forward whichever came first, so Meta credited an earlier ad than the
  one the visitor last clicked. It now picks the newest click by the creation time inside Meta's
  cookie format, skips values that do not have Meta's shape (so a broken first cookie can no longer
  hide a good one), and reads a plain-object `req.headers` (Vercel Node functions, Express) as well
  as `Headers`. `_fbp` is read as before (first listed), and dropped when it is not in Meta's shape.
  Same rules as infinite.fast, fixed there on 29 Sep.
- **One rule for hashing the account ID sent to Meta.** The server-lane setup guide told customers
  to lowercase `external_id` before hashing, while the browser pixel's matching helper keeps the
  id's case — so an id with capital letters reached Meta as two different people. The guide, the
  generated helper's comments and the README now all say the same thing as infinite.fast: the email
  is trimmed and lowercased; the account id is trimmed only. The guide's recipe also stopped
  throwing inside a checkout route on a numeric id or a guest (`String(user.id).trim()`, and only
  when the buyer has an account id). Both recipes, `hashInfiniteEmail` and the new
  `hashInfiniteExternalId`, are now exported from the package, as their documentation already
  said.
- **Truthful Meta event-ID advice in the setup guide and README.** They told customers that the
  `eventId` they pass (`"purchase:" + order.id`) is the event ID Meta receives, and to fire a
  browser `fbq('track', 'Purchase', …, { eventID })` with the same value so Meta would deduplicate.
  That is wrong whenever Infinite derives a different ID (conversions set to *Once per account*, or
  *Once per visitor (TTL)* when a visit key is carried), and a page that builds its own Meta event
  ID sends Meta conversions that never happened. The guide now says: `eventId` is Infinite's
  idempotency key, so a retried webhook is counted once, and one purchase is reported under one
  `eventId` wherever it is reported (`"purchase:" + session.id` in every example; two ids would
  count it twice); Infinite decides the ID Meta receives; purchases are reported from the payment
  webhook as server events only, with the match data and the visit key captured at checkout; and
  the page never builds a Meta event ID or fires a Meta conversion on a click. The serverless route
  example no longer attaches Meta match data to a purchase, and says to move the report to the
  webhook (not add a second one) when purchases go to Meta.
- **A domain-verification file no longer blocks a static-site install.** Meta's domain-verification
  `.html` file (and Google's `google<hash>.html`) is a bare token with no markup, so it has no
  `</head>`, and one such file blocked the whole install. Files whose content is a single short line
  with no markup at all now look like verification tokens (judged by content, since the names vary
  per site): they are left byte-for-byte untouched and named in the plan as looking like a token. A
  head is never added to one.
  Genuinely broken pages (markup without `</head>`, empty files) still block the install.
- **Only real Meta pixel IDs are accepted.** `--meta-pixel-id` (and a pixel ID read from `.env`)
  accepted any 6-20 digit number, so a typo, a placeholder or an ad-account number installed a
  pixel that looks alive and never receives an event. Meta issues 15- and 16-digit pixel IDs only;
  anything else is now refused, and the message says what a pixel ID looks like and where to find
  it in Events Manager. Pixels already on a site are still detected whatever their shape, so a
  broken one is reported rather than hidden.
- **The managed PostHog snippet now starts, and can identify visitors before PostHog loads — and on
  Next.js, so do the Meta pixel, the X pixel and Infinite's own pixel.** The snippet's stub method
  list named methods under parents the stub never creates (`person.*`, `group.*`,
  `feature_flags.*`, `sessionRecording.*`), so building the stub threw before `posthog.init` was
  queued, and it had no top-level `identify`, `alias` or `get_distinct_id`, so an early
  `posthog.identify()` threw too. On Next.js (App Router and Pages Router) infinite-tag puts every
  provider in ONE script, in the order GA4, PostHog, X, Meta, Infinite, so that throw also stopped
  everything after PostHog: on every Next.js site where infinite-tag managed PostHog, the Meta
  pixel, the X pixel and the Infinite pixel it installed never started (GA4, placed first, did).
  Static HTML and Vite sites give each provider its own script, so there only PostHog was affected.
  The list is now PostHog's official snippet list as infinite.fast ships it. Only the method list
  changed: `defaults`, `api_host` and installs the customer already had are untouched. A new test
  runs the whole Next.js module with every provider and checks that each one starts.
- **The harness's step list has one source of truth.** The runbook's step ids listed 12 steps while
  the harness ran 13 (`setup-checks` was missing from the list), so anything reading the step ids
  disagreed with what actually ran. The run order is now derived from the id list, an id without a
  step does not compile, and a test fails if the two ever drift again.

Meta browser code ported from infinite.fast, where every rule was fixed after a real incident. The
code and its tests came across together; the tests run the snippet infinite-tag writes (the
static-html `<script>` and the Next module's string literal) in a sandbox, not a text search.

- **Meta click id (`_fbc`) saved on the landing page, for new installs.** When a visitor arrives
  from a Meta ad, the `fbclid` exists in the landing URL and nowhere else. If the pixel cannot run
  there (an ad blocker, a Traffic Permissions block), the click id used to be
  lost, and a later sign-up or purchase reached Meta with nothing tying it to the ad, so the ad looked
  like it did not work. The Meta snippet now saves the click id in Meta's own `_fbc` cookie before
  the pixel starts. The last click wins: a second ad click replaces the first, and one cookie is
  left, in the scope Meta uses, so an older copy can never shadow the newer click. The subdomain
  index names the domain the cookie was actually written on (`www.acme.com` → 1, `shop.acme.co.uk` →
  2). It never writes `_fbp`, never stores the click id anywhere else, writes nothing when there is no
  `fbclid`, and refuses malformed or oversized ids. It sends nothing. It is not limited to the
  production host, so previews can test it. It follows the visitor's consent in every consent
  mode, as infinite.fast's capture does: nothing is written for a visitor who said no on the site,
  or whose browser sends Do Not Track / Global Privacy Control, until they grant; and under
  `--infinite-consent-mode required` nothing is written before a recorded grant.
  `window.infiniteMetaClickId()` returns the click id or `""`.
  Pixels the site already had are left exactly as they are.
- **Manual Advanced Matching follows consent.** `window.infiniteMetaAdvancedMatch` now attaches
  nothing for a visitor who denied on the site, or whose browser sends DNT/GPC without a grant, and
  under `required` mode nothing until a grant. It checks on every call, so a revocation counts at
  once. Unchanged and now pinned by tests: the email is trimmed and lowercased before hashing, the
  account id is trimmed only (case kept, matching the server's hash), a phone number is never sent,
  and a missing `fbq` or WebCrypto resolves `false` instead of failing. It is still off by default.
- **New setup check: Meta automatic events.** A Meta pixel infinite-tag installed that is missing
  `fbq('set', 'autoConfig', false, id)` before `init` is a problem in infinite-tag's own code. A
  pixel the site already had with automatic events on is reported as information to review, never
  as a problem and never edited. When the source cannot settle it, the check says "undetermined";
  an opt-out that only exists inside a comment is "undetermined", never a pass. A Next module written
  by an older infinite-tag (before 0.7) is recognised as infinite-tag's own. The same check counts
  infinite-tag's managed Meta block across the whole page: exactly one `init` per pixel, at most one
  click-id capture and one matching accessor, and the capture before `init`, so a page that ended up
  with the block twice (every page view counted twice) is caught. Identical results are reported
  once, naming up to five files and counting the rest, and the step note now also counts the
  "worth checking" items. A site with no Meta pixel in its source gets one line about it, not two.
- **Fixed: the setup checks could not see a managed Next.js pixel.** The Next module stores the
  snippet as a string with escaped quotes, so the click-id check read a correct Next install as "no
  pixel found". The checks now decode it, and the click-id check names the managed capture when it
  is there.

## 0.11.0 — 2026-09-21

The Meta pixel's `verify` lane now checks DELIVERY, not just that a snippet is on the page.

- **Traffic-permissions detection.** `verify` / `harness` / `infinite analytics` ask Meta's own
  public, domain-scoped pixel config (`connect.facebook.net/signals/config/<pixel>?…&domain=<host>`)
  whether the pixel is allowed to transmit from the site's host, and report the exact remedy when it
  is not. This catches a pixel that loads, registers, increments `eventCount` and shows "Active" in
  Meta Pixel Helper while Meta silently drops every send — the state infinite.fast was in on
  2026-09-20, because the pixel's allow list still named the pre-rebrand domain. The block is
  invisible by design (`lockWebpage:false`), and while it stands no `_fbp`/`_fbc` cookie is written,
  so ad clicks cannot be attributed.
- **No credentials, no Graph call, no rate-limit cost.** The config endpoint is an unauthenticated
  CDN, so the check runs for any pixel on any domain — before or without a Meta connection — and
  spends nothing from the per-ad-account Graph request budget.
- **It never fabricates a pass.** A pixel that is not blocked is reported as "delivery is not
  blocked", never `verified` — Meta offers no install-time read-back. A probe that could not run
  says "could not check", and a config body the parser does not understand is an explicit unknown,
  never a healthy result.
- **The explicit block list too.** A host on the pixel's `prohibitedSources` list (matched on the
  sha256 of the hostname) is reported with its own remedy.

## 0.10.0 — 2026-09-14

`infinite analytics` now gets the server lane's two environment variables onto the production
deployment, and only calls the lane verified once Infinite has actually received an event.

- **Env step before verify.** After installing or adopting a server lane, the harness sets
  `INFINITE_SITE_SOURCE_KEY` + `INFINITE_SERVER_EVENT_SECRET`: through the Infinite desktop app
  (Infinite writes them to the connected Vercel project and redeploys — the secret never reaches
  the terminal); else with your own linked `vercel` CLI (source key first, then a freshly minted
  secret on stdin — never argv, files or output); else it prints both names, where to get the
  secret, and "env var only — never paste the secret into chat, messages, or your repo".
- **Verified means received.** `server_lane` is `verified` only when a server-lane receipt arrives
  under the current secret; otherwise `installed — waiting for the first event (env set: …)`. A lane
  already recorded in `.infinite/install.json` is no longer reported as not requested.
- **Safer secrets and deploys.** Replacing a secret that is already receiving events needs an
  explicit yes (or `--replace-live-secret`); a concurrent secret change is refused, never retried.
  `vercel --prod` refuses a dirty or unpushed tree unless `--allow-dirty`.
- **Honest outcomes.** Every redeploy result (started / skipped / unconfirmed / unknown) and its
  reason is reported in plain words and in `--json`; Vercel read failures are not reported as missing
  permissions; the server-lane brief and help text lead with the env step.

## 0.9.1 — 2026-09-05

- Share installation-evidence rules across the installer and harness. Recognize the current
  Infinite runtime and real SDK initialization/loaders; ignore ordinary event calls, HTML prose,
  commented examples, unused provider-name strings and conventional test runners.
- Report custom source/build-output ownership and older exact tag pins. Refuse to install or
  mark conversions in configured generated output; unsupported builds can request a manual brief.
- Make explicit `--verify-only` requests fail with `INF_VERIFY_INCOMPLETE` when receipt checks
  cannot run or complete. Preserve `INF_VERIFY_NO_RECEIPT` for actual unsuccessful polling.
- Include a source-to-deployment and per-action test checklist in reports and agent briefs;
  adopted/installed providers are not described as a completed coverage audit.
- Exercise these regressions in the npm tarball and packaged CLI tests. Six runtime/type files
  are added; the reviewed tarball now contains 122 files within unchanged supply-chain bounds.

## 0.9.0 — 2026-09-02

Harness hardening: the Vite lane stops editing entrypoints, the outcome helper carries the visit key
end-to-end (including a checkout → Stripe metadata → webhook round trip), the server lane honours
DNT/GPC, and the runbook reports honestly and recommends the funnel work an install can't do for you.

- **The Vite adapter injects into `index.html`, never the entrypoint.** The browser tag is added via
  an `index.html` snippet (Vite serves it verbatim) instead of editing `main.tsx`/`main.jsx`, so a
  named or aliased `createRoot` import is no longer a blocker and there is no risk of mangling an
  entrypoint. When there is no `index.html` to own, the adapter falls back to the manual brief with
  the exact snippet rather than guessing at the entry file. The managed HTML lives in
  `frameworks/managed-html.ts` (new file → the packed file count moves to 116).
- **The outcome helper is emitted in the right module format and exports the visit key.** Each target
  writes `lib/infinite-outcome` as `.js` or `.mjs` to match the host's module system, exports
  **`infiniteVisitKey`** so a server route can compute the SAME `visitKey` the page view carried, and
  the Vercel-Node helper builds its signed request with a **plain-object header** map (the previous
  `Headers`-instance shape dropped on some Node runtimes). The brief's checkout example threads the
  visit key **checkout → Stripe session metadata → webhook**, so a purchase confirmed in a Stripe
  webhook is attributed to the same visit as the click that started it.
- **The server lane honours Do-Not-Track / Global Privacy Control.** Every generated server lane now
  skips a request whose `DNT: 1` or `Sec-GPC: 1` header is set, matching the browser runtime's
  consent posture — no page or outcome is counted for a visitor who has signalled opt-out.
- **`--infinite-allow-automation`.** The runtime drops automation-driven browsers
  (`navigator.webdriver`) by default; the new flag opts a site back in for its own end-to-end and
  verification runs, where the driven browser IS the thing under test.
- **Richer `cta_location`.** Autocaptured clicks now carry a more specific structural
  `cta_location`, so reporting can tell a nav click from a hero or footer click without ever storing
  DOM text.
- **The harness recommends the funnel work it can't install.** `--check`/`harness` next-steps now
  surface four recommendations an install alone can't wire: funnel identity-merge, post-response
  capture, a privacy disclosure, and the server-side checkout pair (mark the checkout intent AND post
  the server-confirmed purchase). They are advice with evidence, never silent edits.
- **Honest install summaries + a `--check` PostHog audit.** The run summary states exactly what was
  adopted, installed, skipped, or blocked — never an optimistic claim — and `--check` reports what
  PostHog is actually configured to capture so a customer can see gaps before trusting the numbers.
- **Comment- and string-safe provider detection.** Adoption detection no longer treats a provider
  token inside a comment or a string literal as an installed tag, so a mention of `posthog.init` in
  prose can't make the installer skip a real install.
- **The server-lane guide moved to `docs/`.** The long server-lane explainer now lives under `docs/`
  rather than beside the package sources; the install brief still links it.

## 0.8.0 — 2026-09-02

The harness release. One command adopts what a site already has, installs what is missing, marks
conversions, installs a server lane on any stack, verifies each provider with a receipt, and reports.

- **`adMatch` on `postInfiniteOutcome` — the Meta Conversions API relay.** The outcome envelope gains
  an OPTIONAL `adMatch` block (`{ em?, fbc?, fbp?, external_id? }`), carried verbatim inside the
  SIGNED body by every generated lane: the Next.js managed module, the shared edge core (Vercel,
  Netlify, Cloudflare), the Node helper, and `lib/infinite-outcome`. It exists for one founder — the
  one who runs Meta ads and has no PostHog, and whose server-confirmed purchases Meta's optimiser
  therefore never learns about. A PostHog customer needs none of it (PostHog ships its own Meta
  destination; two senders for one conversion is a double count). YOUR server hashes: `em` and
  `external_id` are sha256 hex (`hashInfiniteEmail` is the recipe), so a raw email never leaves your
  process, and a value that is not a 64-character digest is rejected with a `400` rather than
  forwarded. `fbc`/`fbp` are Meta's own first-party cookies on your domain. Infinite forwards the
  outcome at ingest and then DISCARDS the block — it is never stored, logged, or written to the
  ledger — and the `eventId` becomes Meta's `event_id`, so a browser pixel firing the same id
  deduplicates. Nothing is sent without the relay toggle in Infinite → Site → Settings. Documented in
  the agent brief, the README, and `contracts/server-lane-v1.vectors.json` (new `outcomeAdMatch*`
  vectors the receiving side proves against).
  The block also carries the BUYER'S BROWSER `client_ip_address` and `client_user_agent`, and the
  generated helper exports **`adMatchFromRequest(request, { em })`** to fill those plus `_fbc`/`_fbp`
  from your own inbound request. They cannot be derived on Infinite's side: the call to Infinite is
  server-to-server, so its ip is your host's egress address and its user agent is `node`, while
  Meta's spec wants "the IP address of the browser" and "the user agent for the browser … required
  for website events". Validation is split by whose mistake it is — a malformed `em`/`external_id`
  (your own computation) is a 400, while a malformed cookie, ip or user agent is DROPPED and the
  outcome is still recorded, so a visitor's tampered `_fbc` can never delete your conversion. The
  brief and README also now state Meta's four required-parameter skips (no `event_source_url`, no
  `client_user_agent`, an unpriced Purchase, an `event_time` outside the 7-day window), the 48-hour
  `event_id` + `event_name` dedup window and the matching `fbq(..., { eventID })` argument, and the
  verified-domain precondition in Events Manager.
- **The harness names the relay.** When a Meta pixel is on file, every run (`--check` included) adds
  a "Meta relay" line to its next steps: `off` when no server lane reports outcomes, `on locally`
  when both halves are installed — stated as the LOCAL half only, because this command holds no
  session and must never claim a cloud toggle it cannot read.
- **`infinite-tag harness` — one runbook that adopts, installs, marks conversions, verifies and
  reports.** `npx infinite-tag harness [--check | --plan | --apply | --verify-only]` runs the eleven
  steps from the PostHog-wizard teardown in order, each with its own failure code (`INF_ENV_DIRTY_TREE`,
  `INF_DETECT_NO_FRAMEWORK`, `INF_POSTHOG_NO_KEY`, `INF_PLAN_UNMANAGED_TARGET`, `INF_APPLY_ROLLED_BACK`,
  `INF_MARK_STALE_ELEMENT`, `INF_VERIFY_NO_RECEIPT`, `INF_ARGS_CONVERSIONS_REQUIRED`) and a halt/continue
  rule, and always ends with the seven-row state table (`ga4, gtm, posthog, meta, x, infinite,
  server_lane` × `absent / adopted / installed / verified / conflict / skipped`). `verified` is printed
  only with a receipt timestamp. Keys resolve from flags → saved artifacts → real `.env` files, never a
  template; existing snippets and Tag Manager containers are adopted with file + line evidence and their
  public id; conflicts (two ids, managed + unmanaged) install nothing and say why.
- **Conversion marking (propose → confirm → apply).** The harness proposes `data-analytics-cta-id` /
  `data-analytics-cta-location` for the site's anchors and buttons into a gitignored
  `.infinite/conversions.proposed.json`, asks separately (`--yes` never approves it; `--conversions
  <file>` is the non-interactive path, `--no-mark` skips), then writes only those two attributes on the
  exact element after a line-hash pre-image check, recorded and reversible via
  `.infinite/conversions.json`. Elements the runtime already counts (download destination, Stripe hosts,
  `data-conversion`) are never double-marked.
- **Verification backends.** `NoneBackend` (standalone: `installed, not verifiable`), `DesktopBridgeBackend`
  (the running Infinite Desktop reads the receipts back on the CLI's behalf), `InfiniteCloudBackend`
  (`POST /api/analytics/verify`, 60 s / 3 s polling, honest states for 401/404/unreachable),
  `PosthogQueryBackend` (optional `--posthog-query-key`, one bounded HogQL `$pageview` poll). Meta is never
  claimed verified at install time.
- **Verification rides the Desktop bridge — no tokens.** `DesktopBridgeBackend` POSTs the app's loopback
  verb `analytics.verify.v1` (1bu-1 `apps/desktop/src/main/brain/agent/analytics-verify-bridge.ts`), and the
  app — which holds the session and the active workspace — makes the cloud call and returns its status and
  body verbatim, so every Wave 1 decoding still applies. Its one extra shape is `409 not_ready`: the app
  refusing BEFORE it spends a cloud read, naming the exact blocker (`signed_out` / `no_linked_workspace` /
  `subscription_required` / `no_provider` / `booting`). Requires a Desktop that advertises the capability;
  an older one reads `update the Infinite app`.
- **`infinite analytics`** in the `infinite` CLI runs the same runbook with the Desktop's active workspace
  and the saved artifacts, verifying through the Desktop bridge by default and saying which backend answered.
  A cloud bearer in the environment is never used implicitly: `--api-token-env [NAME]` (default
  `INFINITE_API_TOKEN`) is an explicit, advanced escape hatch for machines with no Desktop.
  It sits behind the CLI's Desktop readiness gate (the `infinite` CLI is paid; only `--help` and the
  read-only `--check` are ungated, and a not-ready `--check` ends with the onboarding prompt); the
  standalone `infinite-tag harness` is not gated. A 402 from the cloud verify
  route is `not verifiable (subscription required — complete onboarding in Infinite Desktop)`.
- Every run that writes ends with `.infinite/REPORT.md` and the pasteable handoff line.
- **`uninstall` reverses the harness too:** after the managed install it unmarks every recorded
  conversion (`.infinite/conversions.json`) and removes the harness's own outputs
  (`.infinite/harness.json`: REPORT.md, the proposal, the brief, the `.gitignore` block).

- **The server lane is no longer Next.js-only.** `install --server-lane` now writes runnable,
  manifest-managed, byte-exact reversible files for the host a site actually deploys to, chosen from
  file and dependency evidence in the repo (`vercel.json` wins every tie):
  - **Vercel, any framework** — the root `middleware.ts` Vercel runs framework-agnostically, plus
    `lib/infinite-server-lane.ts`. A Vite/React or static site on Vercel finally gets a real lane.
    The entry imports `@vercel/functions`; the CLI and the brief name the one `npm install` to run.
  - **Netlify** — `netlify/edge-functions/infinite-server-lane.ts`, declared in-file with
    `export const config`, so `netlify.toml` is never edited.
  - **Cloudflare Pages** — `functions/_middleware.ts`, reading its secret from `context.env`. A plain
    Worker still gets the brief's snippet: there is no file of ours to add safely.
  - **Express / any Node server** — `lib/infinite-server-lane.js` plus the exact one-line mount the
    brief names. No server file is edited automatically.
- **An outcome helper every server route can import.** Each target also writes `lib/infinite-outcome`
  exporting `postInfiniteOutcome({ type, path, eventId, accountKey, visitKeyInputs })`, so a Vercel
  `api/` function confirming a paid Stripe session reports a purchase in three lines, carrying the
  same `visitKey` as the page view. The brief gains a "Post a purchase from a server route" section.
- **The pixel's collect path joins the skip list** in every **non-Next** generated lane and matcher,
  alongside `/api/*`, `/_next/*`, `/_vercel/*`, prefetches, non-GETs, non-HTML and anything with an
  extension. The Next.js lane is unchanged and still byte-identical to earlier installs; adding the
  collect path there would move bytes every Next customer already has, so it is a separate change.
  The path is read from the artifact and defaults to `DEFAULT_INFINITE_COLLECT_PATH`, never a copy.
- **`--infinite-api-origin` now moves the server lane too.** The override used to re-point only the
  browser proxy, so a founder who set it would have had a browser lane on one host and a server lane
  on the default one. The resolved origin now flows into every generated lane (Next included), both
  outcome helpers, the brief's transport and verify sections, and `verify --server-lane`'s receipt
  URL. With no override every generated file is byte-identical to before.
- **Uninstall prunes only directories the lane created.** `serverLane.createdDirs` records them (and
  carries across re-runs), so a `netlify/` or `functions/` directory the customer already had — for
  `netlify/`, the very evidence that picked the host — is never removed.
- **Netlify's asset exclusion is per-extension, not `/*.*`.** `excludedPath` takes URLPattern
  expressions and its wildcard is greedy across `/`, so `/*.*` would have excluded any path with a
  dot at any depth, silently dropping a real page like `/v1.0/pricing`. The declaration now lists the
  extensions Netlify's own example uses; it can only under-exclude, and correctness stays in
  `isInfiniteDocumentRequest`.
- Next.js installs are byte-identical: hosting detection never changes that lane.
- A file infinite-tag would create but does not manage is left alone, with its exact content in the
  brief; an unmanaged `lib/infinite-server-lane.*` is a planning blocker, never an overwrite.

## 0.7.0 — 2026-09-02

- **Server-lane copy stops claiming 100% of traffic.** The positioning line (brief + README) now
  reads: "server-side analytics: every page your server serves and every outcome it confirms,
  counted where ad-blockers can't reach. A floor for people, never an exact share — installed by
  your agent in ten minutes."
**Minor bump: the browser contract changes** (`contracts/browser-collect-v1.schema.json`, mirrored
byte-for-byte and hash-pinned in the cloud).

- **Campaign capture on the initial page view.** The `nav: "navigate"` `site_page_view` now carries
  an allowlisted campaign block read from the landing URL: `utm_source` / `utm_medium` /
  `utm_campaign` / `utm_content` / `utm_term` as bounded values (trimmed, control characters
  stripped, 100 chars, absent when empty) and `has_gclid` / `has_fbclid` / `has_ttclid` /
  `has_msclkid` as presence-only `true`. The click-id VALUE and the raw query string are never
  sent; every other parameter is dropped; History-API views carry `nav: "history"` only; click
  events never carry the block. Contract v1 gains those nine keys (`maxProperties` 4 → 13; the
  `site_page_view` branch allows `nav` + the nine).
- **Autocapture is a flag (default on).** `--infinite-autocapture on|off` (artifact field
  `infinite.autocapture: boolean`) — `off` stops unmarked links and buttons from emitting
  `site_click`; marked `data-analytics-cta-id` CTAs, the conversion destination, Stripe checkout
  buckets, `data-conversion="checkout|signup"` markers and sign-up paths still emit. With the flag
  absent the runtime config is byte-identical to 0.6.2, and the `auto_` / `button` / `external_*`
  cta ids are unchanged.
- **Meta pixel now installs with Automatic Configuration off:** `fbq('set', 'autoConfig',
  'false', <id>)` precedes `fbq('init', <id>)`, so no button clicks or page metadata are sent to
  Meta by default. The rest of the snippet is Meta's own native bootstrap, unchanged.
- **Existing tags are adopted instead of refused.** A requested provider that already exists in
  the repo (hand-pasted `gtag`/`posthog.init`/`twq`/`fbq` snippet, or GA4 served through a Google
  Tag Manager container) is left byte-for-byte alone, dropped from the install set, and reported
  under `adopted` (`{ provider, via: "snippet" | "gtm", file }`) — it is no longer a blocker, and
  `infinite-tag` never installs a second copy. Detection now walks the whole app root (bounded:
  2,000 files / 512 KB each, skipping `node_modules`, build output and dot-directories) instead of
  a fixed seven-file list — skipping `public`, `static`, `__tests__`, `__mocks__`, `.storybook`,
  `emails` and `*.d.ts` / `*.test.*` / `*.spec.*` / `*.stories.*` / `*.min.js` files, since a false
  positive silently drops a provider from the install. A Tag Manager verdict needs evidence (the
  `gtm.js` loader, `dataLayer.push(` beside `googletagmanager.com`, a `gtmId` prop, or a quoted
  `GTM-…` id on a line mentioning gtm) — never a bare token or a bare data-layer push. GA4 through
  `@next/third-parties/google`, `react-ga4`, `vue-gtag`, `nuxt-gtag` and
  `@analytics/google-analytics`, and PostHog through `posthog-js/react` / `@posthog/nextjs`, are
  recognised so the site is not double-tagged. When everything requested already exists, `apply`
  writes nothing and records nothing. `detectUnmanagedProviders` returns the object shape above
  (was `string[]`).
- **Default same-origin collect path is now `/infinite/ledger`.** The old `/infinite/events/collect`
  wording matches privacy blocklists; an artifact or install that already records a path keeps it
  (no silent migration). `--infinite-api-origin <https://host>` / `INFINITE_API_ORIGIN` override the
  API host the route proxies to (default `https://api.ultima.inc`); the value is validated as an
  https origin with no path and only ever shapes the Vercel/Next rewrite destination.

## 0.6.2 — 2026-09-02

- **Precise Stripe checkout bucketing.** Hosted Stripe payment surfaces now emit structural
  `site_click` checkout-intent buckets instead of `app_download_click`: Payment Links
  (`buy.stripe.com`, `book.stripe.com`, `donate.stripe.com`), Checkout Sessions
  (`checkout.stripe.com/c/...`), and Hosted Invoice Pages (`invoice.stripe.com/i/...`). Other
  Stripe hosts, including docs, dashboard, support, customer portal, and unmatched paths, stay in
  the generic external-click lane. The runtime still never sends external URLs, query strings, or
  link/button text.
- **Safer unmarked button autocapture.** Standalone unmarked buttons now stay under the generic
  `button` CTA id instead of promoting arbitrary DOM `id` / `name` / test ids. Use explicit
  `data-analytics-cta-id` and `data-analytics-cta-location` markers for cleaner button reporting.

## 0.6.1 — 2026-09-02

- **Safe click autocapture.** The Infinite runtime now captures unmarked same-origin link and button
  clicks as structural `site_click` events, detects direct Stripe Payment Links as
  `app_download_click` conversion intent under `/external/stripe`, buckets other external links
  without storing external URLs, and treats obvious same-origin sign-up routes as `sign_up_click`
  intent. It still never captures DOM text, link text, button text, form values, query strings, or
  fragments.
- **Conversion path is a first-class CLI flag.** `--infinite-download-destination-path <path>` lets
  agents install checkout-style funnels (`/checkout` before Stripe, for example) without hand-editing
  the managed runtime.
- **Package-install UX.** `npm i infinite-tag` now prints the next command so a dependency install is
  not mistaken for completed instrumentation.

## 0.6.0 — 2026-08-19

**The consolidated truth-train release: providers stay independent; the runtime tells the truth
about page views.** A minor bump because the install CONFIG changes (mirror mode is removed).

- **Mirror mode removed.** The Infinite runtime now emits ONLY to Infinite's same-origin collect
  route. It no longer translates `site_page_view` → GA4 `page_view` / PostHog `$pageview`,
  `app_download_click` → `app_download_clicked`, or `sign_up_click` → GA4 `sign_up`; it no longer
  calls PostHog `set_config` / `opt_in_capturing` / `opt_out_capturing`, no longer drives the GA4
  consent bridge (`__infiniteGa4Consent` is gone), and no longer polls for provider globals
  before binding — it binds immediately. `InfiniteBrowserConfig.mirrors` is gone. Why (founder
  decision): healthy providers stay fully independent — the GA4 mirror already duplicated
  enhanced-measurement page_views on SPAs, and a provider that the installer had "reduced" was a
  provider nobody else could trust.
- **GA4 / PostHog bootstraps are FULL NATIVE.** GA4 = Google's own `gtag.js` snippet (loader +
  `dataLayer` + `gtag('js')` + `gtag('config', ID)` with the default `send_page_view`), no consent
  default queued by Infinite. PostHog = `posthog.init(key, { api_host, [ui_host], defaults:
  '2025-05-24' })` — PostHog's own autocapture / page views / pageleave / session recording /
  persistence / opt-in state. Installers only do explicit native setup or repair and never reduce
  a provider; consent for a provider is the site's own, exactly as with a hand-pasted snippet.
- **No dormant "mirror-only" runtime.** A GA4/PostHog install with no Infinite source embeds no
  Infinite runtime at all (there is nothing for it to do). Top-level `productionHosts` still
  scope the Infinite runtime when an Infinite source is present.
- **`navigator.webdriver` check.** When true the runtime emits nothing — automation-driven
  browsers (Playwright, Puppeteer, Lighthouse) are not visitors.
- **`nav` on `site_page_view`.** Every page view carries `properties.nav`: `"navigate"` for the
  initial document load, `"history"` for History-API route changes (pushState / replaceState /
  popstate); the pathname-only dedupe is unchanged. A consent grant after the load emits the
  current page as the initial view. `contracts/browser-collect-v1.schema.json` admits the bounded
  enum (optional — 0.5.x tags send no page-view properties).
- **Requires the receiving side.** Infinite's cloud collect endpoint must accept
  `properties.nav` on `site_page_view` before a 0.6.0 tag is installed anywhere — a collect
  endpoint on the pre-0.6.0 contract rejects the page view (`invalid_event`). Ship the cloud
  change first; then publish / pin this version.
- The Infinite consent contract (DNT/GPC default, explicit gesture-gated decision overrides it,
  `required` mode dormant until granted, `infinite:analytics-consent-change`) is unchanged.

## 0.5.0 — 2026-08-18

**Server lane (lossless analytics).** Customers get the same server-side Visitors / outcome /
rate board Infinite runs on its own site, installed by their coding agent.

- `install --server-lane` (also `plan` / `apply`): on Next.js creates `middleware.ts` (`proxy.ts`
  on 16+) or patches an existing one with fenced `// infinite-tag:server-lane:start … :end`
  blocks that wrap the existing handler; writes the managed `lib/infinite-server-lane.ts`
  (WebCrypto, Edge-safe) and the agent brief `INSTALL-SERVER-LANE.md`. Every write is
  manifest-tracked (`serverLane` + a new `text-edits` ownership kind) and `uninstall` reverses
  it byte-for-byte. Unrecognized middleware shapes and narrow matchers are refused, not guessed;
  the brief then carries the exact addition. Works alone (no browser artifacts) or with them.
- Every other stack gets the brief (written for Vite/static, printed for unrecognized repos);
  `server-lane --brief` prints it without installing.
- `verify --server-lane <url>`: loads the page like a browser, polls Infinite's receipt endpoint
  with the source key + HMAC signature (over the raw query string), prints PASS/FAIL with the most
  likely cause. Needs `INFINITE_SERVER_EVENT_SECRET` in the environment; never persisted.
- Contract constants: `INFINITE_API_ORIGIN` (one place for the api host),
  `INFINITE_SERVER_EVENTS_DESTINATION`, `INFINITE_SERVER_LANE_RECEIPT_URL`; recipe vectors in
  `contracts/server-lane-v1.vectors.json`.
- All server-lane prose lives in `src/server-lane/copy.ts`.
- **Requires the receiving side.** `--server-lane` installs and `verify --server-lane` only prove
  out once Infinite's API serves the server lane (the signed `site_document_request` ingest on
  `/api/analytics/events/server` and the `/api/analytics/site/server-lane/receipt` route). Before
  that, deliveries are refused and `verify` reports `receipt_unavailable` / `unauthorized`; the
  0.4.0 pixel install is unaffected either way.

## 0.4.0 — 2026-08-18

- `sign_up_click` intent emitter + parameterized download destination (see #135).
