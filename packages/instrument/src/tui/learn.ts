// The Learn cards (the design's `v6-data.js` `__LEARN`) and each step's one-line "what it does" copy, as the
// TTY UI shows them beside the step list.
//
// Copied from the design (ui-artifacts/2026-10-01-infinite-tag-wizard/src/v6-data.js) with these honest-copy
// changes (the design is a mock of one example run; a real run must not claim what it does not know):
// - `agent` card, "Infinite's key folder": "Claude: blocked by path rules · Codex: only when its read block is
//   proven" (plan O2; R1-05/R2-02), not "blocked / card";
// - the `settings` step copy never says the build restarts (§3d.1 STEP_COPY_OVERRIDES);
// - example values from the mock run ("acme-store.com", workspace "Acme", "Claude Code"/"Codex" in fixed
//   roles, "connected" for every key) are replaced by what is true before the run knows: the agent and the
//   workspace are named in the step's own status lines instead.
import type { WizardStoreSnapshot } from "../wizard/contracts/state.js"
import { STEP_COPY_OVERRIDES, type LearnId, type WizardStepId } from "../wizard/contracts/steps.js"

/** `g` good, `i` info, `y` needs you, `` plain (the design's row tones). */
export type LearnTone = "g" | "i" | "y" | ""

export interface LearnCard {
  title: string
  sub: string
  rows: ReadonlyArray<readonly [label: string, value: string, tone: LearnTone]>
}

export const LEARN_CARDS: { readonly [Id in LearnId]: LearnCard } = {
  link: {
    title: "Link once, then it's remembered",
    sub: "One site, one workspace.",
    rows: [
      ["This site", "this repo + app", ""],
      ["Workspace", "you pick it in the app", "g"],
      ["Needs", "the Infinite app", "y"],
      ["Remove it", "Settings › Linked sites", ""]
    ]
  },
  agent: {
    title: "Two agents, two jobs",
    sub: "Both on your own account.",
    rows: [
      ["Does the work", "your Claude Code or Codex", ""],
      ["Reviews it", "the other one, read-only", "i"],
      ["Infinite's AI bill", "$0", "g"],
      ["Infinite's key folder", "Claude: blocked by path rules · Codex: only when its read block is proven", "y"]
    ]
  },
  standard: {
    title: "The finish line (from infinite.fast)",
    sub: "Collecting properly means:",
    rows: [
      ["Each tag once per page", "check", "i"],
      ["Previews send nothing", "check", "i"],
      ["Survives ad blockers", "check", "i"],
      ["Conversions on the server", "check", "i"],
      ["Proof from a real visit", "check", "i"]
    ]
  },
  keys: {
    title: "Keys from Infinite",
    sub: "Public IDs only.",
    rows: [
      ["PostHog project key", "from your connection", "g"],
      ["GA4 measurement ID", "from your connection", "g"],
      ["Meta pixel", "from your connection", "g"],
      ["Server-lane secret", "saved on Vercel", "i"]
    ]
  },
  asks: {
    title: "What only you decide",
    sub: "Everything else is done for you.",
    rows: [
      ["Consent", "legal", "y"],
      ["Conversion names", "your data", "y"],
      ["Privacy text", "legal", "y"],
      ["Merging", "shipping", "y"]
    ]
  },
  checklist: {
    title: "The agent's checklist",
    sub: "The agent claims; the wizard checks.",
    rows: [
      ["Agent says done", "not enough", "y"],
      ["Code check", "wizard runs it", "i"],
      ["Build + offline test", "wizard runs it", "i"],
      ["Live test", "after merge", "i"]
    ]
  },
  tests: {
    title: "Tests every run",
    sub: "Three moments.",
    rows: [
      ["Before", "nothing sent", "g"],
      ["Rehearsal", "nothing sent", "g"],
      ["After merge", "1 real visit", "y"]
    ]
  },
  review: {
    title: "Second-agent review",
    sub: "On GitHub, in the pull request.",
    rows: [
      ["Reviewer", "second agent, read-only", "i"],
      ["Posted by", "the wizard", ""],
      ["Fix rounds", "up to 2", ""],
      ["Ships when", "you merge", "y"]
    ]
  },
  proof: {
    title: "How it's proven",
    sub: "Best proof each tool can give.",
    rows: [
      ["Infinite + server lane", "receipt", "g"],
      ["PostHog", "this visit by ID", "g"],
      ["GA4", "sent (seen leaving)", "i"],
      ["Meta", "sent, domain allowed", "i"]
    ]
  },
  after: {
    title: "After setup",
    sub: "It keeps checking.",
    rows: [
      ["Report", "Site Settings", "i"],
      ["Check-in", "in 7 days", "y"],
      ["Re-run any time", "npx infinite-tag", ""],
      ["Undo code changes", "uninstall", ""]
    ]
  }
}

