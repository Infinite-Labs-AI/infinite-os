import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cleanup, tempDir } from "../../test/wizard/repo.js"
import { agentArgvViolations, CLAIMS_SCHEMA, codexPermissionArgs, CODEX_DISABLED_FEATURES, REVIEW_SCHEMA } from "../wizard/contracts/agents.js"
import { buildClaudeReviewerArgv, buildClaudeWorkerArgv, claudeMcpConfig, sensitiveDenies } from "./claude.js"
import { buildCodexReviewerArgv, buildCodexWorkerArgv } from "./codex.js"
import { withWizardDirDenied } from "./runner.js"
import { operatorRules } from "../jobs/briefs.js"
import { apiKeySourceMatches, claudeWhoPays, codexWhoPays, parseVersion } from "./detect.js"
import { resolveSensitivePaths, type SensitivePath } from "./paths.js"

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

const MODEL = { model: "claude-opus-4-8", effort: "xhigh" }
const SENSITIVE: SensitivePath[] = [
  { path: "/Users/u/.growth-os", kind: "dir" },
  { path: "/Users/u/Library/Application Support/Infinite", kind: "dir" },
  { path: "/Users/u/.npmrc", kind: "file" }
]

describe("Claude argv (§3f.3 + §3f.7)", () => {
  it("builds the exact worker argv", () => {
    const argv = buildClaudeWorkerArgv({
      sensitive: SENSITIVE,
      mcpConfigPath: "/Users/u/Library/Caches/infinite-tag/run/tag.mcp.1.json",
      systemPrompt: "RULES",
      claimsSchema: JSON.stringify(CLAIMS_SCHEMA),
      maxTurns: 30,
      session: { mode: "new", sessionId: "11111111-1111-4111-8111-111111111111" },
      model: MODEL
    })
    expect(argv).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--restricted",
      "--model", "claude-opus-4-8", "--effort", "xhigh",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--tools", "Read,Edit,Write,Glob,Grep",
      "--allowedTools", "Read Edit Write Glob Grep mcp__infinite_tag__*",
      "--disallowedTools",
      "Bash", "WebFetch", "WebSearch", "Read(./.env*)", "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)",
      "Read(./.git/**)", "Read(**/.npmrc)", "Read(**/.netrc)", "Edit(**/.npmrc)", "Write(**/.npmrc)",
      "Read(//Users/u/.growth-os/**)", "Edit(//Users/u/.growth-os/**)", "Write(//Users/u/.growth-os/**)",
      "Read(//Users/u/Library/Application Support/Infinite/**)", "Edit(//Users/u/Library/Application Support/Infinite/**)", "Write(//Users/u/Library/Application Support/Infinite/**)",
      "Read(//Users/u/.npmrc)", "Edit(//Users/u/.npmrc)", "Write(//Users/u/.npmrc)",
      "Read(./.infinite/**)", "Edit(./.infinite/**)", "Write(./.infinite/**)", "Edit(**/node_modules/**)", "Write(**/node_modules/**)",
      "Edit(./.git/**)", "Write(./.git/**)", "Edit(./.claude/**)", "Write(./.claude/**)", "Edit(./.codex/**)", "Write(./.codex/**)",
      "--strict-mcp-config", "--mcp-config", "/Users/u/Library/Caches/infinite-tag/run/tag.mcp.1.json",
      "--append-system-prompt", "RULES",
      "--json-schema", JSON.stringify(CLAIMS_SCHEMA),
      "--max-turns", "30",
      "--session-id", "11111111-1111-4111-8111-111111111111",
      "--disable-slash-commands", "--no-chrome"
    ])
  })

  it("resumes with --resume <id> and falls back to the user's default model without --model", () => {
    const argv = buildClaudeWorkerArgv({
      sensitive: [],
      mcpConfigPath: "/x/tag.mcp.json",
      systemPrompt: "R",
      claimsSchema: "{}",
      maxTurns: 10,
      session: { mode: "resume", sessionId: "sess-1" },
      model: { model: null, effort: "xhigh" }
    })
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", "sess-1"])
    expect(argv).not.toContain("--session-id")
    expect(argv).not.toContain("--model")
    expect(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2)).toEqual(["--effort", "xhigh"])
  })

  it("builds the exact reviewer argv", () => {
    const argv = buildClaudeReviewerArgv({ sensitive: SENSITIVE.slice(0, 1), systemPrompt: "R1-R16", reviewSchema: JSON.stringify(REVIEW_SCHEMA), maxTurns: 25, model: MODEL })
    expect(argv).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--restricted",
      "--model", "claude-opus-4-8", "--effort", "xhigh",
      "--tools", "Read,Glob,Grep", "--allowedTools", "Read Glob Grep",
      "--disallowedTools", "Read(./.env*)", "Read(**/.env*)", "Read(./.git/**)", "Read(**/.npmrc)", "Read(**/.netrc)", "Read(//Users/u/.growth-os/**)",
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--strict-mcp-config", "--json-schema", JSON.stringify(REVIEW_SCHEMA),
      "--append-system-prompt", "R1-R16",
      "--max-turns", "25", "--no-session-persistence", "--disable-slash-commands", "--no-chrome"
    ])
  })

  it("never carries a forbidden flag, a shell or a web tool (negatives)", () => {
    const worker = buildClaudeWorkerArgv({ sensitive: SENSITIVE, mcpConfigPath: "/x", systemPrompt: "r", claimsSchema: "{}", maxTurns: 1, session: { mode: "new", sessionId: "s" }, model: MODEL })
    const reviewer = buildClaudeReviewerArgv({ sensitive: SENSITIVE, systemPrompt: "r", reviewSchema: "{}", maxTurns: 1, model: MODEL })
    for (const argv of [worker, reviewer]) {
      expect(agentArgvViolations("claude_code", argv)).toEqual([])
      for (const forbidden of ["--bare", "--safe-mode", "--approve-for-me", "--setting-sources", "--dangerously-skip-permissions"]) expect(argv).not.toContain(forbidden)
      const tools = argv[argv.indexOf("--tools") + 1]!.split(",")
      expect(tools).not.toContain("Bash")
      expect(tools.some((tool) => tool.startsWith("Web"))).toBe(false)
    }
    // The checker itself fails a bad argv.
    expect(agentArgvViolations("claude_code", [...worker, "--dangerously-skip-permissions"])).not.toEqual([])
    expect(agentArgvViolations("claude_code", worker.filter((arg) => arg !== "--restricted"))).toContain("missing --restricted")
    expect(() => sensitiveDenies([{ path: "relative/.growth-os", kind: "dir" }], ["Read"])).toThrow(/not absolute/)
  })

  it("writes the tag.mcp.json shape (MCP vars reach Claude only through this file)", () => {
    expect(JSON.parse(claudeMcpConfig({ node: "/usr/bin/node", cliPath: "/pkg/dist/src/cli.js", url: "http://127.0.0.1:5/mcp", token: "t" }))).toEqual({
      mcpServers: {
        infinite_tag: {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/pkg/dist/src/cli.js", "mcp-proxy"],
          env: { INFINITE_TAG_MCP_URL: "http://127.0.0.1:5/mcp", INFINITE_TAG_MCP_TOKEN: "t" },
          timeout: 900000,
          alwaysLoad: true
        }
      }
    })
  })
})

