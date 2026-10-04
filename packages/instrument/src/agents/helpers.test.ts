import { describe, expect, it } from "vitest"

import { applyTextEdits, reverseTextEdits } from "../server-lane/text-edits.js"
import { buildAgentEnv, nestingMarker, strippedEnv } from "./env.js"
import { globToRegExp, matchesAnyGlob } from "./glob.js"
import { applySomeHunks, diffLines, hunksToTextEdits, splitLines } from "./line-diff.js"
import { claimBeat, claudeToolBeat, codexItemBeat, Narrator, ThinkingTicker } from "./narration.js"
import { sanitizeUntrusted } from "./sanitize.js"
import { claudeResetsAt, claudeUsageSignals, codexErrorMessage, codexUsageLimit, outOfUsageResumeLine } from "./usage-limit.js"
import { GLOBAL_DENY_GLOBS } from "../wizard/contracts/jobs.js"

describe("sanitizeUntrusted", () => {
  it("strips ANSI, OSC links, C0/C1 controls, bidi overrides and zero-width characters", () => {
    const hostile = "\u001b[31mred\u001b[0m \u001b]8;;https://evil\u0007link\u001b]8;;\u0007 \u009b2Jx ‮evil‬ ​hidden\u0007\r\nnext"
    expect(sanitizeUntrusted(hostile, 200)).toBe("red link x evil hidden next")
  })

  it("caps by code points with an ellipsis and never splits a surrogate pair", () => {
    expect(sanitizeUntrusted("abcdef", 4)).toBe("abc…")
    expect(sanitizeUntrusted("😀😀😀😀😀", 3)).toBe("😀😀…")
    expect(sanitizeUntrusted("short", 10)).toBe("short")
  })

  it("strips Unicode tag characters (ASCII smuggling) and the soft hyphen (review O3 F22)", () => {
    const smuggled = "ok" + String.fromCodePoint(0xe0049, 0xe0047, 0xe004e, 0xe007f) + "hid\u00ADden"
    expect(sanitizeUntrusted(smuggled, 120)).toBe("okhidden")
    expect(sanitizeUntrusted("plain text", 120)).toBe("plain text")
  })

  it("rejects a bad cap and renders non-strings safely (negative)", () => {
    expect(() => sanitizeUntrusted("x", 0)).toThrow()
    expect(sanitizeUntrusted(undefined, 5)).toBe("")
    expect(sanitizeUntrusted(42, 5)).toBe("42")
  })
})

