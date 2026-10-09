import { describe, expect, it } from "vitest"

import { applyTextEdits, reverseTextEdits } from "../server-lane/text-edits.js"
import { buildAgentEnv, nestingMarker, strippedEnv } from "./env.js"
import { globToRegExp, matchesAnyGlob } from "./glob.js"
import { applySomeHunks, diffLines, hunksToTextEdits, splitLines } from "./line-diff.js"
import { claimBeat, claudeToolBeat, codexItemBeat } from "./narration.js"
import { sanitizeUntrusted } from "./sanitize.js"
import { claudeUsageSignals, codexErrorMessage, codexUsageLimit } from "./usage-limit.js"
import { GLOBAL_DENY_GLOBS } from "../wizard/contracts/jobs.js"

describe("sanitizeUntrusted", () => {
  it("strips ANSI, OSC links, C0/C1 controls, bidi overrides and zero-width characters", () => {
    const hostile = "\u001b[31mred\u001b[0m \u001b]8;;https://evil\u0007link\u001b]8;;\u0007 \u009b2Jx ‮evil‬ ​hidden\u0007\r\nnext"
    expect(sanitizeUntrusted(hostile, 200)).toBe("red link x evil hidden next")
  })

  it("strips Unicode tag characters (ASCII smuggling) and the soft hyphen (review O3 F22)", () => {
    const smuggled = "ok" + String.fromCodePoint(0xe0049, 0xe0047, 0xe004e, 0xe007f) + "hid\u00ADden"
    expect(sanitizeUntrusted(smuggled, 120)).toBe("okhidden")
    expect(sanitizeUntrusted("plain text", 120)).toBe("plain text")
  })
})

describe("usage limits (§3f.5)", () => {
  it("reads a Claude rejected rate_limit_event with resetsAt and type", () => {
    const signals = claudeUsageSignals({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790000000, rateLimitType: "five_hour" } })
    expect(signals).toEqual([{ kind: "rejected", resetsAt: new Date(1790000000 * 1000).toISOString(), rateLimitType: "five_hour" }])
  })

  it("reads a Codex usage limit and its verbatim reset time", () => {
    const message = "You've hit your usage limit. Upgrade to Pro or try again at Oct 3rd, 2026 9:41 AM."
    expect(codexUsageLimit(message)).toEqual({ resetsAt: "Oct 3rd, 2026 9:41 AM" })
    expect(codexErrorMessage({ type: "turn.failed", error: { message } })).toBe(message)
    expect(codexErrorMessage({ type: "error", message: "x" })).toBe("x")
    expect(codexUsageLimit("usage limit exceeded")).toEqual({ resetsAt: null })
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
})