describe("the resolved sensitive paths → a Read deny each", () => {
  it("covers a temp GROWTH_OS_HOME, every ~/.growth-os*, the Infinite userData dirs, ~/.codex and the cache (realpaths)", async () => {
    const home = tempDir("infinite-tag-sens-home-")
    const elsewhere = tempDir("infinite-tag-sens-growth-")
    dirs.push(home, elsewhere)
    mkdirSync(join(home, ".growth-os-dev3"), { recursive: true })
    mkdirSync(join(home, "Library/Application Support/Infinite Dev 3"), { recursive: true })
    mkdirSync(join(home, ".codex"), { recursive: true })
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude/.credentials.json"), "{}")
    symlinkSync(elsewhere, join(home, "growth-link"))
    const paths = await resolveSensitivePaths({ home, env: { GROWTH_OS_HOME: join(home, "growth-link") } })
    const denied = buildClaudeWorkerArgv({ sensitive: paths, mcpConfigPath: "/x", systemPrompt: "r", claimsSchema: "{}", maxTurns: 1, session: { mode: "new", sessionId: "s" }, model: MODEL })
    for (const expected of [
      `Read(/${elsewhere}/**)`,
      `Read(/${join(home, ".growth-os-dev3")}/**)`,
      `Read(/${join(home, "Library/Application Support/Infinite Dev 3")}/**)`,
      `Read(/${join(home, ".codex")}/**)`,
      `Read(/${join(home, ".claude/.credentials.json")})`,
      `Read(/${join(home, ".ssh")}/**)`,
      `Read(/${join(home, "Library/Caches/infinite-tag")}/**)`
    ]) {
      expect(denied).toContain(expected)
    }
    // Negative: a path left out of the resolved list has no deny.
    const without = buildClaudeWorkerArgv({ sensitive: paths.filter((entry) => !entry.path.endsWith(".codex")), mcpConfigPath: "/x", systemPrompt: "r", claimsSchema: "{}", maxTurns: 1, session: { mode: "new", sessionId: "s" }, model: MODEL })
    expect(without).not.toContain(`Read(/${join(home, ".codex")}/**)`)
  })
})

