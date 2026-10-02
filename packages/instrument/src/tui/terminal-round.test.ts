// The terminal round (final verify F1, F3, F5 and the terminal QA's display items): what a customer SEES.
// Every test here fails on the code before the round (each was checked against the old source).
import { describe, expect, it, vi } from "vitest"

import { FakeStdin, FakeStdout, FakeStore, flushMicrotasks, makeSnapshot, makeTestSanitizer, midRunSnapshot, stepRows } from "../../test/wizard/fake-store.js"
import type { AskPayloads, PlanLine } from "../wizard/contracts/asks.js"
import { makeStyles, stripAnsi, visibleWidth, wrapAnsi } from "./ansi.js"
import { renderFrame, type FrameInput } from "./frame.js"
import { LEARN_CARDS, learnCard } from "./learn.js"
import { OVERLAYS } from "./overlays/index.js"
import type { OverlayContext } from "./overlays/types.js"
import { TtyUi } from "./tty-ui.js"

function frame(change: Partial<FrameInput> = {}): string[] {
  return renderFrame({
    snapshot: midRunSnapshot(),
    width: 120,
    height: 40,
    styles: makeStyles(true),
    sanitize: makeTestSanitizer(),
    spinnerIndex: 0,
    overlay: null,
    outro: null,
    ...change
  })
}

/** The text a person reads off the screen: styling removed, box borders removed, wrapped rows joined. */
function readable(lines: readonly string[]): string {
  return lines
    .map((line) => stripAnsi(line).replace(/[│╭╮╰╯─]/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
}

const line = (id: string, kind: PlanLine["kind"], text: string, extra: Partial<PlanLine> = {}): PlanLine => ({ id, kind, text, requires: "approval", editable: false, ...extra })

/** The plan of the recorded QA run: 15 lines, the wizard's own wording (10 of them were cut at 96 characters). */
const PLAN_LINES: PlanLine[] = [
  line("consent_mode", "consent_mode", "Consent: choose — collect by default, or wait for your cookie banner's yes (covers Infinite only)", { editable: true }),
  line("conversion_names", "conversion_names", "Conversions: signup", { editable: true }),
  line("privacy_text", "privacy_text", "Privacy: 4 drafted lines for app/privacy/page.tsx", { editable: true }),
  line("npm_install", "npm_install", "Install the server-lane package (runs its install scripts): npm install @vercel/functions", { editable: true }),
  line("install_provider:infinite", "install_provider", "Install Infinite"),
  line(
    "server_lane",
    "server_lane",
    "Server lane (Next.js middleware): counts every page request on your server, even with ad blockers. After you merge, the one real test visit lands TWO bot-flagged page rows in your Infinite ledger (the visit itself and a server-lane probe). The no-send checks before that land none."
  ),
  line("improve_additive:posthog:proxy", "improve_additive", "PostHog: send through /ingest on your own domain, so ad blockers do not drop it. Changes your existing PostHog setup.", { ownership: "adopted" }),
  line("improve_additive:posthog:history_change", "improve_additive", "PostHog: count page changes in your single-page app (capture_pageview: 'history_change'). Changes your existing PostHog setup.", { ownership: "adopted" }),
  line(
    "posthog_defaults_bump_adopted:posthog",
    "posthog_defaults_bump_adopted",
    "PostHog: update your existing setup to PostHog's current recommended settings (defaults '2026-01-30'). This changes how PostHog measures; the report marks it \"measurement changed\", never growth."
  ),
  line("remove_duplicate:ga4:G-FAKE00001", "remove_duplicate", "GA4: G-FAKE00001 is set up 2 times in your code, so page views count more than once. Keep one.", { measured: { value: "2 page views per visit", window: "dry load" } }),
  line("preview_guard_adopted:ga4", "preview_guard_adopted", "Previews stay silent for your existing GA4, PostHog and Meta tags; acme-store.com and www.acme-store.com always fire."),
  line("sensitive_pages", "sensitive_pages", "PostHog: no session replay and no autocapture on sensitive pages (/login, /account/billing)."),
  line("meta_relay", "meta_relay", "Meta server events: send your server-side conversions to Meta through Infinite, with ONE shared event id so the browser and server never count twice."),
  line("checkin", "checkin", "Infinite checks your site again 7 days after the deploy and shows you what it finds.", { requires: "info" }),
  line("agent_budget", "agent_budget", "Claude Code: 11 jobs · Opus 4.8 at xhigh effort · up to 30 turns or 10 min · your Claude plan pays (Infinite pays $0)")
]

const planPayload = (lines: PlanLine[] = PLAN_LINES): AskPayloads["plan"] => ({
  lines,
  decisions: { consentMode: null, conversionNames: ["signup"], privacyText: "one\ntwo\nthree\nfour", npmInstall: "npm install @vercel/functions" }
})

function planFrame(width: number, height: number, payload = planPayload(), keys = ""): string[] {
  let state = OVERLAYS.plan.init(payload)
  for (const key of keys) {
    state = OVERLAYS.plan.onKey(payload, state, key === "↓" ? { name: "down" } : { name: "char", char: key }).state
  }
  const overlay = (ctx: OverlayContext) => OVERLAYS.plan.render(payload, state, ctx)
  const snapshot = makeSnapshot({
    steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "ok" }, keys: { state: "ok" }, plan: { state: "running" } }),
    currentStep: "plan",
    pendingAsk: { askId: "a1", kind: "plan", payload }
  })
  return frame({ snapshot, overlay, width, height })
}