describe("usage limits (§3f.5)", () => {
  it("reads a Claude rejected rate_limit_event with resetsAt and type", () => {
    const signals = claudeUsageSignals({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790000000, rateLimitType: "five_hour" } })
    expect(signals).toEqual([{ kind: "rejected", resetsAt: new Date(1790000000 * 1000).toISOString(), rateLimitType: "five_hour" }])
  })

  it("maps allowed_warning to one warning, overage to a notice, and assistant/result errors to rejected", () => {
    expect(claudeUsageSignals({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8, isUsingOverage: true } }))
      .toEqual([{ kind: "warning", rateLimitType: "seven_day", utilization: 0.8 }, { kind: "overage" }])
    expect(claudeUsageSignals({ type: "assistant", error: "billing_error", message: {} })[0]!.kind).toBe("rejected")
    expect(claudeUsageSignals({ type: "result", api_error_status: 429 })[0]!.kind).toBe("rejected")
  })

  it("ignores allowed events and the stale desktop sentinel (negative)", () => {
    expect(claudeUsageSignals({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toEqual([])
    expect(claudeUsageSignals({ type: "assistant", message: { content: [{ type: "text", text: "Claude AI usage limit reached|1790000000" }] } })).toEqual([])
    expect(claudeResetsAt("soon")).toBe("soon")
    expect(claudeResetsAt(null)).toBeNull()
  })

  it("reads a Codex usage limit and its verbatim reset time", () => {
    const message = "You've hit your usage limit. Upgrade to Pro or try again at Oct 3rd, 2026 9:41 AM."
    expect(codexUsageLimit(message)).toEqual({ resetsAt: "Oct 3rd, 2026 9:41 AM" })
    expect(codexErrorMessage({ type: "turn.failed", error: { message } })).toBe(message)
    expect(codexErrorMessage({ type: "error", message: "x" })).toBe("x")
    expect(codexUsageLimit("usage limit exceeded")).toEqual({ resetsAt: null })
  })

  it("does not call an ordinary Codex error a usage limit (negative)", () => {
    expect(codexUsageLimit("stream disconnected before completion")).toBeNull()
    expect(codexErrorMessage({ type: "turn.completed" })).toBeNull()
    expect(outOfUsageResumeLine("10:00")).toBe("resets at 10:00; run `npx infinite-tag` again to resume")
  })
})

describe("agent env (§3f.3)", () => {
  const base = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "kept",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDE_CONFIG_DIR: "/Users/x/.claude-work",
    HTTPS_PROXY: "http://proxy:8080",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_CHILD_SESSION: "1",
    AI_AGENT: "claude-code",
    CODEX_THREAD_ID: "t",
    CODEX_SANDBOX: "seatbelt",
    INFINITE_TAG_MCP_TOKEN: "stale",
    INFINITE_TAG_MCP_URL: "http://127.0.0.1:1/mcp",
    INFINITE_TAG_OTHER: "x"
  }

  it("strips the nesting markers and every inherited INFINITE_TAG_*, keeps ANTHROPIC_*, CLAUDE_CONFIG_DIR and proxies", () => {
    const env = strippedEnv(base)
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "PATH"])
  })

  it("puts this run's MCP vars on the Codex child only", () => {
    const mcp = { url: "http://127.0.0.1:5555/mcp", token: "run-token" }
    const codex = buildAgentEnv(base, { kind: "codex", mcp })
    expect(codex.INFINITE_TAG_MCP_TOKEN).toBe("run-token")
    expect(codex.INFINITE_TAG_MCP_URL).toBe("http://127.0.0.1:5555/mcp")
    expect(codex.INFINITE_TAG_OTHER).toBeUndefined()
    const claude = buildAgentEnv(base, { kind: "claude_code", mcp })
    expect(claude.INFINITE_TAG_MCP_TOKEN).toBeUndefined()
    expect(claude.INFINITE_TAG_MCP_URL).toBeUndefined()
    expect(claude.ENABLE_TOOL_SEARCH).toBe("false")
    expect(claude.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1")
    expect(claude.ANTHROPIC_API_KEY).toBe("kept")
  })

  it("never lets the stale inherited token through, even with no MCP for this run (negative)", () => {
    expect(buildAgentEnv(base, { kind: "codex" }).INFINITE_TAG_MCP_TOKEN).toBeUndefined()
    expect(nestingMarker(base)).toBe("CLAUDECODE")
    expect(nestingMarker({ PATH: "/bin" })).toBeNull()
  })
})

describe("glob", () => {
  it("anchors at the root and keeps * inside a segment", () => {
    expect(matchesAnyGlob(".env.local", GLOBAL_DENY_GLOBS)).toBe(true)
    expect(matchesAnyGlob("apps/web/.env", GLOBAL_DENY_GLOBS)).toBe(true)
    expect(matchesAnyGlob("apps/web/.infinite/install.json", GLOBAL_DENY_GLOBS)).toBe(true)
    expect(matchesAnyGlob("packages/ui/node_modules/x/index.js", GLOBAL_DENY_GLOBS)).toBe(true)
    expect(matchesAnyGlob("app/layout.tsx", GLOBAL_DENY_GLOBS)).toBe(false)
    expect(matchesAnyGlob("app/environment.ts", GLOBAL_DENY_GLOBS)).toBe(false)
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false)
    expect(globToRegExp("src/**/*.ts").test("src/a/b.ts")).toBe(true)
  })
})

describe("line diff", () => {
  function roundTrip(before: string, after: string) {
    const beforeLines = splitLines(before)
    const afterLines = splitLines(after)
    const hunks = diffLines(before, after)
    expect(applySomeHunks(beforeLines, afterLines, hunks, () => true)).toBe(after)
    expect(applySomeHunks(beforeLines, afterLines, hunks, () => false)).toBe(before)
    const edits = hunksToTextEdits(beforeLines, afterLines, hunks)
    expect(applyTextEdits(before, edits)).toBe(after)
    expect(reverseTextEdits(after, edits)).toBe(before)
  }

  it("round-trips edge cases", () => {
    roundTrip("", "a\n")
    roundTrip("a\n", "")
    roundTrip("a\nb\nc", "a\nB\nc\n")
    roundTrip("x\n".repeat(5), "x\n".repeat(7))
    roundTrip("same\n", "same\n")
    expect(diffLines("same\n", "same\n")).toEqual([])
  })

  it("round-trips random edits (seeded)", () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const vocab = ["a\n", "b\n", "c\n", "d\n", "e", "\n", "ff\r\n"]
    for (let round = 0; round < 300; round += 1) {
      const before = Array.from({ length: rand(12) }, () => vocab[rand(vocab.length)]!).join("")
      const after = Array.from({ length: rand(12) }, () => vocab[rand(vocab.length)]!).join("")
      roundTrip(before, after)
    }
  })
})

