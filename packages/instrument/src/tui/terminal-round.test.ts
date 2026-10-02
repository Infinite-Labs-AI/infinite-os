// The terminal round (final verify F1, F3, F5 and the terminal QA's display items): what a customer SEES.
// Every test here fails on the code before the round (each was checked against the old source).
import { describe, expect, it, vi } from "vitest"

import { FakeStdin, FakeStdout, FakeStore, flushMicrotasks, makeSnapshot, makeTestSanitizer, midRunSnapshot, stepRows } from "../../test/wizard/fake-store.js"
import type { AskPayloads, PlanLine } from "../wizard/contracts/asks.js"
import { makeStyles, stripAnsi, visibleWidth, wrapAnsi } from "./ansi.js"
import { exitLine, exitLines } from "./exit-line.js"
import { overlayContext, renderFrame, type FrameInput } from "./frame.js"
import { LEARN_CARDS, learnCard } from "./learn.js"
import { OVERLAYS } from "./overlays/index.js"
import type { PlanState } from "./overlays/plan.js"
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
      expect(text).toMatch(/ENTER (approve|read on)/)
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

  it("every Learn value that can sit beside its label does (a value pushed to a second row loses its dot leader)", () => {
    const text = frame({ snapshot: makeSnapshot({ currentStep: "keys", learn: "keys", steps: stepRows({ keys: { state: "running" } }) }) }).map(stripAnsi).join("\n")
    for (const label of ["PostHog project key", "GA4 measurement ID", "Meta pixel"]) expect(text).toMatch(new RegExp(`${label} ·+ your connection`))
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

// ---------------------------------------------------------------------------------------------------------
// Terminal round 2 (final verify round 2: F1b, F11, F13).

const PLAN_SNAPSHOT = (payload: AskPayloads["plan"]) =>
  makeSnapshot({
    steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "ok" }, keys: { state: "ok" }, plan: { state: "running" } }),
    currentStep: "plan",
    pendingAsk: { askId: "a1", kind: "plan", payload }
  })

type PlanKey = "↓" | "↑" | "enter" | "space" | "e"

/** Drives the plan like `TtyUi` does: each key gets the box the screen was drawn in. Returns every screen drawn. */
function drivePlan(width: number, height: number, payload: AskPayloads["plan"], keys: readonly PlanKey[]) {
  let state: PlanState = OVERLAYS.plan.init(payload)
  let answer: unknown
  const snapshot = PLAN_SNAPSHOT(payload)
  const draw = () => frame({ snapshot, width, height, overlay: (ctx: OverlayContext) => OVERLAYS.plan.render(payload, state, ctx) })
  const frames = [draw()]
  for (const key of keys) {
    const current = state
    const ctx = overlayContext({ snapshot, width, height, styles: makeStyles(true), sanitize: makeTestSanitizer(), spinnerIndex: 0, overlay: (overlayCtx) => OVERLAYS.plan.render(payload, current, overlayCtx) })
    const outcome = OVERLAYS.plan.onKey(
      payload,
      state,
      key === "↓" ? { name: "down" } : key === "↑" ? { name: "up" } : key === "enter" ? { name: "enter" } : key === "space" ? { name: "space" } : { name: "char", char: "e" },
      ctx ?? undefined
    )
    state = outcome.state
    if ("answer" in outcome) {
      answer = outcome.answer
      break
    }
    frames.push(draw())
  }
  return { state, answer, frames }
}

const chosenPayload = (lines: PlanLine[] = PLAN_LINES): AskPayloads["plan"] => ({ ...planPayload(lines), decisions: { ...planPayload(lines).decisions, consentMode: "not_required" } })
const fullText = (planLine: PlanLine) => shown(planLine).replace(/\s+/g, " ")