/** A plan line as the screen words it (its text, then the measured value in brackets). */
const shown = (planLine: PlanLine): string => (planLine.measured ? `${planLine.text} (${planLine.measured.value} · ${planLine.measured.window})` : planLine.text)

describe("F1: the plan screen shows the FULL text of every line the user approves", () => {
  for (const width of [80, 100, 120]) {
    it(`${width} columns: every plan line is on screen in full, wrapped under its text, never cut`, () => {
      const lines = planFrame(width, 90)
      const text = readable(lines)
      for (const planLine of PLAN_LINES) expect(text, planLine.id).toContain(shown(planLine).replace(/\s+/g, " "))
      // Nothing in the box is cut, and the box never runs past the terminal.
      const box = lines.map(stripAnsi).filter((row) => /│\s*$/.test(row))
      expect(box.length).toBeGreaterThan(PLAN_LINES.length)
      for (const row of box) expect(row).not.toContain("…")
      for (const row of lines) expect(visibleWidth(row)).toBeLessThan(width)
      // The keys stay on screen below the lines.
      expect(text).toContain("ENTER approve")
      expect(text).toContain("ESC later")
    })
  }

  it("a wrapped line continues under its own text (a hanging indent), and the box border stays closed in colour", () => {
    const lines = planFrame(80, 90)
    const rows = lines.map(stripAnsi)
    const first = rows.findIndex((row) => row.includes("[✓] Server lane (Next.js middleware)"))
    expect(first).toBeGreaterThan(0)
    const textColumn = rows[first]!.indexOf("Server lane")
    // The next row is the same plan line: it starts exactly under the text, with no marker.
    expect(rows[first + 1]!.slice(0, textColumn).replace(/[│ ]/g, "")).toBe("")
    expect(rows[first + 1]!.charAt(textColumn)).not.toBe(" ")
    expect(rows[first + 1]).not.toContain("[✓]")
    // Every box row ends with the dim border: a style open at a break never bleeds into it.
    for (const row of lines.filter((candidate) => stripAnsi(candidate).includes("│"))) expect(row.endsWith("\x1b[2m│\x1b[22m")).toBe(true)
  })

  it("the box uses the terminal's width: at 120 columns it is wider than the old 100-column cap", () => {
    const top = planFrame(120, 60).map(stripAnsi).find((row) => row.includes("╭")) ?? ""
    expect(top.trim().length).toBeGreaterThan(110)
  })

  it("negative: a 300-character line is shown in full at 80, 100 and 120 columns (it was cut at 96)", () => {
    const long = `Meta: ${"a very long sentence about one existing tag that must be read before it is approved ".repeat(4)}`.trim().slice(0, 300)
    expect(long.length).toBe(300)
    const payload = planPayload([PLAN_LINES[0]!, line("remove_duplicate:meta", "remove_duplicate", long), PLAN_LINES[14]!])
    for (const width of [80, 100, 120]) {
      const lines = planFrame(width, 40, payload)
      expect(readable(lines), `${width} columns`).toContain(long.replace(/\s+/g, " "))
      expect(lines.map(stripAnsi).join("\n")).not.toContain("…")
    }
  })

  it("a short terminal scrolls whole lines: the line under the cursor is always in full, and the rest is counted", () => {
    const seen = new Set<string>()
    for (let down = 0; down < PLAN_LINES.length; down += 1) {
      const lines = planFrame(120, 36, planPayload(), "↓".repeat(down))
      expect(lines.length).toBeLessThanOrEqual(36)
      const text = readable(lines)
      // The cursor's line: full text, and the keys are still on screen.
      expect(text, PLAN_LINES[down]!.id).toContain(shown(PLAN_LINES[down]!).replace(/\s+/g, " "))
      expect(text).toContain("ENTER approve")
      for (const planLine of PLAN_LINES) if (text.includes(shown(planLine).replace(/\s+/g, " "))) seen.add(planLine.id)
      // A line is on screen in full or not at all (never half of one).
      for (const row of lines.map(stripAnsi).filter((candidate) => /│\s*$/.test(candidate))) expect(row).not.toContain("…")
    }
    // Walking the cursor through the plan puts every line on screen in full.
    expect([...seen].sort()).toEqual(PLAN_LINES.map((planLine) => planLine.id).sort())
    // What is not on screen is counted, so the user knows there is more to read.
    expect(readable(planFrame(120, 36))).toMatch(/↓ \d+ more lines? below/)
    expect(readable(planFrame(120, 36, planPayload(), "↓".repeat(14)))).toMatch(/↑ \d+ more lines? above/)
  })

  it("QA #14: after E the consent line itself says what was chosen (not only the summary above)", () => {
    const before = readable(planFrame(120, 60))
    expect(before).not.toContain("→ chosen:")
    const after = readable(planFrame(120, 60, planPayload(), "e"))
    expect(after).toContain("(covers Infinite only) → chosen: collect by default (covers Infinite only)")
    expect(readable(planFrame(120, 60, planPayload(), "ee"))).toContain("→ chosen: wait for consent")
  })
})