export type LearnFacts = NonNullable<WizardStoreSnapshot["learnFacts"]>

const AGENT_NAME = { claude_code: "Claude Code", codex: "Codex" } as const

/**
 * The card as the run knows it NOW (terminal QA #12): once the link is approved the card names the site and the
 * workspace, and once the agents are found it names them, as the design does. Until then it keeps the wording
 * above, which is true without knowing. `clean` is the UI's sanitiser (a workspace name is outside text).
 */
export function learnCard(id: LearnId, facts: LearnFacts | undefined, clean: (text: string) => string = (text) => text): LearnCard {
  const card = LEARN_CARDS[id]
  if (!facts) return card
  const worker = facts.worker ? AGENT_NAME[facts.worker] : null
  const reviewer = facts.reviewer === "brief" ? "a printed brief" : facts.reviewer ? AGENT_NAME[facts.reviewer] : null
  const swap: Record<string, string | null> =
    id === "link"
      ? { "This site": facts.site ? clean(facts.site) : null, Workspace: facts.workspace ? clean(facts.workspace) : null }
      : id === "agent"
        ? { "Does the work": worker, "Reviews it": reviewer && facts.reviewer !== "brief" ? `${reviewer}, read-only` : reviewer }
        : id === "review"
          ? { Reviewer: reviewer && facts.reviewer !== "brief" ? `${reviewer} (read-only)` : reviewer }
          : {}
  return { ...card, rows: card.rows.map(([label, value, tone]) => [label, swap[label] || value, tone] as const) }
}

/** Each step's "what it does" and "if it gets stuck" (the design's `what` / `stuck`, honest-copy edits applied). */
export const STEP_COPY: { readonly [Id in WizardStepId]: { what: string; stuck: string } } = {
  link: {
    what: "Pairs this site (folder, repo and app) with one Infinite workspace. Once per site. Needs the paid Infinite app.",
    stuck: "No Infinite app: the wizard shows where to get it. The tag only works with the app."
  },
  agent: {
    what: "Finds Claude Code or Codex, checks you are logged in and which plan or key pays. Spends no prompt.",
    stuck: "No agent installed: the code jobs still run; the agent jobs are listed for you."
  },
  before: {
    what: "Makes a new branch from the production branch first. Then scans the code and loads the live site in a hidden window, recording every tag request and cancelling it, so nothing is sent.",
    stuck: "An unusual layout: the agent finds the app."
  },
  keys: {
    what: "Uses the PostHog, GA4 and Meta you connected in Infinite, and checks the live site uses the same IDs.",
    stuck: "Not connected: connect it in Infinite. It never makes up a key."
  },
  plan: {
    what: "One screen: every job it will do, and the only decisions that are yours.",
    stuck: "You say no to a line: that job is skipped."
  },
  install: {
    what: "Writes the tags, the PostHog proxy and the server lane, and checks the build.",
    stuck: "The build breaks: changes roll back and the agent fixes the cause."
  },
  jobs: {
    what: "The agent works through its checklist. It can only say \"I think it's done\". The wizard runs its own check on every job before ticking it.",
    stuck: "Out of usage: its edits are undone; run again when the limit resets."
  },
  settings: {
    what: STEP_COPY_OVERRIDES.settings.what,
    stuck: "No Vercel connection: connect it in Infinite."
  },
  rehearsal: {
    what: "Opens a draft pull request, then loads its Vercel preview under your production host in a hidden window. Every beacon is recorded and cancelled, so nothing is sent.",
    stuck: "A test fails: the agent fixes it and the rehearsal runs again."
  },
  review: {
    what: "The second agent reviews the pull request read-only against the checklist. The wizard posts the review on GitHub, the first agent fixes what's valid, and the rehearsal re-runs on the new commit.",
    stuck: "No second agent: the wizard prints a ready-made review brief for any agent."
  },
  merge: {
    what: "Shipping is your decision. The wizard never pushes to main or ships new code by itself.",
    stuck: "You close the terminal: running npx infinite-tag again picks up the open pull request."
  },
  prove: {
    what: "After the deploy, Infinite makes ONE real test visit and collects the best proof each tool can give.",
    stuck: "A tool shows nothing: it names the likely cause."
  },
  done: {
    what: "A before-and-after summary, the same report in the Infinite app, and a check-in card 7 days later.",
    stuck: ""
  }
}