describe("narration (§3f.7)", () => {
  const ctx = {
    root: "/repo",
    isAllowed: (path: string) => path === "app/layout.tsx",
    agent: "claude_code" as const,
    jobNumber: (id: string) => (id === "meta_improve:landing" ? 5 : null)
  }

  it("maps tools to beats and never prints tool input content", () => {
    expect(claudeToolBeat("Read", { file_path: "/repo/app/page.tsx" }, ctx)).toBe("Reading app/page.tsx")
    expect(claudeToolBeat("Edit", { file_path: "/repo/app/layout.tsx", old_string: "SECRET", new_string: "x" }, ctx)).toBe("Editing app/layout.tsx")
    expect(claudeToolBeat("Write", { file_path: "/repo/lib/x.ts", content: "SECRET" }, ctx)).toMatch(/not one of its allowed files/)
    expect(claudeToolBeat("Read", { file_path: "/Users/x/.growth-os/auth.json" }, ctx)).toBe("Reading a file outside the repo")
    expect(claudeToolBeat("mcp__infinite_tag__job_claim", { job_id: "meta_improve:landing", status: "done" }, ctx)).toBe("Claude Code says job 5 is done; checking…")
    expect(claudeToolBeat("Bash", { command: "cat .env" }, ctx)).toBeNull()
    expect(codexItemBeat({ type: "tool_search_call" }, { ...ctx, agent: "codex" })).toBe("Loading its checklist tools")
    expect(codexItemBeat({ type: "mcp_tool_call", server: "infinite_tag", tool: "job_claim", arguments: { job_id: "x", status: "not_needed" } }, { ...ctx, agent: "codex" }))
      .toBe("Codex says a job isn't needed; checking…")
    expect(claimBeat("codex", "meta_improve:landing", "blocked", ctx.jobNumber)).toBe("Codex says job 5 is blocked; checking…")
  })

  it("throttles to one beat per 3 s, strips escapes and ticks", () => {
    let now = 0
    const beats: string[] = []
    const narrator = new Narrator({ agent: "codex", role: "worker", emit: (beat) => beats.push(beat.text), now: () => now })
    expect(narrator.beat("\u001b[32m✓ all done\u001b[0m")).toBe(true)
    now = 2_999
    expect(narrator.beat("second")).toBe(false)
    now = 3_000
    expect(narrator.beat("third")).toBe(true)
    expect(beats).toEqual(["all done", "third"])
  })
})

describe("§3x.3 (D1, W8) the thinking beat: silence after a tool result is said as thinking, never as the last tool", () => {
  it("Grep, its result, then 12 s of silence → Searching the code, then Thinking · 3 s … Thinking · 12 s", () => {
    let now = 0
    const beats: string[] = []
    const narrator = new Narrator({ agent: "claude_code", role: "worker", emit: (beat) => beats.push(beat.text), now: () => now })
    const ticker = new ThinkingTicker(narrator, () => now)
    ticker.acted()
    narrator.beat(claudeToolBeat("Grep", { pattern: "infiniteTrack" }, { root: "/repo", isAllowed: () => true, agent: "claude_code", jobNumber: () => null })!)
    now = 400
    ticker.toolReturned()
    for (now = 1_400; now <= 12_400; now += 1_000) ticker.tick()
    expect(beats).toEqual(["Searching the code", "Thinking · 3 s", "Thinking · 6 s", "Thinking · 9 s", "Thinking · 12 s"])
  })

  it("negative: a new tool call stops the thinking beat; no tool result, no thinking", () => {
    let now = 0
    const beats: string[] = []
    const ticker = new ThinkingTicker(new Narrator({ agent: "codex", role: "worker", emit: (beat) => beats.push(beat.text), now: () => now }), () => now)
    for (now = 0; now <= 10_000; now += 1_000) ticker.tick()
    expect(beats).toEqual([])
    ticker.toolReturned()
    now = 1_500
    ticker.acted()
    for (; now <= 10_000; now += 1_000) ticker.tick()
    expect(beats).toEqual([])
  })
})