describe("wrapAnsi", () => {
  const styles = makeStyles(true)
  it("wraps styled text to the width with a hanging indent and loses no character", () => {
    const text = `${styles.accent("▸")} ${styles.ok("[✓]")} ${"word ".repeat(30).trim()}${styles.dim(" (2 per visit · dry load)")}`
    const rows = wrapAnsi(styles.bold(text), 40, 6)
    expect(rows.length).toBeGreaterThan(3)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
    for (const row of rows.slice(1)) expect(stripAnsi(row).startsWith("      ")).toBe(true)
    expect(rows.map((row) => stripAnsi(row).trim()).join(" ")).toBe(stripAnsi(text))
  })

  it("closes the open style at a break and re-opens it on the next row (negative: an unstyled text adds no sequence)", () => {
    const rows = wrapAnsi(styles.bold("alpha beta gamma delta epsilon zeta"), 12)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows.slice(0, -1)) expect(row.endsWith("\x1b[0m")).toBe(true)
    for (const row of rows.slice(1)) expect(row.startsWith("\x1b[1m")).toBe(true)
    expect(wrapAnsi("alpha beta gamma delta epsilon zeta", 12).join("")).not.toContain("\x1b")
  })

  it("hard-splits a word wider than the row instead of cutting it", () => {
    const url = `https://github.com/acme/acme-store/pull/42?${"x".repeat(60)}`
    const rows = wrapAnsi(url, 30)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(30)
    expect(rows.join("")).toBe(url)
  })

  it("a text that fits is returned as it is", () => {
    expect(wrapAnsi("fits", 10)).toEqual(["fits"])
  })
})