describe("§3y.10 (P3-10): the worker never reads the wizard's own files; the reviewers still read theirs", () => {
  it("Claude: Read(./.infinite/**) is denied to the worker only", () => {
    const worker = buildClaudeWorkerArgv({ sensitive: [], mcpConfigPath: "/x", systemPrompt: "r", claimsSchema: "{}", maxTurns: 1, session: { mode: "new", sessionId: "s" }, model: MODEL })
    expect(worker).toContain("Read(./.infinite/**)")
    const reviewer = buildClaudeReviewerArgv({ sensitive: [], systemPrompt: "r", reviewSchema: "{}", maxTurns: 1, model: MODEL })
    expect(reviewer).not.toContain("Read(./.infinite/**)")
  })

  it("Codex: the worker's profile denies <root>/.infinite (its realpath, when it exists); nothing when it does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "wizard-dir-deny-"))
    try {
      expect(await withWizardDirDenied({ none: [], readOnly: [] }, root)).toEqual({ none: [], readOnly: [] })
      mkdirSync(join(root, ".infinite"))
      const denied = await withWizardDirDenied({ none: ["/a/.env"], readOnly: ["/g"] }, root)
      expect(denied.none).toContain(realpathSync(join(root, ".infinite")))
      expect(denied.readOnly).toEqual(["/g"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("the operator rules say the brief is all the worker needs, and a job blocked by Infinite is claimed blocked, never asked", () => {
    const rules = operatorRules({ runId: "r", framework: "next-app-router", packageManager: "pnpm", router: "app", appRoot: ".", plan: null, connections: null, previewGuard: null })
    expect(rules).toContain("Everything you need is in this brief; never read .infinite/.")
    expect(rules).toContain("If a job cannot be done because something is missing in Infinite, claim it blocked with the reason; never ask the user about it.")
  })
})

describe("Codex argv (§3f.3 + §3f.7)", () => {
  const permission = (role: "worker" | "reviewer") =>
    codexPermissionArgs({
      role,
      homeRealpath: "/Users/u",
      sensitiveRealpaths: ["/Users/u/.growth-os", "/Volumes/x/.growth-os-alt"],
      codexBinDir: "/Users/u/.local/bin",
      codexInstallRoot: "/Users/u/.codex/packages/standalone/releases/0.159.2"
    })

  it("builds the exact worker argv (profile, never -s)", () => {
    const argv = buildCodexWorkerArgv({
      repo: "/repo",
      permissionArgs: permission("worker"),
      model: { model: "gpt-6.1-sol", effort: "xhigh" },
      node: "/usr/bin/node",
      cliPath: "/pkg/dist/src/cli.js",
      outputPath: "/Users/u/Library/Caches/infinite-tag/run/last.1.json",
      schemaPath: "/Users/u/Library/Caches/infinite-tag/run/claims.schema.json"
    })
    expect(argv).toEqual([
      "exec", "--json", "-C", "/repo", "--ignore-user-config", "--ignore-rules", "--strict-config", "--color", "never",
      "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"',
      "-c", 'default_permissions="infinite_tag"',
      "-c", 'permissions.infinite_tag.filesystem={":root"="read", "/Users/u"="none", "/Volumes/x/.growth-os-alt"="none", "/Users/u/.local/bin"="read", "/Users/u/.codex/packages/standalone/releases/0.159.2"="read", ":project_roots"="write"}',
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
      "-c", "sandbox_workspace_write.network_access=false",
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
      "-c", 'mcp_servers.infinite_tag.command="/usr/bin/node"',
      "-c", 'mcp_servers.infinite_tag.args=["/pkg/dist/src/cli.js","mcp-proxy"]',
      "-c", 'mcp_servers.infinite_tag.env_vars=["INFINITE_TAG_MCP_URL","INFINITE_TAG_MCP_TOKEN"]',
      "-c", 'mcp_servers.infinite_tag.default_tools_approval_mode="approve"',
      "-c", "mcp_servers.infinite_tag.required=true",
      "-c", "mcp_servers.infinite_tag.tool_timeout_sec=900",
      "-c", "mcp_servers.infinite_tag.startup_timeout_sec=20",
      "-c", 'mcp_servers.infinite_tag.enabled_tools=["job_list","job_claim","report_progress","ask_user"]',
      "-c", 'shell_environment_policy.exclude=["INFINITE_TAG_*"]',
      "-o", "/Users/u/Library/Caches/infinite-tag/run/last.1.json",
      "--output-schema", "/Users/u/Library/Caches/infinite-tag/run/claims.schema.json",
      "-"
    ])
  })

  it("resumes with exec resume <thread> under the same profile", () => {
    const argv = buildCodexWorkerArgv({ repo: "/repo", permissionArgs: permission("worker"), model: { model: null, effort: "xhigh" }, node: "n", cliPath: "c", outputPath: "o", schemaPath: "s", resumeThreadId: "thread-9" })
    expect(argv.slice(0, 3)).toEqual(["exec", "resume", "thread-9"])
    expect(argv).not.toContain("-C")
    expect(argv).not.toContain("-m")
    expect(argv).toContain('default_permissions="infinite_tag"')
    expect(argv.some((arg) => arg.startsWith("sandbox_mode"))).toBe(false)
  })

  it("builds the exact reviewer argv (read-only profile, ephemeral, no MCP)", () => {
    const argv = buildCodexReviewerArgv({ worktree: "/wt", permissionArgs: permission("reviewer"), model: { model: "gpt-6.1-sol", effort: "xhigh" }, outputPath: "/c/review.json", schemaPath: "/c/review.schema.json" })
    expect(argv).toEqual([
      "exec", "--json", "-C", "/wt", "--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral", "--color", "never",
      "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"',
      "-c", 'default_permissions="infinite_tag_ro"',
      "-c", 'permissions.infinite_tag_ro.filesystem={":root"="read", "/Users/u"="none", "/Volumes/x/.growth-os-alt"="none", "/Users/u/.local/bin"="read", "/Users/u/.codex/packages/standalone/releases/0.159.2"="read", ":project_roots"="read"}',
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
      "--output-schema", "/c/review.schema.json", "-o", "/c/review.json", "-"
    ])
    expect(argv.join(" ")).not.toContain("mcp_servers")
  })

  it("§3y.7: the reviewer's worktree is re-allowed READ right after :project_roots (the $HOME deny covers ~/Library/Caches); never the worker", () => {
    const input = {
      homeRealpath: "/Users/u",
      sensitiveRealpaths: ["/Users/u/.growth-os"],
      codexBinDir: "/Users/u/.local/bin",
      codexInstallRoot: "/Users/u/.codex/packages/standalone/releases/0.160.0",
      repoDenies: { none: ["/Users/u/Library/Caches/infinite-tag-review/wt/.env"] },
      readRoots: ["/Users/u/Library/Caches/infinite-tag-review/wt"]
    }
    const reviewer = codexPermissionArgs({ role: "reviewer", ...input })[3]!
    expect(reviewer).toBe(
      'permissions.infinite_tag_ro.filesystem={":root"="read", "/Users/u"="none", "/Users/u/.local/bin"="read", "/Users/u/.codex/packages/standalone/releases/0.160.0"="read", ":project_roots"="read", "/Users/u/Library/Caches/infinite-tag-review/wt"="read", "/Users/u/Library/Caches/infinite-tag-review/wt/.env"="none"}'
    )
    const worker = codexPermissionArgs({ role: "worker", ...input })[3]!
    expect(worker).not.toContain("infinite-tag-review/wt\"=\"read")
    expect(() => codexPermissionArgs({ role: "reviewer", ...input, readRoots: ["relative/path"] })).toThrow(/not an absolute path/)
  })

  it("refuses a Codex argv without the profile, or with -s / sandbox_mode (negatives)", () => {
    const base = { repo: "/repo", model: { model: null, effort: "x" }, node: "n", cliPath: "c", outputPath: "o", schemaPath: "s" }
    expect(() => buildCodexWorkerArgv({ ...base, permissionArgs: [] })).toThrow(/missing default_permissions profile/)
    expect(() => buildCodexWorkerArgv({ ...base, permissionArgs: [...permission("worker"), "-s", "workspace-write"] })).toThrow(/forbidden codex flag -s/)
    expect(() => buildCodexWorkerArgv({ ...base, permissionArgs: [...permission("worker"), "-c", 'sandbox_mode="workspace-write"'] })).toThrow(/sandbox_mode/)
    const good = buildCodexWorkerArgv({ ...base, permissionArgs: permission("worker") })
    for (const feature of CODEX_DISABLED_FEATURES) expect(good).toContain(`features.${feature}=false`)
    expect(good).toContain("features.apps=false")
    expect(good).toContain("--ignore-user-config")
  })

  it("R2-1: neither the built reviewer nor the worker argv disables code_mode_host (Codex 0.160's shell host)", () => {
    const reviewer = buildCodexReviewerArgv({ worktree: "/wt", permissionArgs: permission("reviewer"), model: { model: "gpt-6.1-sol", effort: "xhigh" }, outputPath: "/c/r.json", schemaPath: "/c/s.json" })
    const worker = buildCodexWorkerArgv({ repo: "/repo", permissionArgs: permission("worker"), model: { model: "gpt-6.1-sol", effort: "xhigh" }, node: "n", cliPath: "c", outputPath: "o", schemaPath: "s" })
    const resume = buildCodexWorkerArgv({ repo: "/repo", permissionArgs: permission("worker"), model: { model: null, effort: "xhigh" }, node: "n", cliPath: "c", outputPath: "o", schemaPath: "s", resumeThreadId: "t-1" })
    for (const argv of [reviewer, worker, resume]) {
      expect(argv.some((arg) => arg.includes("code_mode_host"))).toBe(false)
      // the other disables stay
      expect(argv).toContain("features.browser_use=false")
      expect(argv).toContain("features.computer_use=false")
    }
    expect(CODEX_DISABLED_FEATURES as readonly string[]).not.toContain("code_mode_host")
    // negative: an argv that disables it is refused, so it cannot come back by accident
    expect(agentArgvViolations("codex", [...reviewer.slice(0, -1), "-c", "features.code_mode_host=false", "-"])).toEqual([
      "features.code_mode_host=false blinds the agent (it disables Codex's shell)"
    ])
    expect(() => buildCodexReviewerArgv({ worktree: "/wt", permissionArgs: [...permission("reviewer"), "-c", "features.code_mode_host = false"], model: { model: null, effort: "x" }, outputPath: "o", schemaPath: "s" })).toThrow(/code_mode_host=false blinds the agent/)
  })
})

describe("who pays (§3f.2)", () => {
  it("maps claude auth status without reading email or org", () => {
    const plan = claudeWhoPays({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "PII", orgName: "PII" })
    expect(plan).toEqual({ payer: "plan", label: "your Claude plan (max) pays" })
    expect(JSON.stringify(plan)).not.toContain("PII")
    expect(claudeWhoPays({ authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }).payer).toBe("api_key")
    expect(claudeWhoPays({ authMethod: "claude.ai", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }).payer).toBe("api_key")
    expect(claudeWhoPays({ authMethod: "third_party", apiProvider: "bedrock" })).toEqual({ payer: "third_party", label: "billed to your Amazon Bedrock account" })
    expect(claudeWhoPays({ authMethod: "oauth_token", apiProvider: "firstParty" }).payer).toBe("unknown")
  })

  it("maps codex login status by credential kind and never echoes key text", () => {
    expect(codexWhoPays("Logged in using ChatGPT")).toEqual({ payer: "plan", label: "your ChatGPT plan pays" })
    const key = codexWhoPays("Logged in using an API key - sk-proj-***abcd")
    expect(key?.payer).toBe("api_key")
    expect(JSON.stringify(key)).not.toContain("sk-proj")
    expect(codexWhoPays("Not logged in")).toBeNull()
  })

  it("checks system/init.apiKeySource against the plan line (\"none\" = plan)", () => {
    expect(apiKeySourceMatches({ payer: "plan", label: "" }, "none")).toBe(true)
    expect(apiKeySourceMatches({ payer: "plan", label: "" }, "ANTHROPIC_API_KEY")).toBe(false)
    expect(apiKeySourceMatches({ payer: "plan", label: "" }, null)).toBe(false)
    expect(apiKeySourceMatches({ payer: "api_key", label: "" }, "none")).toBe(false)
    expect(parseVersion("2.1.287 (Claude Code)")).toBe("2.1.287")
    expect(parseVersion("codex-cli 0.159.2")).toBe("0.159.2")
  })
})