describe("F1b: every plan line can be read in full in a short terminal", () => {
  for (const [width, height] of [
    [80, 24],
    [80, 20],
    [100, 24],
    [100, 30],
    [120, 36],
    [120, 20]
  ] as const) {
    it(`${width}×${height}: the cursor's line is on screen in full at every position, and the frame fits the terminal`, () => {
      for (let down = 0; down < PLAN_LINES.length; down += 1) {
        const { frames } = drivePlan(width, height, planPayload(), Array<PlanKey>(down).fill("↓"))
        const lines = frames.at(-1)!
        expect(lines.length, `rows at cursor ${down}`).toBeLessThanOrEqual(height)
        for (const row of lines) expect(visibleWidth(row)).toBeLessThan(width)
        const text = readable(lines)
        // The whole line, not its first row (it read "… or wait for your cookie" and stopped at 80×24).
        expect(text, PLAN_LINES[down]!.id).toContain(fullText(PLAN_LINES[down]!))
        // The question, the keys and the box's bottom border are still on screen.
        expect(text).toContain("Approve the plan: 14 lines to approve.")
        expect(text).toContain("ESC later")
        expect(lines.map(stripAnsi).some((row) => row.includes("╰"))).toBe(true)
        expect(lines.map(stripAnsi).join("\n")).not.toContain("…")
      }
    })
  }

  it("80×24: more than one line is on screen at once, and what is not is counted (it was ONE row of one line)", () => {
    const text = readable(drivePlan(80, 24, planPayload(), []).frames[0]!)
    for (const planLine of PLAN_LINES.slice(0, 4)) expect(text).toContain(fullText(planLine))
    expect(text).toMatch(/The plan · lines 1–\d+ of 15/)
    expect(text).toMatch(/↓ \d+ more lines below/)
    // The summary gave its rows to the lines; the consent decision is still on screen, on its own line.
    expect(text).not.toContain("Your decisions")
    expect(readable(drivePlan(80, 24, planPayload(), ["e"]).frames.at(-1)!)).toContain("→ chosen: collect by default")
  })

  it("a tall terminal keeps the summary and the step list (negative: nothing is dropped when there is room)", () => {
    const text = readable(drivePlan(120, 50, planPayload(), []).frames[0]!)
    expect(text).toContain("Your decisions")
    expect(text).toContain("The plan (one screen)")
    expect(text).toContain("Check the live site")
    expect(text).toContain("ENTER approve")
  })

  it("a line taller than the box scrolls by its wrapped rows: ↓ reads on, every word is shown, then the cursor moves on", () => {
    const words = Array.from({ length: 48 }, (_, index) => `word${String(index + 1).padStart(3, "0")}`)
    const tall = line("remove_duplicate:meta", "remove_duplicate", `Meta: ${words.join(" ")}`)
    const payload = planPayload([PLAN_LINES[1]!, tall, PLAN_LINES[4]!])
    const downs: PlanKey[] = ["↓"]
    const first = drivePlan(80, 14, payload, downs)
    expect(readable(first.frames.at(-1)!)).toContain("word001")
    // 48 numbered words: 389 characters, under the 400-character cap on a plan line's text.
    expect(readable(first.frames.at(-1)!)).not.toContain("word048")
    expect(readable(first.frames.at(-1)!)).toContain("↓ this line continues (↓ to read on) · 1 more line below")
    expect(first.state.seen).not.toContain(tall.id)
    // Keep pressing ↓ until the cursor leaves the line: every word was on some screen, and no screen is too tall.
    const seenWords = new Set<string>()
    let state = first
    while (state.state.cursor === 1 && downs.length < 40) {
      for (const word of words) if (readable(state.frames.at(-1)!).includes(word)) seenWords.add(word)
      expect(state.frames.at(-1)!.length).toBeLessThanOrEqual(14)
      downs.push("↓")
      state = drivePlan(80, 14, payload, downs)
    }
    expect(state.state.cursor).toBe(2)
    expect([...seenWords].sort()).toEqual(words)
    expect(downs.length).toBeGreaterThan(3)
    expect(state.state.seen).toContain(tall.id)
    // ↑ from the line's later rows goes back inside the line first.
    const back = drivePlan(80, 14, payload, ["↓", "↓", "↑"])
    expect(back.state.cursor).toBe(1)
    expect(readable(back.frames.at(-1)!)).toContain("word001")
  })
})