describe("F3: the merge prompt says each sentence once, with the branch and the files changed", () => {
  const ctx = (): OverlayContext => ({ width: 96, maxBodyLines: 20, styles: makeStyles(false), sanitize: makeTestSanitizer(), spinner: "⠋" })
  const payload = {
    prUrl: "https://github.com/acme/acme-store/pull/42",
    number: 42,
    summary: "Reviewed by Codex · rehearsal passed.\ninfinite/tag/2026-10-02-7f3c2a → main\n9 files changed · rehearsal passed on the latest commit"
  }

  it("the question is the design's sentence, once; the detail rows sit under it, then the link", () => {
    const view = OVERLAYS["merge-ready"].render(payload, {}, ctx())
    expect(view.question).toBe("Pull request #42 is ready. Reviewed by Codex · rehearsal passed. Merge it to ship.")
    expect(view.body).toEqual(["· infinite/tag/2026-10-02-7f3c2a → main", "· 9 files changed · rehearsal passed on the latest commit", "https://github.com/acme/acme-store/pull/42"])
    for (const sentence of ["is ready.", "Merge it to ship."]) expect(view.question.split(sentence).length - 1, sentence).toBe(1)
  })

  it("negative: a host with no pull request never says 'Pull request #0 is ready'", () => {
    const view = OVERLAYS["merge-ready"].render({ prUrl: "infinite/tag/x", number: 0, summary: "Merge infinite/tag/x into main on your git host." }, {}, ctx())
    expect(view.question).toBe("Merge infinite/tag/x into main on your git host.")
    expect(view.keys.join(" ")).not.toContain("GitHub")
  })

  it("in the frame the box title is not repeated by the heading (QA #10: 'Link to Infinite' twice)", () => {
    const linkPayload = { code: "4729", site: { repoLabel: "github.com/acme/acme-store", appRoot: ".", folderLabel: "~/Github/acme-store" } }
    const snapshot = makeSnapshot({ currentStep: "link", steps: stepRows({ link: { state: "running" } }), pendingAsk: { askId: "l", kind: "link-code", payload: linkPayload } })
    const text = frame({ snapshot, overlay: (overlayCtx) => OVERLAYS["link-code"].render(linkPayload, {}, overlayCtx) }).map(stripAnsi).join("\n")
    const box = text.slice(text.indexOf("╭"))
    expect(box.split("Link to Infinite").length - 1).toBe(1)
    expect(box).toContain("4 7 2 9")
  })
})

describe("QA #9: the status line wraps instead of being cut at the screen edge", () => {
  it("a step's description is on screen in full at 120 and at 80 columns", () => {
    const snapshot = makeSnapshot({ currentStep: "before", steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "running" } }) })
    for (const width of [120, 80]) {
      const lines = frame({ snapshot, width })
      const text = readable(lines)
      expect(text, `${width}`).toContain("recording every tag request and cancelling it, so nothing is sent.")
      expect(lines.map(stripAnsi).join("\n")).not.toContain("…")
      for (const row of lines) expect(visibleWidth(row)).toBeLessThan(width)
    }
  })

  it("a tall terminal shows every sub-status the store keeps (8); a 24-row one keeps the last 5", () => {
    const subs = Array.from({ length: 8 }, (_, index) => ({ text: `sub line ${index + 1}`, tone: "info" as const, at: "2026-10-02T09:12:00.000Z" }))
    const snapshot = makeSnapshot({ currentStep: "review", steps: stepRows({ review: { state: "running", status: "Reviewing", subs } }) })
    const tall = frame({ snapshot, height: 40 }).map(stripAnsi).join("\n")
    expect(tall).toContain("sub line 1")
    const short = frame({ snapshot, height: 24 }).map(stripAnsi).join("\n")
    expect(short).not.toContain("sub line 3")
    expect(short).toContain("sub line 4")
    expect(short).toContain("sub line 8")
  })
})

