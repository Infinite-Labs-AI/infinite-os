import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cleanup, tempDir } from "../../test/wizard/repo.js"
import { agentArgvViolations, CLAIMS_SCHEMA, codexPermissionArgs, CODEX_DISABLED_FEATURES, REVIEW_SCHEMA } from "../wizard/contracts/agents.js"
import { buildClaudeReviewerArgv, buildClaudeWorkerArgv, claudeMcpConfig, sensitiveDenies } from "./claude.js"
import { buildCodexWorkerArgv } from "./codex.js"
import { codexWhoPays } from "./detect.js"
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
})

describe("who pays (§3f.2)", () => {
  it("maps codex login status by credential kind and never echoes key text", () => {
    expect(codexWhoPays("Logged in using ChatGPT")).toEqual({ payer: "plan", label: "your ChatGPT plan pays" })
    const key = codexWhoPays("Logged in using an API key - sk-proj-***abcd")
    expect(key?.payer).toBe("api_key")
    expect(JSON.stringify(key)).not.toContain("sk-proj")
    expect(codexWhoPays("Not logged in")).toBeNull()
  })
})