describe("F11: ENTER never approves a plan line that was not on screen", () => {
  const needUser = PLAN_LINES.filter((planLine) => planLine.requires !== "info")

  it("120×36: the first ENTER shows the next unread lines and says how many are left; it approves only after every line was shown", () => {
    const opened = drivePlan(120, 36, chosenPayload(), [])
    const unreadAtOpen = needUser.filter((planLine) => !readable(opened.frames[0]!).includes(fullText(planLine)))
    expect(unreadAtOpen.length).toBeGreaterThan(3)
    expect(readable(opened.frames[0]!)).toContain("ENTER read on")
    expect(readable(opened.frames[0]!)).not.toContain("ENTER approve")

    const once = drivePlan(120, 36, chosenPayload(), ["enter"])
    expect(once.answer).toBeUndefined()
    // It moved to the first line that was not on screen, and that line is now on screen in full.
    expect(PLAN_LINES[once.state.cursor]!.id).toBe(unreadAtOpen[0]!.id)
    expect(readable(once.frames.at(-1)!)).toContain(fullText(unreadAtOpen[0]!))
    expect(readable(once.frames.at(-1)!)).toMatch(/(\d+ more lines? to read before you approve: ENTER shows the next, ↓ scrolls\.|That is the whole plan\. ENTER approves it as shown\.)/)

    // ENTER again and again: it answers in the end, and by then every line was on a screen in full.
    const keys: PlanKey[] = []
    let run = opened
    while (run.answer === undefined && keys.length < 20) {
      keys.push("enter")
      run = drivePlan(120, 36, chosenPayload(), keys)
    }
    expect(keys.length).toBeGreaterThan(2)
    const everShown = run.frames.map(readable).join(" ")
    for (const planLine of needUser) expect(everShown, planLine.id).toContain(fullText(planLine))
    expect(readable(run.frames.at(-1)!)).toContain("That is the whole plan. ENTER approves it as shown.")
    expect(readable(run.frames.at(-1)!)).toContain("ENTER approve")
    expect(run.answer).toEqual({ approved: needUser.map((planLine) => planLine.id), declined: [], edits: {} })
  })

  for (const [width, height] of [
    [80, 24],
    [80, 20],
    [100, 24]
  ] as const) {
    it(`${width}×${height}: one ENTER does not approve; the lines still to read are counted down to none`, () => {
      const keys: PlanKey[] = []
      let run = drivePlan(width, height, chosenPayload(), keys)
      const left: number[] = []
      while (run.answer === undefined && keys.length < 40) {
        keys.push("enter")
        run = drivePlan(width, height, chosenPayload(), keys)
        const count = /(\d+) more lines? to read before you approve/.exec(readable(run.frames.at(-1)!))?.[1]
        if (run.answer === undefined && count) left.push(Number(count))
      }
      expect(keys.length).toBeGreaterThan(2)
      expect(left.length).toBeGreaterThan(0)
      expect([...left].sort((a, b) => b - a)).toEqual(left)
      const everShown = run.frames.map(readable).join(" ")
      for (const planLine of needUser) expect(everShown, planLine.id).toContain(fullText(planLine))
      expect(run.answer).toMatchObject({ declined: [] })
    })
  }

  it("scrolling through the plan with ↓ counts as reading: ENTER then approves at once, with the skipped line declined", () => {
    const toMeta = PLAN_LINES.findIndex((planLine) => planLine.id === "meta_relay")
    const keys: PlanKey[] = [...Array<PlanKey>(toMeta).fill("↓"), "space", "↓", "↓", "enter"]
    const run = drivePlan(80, 24, chosenPayload(), keys)
    expect(run.answer).toEqual({ approved: needUser.filter((planLine) => planLine.id !== "meta_relay").map((planLine) => planLine.id), declined: ["meta_relay"], edits: {} })
  })

  it("negative: a plan that is on screen whole is approved by the first ENTER, and an unread note does not hold it", () => {
    expect(drivePlan(120, 90, chosenPayload(), ["enter"]).answer).toMatchObject({ declined: [] })
    // The 7-day note (`requires: "info"`) is nothing the user decides: with every other line read, ENTER approves.
    const state = { ...OVERLAYS.plan.init(chosenPayload()), seen: needUser.map((planLine) => planLine.id) }
    const ctx: OverlayContext = { width: 74, maxBodyLines: 8, styles: makeStyles(false), sanitize: makeTestSanitizer(), spinner: "⠋" }
    expect(state.seen).not.toContain("checkin")
    expect("answer" in OVERLAYS.plan.onKey(chosenPayload(), state, { name: "enter" }, ctx)).toBe(true)
  })

  it("the consent choice still comes first: with none chosen ENTER asks for it, whatever was read", () => {
    const run = drivePlan(80, 24, planPayload(), ["enter"])
    expect(run.answer).toBeUndefined()
    expect(run.state.cursor).toBe(0)
    expect(readable(run.frames.at(-1)!)).toContain("Choose the consent setting first: press E on it.")
  })

  it("in the real UI at 80×24 a single ENTER on the plan answers nothing (TtyUi passes the box to the overlay)", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout(80, 24)
    const ui = new TtyUi({ stdin, stdout, env: {}, sanitize: makeTestSanitizer(), onInterrupt: () => undefined, spinnerIntervalMs: 0, registerExitHook: false })
    const store = new FakeStore(PLAN_SNAPSHOT(chosenPayload()))
    ui.start(store)
    stdin.type("\r")
    await flushMicrotasks()
    expect(store.answers).toEqual([])
    expect(readable(ui.lastFrame())).toMatch(/\d+ more lines? to read before you approve/)
    for (let presses = 0; presses < 40 && store.answers.length === 0; presses += 1) {
      stdin.type("\r")
      await flushMicrotasks()
    }
    expect(store.answers).toHaveLength(1)
    ui.stop()
  })
})