describe("QA #12: the Learn cards name what the run knows", () => {
  it("before the run knows, the cards keep the wording that is true without it", () => {
    expect(learnCard("link", undefined)).toBe(LEARN_CARDS.link)
    expect(learnCard("agent", {}).rows[0]).toEqual(["Does the work", "your Claude Code or Codex", ""])
  })

  it("after the link and the agent step they name the site, the workspace and the two agents", () => {
    const facts = { site: "acme-store", workspace: "Acme", worker: "claude_code" as const, reviewer: "codex" as const }
    expect(learnCard("link", facts).rows.slice(0, 2)).toEqual([["This site", "acme-store", ""], ["Workspace", "Acme", "g"]])
    expect(learnCard("agent", facts).rows.slice(0, 2)).toEqual([["Does the work", "Claude Code", ""], ["Reviews it", "Codex, read-only", "i"]])
    expect(learnCard("review", facts).rows[0]).toEqual(["Reviewer", "Codex (read-only)", "i"])
    const snapshot = makeSnapshot({ currentStep: "review", learn: "review", learnFacts: facts, steps: stepRows({ review: { state: "running" } }) })
    // The dot leader is back: the value fits its row (it was pushed onto a second row before).
    expect(frame({ snapshot }).map(stripAnsi).join("\n")).toMatch(/Reviewer ·+ Codex \(read-only\)/)
  })

  it("a workspace name is outside text: it goes through the sanitiser", () => {
    const sanitize = makeTestSanitizer()
    const snapshot = makeSnapshot({ currentStep: "link", learn: "link", learnFacts: { workspace: "Acme\x1b[2J" }, steps: stepRows({ link: { state: "running" } }) })
    const lines = frame({ snapshot, sanitize })
    expect(sanitize.calls).toContain("Acme\x1b[2J")
    expect(lines.join("\n")).not.toContain("\x1b[2J")
  })
})

describe("F5: the closing screen", () => {
  function setup(rows = 40) {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout(120, rows)
    const interrupts: number[] = []
    const ui = new TtyUi({ stdin, stdout, env: {}, sanitize: makeTestSanitizer(), onInterrupt: () => interrupts.push(1), spinnerIntervalMs: 0, registerExitHook: false })
    const store = new FakeStore(midRunSnapshot())
    return { stdin, stdout, ui, store, interrupts }
  }

  it("Ctrl+C on the closing screen closes it like Q and does not interrupt the (finished) run", async () => {
    const { stdin, ui, store, interrupts } = setup()
    ui.start(store)
    ui.setOutro("◆ acme-store.com collects analytics properly now · run r-7f3c · 9 min")
    await flushMicrotasks()
    const dismissed = vi.fn()
    void ui.waitForDismiss().then(dismissed)
    await flushMicrotasks()
    expect(dismissed).not.toHaveBeenCalled()
    stdin.type("\x03")
    await flushMicrotasks()
    expect(dismissed).toHaveBeenCalled()
    expect(interrupts).toEqual([])
    ui.stop()
  })

  it("negative: Ctrl+C with no closing screen still interrupts the run", async () => {
    const { stdin, ui, store, interrupts } = setup()
    ui.start(store)
    stdin.type("\x03")
    await flushMicrotasks()
    expect(interrupts).toEqual([1])
    ui.stop()
  })

  it("a table taller than the terminal keeps its keys on screen and says the rest stays in the terminal", () => {
    const outro = ["◆ acme-store.com collects analytics properly now · run r-7f3c · 9 min", ...Array.from({ length: 50 }, (_, index) => `row ${index + 1}`)].join("\n")
    const lines = frame({ outro, height: 24 }).map(stripAnsi)
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(lines.join("\n")).toContain("collects analytics properly now")
    expect(lines.join("\n")).toMatch(/… \d+ more lines: the full table stays in your terminal when you close this/)
    expect(lines.at(-1)).toContain("ENTER close")
    // A short table shows whole, with the same keys.
    const short = frame({ outro: "◆ done\nrow 1", height: 24 }).map(stripAnsi).join("\n")
    expect(short).toContain("row 1")
    expect(short).not.toContain("more line")
    expect(short).toContain("ENTER close")
  })

  it("a closing line wider than the screen wraps (it was cut with …)", () => {
    const long = `◆ ${"acme-store.com collects analytics properly now ".repeat(5)}`.trim()
    const lines = frame({ outro: long, width: 80 })
    expect(readable(lines)).toContain(long)
    expect(lines.map(stripAnsi).join("\n")).not.toContain("…")
  })
})