describe("F13: the exit line breaks between its parts, never inside the pull request URL or the report path", () => {
  const input = { displayId: "r-db62", exitCode: 0, prUrl: "https://github.com/acme/acme-store/pull/42", reportPath: ".infinite/wizard/report.md" }
  const styles = makeStyles(false)

  it("at 100 columns the report path starts its own row (the terminal cut it as '.infinite/w' / 'izard/report.md')", () => {
    // The one-line form is 104 columns: a 100-column terminal breaks it inside the path.
    expect(visibleWidth(exitLine(input, styles))).toBeGreaterThan(100)
    const rows = exitLines(input, styles, 100)
    expect(rows).toEqual(["◆ infinite-tag run r-db62: done · PR https://github.com/acme/acme-store/pull/42", "  report .infinite/wizard/report.md"])
    for (const width of [60, 80, 100, 120]) {
      const wrapped = exitLines(input, styles, width)
      for (const row of wrapped) expect(visibleWidth(row), `${width}`).toBeLessThan(width)
      expect(wrapped.some((row) => row.includes(input.prUrl))).toBe(true)
      expect(wrapped.some((row) => row.includes(input.reportPath))).toBe(true)
    }
  })

  it("negative: a terminal wide enough keeps it on one line, the same words as before", () => {
    expect(exitLines(input, styles, 140)).toEqual([exitLine(input, styles)])
  })

  it("the terminal UI writes the wrapped form on exit", () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout(100, 36)
    const ui = new TtyUi({ stdin, stdout, env: {}, sanitize: makeTestSanitizer(), onInterrupt: () => undefined, spinnerIntervalMs: 0, registerExitHook: false })
    const store = new FakeStore(makeSnapshot({ exit: { exitCode: 0, prUrl: input.prUrl, reportPath: input.reportPath } }))
    ui.start(store)
    ui.stop()
    const tail = stripAnsi(stdout.text).split("\n").filter((row) => row.includes("report .infinite") || row.includes("infinite-tag run"))
    expect(tail.at(-2)).toMatch(/infinite-tag run .*: done · PR https:\/\/github\.com\/acme\/acme-store\/pull\/42$/)
    expect(tail.at(-1)).toBe("  report .infinite/wizard/report.md")
  })
})
