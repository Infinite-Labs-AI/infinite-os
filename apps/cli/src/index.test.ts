import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import * as growthDb from "@infinite-os/db";
import {
  createFileSessionMemoryStore,
  createOperatorSessionMemory,
  sessionMemoryPathForRoot
} from "@infinite-os/runtime";
import {
  NoActiveProjectError,
  readActiveProjectId,
  writeActiveProjectId,
  readDefaultProjectId,
  writeDefaultProjectId,
  readMigrationNoticeShown,
  writeInfiniteOsModelSelection
} from "@infinite-os/config";
import { createInteractiveProgressReporter } from "./formatting/live-activity.js";
import {
  promptChecklist,
  promptChoice,
  promptProviderMatrix,
  promptText,
  promptUrl,
  shouldUseInteractivePrompts
} from "./setup-prompts.js";
import * as setupPrompts from "./setup-prompts.js";
import { formatInfiniteBusyIndicator } from "./tui/ink/status-indicator.js";

import {
  appendInputHistory,
  appendPersistentInputHistory,
  applyCompletionSuggestion,
  applyComposerEdit,
  applySessionPin,
  cliBoot,
  decidePreTurnProjectSelection,
  resolveDistinctProjectMentions,
  completeInteractiveInputForCli,
  composerCursorLayout,
  composerNativeCursorPosition,
  completeInteractiveInput,
  getProjectListCache,
  normalizeProjectSlug,
  readProjectPinChange,
  resolveProjectPin,
  setProjectListCacheForTest,
  completeSlashCommands,
  composeCodeVersion,
  createInfiniteTranscriptRuntime,
  ensureActiveAgentRuntime,
  formatInteractiveProgress,
  getTurnState,
  InfiniteTurnController,
  helpText,
  LongRunToolCharmTicker,
  operatorConfirmationText,
  renderAssistantResponsePanel,
  buildSetupOnboardingResult,
  renderCliResult,
  renderCliResultForStream,
  renderDetectedModelAuthStatus,
  renderInfiniteAppChrome,
  renderInfiniteTranscript,
  resetAgentRuntime,
  applySessionDefaultPin,
  runSetupInterview,
  runSetupWizard,
  renderInkInteractiveSessionToString,
  renderInkTranscriptToString,
  inkTranscriptRowCount,
  renderStatusFooter,
  resolveSetupResumePostHogResumeSecrets,
  resolveSetupResumePostHogPersonalApiKey,
  resolveCliRenderSurface,
  resolveTheme,
  handleInteractiveSetupPreflight,
  inputHistoryPath,
  loadPersistentInputHistory,
  maybeLaunchInfiniteAfterSetup,
  maybeNotifyUpdateAvailable,
  navigateInputHistory,
  parsePersistentInputHistory,
  requiresOperatorConfirmation,
  createLocalGa4OauthBootstrap,
  createSetupInteractionWiring,
  runGa4TagInstallOffer,
  expandHomePath,
  createCliAgentRuntime,
  runCli,
  runCliInput,
  runCommand,
  runSlashCommand,
  resetTurnState,
  resolveProjectFlag,
  setupProjectStep,
  shouldUseInkInteractiveSession,
  localChatReadiness,
  readSetupReadiness,
  waitForAppReady,
  type ChatProgressEvent,
  type CliAgentRuntime
} from "./index.js";

type RunSetupWizardOptions = NonNullable<Parameters<typeof runSetupWizard>[2]>;
type RunSetupOnboardingMock = NonNullable<RunSetupWizardOptions["runSetupOnboarding"]>;
type ResumeSetupRunMock = NonNullable<RunSetupWizardOptions["resumeSetupRun"]>;

// Box-drawing layout assertions must hold whether or not the terminal advertises
// color support. When color is enabled (isTTY: true and NO_COLOR unset) the renderer
// wraps the border glyph and the body text in separate ANSI color spans, so a literal
// substring like "│ Revenue is up." is split by an SGR reset. Strip ANSI escapes first
// so these tests verify the rendered glyph + text layout deterministically across
// environments, instead of silently depending on the ambient NO_COLOR setting.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

function writeFakeDockerBin(directory: string, stderrLines: string[]): string {
  const dockerBin = join(directory, "docker");
  writeFileSync(
    dockerBin,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' ${stderrLines.map((line) => `'${line.replace(/'/g, `'\"'\"'`)}'`).join(" ")} >&2`,
      "exit 1"
    ].join("\n")
  );
  chmodSync(dockerBin, 0o755);
  return dockerBin;
}

describe("cli smoke", () => {
  const waitForStreamBatch = () => new Promise((resolve) => setTimeout(resolve, 20));

  afterEach(() => {
    resetTurnState();
    vi.unstubAllGlobals();
  });

  it("boots through the runtime package", () => {
    expect(cliBoot).toBe(true);
  });

  it("exposes first-phase CLI commands", () => {
    expect(helpText()).toContain("init");
    expect(helpText()).toContain("start");
    expect(helpText()).toContain("stop");
    expect(helpText()).toContain("logs [service]");
    expect(helpText()).toContain("migrate");
    expect(helpText()).toContain("connect <provider>             Connect or reconnect a provider interactively");
    expect(helpText()).toContain("connect <provider> [name] <json_credential_payload>");
    expect(helpText()).not.toContain("connect oauth <provider> --client-id <id>");
    expect(helpText()).not.toContain("connect oauth-status <session_id>");
    expect(helpText()).not.toContain("connect oauth-exchange <session_id> [--property-id <id>]");
    expect(helpText()).toContain("Providers: ga4, posthog, x, meta, stripe, shopify");
    expect(helpText()).toContain("sync <provider|source_id> [window]");
    expect(helpText()).toContain("sync all [window]");
    expect(helpText()).toContain("Windows: incremental, 30_days, 3_months, 6_months, 12_months, all_time");
    expect(helpText()).toContain("status");
    expect(helpText()).toContain("sync-runs");
    expect(helpText()).not.toContain("ask <question>");
    expect(helpText()).toContain("explain <metric>");
    expect(helpText()).not.toContain("call <action_id>");
    expect(helpText()).toContain("saved-report create");
    expect(helpText()).toContain("setup");
    expect(helpText()).toContain("setup runtime");
    expect(helpText()).toContain("setup status");
    expect(helpText()).toContain("setup connectors");
    expect(helpText()).toContain("setup query");
    expect(helpText()).toContain("setup resume <run_id>");
    expect(helpText()).toContain("setup reset [tool]");
    expect(helpText()).toContain("auth login codex");
    expect(helpText()).toContain("model use");
    expect(helpText()).toContain("infinite \"message\"");
    expect(helpText()).not.toContain("/sessions");
    expect(helpText()).not.toContain("/resume <session_id>");
    expect(helpText()).not.toContain("/compact [summary]");
    expect(helpText()).toContain("recipes");
    expect(helpText()).not.toContain("recipe <recipe_id>");
    expect(helpText()).not.toContain("mcp | tools");
    expect(helpText()).not.toContain("gateway start|restart|stop");
    expect(helpText()).not.toContain("Inside an interactive session");
    expect(helpText()).toContain("infinite connect x");
    expect(helpText()).toContain("infinite connect meta");
    expect(helpText()).toContain("infinite sync meta 30_days");
    expect(helpText()).toContain("infinite sync all incremental");
    expect(helpText()).toContain("Common:");
    expect(helpText()).toContain("Connect data:");
    expect(helpText()).toContain("Sync data:");
    expect(helpText()).toContain("Inspect:");
    expect(helpText()).toContain("Runtime:");
    expect(helpText()).toContain("Schedules:");
    expect(helpText()).toContain("Reports:");
  });

  it("renders analytical envelopes into operator sections", () => {
    const rendered = renderCliResult({
      ok: true,
      actionId: "run_metric_query",
      authority: "tool_agent",
      status: "ok",
      data: {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        rows: [{ month: "2026-06", value: 123 }]
      },
      provenance: ["queryable.vw_revenue_by_source"],
      freshness: { target: "24 hours", asOf: null, stale: false },
      caveats: ["content_linkage_not_implemented"],
      truncated: false,
      nextActions: ["run_metric_query", "explain_answer", "drilldown_result"]
    });

    expect(rendered).toContain("Answer");
    expect(rendered).toContain("Caveats");
    expect(rendered).toContain("Freshness");
    expect(rendered).toContain("Provenance");
    expect(rendered).toContain("Next actions");
  });

  it("renders chat responses as chat instead of raw JSON", () => {
    const rendered = renderCliResult({
      ok: true,
      sessionId: "cli-session",
      message: "You have 31 followers.",
      provenance: ["queryable.vw_x_profile_public_metrics"],
      actionCalls: []
    });

    expect(rendered).toBe("You have 31 followers.");
    expect(rendered).not.toContain('"sessionId"');
    expect(rendered).not.toContain('"provenance"');
  });

  it("keeps chat responses plain on non-TTY streams", () => {
    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "cli-session",
        message: "You have 31 followers.",
        provenance: [],
        actionCalls: []
      },
      { isTTY: false, columns: 80 },
      {}
    );

    expect(rendered).toBe("You have 31 followers.");
  });

  it("frames chat responses with the Hermes-style Infinite panel on TTY streams", () => {
    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "cli-session",
        message: "You have 31 followers.",
        provenance: [],
        actionCalls: [],
        modelProvider: "codex",
        modelName: "gpt-5.4",
        usage: { promptTokens: 10, completionTokens: 4 }
      },
      { isTTY: true, columns: 54 },
      {}
    );

    const plain = stripAnsi(rendered);
    expect(plain).toContain("╔ ∞ Infinite ");
    expect(plain).toContain("╭─ ∞ Infinite ");
    expect(plain).toContain("│ You have 31 followers.");
    expect(plain).toContain("╰");
    expect(plain).toContain("session cli-session");
    expect(plain).toContain("model codex:gpt-5.4");
    expect(plain).toContain("tokens 10/4");
  });

  it("resolves built-in Hermes-style CLI skins from the environment", () => {
    expect(resolveTheme({}).brand.name).toBe("Infinite");
    expect(resolveTheme({ INFINITE_CLI_SKIN: "mono" }).brand.name).toBe("Infinite Mono");
    expect(resolveTheme({ INFINITE_THEME: "slate" }).color.primary).toBe("#54C6FF");
    expect(resolveTheme({ INFINITE_SKIN: "unknown" }).brand.name).toBe("Infinite");
  });

  it("loads explicit Hermes-style user skin files", () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-skin-file-"));
    try {
      const skinPath = join(root, "cyber.yaml");
      writeFileSync(skinPath, [
        "name: cyber",
        "colors:",
        "  response_border: \"#FF00FF\"",
        "  banner_title: \"#00FFFF\"",
        "  banner_text: \"#F0FFFF\"",
        "  status_bar_dim: \"#778899\"",
        "branding:",
        "  agent_name: \"Cyber Agent\"",
        "  prompt_symbol: \"»\"",
        "tool_prefix: \"▏\""
      ].join("\n"));

      const theme = resolveTheme({ INFINITE_SKIN_FILE: skinPath });
      expect(theme.brand.name).toBe("Cyber Agent");
      expect(theme.brand.prompt).toBe("»");
      expect(theme.brand.tool).toBe("▏");
      expect(theme.color.primary).toBe("#FF00FF");
      expect(theme.color.primaryBright).toBe("#00FFFF");
      expect(theme.color.text).toBe("#F0FFFF");
      expect(theme.color.muted).toBe("#778899");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads named user skins from configured skin directories", () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-skin-dir-"));
    try {
      const skinDir = join(root, "skins");
      mkdirSync(skinDir);
      writeFileSync(join(skinDir, "aurora.yaml"), [
        "name: aurora",
        "colors:",
        "  ui_accent: \"#44FFDD\"",
        "  ui_error: \"#FF3366\"",
        "branding:",
        "  agent_name: \"Aurora\""
      ].join("\n"));

      const theme = resolveTheme({ INFINITE_CLI_SKIN: "aurora", INFINITE_SKIN_DIR: skinDir });
      expect(theme.brand.name).toBe("Aurora");
      expect(theme.color.primary).toBe("#44FFDD");
      expect(theme.color.error).toBe("#FF3366");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies selected CLI skin to TTY app chrome rendering", () => {
    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "cli-session",
        message: "Revenue is up.",
        provenance: [],
        actionCalls: []
      },
      { isTTY: true, columns: 72 },
      { INFINITE_TUI_CHROME: "1", INFINITE_CLI_SKIN: "mono" }
    );

    expect(rendered).toContain("∞ Infinite Mono");
    expect(rendered).toContain("Revenue is up.");
    expect(rendered).toContain("› Type a message, /help, or /exit.");
  });

  it("resolves CLI render surfaces including Ink/TUI aliases", () => {
    expect(resolveCliRenderSurface({ isTTY: false }, { INFINITE_RENDER_SURFACE: "chrome" })).toBe("plain");
    expect(resolveCliRenderSurface({ isTTY: true }, { INFINITE_PLAIN_OUTPUT: "1", INFINITE_RENDER_SURFACE: "ink" })).toBe("plain");
    expect(resolveCliRenderSurface({ isTTY: true }, {})).toBe("ink");
    expect(resolveCliRenderSurface({ isTTY: true }, { INFINITE_RENDER_SURFACE: "raw" })).toBe("raw");
    expect(resolveCliRenderSurface({ isTTY: true }, { INFINITE_TUI_CHROME: "true" })).toBe("chrome");
    expect(resolveCliRenderSurface({ isTTY: true }, { INFINITE_RENDER_SURFACE: "app_chrome" })).toBe("chrome");
    expect(resolveCliRenderSurface({ isTTY: true }, { INFINITE_RENDER_SURFACE: "tui" })).toBe("ink");
    expect(resolveCliRenderSurface({ isTTY: true }, { INFINITE_RENDER_SURFACE: "alternate-screen" })).toBe("ink");
  });

  it("routes requested Ink/TUI final output through transcript app chrome", () => {
    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "cli-session",
        message: "Revenue is up.",
        provenance: [],
        actionCalls: [],
        modelProvider: "codex",
        modelName: "gpt-5.4"
      },
      { isTTY: true, columns: 72 },
      { INFINITE_RENDER_SURFACE: "ink" }
    );

    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("Revenue is up.");
    expect(rendered).toContain("session cli-session");
    expect(rendered).toContain("model codex:gpt-5.4");
    expect(rendered).toContain("❯ Type a message, /help, or /exit.");
  });

  it("renders assistant panels and status footers with bounded display width", () => {
    const panel = renderAssistantResponsePanel("Revenue is up and signups are steady.", {
      color: false,
      columns: 48
    });
    const footer = renderStatusFooter(["Infinite", "gpt-5.4", "12s", "workspace"], {
      color: false,
      columns: 32
    });

    expect(panel).toContain("Revenue is up and signups are");
    expect(panel).toContain("steady.");
    expect(footer).toHaveLength(32);
    expect(footer.trim()).toBe("Infinite  |  gpt-5.4  |  12s …");
  });

  it("renders Hermes app chrome around transcript snapshots", () => {
    const rendered = renderInfiniteAppChrome(
      {
        prompt: { placeholder: "Ask about your growth data." },
        status: ["session cli-session", "model codex:gpt-5.4", "tokens 10/4"],
        transcript: {
          messages: [{ role: "assistant", text: "Revenue is up." }]
        }
      },
      { columns: 72, color: false }
    );

    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("Revenue is up.");
    expect(rendered).toContain("session cli-session");
    expect(rendered).toContain("model codex:gpt-5.4");
    expect(rendered).toContain("❯ Ask about your growth data.");
  });

  it("renders inline diff messages in Hermes transcript snapshots", () => {
    const rendered = renderInfiniteTranscript(
      {
        messages: [
          {
            kind: "diff",
            role: "system",
            text: [
              "diff --git a/app.ts b/app.ts",
              "@@ -1,3 +1,3 @@",
              "-old revenue label",
              "+new revenue label",
              " unchanged context"
            ].join("\n")
          }
        ]
      },
      { columns: 72, color: false }
    );

    expect(rendered).toContain("Δ diff");
    expect(rendered).toContain("diff --git a/app.ts b/app.ts");
    expect(rendered).toContain("@ -1,3 +1,3 @@");
    expect(rendered).toContain("- old revenue label");
    expect(rendered).toContain("+ new revenue label");
    expect(rendered).toContain("│  unchanged context");
  });

  it("renders inline diffs inside Hermes app chrome", () => {
    const rendered = renderInfiniteAppChrome(
      {
        status: ["session cli-session"],
        transcript: {
          messages: [
            { kind: "diff", role: "system", text: "-before\n+after" },
            { role: "assistant", text: "Updated the label." }
          ]
        }
      },
      { columns: 72, color: false }
    );

    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("Δ diff");
    expect(rendered).toContain("- before");
    expect(rendered).toContain("+ after");
    expect(rendered).toContain("Updated the label.");
  });

  it("can opt into Hermes app chrome for TTY chat responses", () => {
    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "cli-session",
        message: "Revenue is up.",
        provenance: ["queryable.vw_revenue_by_source"],
        actionCalls: [
          {
            actionId: "run_metric_query",
            input: { metric: "recognized_revenue", view: "queryable.vw_revenue_by_source" },
            status: "ok",
            envelope: {
              actionId: "run_metric_query",
              authority: "tool_agent",
              caveats: [],
              data: { rows: [{ recognized_revenue: 9800 }] },
              freshness: { target: "stripe", asOf: "2026-06-01", stale: false },
              nextActions: [],
              ok: true,
              provenance: ["queryable.vw_revenue_by_source"],
              status: "ok",
              truncated: false
            }
          }
        ],
        modelProvider: "codex",
        modelName: "gpt-5.4",
        usage: { promptTokens: 10, completionTokens: 4 }
      },
      { isTTY: true, columns: 72 },
      { INFINITE_TUI_CHROME: "1" }
    );

    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("Revenue is up.");
    expect(rendered).toContain("tools 1");
    expect(rendered).toContain("Run Metric Query");
    expect(rendered).toContain("metric=recognized_revenue");
    expect(rendered).toContain("1 row");
    expect(rendered).toContain("1 source");
    expect(rendered).toContain("session cli-session");
    expect(rendered).toContain("model codex:gpt-5.4");
    expect(rendered).toContain("tokens 10/4");
    expect(rendered).toContain("actions 1");
    expect(rendered).toContain("sources 1");
    expect(rendered).toContain("❯ Type a message, /help, or /exit.");
  });

  it("renders setup results as a human summary instead of raw JSON", () => {
    const rendered = renderCliResult({
      ok: true,
      init: {
        configPath: "/workspace/.growth-os/config.yml",
        envPath: "/workspace/.growth-os/.env"
      },
      model: {
        provider: "claude",
        model: "claude-sonnet-4-5"
      },
      auth: {
        provider: "claude",
        ready: true,
        source: "claude-code-credentials-file"
      },
      runtime: {
        ok: true,
        command: ["docker", "compose", "up", "-d"]
      },
      next: "Run `infinite`, then type your question."
    });

    expect(rendered).toContain("Infinite setup complete.");
    expect(rendered).toContain("Runtime:");
    expect(rendered).toContain("Start: docker compose up -d");
    expect(rendered).toContain("Provider: claude");
    expect(rendered).toContain("Auth: ready");
    expect(rendered).toContain("Run infinite, then type your question.");
    expect(rendered.trim()).not.toMatch(/^\{/);
  });

  it("renders runtime setup results as a human summary instead of raw JSON", () => {
    const rendered = renderCliResult({
      ok: true,
      section: "runtime",
      runtime: {
        mode: "external_postgres",
        configPath: "/workspace/.growth-os/config.yml",
        envPath: "/workspace/.growth-os/.env",
        databaseUrl: "postgres://user:[redacted]@db.example.com:5432/growth",
        start: { ok: true, skipped: true, reason: "external_runtime" },
        migrations: { ok: true, dryRun: true }
      },
      next: "Run `infinite setup model` to choose Codex or Claude."
    });

    expect(rendered).toContain("Infinite runtime setup");
    expect(rendered).toContain("Mode: external_postgres");
    expect(rendered).toContain("Migrations: dry-run");
    expect(rendered).toContain("Run infinite setup model to choose Codex or Claude.");
    expect(rendered.trim()).not.toMatch(/^\{/);
  });

  it("renders full setup wizard results as a human summary instead of raw JSON", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "wizard",
      setupMode: "full",
      existingInstall: true,
      sections: [
        {
          id: "runtime",
          title: "Runtime and storage",
          result: { runtime: { mode: "local_docker", migrations: { alreadyUpToDate: true } } }
        },
        {
          id: "model",
          title: "Model and auth for LLM querying",
          result: { provider: "claude", model: "claude-sonnet-4-5", auth: { reason: "growth_os_auth_ready" } }
        },
        {
          id: "project",
          title: "Your first project",
          result: {
            interview: {
              projectName: "Acme",
              websiteUrl: "https://acme.test",
              productSurface: "web",
              providerInventory: [
                { provider: "ga4", hasAccount: true, installState: "installed", selected: true, recommended: true },
                { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
                { provider: "x", hasAccount: false, installState: "not_installed", selected: false, recommended: true }
              ]
            }
          }
        },
        {
          id: "query",
          title: "Query readiness",
          result: { setupReadiness: { llmQuery: "blocked", blockingReasons: ["connectors_missing"] } }
        },
        {
          id: "status",
          title: "Review and start",
          result: {
            files: {
              projectConfigPath: "/workspace/.growth-os/config.yml",
              runtimeEnvPath: "/workspace/.growth-os/.env",
              userConfigPath: "/home/user/.growth-os/config.yml",
              userAuthPath: "/home/user/.growth-os/auth.json"
            }
          }
        }
      ],
      next: "Run `infinite setup status` to review blockers."
    });

    expect(rendered).toContain("Infinite setup");
    expect(rendered).toContain("Reconfigure (full)");
    expect(rendered).toContain("Runtime and storage");
    expect(rendered).toContain("Model and auth for LLM querying");
    expect(rendered).toContain("Your first project");
    expect(rendered).toContain("project=Acme surface=web providers=GA4, POSTHOG");
    expect(rendered).toContain("Website: https://acme.test");
    expect(rendered).toContain("Query readiness");
    expect(rendered).toContain("Files");
    expect(rendered).toContain("/workspace/.growth-os/config.yml");
    expect(rendered).toContain("Setup incomplete.");
    expect(rendered.trim()).not.toMatch(/^\{/);
  });

  it("renders default existing-setup wizard summaries without reconfigure wording", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "wizard",
      setupMode: "reuse",
      existingInstall: true,
      sections: [
        {
          id: "runtime",
          title: "Runtime and storage",
          result: {
            reused: true,
            runtime: { mode: "local_docker", migrations: { skipped: true, mode: "existing_setup" } }
          }
        }
      ],
      next: "Run `infinite setup status` to review blockers."
    });

    expect(rendered).toContain("Using existing setup");
    expect(rendered).toContain("mode=local_docker using existing setup");
    expect(rendered).not.toContain("Reconfigure (full)");
  });

  it("renders quick-setup wizard summaries with skipped-section guidance", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "wizard",
      setupMode: "quick",
      existingInstall: false,
      sections: [
        {
          id: "connectors",
          title: "Data connectors",
          result: {
            ok: false,
            skipped: true
          }
        }
      ],
      next: "Run `infinite setup status` to review blockers."
    });

    expect(rendered).toContain("quick");
    expect(rendered).toContain("Skipped in quick setup.");
    expect(rendered).toContain("Run `infinite setup connectors`");
  });

  it("renders setup status with files, blockers, and exact rerun command", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "status",
      setupReadiness: {
        ok: false,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "none",
        llmQuery: "blocked",
        blockingReasons: ["connectors_missing: Connect at least one marketing data source."]
      },
      files: {
        projectConfigPath: "/workspace/.growth-os/config.yml",
        runtimeEnvPath: "/workspace/.growth-os/.env",
        userConfigPath: "/home/user/.growth-os/config.yml",
        userAuthPath: "/home/user/.growth-os/auth.json"
      },
      nextCommand: "infinite setup connectors",
      next: "Run `infinite setup connectors` to finish setup."
    });

    expect(rendered).toContain("Infinite setup status");
    expect(rendered).toContain("Files:");
    expect(rendered).toContain("Blocking reasons:");
    expect(rendered).toContain("connectors_missing");
    expect(rendered).toContain("Rerun:");
    expect(rendered).toContain("infinite setup connectors");
    expect(rendered).not.toContain("supersecret");
  });

  it("renders setup status with `Next: infinite` when setup is complete", () => {
    const rendered = renderCliResult({
      ok: true,
      section: "status",
      setupReadiness: {
        ok: true,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "connected",
        llmQuery: "ready",
        blockingReasons: []
      },
      files: {
        projectConfigPath: "/workspace/.growth-os/config.yml",
        runtimeEnvPath: "/workspace/.growth-os/.env",
        userConfigPath: "/home/user/.growth-os/config.yml",
        userAuthPath: "/home/user/.growth-os/auth.json"
      },
      nextCommand: "infinite",
      next: "Run `infinite`, then type your question."
    });

    expect(rendered).toContain("Next:");
    expect(rendered).toContain("infinite");
    expect(rendered).not.toContain("Rerun:");
  });

  it("renders setup status with active run, handoff, and verification summaries", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "status",
      setupReadiness: {
        ok: false,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "none",
        llmQuery: "blocked",
        blockingReasons: ["connectors_missing: Connect at least one marketing data source."],
        activeSetupRun: {
          id: "setuprun_active",
          tool: "ga4",
          provider: "ga4",
          status: "paused_handoff",
          interview: {
            projectName: "Acme",
            websiteUrl: "https://acme.test",
            productSurface: "web"
          },
          selectedProviders: ["ga4"],
          recommendedProviders: ["ga4", "posthog"],
          providers: {
            ga4: {
              phases: {
                detect: { status: "ok", detail: "detected" },
                connect: { status: "needs_human", detail: "Finish Google sign-in" }
              },
              verification: {
                installStatus: "verified",
                queryabilityStatus: "pending"
              }
            }
          },
          pendingHandoff: {
            kind: "open_url",
            instructions: "Finish Google sign-in",
            url: "https://accounts.google.com/o/oauth2/auth"
          },
          site: {
            url: "https://acme.test",
            repoPath: "/workspace/acme",
            appDir: "apps/web",
            framework: "next"
          }
        }
      },
      files: {
        projectConfigPath: "/workspace/.growth-os/config.yml",
        runtimeEnvPath: "/workspace/.growth-os/.env",
        userConfigPath: "/home/user/.growth-os/config.yml",
        userAuthPath: "/home/user/.growth-os/auth.json"
      },
      nextCommand: "infinite setup connectors",
      next: "Run `infinite setup connectors` to finish setup."
    });

    expect(rendered).toContain("Active setup run:");
    expect(rendered).toContain("setuprun_active");
    expect(rendered).toContain("Acme");
    expect(rendered).toContain("Selected providers: GA4");
    expect(rendered).toContain("Action required: Finish Google sign-in");
    expect(rendered).toContain("Open this page: https://accounts.google.com/o/oauth2/auth");
    expect(rendered).toContain("Finish Google sign-in");
    expect(rendered).toContain("Resume: infinite setup resume setuprun_active");
    expect(rendered).toContain("Verification:");
    expect(rendered).toContain("ga4: install=verified, queryability=pending");
  });

  it("renders a PostHog key-file import hint for active API-key handoffs", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "status",
      setupReadiness: {
        ok: false,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "none",
        llmQuery: "blocked",
        blockingReasons: [],
        activeSetupRun: {
          id: "setuprun_posthog",
          tool: "posthog",
          provider: "posthog",
          status: "paused_handoff",
          interview: {
            projectName: "Acme",
            websiteUrl: "https://acme.test",
            productSurface: "web"
          },
          selectedProviders: ["posthog"],
          recommendedProviders: ["posthog"],
          providers: {},
          pendingHandoff: {
            kind: "open_url",
            instructions: "Create a scoped personal API key, then resume setup.",
            url: "https://us.posthog.com/settings/user-api-keys"
          }
        }
      },
      nextCommand: "infinite setup resume setuprun_posthog",
      next: "Run `infinite setup resume setuprun_posthog` to resume the active setup run."
    });

    expect(rendered).toContain("Action required: Create a scoped personal API key, then resume setup.");
    expect(rendered).toContain(
      "Key file import: infinite setup resume setuprun_posthog --posthog-personal-api-key-file .growth-os/tmp/posthog-personal-api-key --posthog-api-host <https://eu.posthog.com|https://us.posthog.com>"
    );
    expect(rendered).toContain("Open this page: https://us.posthog.com/settings/user-api-keys");
  });

  it("does not advertise resume for a running active setup run", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "status",
      setupReadiness: {
        ok: false,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "none",
        llmQuery: "blocked",
        blockingReasons: [],
        activeSetupRun: {
          id: "setuprun_running",
          tool: "ga4",
          provider: "ga4",
          status: "running"
        }
      }
    });

    expect(rendered).toContain("Active setup run:");
    expect(rendered).toContain("Status: running");
    expect(rendered).not.toContain("Resume: infinite setup resume setuprun_running");
  });

  it("flags a stale active setup run and points at setup reset", () => {
    const staleReadiness = (updatedAt: string) => ({
      ok: false,
      section: "status",
      setupReadiness: {
        ok: false,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "none",
        llmQuery: "blocked",
        blockingReasons: [],
        activeSetupRun: {
          id: "setuprun_stuck",
          tool: "ga4",
          provider: "ga4",
          status: "running",
          updatedAt
        }
      }
    });

    const stale = renderCliResult(staleReadiness(new Date(Date.now() - 16 * 60 * 1000).toISOString()));
    expect(stale).toContain("This run looks stale — run `infinite setup reset` to clear it.");

    const fresh = renderCliResult(staleReadiness(new Date().toISOString()));
    expect(fresh).not.toContain("looks stale");
  });

  it("renders setup reset results with the cleared runs", () => {
    const rendered = renderCliResult({
      ok: true,
      section: "reset",
      cleared: [
        { id: "setuprun_1", tool: "ga4" },
        { id: "setuprun_2", tool: "posthog" }
      ],
      next: "Run `infinite setup` to start a fresh setup run."
    });
    expect(rendered).toContain("Cleared 2 active setup runs:");
    expect(rendered).toContain("ga4: setuprun_1");
    expect(rendered).toContain("posthog: setuprun_2");
    expect(rendered).toContain("Next:");

    const empty = renderCliResult({ ok: true, section: "reset", cleared: [] });
    expect(empty).toContain("No active setup runs to clear.");
  });

  it("redacts OAuth query strings and fragments from active setup run summaries", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "status",
      setupReadiness: {
        ok: false,
        workspaceRoot: "/workspace",
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        model: "selected",
        auth: "ready",
        connectors: "none",
        llmQuery: "blocked",
        blockingReasons: [],
        activeSetupRun: {
          id: "setuprun_active",
          tool: "ga4",
          provider: "ga4",
          status: "paused_handoff",
          pendingHandoff: {
            kind: "open_url",
            instructions: "Finish Google sign-in",
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=secret-state",
            lastKnownUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=secret-state#last"
          }
        }
      }
    });

    expect(rendered).toContain("Open this page: https://accounts.google.com/o/oauth2/v2/auth");
    expect(rendered).not.toContain("client_id=ga-client-id");
    expect(rendered).not.toContain("secret-state");
    expect(rendered).not.toContain("#last");
  });

  it("omits resume from setup status nextCommand for a running active setup run", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-status-running-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-status-running-home-"));
    const originalFetch = globalThis.fetch;
    const dbSpy = vi.spyOn(growthDb, "createInfiniteOsDb").mockReturnValue({
      async query(sql: string) {
        if (sql.includes("from sources")) {
          return [];
        }
        return [];
      },
      async one(sql: string) {
        if (sql.includes("from setup_runs")) {
          return {
            id: "setuprun_running",
            tool: "ga4",
            provider: "ga4",
            status: "running",
            phase_state: {
              interview: {
                projectName: "Acme",
                productSurface: "web",
                providerInventory: []
              }
            },
            pending_handoff: null,
            site_id: null
          };
        }
        return null;
      },
      async close() {
        return undefined;
      }
    } as unknown as growthDb.InfiniteOsDb);

    try {
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });
      globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;

      const result = (await runCommand("setup", ["status"], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_WORKSPACE_ID: "proj_running",
        GROWTH_OS_HOME: growthHome
      })) as { section?: string; nextCommand?: string; next?: string };

      expect(result).toMatchObject({
        section: "status"
      });
      expect(result.nextCommand).not.toBe("infinite setup resume setuprun_running");
      expect(String(result.next)).not.toContain("resume setuprun_running");
    } finally {
      dbSpy.mockRestore();
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("renders rerun setup wizard output with active setup run summaries in the status section", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "wizard",
      existingInstall: true,
      setupMode: "full",
      sections: [
        {
          id: "status",
          title: "Setup status",
          result: {
            ok: false,
            section: "status",
            setupReadiness: {
              ok: false,
              workspaceRoot: "/workspace",
              runtimeConfig: "configured",
              runtimeServices: "ready",
              database: "migrated",
              model: "selected",
              auth: "ready",
              connectors: "none",
              llmQuery: "blocked",
              blockingReasons: ["connectors_missing: Connect at least one marketing data source."],
              activeSetupRun: {
                id: "setuprun_active",
                tool: "ga4",
                provider: "ga4",
                status: "paused_handoff",
                providers: {
                  ga4: {
                    phases: {
                      connect: { status: "needs_human", detail: "Finish Google sign-in" }
                    },
                    verification: {
                      installStatus: "verified",
                      queryabilityStatus: "pending"
                    }
                  }
                },
                pendingHandoff: {
                  kind: "open_url",
                  instructions: "Finish Google sign-in"
                }
              }
            }
          }
        }
      ],
      next: "Run `infinite setup status` to review blockers."
    });

    expect(rendered).toContain("Reconfigure (full)");
    expect(rendered).toContain("run=setuprun_active");
    expect(rendered).toContain("handoff=Finish Google sign-in");
    expect(rendered).toContain("verify=ga4:verified/pending");
  });

  it("identifies operator commands for confirmation in the interactive shell", () => {
    expect(requiresOperatorConfirmation("/sync src_1")).toBe(true);
    expect(requiresOperatorConfirmation("/sync x")).toBe(false);
    expect(requiresOperatorConfirmation("/sync x 30_days")).toBe(true);
    expect(requiresOperatorConfirmation("/recipe sync_source {\"sourceId\":\"src_1\"}")).toBe(true);
    expect(operatorConfirmationText("/saved-report export report_1")).toContain("Operator action");
  });

  it("does not expose ask as a command or slash-command", async () => {
    const env = { GROWTH_OS_WORKSPACE_ID: "proj_test" };
    await expect(runCommand("ask", ["What changed?"], env)).rejects.toThrow(
      "Unknown Infinite OS CLI command: ask"
    );
    await expect(runSlashCommand("/ask What changed?", env)).rejects.toThrow(
      "Unknown Infinite OS CLI command: ask"
    );
  });

  it("maps plain interactive input to chat", async () => {
    const calls: Array<{
      message: string;
      onProgress?: (event: ChatProgressEvent) => void;
      progressMode?: "legacy" | "rich" | "both";
      sessionId?: string;
    }> = [];
    const runtime = fakeAgentRuntime({
      async chat(input) {
        calls.push(input);
        return { ok: true, sessionId: "session-chat" };
      }
    });

    await runSlashCommand("How much revenue this month?", {}, undefined, undefined, {
      conversationId: "session-chat"
    }, runtime);

    expect(calls[0]).toMatchObject({
      message: "How much revenue this month?",
      // The runtime receives the immutable conversation id; the real runtime
      // derives `${conversationId}:${workspaceId}` (see deriveControllerSessionId),
      // the fake forwards it verbatim.
      sessionId: "session-chat"
    });
    expect(typeof calls[0]?.onProgress).toBe("function");
  });

  it("lets the Ink interactive shell inject the chat progress callback", async () => {
    const progress = vi.fn();
    const runtime = fakeAgentRuntime({
      async chat(input) {
        input.onProgress?.({
          type: "message.complete",
          stage: "message",
          message: "Assistant message complete.",
          text: "Revenue is up."
        });
        return { ok: true, sessionId: "session-chat", message: "Revenue is up." };
      }
    });

    await runSlashCommand(
      "How much revenue this month?",
      {},
      undefined,
      undefined,
      { conversationId: "session-chat" },
      runtime,
      { onProgress: progress }
    );

    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.complete",
      text: "Revenue is up."
    }));
  });

  it("renders interactive progress lines with Hermes-style tool formatting", () => {
    expect(
      formatInteractiveProgress({ stage: "resolve", message: "Preparing X engagement breakdown." }, 3400)
    ).toBe("┊ ⚡ preparing X engagement breakdown…  3.4s");
    expect(
      formatInteractiveProgress({ stage: "recall", message: "Recalled prior session context." }, 1200)
    ).toBe("┊ 🔍 recall    Recalled prior session context  1.2s");
    expect(
      formatInteractiveProgress({ stage: "tool", message: "Running run_breakdown_query." }, 9800)
    ).toBe("┊ ⚡ tool      run_breakdown_query  9.8s");
    expect(
      formatInteractiveProgress({ stage: "tool", message: "Checking available metrics." }, 2100)
    ).toBe("┊ 🔍 checking  available metrics  2.1s");
    expect(
      formatInteractiveProgress({
        type: "tool.generating",
        stage: "tool",
        message: "Drafting run_breakdown_query.",
        name: "run_breakdown_query"
      }, 1800)
    ).toBe("┊ ⚡ drafting  Run Breakdown Query…  1.8s");
    expect(
      formatInteractiveProgress({
        type: "tool.complete",
        stage: "tool",
        message: "Finished run_breakdown_query.",
        toolId: "call_1",
        name: "run_breakdown_query",
        durationMs: 62000,
        summary: "Finished run_breakdown_query",
        status: "ok"
      }, 9800)
    ).toBe("┊ ⚡ tool      Run Breakdown Query (62.0s) :: Finished run_breakdown_query ✓");
    expect(
      formatInteractiveProgress({
        type: "subagent.start",
        stage: "subagent",
        message: "Delegating transcript review.",
        subagent: {
          id: "agent_review",
          model: "gpt-5.4",
          status: "running",
          summary: "Review Hermes transcript renderer"
        }
      }, 2100)
    ).toBe("┊ ◇ delegate  Review Hermes transcript renderer  2.1s");
  });

  it("records Hermes-style turn state from progress events", () => {
    let now = 1_000;
    const controller = new InfiniteTurnController(() => now);

    resetTurnState();
    controller.recordProgressEvent({
      type: "tool.generating",
      stage: "tool",
      message: "Drafting run_metric_query.",
      name: "run_metric_query"
    });

    expect(getTurnState().turnTrail).toEqual(["drafting Run Metric Query…"]);
    expect(getTurnState().activity.at(-1)?.text).toBe("drafting Run Metric Query");

    controller.recordProgressEvent({
      type: "tool.start",
      stage: "tool",
      message: "Running run_metric_query.",
      toolId: "call_1",
      name: "run_metric_query",
      context: "Running revenue total lookup."
    });

    expect(getTurnState().tools).toMatchObject([
      {
        id: "call_1",
        name: "run_metric_query",
        context: "Running revenue total lookup.",
        startedAt: 1_000
      }
    ]);
    expect(getTurnState().turnTrail).toEqual([]);

    controller.recordProgressEvent({
      type: "reasoning.delta",
      stage: "thinking",
      message: "Checking source coverage.",
      text: "Checking source coverage."
    });

    expect(getTurnState().reasoning).toBe("Checking source coverage.");
    expect(getTurnState().reasoningActive).toBe(true);
    expect(getTurnState().streamSegments[0]).toMatchObject({
      kind: "trail",
      role: "system",
      text: "",
      thinking: "Checking source coverage."
    });

    now = 2_750;
    controller.recordProgressEvent({
      type: "tool.progress",
      stage: "tool",
      message: "Querying recognized revenue.",
      toolId: "call_1",
      name: "run_metric_query",
      preview: "recognized revenue by source"
    });
    controller.recordProgressEvent({
      type: "tool.complete",
      stage: "tool",
      message: "Finished run_metric_query.",
      toolId: "call_1",
      name: "run_metric_query",
      durationMs: 1_750,
      summary: "3 rows",
      status: "ok"
    });

    expect(getTurnState().tools).toEqual([]);
    expect(getTurnState().turnTrail).toEqual(["analyzing tool output…"]);
    expect(getTurnState().streamSegments[0]?.tools).toEqual([
      "Run Metric Query(\"recognized revenue by source\") (1.8s) :: 3 rows ✓"
    ]);

    controller.fullReset();
  });

  it("splits Hermes reasoning tags into trail details at message completion", () => {
    const controller = new InfiniteTurnController(() => 1_000);

    resetTurnState();
    const result = controller.recordMessageComplete({
      text: "<thinking>Need source freshness.</thinking>\nRevenue is $123."
    });

    expect(result.finalText).toBe("Revenue is $123.");
    expect(result.finalMessages).toContainEqual({
      kind: "trail",
      role: "system",
      text: "",
      thinking: "Need source freshness.",
      thinkingTokens: 6,
      toolTokens: undefined
    });
    expect(result.finalMessages).toContainEqual({ role: "assistant", text: "Revenue is $123." });
  });

  it("records Hermes message event deltas into streaming transcript state", async () => {
    const controller = new InfiniteTurnController(() => 1_000);

    resetTurnState();
    controller.recordProgressEvent({
      type: "message.start",
      stage: "message",
      message: "Assistant message started."
    });
    controller.recordProgressEvent({
      type: "message.delta",
      stage: "message",
      message: "Revenue is",
      text: "Revenue is"
    });
    controller.recordProgressEvent({
      type: "message.delta",
      stage: "message",
      message: " up.",
      text: " up."
    });
    await waitForStreamBatch();

    expect(getTurnState().streaming).toBe("Revenue is up.");

    const complete = controller.recordProgressEvent({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Revenue is up."
    });

    expect(complete?.finalMessages).toContainEqual({ role: "assistant", text: "Revenue is up." });
  });

  it("stacks sequential assistant messages within a single turn", async () => {
    const controller = new InfiniteTurnController(() => 1_000);

    resetTurnState();

    // First assistant message: prose streamed, then a tool call begins.
    controller.recordProgressEvent({ type: "message.start", stage: "message", message: "" });
    controller.recordProgressEvent({ type: "message.delta", stage: "message", message: "First answer.", text: "First answer." });
    await waitForStreamBatch();
    expect(getTurnState().streaming).toBe("First answer.");

    // A tool starts. Hermes commits the prior prose into the transcript as
    // its own segment and clears the live region for the next message.
    controller.recordProgressEvent({
      type: "tool.start",
      stage: "tool",
      message: "Running run_metric_query.",
      toolId: "call_1",
      name: "run_metric_query",
      context: "recognized revenue"
    });

    expect(getTurnState().streaming).toBe("");
    expect(getTurnState().streamSegments).toContainEqual({ role: "assistant", text: "First answer." });

    controller.recordProgressEvent({
      type: "tool.complete",
      stage: "tool",
      message: "Finished run_metric_query.",
      toolId: "call_1",
      name: "run_metric_query",
      durationMs: 800,
      summary: "3 rows"
    });

    // Second assistant message: a fresh message.start should not erase the
    // already-committed first message.
    controller.recordProgressEvent({ type: "message.start", stage: "message", message: "" });
    controller.recordProgressEvent({ type: "message.delta", stage: "message", message: "Second answer.", text: "Second answer." });
    await waitForStreamBatch();
    expect(getTurnState().streamSegments).toContainEqual({ role: "assistant", text: "First answer." });

    const complete = controller.recordProgressEvent({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Second answer."
    });

    const assistantTexts = complete?.finalMessages
      .filter((msg) => msg.role === "assistant")
      .map((msg) => msg.text);

    // Both messages must survive into the committed transcript, in order.
    expect(assistantTexts).toEqual(["First answer.", "Second answer."]);
  });

  it("renders Hermes transcript snapshots from turn state", async () => {
    const controller = new InfiniteTurnController(() => 1_000);

    resetTurnState();
    controller.recordProgressEvent({
      type: "reasoning.delta",
      stage: "thinking",
      message: "Thinking.",
      text: "Compare revenue against traffic freshness."
    });
    controller.recordProgressEvent({
      type: "tool.start",
      stage: "tool",
      message: "Running metric query.",
      toolId: "call_1",
      name: "run_metric_query",
      context: "recognized revenue"
    });
    controller.recordProgressEvent({
      type: "tool.complete",
      stage: "tool",
      message: "Metric query complete.",
      toolId: "call_1",
      name: "run_metric_query",
      durationMs: 1_200,
      summary: "recognized_revenue=9800",
      status: "ok"
    });
    controller.recordProgressEvent({
      type: "message.delta",
      stage: "message",
      message: "Revenue is up.",
      text: "Revenue is up."
    });
    await waitForStreamBatch();

    const rendered = renderInfiniteTranscript(
      {
        footer: ["session session-1", "model codex:gpt-5.4", "tokens 12/5"],
        state: getTurnState()
      },
      { columns: 72, color: false, thinkingMode: "full" }
    );

    expect(rendered).toContain("thinking");
    expect(rendered).toContain("Compare revenue against traffic freshness.");
    expect(rendered).toContain("tools 1");
    expect(rendered).toContain("Run Metric Query(\"recognized revenue\")");
    expect(rendered).toContain("recognized_revenue=9800");
    expect(rendered).toContain("Revenue is up.");
    expect(rendered).toContain("session session-1");
    expect(rendered).toContain("model codex:gpt-5.4");
    expect(rendered).toContain("tokens 12/5");
  });

  it("renders active tools and todos in Hermes transcript snapshots", () => {
    const controller = new InfiniteTurnController(() => 1_000);

    resetTurnState();
    controller.recordProgressEvent({
      type: "tool.start",
      stage: "tool",
      message: "Running breakdown.",
      toolId: "call_2",
      name: "run_breakdown_query",
      context: "traffic by channel"
    });
    controller.recordTodos([
      { id: "todo_1", content: "Compare channel mix", status: "in_progress" },
      { id: "todo_2", content: "Draft recommendation", status: "pending" }
    ]);

    const rendered = renderInfiniteTranscript({ state: getTurnState() }, { columns: 72, color: false, nowMs: 3_400 });

    expect(rendered).toContain("running 1");
    expect(rendered).toContain("Run Breakdown Query");
    expect(rendered).toContain("call_2");
    expect(rendered).toContain("started");
    expect(rendered).toContain("traffic by channel");
    expect(rendered).toContain("2.4s");
    expect(rendered).toContain("2 todos left");
    expect(rendered).toContain("Compare channel mix");
    expect(rendered).toContain("Draft recommendation");
  });

  it("renders Hermes-style Ink busy status for active tools", () => {
    const rendered = renderInkTranscriptToString({
      columns: 96,
      indicatorTick: 0,
      nowMs: 3_400,
      status: ["session cli"],
      transcript: {
        state: {
          ...getTurnState(),
          tools: [{
            context: "recognized revenue",
            id: "call_1",
            latestPreview: "recognized revenue by source",
            name: "run_metric_query",
            progressCount: 2,
            startedAt: 1_000,
            updatedAt: 2_200
          }]
        }
      }
    });
    const statusLine = rendered.split("\n").find((line) => line.includes("session cli")) ?? "";

    expect(statusLine).toContain("querying…");
    expect(statusLine).toContain("Run Metric Query");
    expect(statusLine).toContain("2.4s");
  });

  it("shows a turn-level elapsed clock while streaming without active tools", () => {
    const rendered = renderInkTranscriptToString({
      columns: 96,
      indicatorTick: 4,
      nowMs: 2_300,
      status: ["session cli"],
      transcript: {
        state: {
          ...getTurnState(),
          streaming: "Revenue is up."
        }
      },
      turnStartedAt: 1_000
    });
    const statusLine = rendered.split("\n").find((line) => line.includes("session cli")) ?? "";

    expect(statusLine).toContain("ruminating…");
    expect(statusLine).toContain("streaming");
    expect(statusLine).toContain("1.3s");
  });

  it("keeps Hermes spinner frames independent from slower face and verb ticks", () => {
    const state = {
      ...getTurnState(),
      streaming: "Revenue is up."
    };
    const first = formatInfiniteBusyIndicator({
      labelTick: 0,
      nowMs: 2_300,
      spinnerTick: 0,
      state,
      turnStartedAt: 1_000
    });
    const second = formatInfiniteBusyIndicator({
      labelTick: 0,
      nowMs: 2_300,
      spinnerTick: 1,
      state,
      turnStartedAt: 1_000
    });

    expect(first).toContain("(｡•́︿•̀｡)");
    expect(second).toContain("(｡•́︿•̀｡)");
    expect(first).toContain("pondering…");
    expect(second).toContain("pondering…");
    expect(first).not.toBe(second);
  });

  it("renders submit-time busy status before transcript progress events arrive", () => {
    const rendered = renderInkTranscriptToString({
      busy: true,
      columns: 96,
      indicatorTick: 0,
      nowMs: 2_300,
      status: ["session cli"],
      transcript: {
        state: getTurnState()
      },
      turnStartedAt: 1_000
    });
    const statusLine = rendered.split("\n").find((line) => line.includes("session cli")) ?? "";

    expect(statusLine).toContain("pondering…");
    expect(statusLine).toContain("working");
    expect(statusLine).toContain("1.3s");
  });

  it("renders nested subagent trees in Hermes transcript snapshots", () => {
    const rendered = renderInfiniteTranscript(
      {
        messages: [
          {
            kind: "trail",
            role: "system",
            text: "",
            subagents: [
              {
                depth: 0,
                durationSeconds: 12,
                id: "agent_root",
                index: 0,
                inputTokens: 1200,
                model: "gpt-5.4",
                notes: ["Review Hermes app chrome"],
                outputTail: [{ isError: false, preview: "mapped appChrome.tsx", tool: "read" }],
                outputTokens: 400,
                parentId: null,
                status: "running",
                summary: "Review Hermes app chrome",
                taskCount: 2,
                thinking: [],
                toolCount: 3,
                tools: ["read", "rg"]
              },
              {
                depth: 1,
                durationSeconds: 4,
                id: "agent_child",
                index: 0,
                model: "gpt-5.4",
                notes: ["Check status bar widths"],
                parentId: "agent_root",
                status: "completed",
                summary: "Check status bar widths",
                taskCount: 1,
                thinking: [],
                toolCount: 2,
                tools: ["rg"]
              }
            ]
          }
        ]
      },
      { columns: 88, color: false }
    );

    expect(rendered).toContain("subagents");
    expect(rendered).toContain("2 agents");
    expect(rendered).toContain("5 tools");
    expect(rendered).toContain("active 1");
    expect(rendered).toContain("Review Hermes app chrome");
    expect(rendered).toContain("Check status bar widths");
    expect(rendered).toContain("mapped appChrome.tsx");
  });

  it("ingests Hermes subagent progress events into transcript state", () => {
    let now = 1_000;
    const controller = new InfiniteTurnController(() => now);

    resetTurnState();
    controller.recordProgressEvent({
      type: "subagent.start",
      stage: "subagent",
      message: "Delegating Hermes review.",
      subagent: {
        id: "agent_root",
        model: "gpt-5.4",
        notes: ["Review Hermes app chrome"],
        summary: "Review Hermes app chrome",
        taskCount: 2,
        tools: ["rg"]
      }
    });
    controller.recordProgressEvent({
      type: "subagent.progress",
      stage: "subagent",
      message: "Checking widths.",
      subagent: {
        id: "agent_child",
        model: "gpt-5.4",
        outputTail: [{ preview: "mapped status rows", tool: "rg" }],
        parentId: "agent_root",
        status: "running",
        summary: "Check status bar widths",
        tools: ["rg", "read"]
      }
    });
    now = 3_400;
    controller.recordProgressEvent({
      type: "subagent.complete",
      stage: "subagent",
      message: "Width review complete.",
      subagent: {
        durationMs: 2_400,
        id: "agent_child",
        outputTail: [{ preview: "status rows fit narrow terminals", tool: "test" }],
        parentId: "agent_root",
        status: "completed",
        summary: "Check status bar widths",
        toolCount: 2
      }
    });

    expect(getTurnState().subagents).toHaveLength(2);
    expect(getTurnState().subagents[0]).toMatchObject({
      id: "agent_root",
      depth: 0,
      index: 0,
      status: "running",
      startedAt: 1_000
    });
    expect(getTurnState().subagents[1]).toMatchObject({
      id: "agent_child",
      depth: 1,
      durationSeconds: 2.4,
      parentId: "agent_root",
      status: "completed"
    });

    const rendered = renderInfiniteTranscript({ state: getTurnState() }, { columns: 88, color: false });
    expect(rendered).toContain("subagents");
    expect(rendered).toContain("2 agents");
    expect(rendered).toContain("active 1");
    expect(rendered).toContain("Review Hermes app chrome");
    expect(rendered).toContain("Check status bar widths");
    expect(rendered).toContain("status rows fit narrow terminals");
  });

  it("renders subagent trees inside Hermes app chrome", () => {
    const rendered = renderInfiniteAppChrome(
      {
        status: ["session cli-session"],
        transcript: {
          messages: [
            {
              kind: "trail",
              role: "system",
              text: "",
              subagents: [
                {
                  depth: 0,
                  id: "agent_review",
                  index: 0,
                  model: "gpt-5.4",
                  notes: ["Verify transcript renderer"],
                  parentId: null,
                  status: "completed",
                  summary: "Verify transcript renderer",
                  taskCount: 1,
                  thinking: [],
                  toolCount: 1,
                  tools: ["test"]
                }
              ]
            }
          ]
        }
      },
      { columns: 72, color: false }
    );

    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("subagents");
    expect(rendered).toContain("Verify transcript renderer");
    expect(rendered).toContain("session cli-session");
  });

  it("provides a transcript runtime adapter for Ink component mounts", async () => {
    let now = 1_000;
    const runtime = createInfiniteTranscriptRuntime({
      controller: new InfiniteTurnController(() => now),
      prompt: { placeholder: "Type a message." },
      status: () => ["session runtime-session"],
      title: "Infinite Runtime"
    });
    const snapshots: string[] = [];
    const unsubscribe = runtime.subscribe((state) => {
      snapshots.push([
        state.reasoning,
        state.tools.map((tool) => tool.name).join(","),
        state.streaming
      ].filter(Boolean).join("|"));
    }, { emitCurrent: true });

    resetTurnState();
    runtime.record({
      type: "reasoning.delta",
      stage: "thinking",
      message: "Checking sources.",
      text: "Checking sources."
    });
    runtime.record({
      type: "tool.start",
      stage: "tool",
      message: "Running run_metric_query.",
      toolId: "call_runtime",
      name: "run_metric_query",
      context: "recognized revenue"
    });
    now = 2_500;
    runtime.record({
      type: "message.delta",
      stage: "message",
      message: "Revenue is up.",
      text: "Revenue is up."
    });
    await waitForStreamBatch();

    const rendered = runtime.render({ columns: 76, color: false, nowMs: now });
    unsubscribe();
    runtime.record({
      type: "status.update",
      stage: "status",
      kind: "status",
      message: "Post-unsubscribe update.",
      text: "Post-unsubscribe update."
    });
    runtime.reset();

    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots.join("\n")).toContain("Checking sources.");
    expect(snapshots.join("\n")).toContain("run_metric_query");
    expect(snapshots.join("\n")).toContain("Revenue is up.");
    expect(rendered).toContain("∞ Infinite Runtime");
    expect(rendered).toContain("Revenue is up.");
    expect(rendered).toContain("Run Metric Query");
    expect(rendered).toContain("session runtime-session");
    expect(rendered).toContain("Type a message.");
    expect(snapshots.join("\n")).not.toContain("Post-unsubscribe update.");
    expect(runtime.snapshot().streaming).toBe("");
    expect(runtime.snapshot().tools).toEqual([]);
  });

  it("renders the dependency-backed Ink transcript component layer", () => {
    const controller = new InfiniteTurnController(() => 1_000);

    resetTurnState();
    controller.recordProgressEvent({
      type: "reasoning.delta",
      stage: "thinking",
      message: "Checking source coverage.",
      text: "Checking source coverage."
    });
    controller.recordProgressEvent({
      type: "tool.start",
      stage: "tool",
      message: "Running run_metric_query.",
      toolId: "call_ink",
      name: "run_metric_query",
      context: "recognized revenue"
    });

    const rendered = renderInkTranscriptToString({
      columns: 88,
      nowMs: 2_500,
      prompt: { placeholder: "Type a message." },
      status: ["session session-1"],
      title: "Infinite TUI",
      transcript: { state: getTurnState() }
    });

    expect(rendered).toContain("∞ Infinite TUI");
    expect(rendered).toContain("Checking source coverage.");
    expect(rendered).toContain("Run Metric Query");
    expect(rendered).toContain("recognized revenue");
    expect(rendered).toContain("session session-1");
    expect(rendered).toContain("Type a message.");
  });

  it("renders the Ink interactive shell with an owned composer row", () => {
    const rendered = renderInkInteractiveSessionToString({
      columns: 88,
      initialMessages: [{ role: "assistant", text: "Prior answer." }],
      async onSubmitLine() {
        return { messages: [] };
      },
      promptPlaceholder: "Ask Infinite.",
      status: ["session cli_123"],
      title: "Infinite TUI"
    });

    expect(rendered).toContain("∞ Infinite TUI");
    expect(rendered).toContain("Prior answer.");
    expect(rendered).toContain("session cli_123");
    expect(rendered).toContain("ready");
    expect(rendered).toContain("Ask Infinite.");
  });

  it("matches slash command completions for the Ink composer", () => {
    expect(completeSlashCommands("/me", [
      { value: "/memory", description: "Memory" },
      { value: "/metrics", description: "Metrics" },
      { value: "/model", description: "Model" }
    ])).toEqual([
      { value: "/memory", description: "Memory" },
      { value: "/metrics", description: "Metrics" }
    ]);
    expect(completeSlashCommands("me", [{ value: "/memory" }])).toEqual([]);
    expect(completeSlashCommands("/memory add", [{ value: "/memory" }])).toEqual([]);
    expect(completeSlashCommands("/memory", [{ value: "/memory" }])).toEqual([]);
  });

  it("renders Ink slash completion menu rows", () => {
    const rendered = renderInkInteractiveSessionToString({
      columns: 88,
      getCompletions: (value) => completeSlashCommands(value, [
        { value: "/memory", description: "Review memory" },
        { value: "/metrics", description: "List metrics" }
      ]),
      initialInputValue: "/me",
      async onSubmitLine() {
        return { messages: [] };
      },
      promptPlaceholder: "Ask Infinite.",
      title: "Infinite TUI"
    });

    expect(rendered).toContain("/me");
    expect(rendered).toContain("> /memory");
    expect(rendered).toContain("Review memory");
    expect(rendered).toContain("  /metrics");
    expect(rendered).toContain("List metrics");
  });

  it("matches path argument completions with Hermes-style replacement offsets", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-ink-path-completions-"));
    mkdirSync(join(workspaceRoot, "reports"));
    writeFileSync(join(workspaceRoot, "reports", "revenue.md"), "Revenue notes");
    writeFileSync(join(workspaceRoot, "reports", "retention.md"), "Retention notes");
    writeFileSync(join(workspaceRoot, "reports", "costs.md"), "Cost notes");
    try {
      const input = "/memory add ./reports/re";
      const completions = completeInteractiveInput(input, [{ value: "/memory" }], { cwd: workspaceRoot });

      expect(completions).toEqual([
        { description: "file", kind: "path", replaceFrom: "/memory add ".length, value: "./reports/retention.md" },
        { description: "file", kind: "path", replaceFrom: "/memory add ".length, value: "./reports/revenue.md" }
      ]);
      expect(applyCompletionSuggestion(input, completions[1]!)).toBe("/memory add ./reports/revenue.md");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses the resolved CLI workspace root for Ink path completions", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-ink-cli-path-root-"));
    const decoyRoot = mkdtempSync(join(tmpdir(), "growth-os-ink-cli-path-decoy-"));
    mkdirSync(join(workspaceRoot, "reports"));
    writeFileSync(join(workspaceRoot, "reports", "revenue.md"), "Revenue notes");
    try {
      expect(completeInteractiveInputForCli("/memory add ./reports/re", {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        PWD: decoyRoot
      })).toEqual([
        { description: "file", kind: "path", replaceFrom: "/memory add ".length, value: "./reports/revenue.md" }
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });

  it("renders Ink path argument completion menu rows", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-ink-path-menu-"));
    mkdirSync(join(workspaceRoot, "reports"));
    mkdirSync(join(workspaceRoot, "reports", "revenue"));
    writeFileSync(join(workspaceRoot, "reports", "retention.md"), "Retention notes");
    try {
      const rendered = renderInkInteractiveSessionToString({
        columns: 88,
        getCompletions: (value) => completeInteractiveInput(value, [{ value: "/memory" }], { cwd: workspaceRoot }),
        initialInputValue: "/memory add ./reports/re",
        async onSubmitLine() {
          return { messages: [] };
        },
        promptPlaceholder: "Ask Infinite.",
        title: "Infinite TUI"
      });

      expect(rendered).toContain("/memory add ./reports/re");
      expect(rendered).toContain("> ./reports/retention.md");
      expect(rendered).toContain("file");
      expect(rendered).toContain("  ./reports/revenue/");
      expect(rendered).toContain("directory");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("applies Hermes-style cursor-aware composer inserts", () => {
    expect(applyComposerEdit(
      { cursor: "show ".length, value: "show revenue" },
      { text: "monthly ", type: "insert" }
    )).toEqual({
      cursor: "show monthly ".length,
      value: "show monthly revenue"
    });
  });

  it("moves the Ink composer cursor by grapheme and word boundaries", () => {
    const value = "show 😊 revenue";

    expect(applyComposerEdit(
      { cursor: "show 😊".length, value },
      { type: "move-left" }
    )).toEqual({
      cursor: "show ".length,
      value
    });

    expect(applyComposerEdit(
      { cursor: value.length, value },
      { type: "move-word-left" }
    )).toEqual({
      cursor: "show 😊 ".length,
      value
    });
  });

  it("renders the Ink composer cursor at the tracked edit position", () => {
    const rendered = renderInkInteractiveSessionToString({
      columns: 88,
      initialInputCursor: "show ".length,
      initialInputValue: "show revenue",
      async onSubmitLine() {
        return { messages: [] };
      },
      promptPlaceholder: "Ask Infinite.",
      title: "Infinite TUI"
    });

    expect(rendered).toContain("show |revenue");
  });

  it("computes Hermes-style native cursor coordinates for the Ink composer", () => {
    expect(composerCursorLayout("show revenue", "show ".length, 80)).toEqual({
      column: "show ".length,
      line: 0
    });
    expect(composerCursorLayout("show\nrevenue", "show\nre".length, 80)).toEqual({
      column: "re".length,
      line: 1
    });
    expect(composerNativeCursorPosition({
      cursor: "show\nre".length,
      label: "❯",
      row: 4,
      value: "show\nrevenue",
      width: 88
    })).toEqual({
      x: "❯ ".length + "re".length,
      y: 5
    });
  });

  it("moves the native cursor onto wrapped composer rows for long input", () => {
    expect(composerCursorLayout("show revenue for every segment", "show revenue for every segment".length, 10)).toEqual({
      column: 0,
      line: 3
    });
    expect(composerNativeCursorPosition({
      cursor: "show revenue for every segment".length,
      label: "❯",
      row: 4,
      value: "show revenue for every segment",
      width: 12
    })).toEqual({
      x: 2,
      y: 7
    });
  });

  it("counts Ink transcript rows before declaring the composer cursor row", () => {
    const props = {
      columns: 88,
      showComposer: false,
      status: ["session cli_123"],
      title: "Infinite TUI",
      transcript: {
        messages: [{ role: "assistant" as const, text: "Prior answer." }],
        state: getTurnState()
      }
    };

    expect(inkTranscriptRowCount(props)).toBe(renderInkTranscriptToString(props).split("\n").length);
  });

  it("applies Hermes-style multiline composer insertion and line navigation", () => {
    expect(applyComposerEdit(
      { cursor: "show ".length, value: "show revenue" },
      { type: "insert-newline" }
    )).toEqual({
      cursor: "show \n".length,
      value: "show \nrevenue"
    });

    const value = "alpha\nbravo\ncharlie";
    expect(applyComposerEdit(
      { cursor: "alpha\nbr".length, value },
      { type: "move-line-up" }
    )).toEqual({
      cursor: "al".length,
      value
    });
    expect(applyComposerEdit(
      { cursor: "alpha\nbr".length, value },
      { type: "move-line-down" }
    )).toEqual({
      cursor: "alpha\nbravo\nch".length,
      value
    });
  });

  it("normalizes Hermes-style pasted text before inserting at the composer cursor", () => {
    expect(applyComposerEdit(
      { cursor: "ask ".length, value: "ask revenue" },
      { text: "\u001b[200~alpha\nbeta\n\n\u001b[201~", type: "insert-paste" }
    )).toEqual({
      cursor: "ask alpha\nbeta".length,
      value: "ask alpha\nbetarevenue"
    });

    expect(applyComposerEdit(
      { cursor: 0, value: "revenue" },
      { text: "\n\n", type: "insert-paste" }
    )).toEqual({
      cursor: 2,
      value: "\n\nrevenue"
    });
  });

  it("replaces selected composer ranges with typed and pasted text", () => {
    expect(applyComposerEdit(
      { cursor: "show revenue".length, selection: { end: "show revenue".length, start: "show ".length }, value: "show revenue" },
      { text: "profit", type: "insert" }
    )).toEqual({
      cursor: "show profit".length,
      value: "show profit"
    });

    expect(applyComposerEdit(
      { cursor: "ask revenue".length, selection: { end: "ask revenue".length, start: "ask ".length }, value: "ask revenue" },
      { text: "\u001b[200~alpha\n\u001b[201~", type: "insert-paste" }
    )).toEqual({
      cursor: "ask alpha".length,
      value: "ask alpha"
    });

    expect(applyComposerEdit(
      { cursor: "show revenue".length, selection: { end: "show revenue".length, start: "show ".length }, value: "show revenue" },
      { type: "backspace" }
    )).toEqual({
      cursor: "show ".length,
      value: "show "
    });
  });

  it("renders selected Ink composer content with Hermes inverse styling", () => {
    const rendered = renderInkInteractiveSessionToString({
      columns: 88,
      initialInputCursor: "show revenue".length,
      initialInputSelection: { end: "show revenue".length, start: "show ".length },
      initialInputValue: "show revenue",
      async onSubmitLine() {
        return { messages: [] };
      },
      promptPlaceholder: "Ask Infinite.",
      title: "Infinite TUI"
    });

    expect(rendered).toContain("show \u001b[7mrevenue\u001b[27m");
  });

  it("renders multiline Ink composer content with the tracked cursor", () => {
    const rendered = renderInkInteractiveSessionToString({
      columns: 88,
      initialInputCursor: "show\n".length,
      initialInputValue: "show\nrevenue",
      async onSubmitLine() {
        return { messages: [] };
      },
      promptPlaceholder: "Ask Infinite.",
      title: "Infinite TUI"
    });

    expect(rendered).toContain("show\n  |revenue");
  });

  it("routes capable default TTY interactive sessions to the Ink shell", () => {
    const outputStream = new PassThrough() as PassThrough & { columns?: number; isTTY?: boolean };
    outputStream.columns = 88;
    outputStream.isTTY = true;

    expect(shouldUseInkInteractiveSession({ isTTY: true }, outputStream, {})).toBe(true);
    expect(shouldUseInkInteractiveSession({ isTTY: true }, outputStream, { INFINITE_RENDER_SURFACE: "raw" })).toBe(false);
    expect(shouldUseInkInteractiveSession({ isTTY: true }, outputStream, { INFINITE_PLAIN_OUTPUT: "1" })).toBe(false);
    expect(shouldUseInkInteractiveSession({ isTTY: false }, outputStream, {})).toBe(false);
  });

  it("navigates Ink input history with draft restoration", () => {
    const entries = appendInputHistory(
      appendInputHistory(["show revenue"], "show revenue"),
      "show pipeline"
    );
    expect(entries).toEqual(["show revenue", "show pipeline"]);

    const older = navigateInputHistory({ draft: "", entries, index: null }, "older", "draft question");
    expect(older.value).toBe("show pipeline");
    expect(older.history).toMatchObject({ draft: "draft question", index: 1 });

    const oldest = navigateInputHistory(older.history, "older", older.value);
    expect(oldest.value).toBe("show revenue");
    expect(oldest.history).toMatchObject({ draft: "draft question", index: 0 });

    const newer = navigateInputHistory(oldest.history, "newer", oldest.value);
    expect(newer.value).toBe("show pipeline");
    expect(newer.history).toMatchObject({ draft: "draft question", index: 1 });

    const restored = navigateInputHistory(newer.history, "newer", newer.value);
    expect(restored.value).toBe("draft question");
    expect(restored.history).toMatchObject({ draft: "", index: null });
  });

  it("persists Ink input history in Infinite OS home using Hermes-style blocks", () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-input-history-"));
    const env = { GROWTH_OS_HOME: growthHome } as NodeJS.ProcessEnv;
    try {
      appendPersistentInputHistory("show revenue", env);
      appendPersistentInputHistory("show revenue", env);
      appendPersistentInputHistory("show\npipeline", env);

      expect(inputHistoryPath(env)).toBe(join(growthHome, "input-history"));
      expect(loadPersistentInputHistory(env)).toEqual(["show revenue", "show\npipeline"]);
      expect(parsePersistentInputHistory(readFileSync(inputHistoryPath(env), "utf8"))).toEqual([
        "show revenue",
        "show\npipeline"
      ]);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("falls back to HOME for persistent Ink input history", () => {
    const home = mkdtempSync(join(tmpdir(), "growth-os-input-history-home-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    try {
      appendPersistentInputHistory("show sources", env);

      expect(inputHistoryPath(env)).toBe(join(home, ".growth-os", "input-history"));
      expect(loadPersistentInputHistory(env)).toEqual(["show sources"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("adds Hermes long-run tool charms after the delay window", () => {
    const ticker = new LongRunToolCharmTicker();
    const activities: string[] = [];

    ticker.tick(
      [{ id: "call_1", name: "run_metric_query", startedAt: 1_000_000, context: "recognized revenue" }],
      1_008_100,
      {
        pushActivity(text) {
          activities.push(text);
        }
      }
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatch(/\(Run Metric Query · 8s\)$/);
  });

  it("keeps progress durable for non-TTY output", () => {
    const chunks: string[] = [];
    let now = 0;
    const progress = createInteractiveProgressReporter(
      { isTTY: false, write: (chunk) => chunks.push(chunk) > 0 },
      { now: () => now }
    );

    now = 3_400;
    progress.progress({ stage: "resolve", message: "Preparing X engagement breakdown." });
    progress.stop();

    expect(chunks.join("")).toBe("┊ ⚡ preparing X engagement breakdown…  3.4s\n");
    expect(chunks.join("")).not.toContain("\r");
  });

  it("does not duplicate assistant message events in non-TTY progress output", () => {
    const chunks: string[] = [];
    const progress = createInteractiveProgressReporter(
      { isTTY: false, write: (chunk) => chunks.push(chunk) > 0 },
      { now: () => 1_000 }
    );

    progress.progress({
      type: "message.start",
      stage: "message",
      message: "Assistant message started."
    });
    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "Revenue is up.",
      text: "Revenue is up."
    });
    progress.progress({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Revenue is up."
    });
    progress.stop();

    expect(chunks).toEqual([]);
  });

  it("streams assistant deltas in a Hermes-style TTY frame and suppresses the duplicate final panel", () => {
    const chunks: string[] = [];
    const stream = {
      columns: 80,
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk) > 0
    };
    const progress = createInteractiveProgressReporter(stream, { animate: true, now: () => 1_000 });

    progress.progress({
      type: "message.start",
      stage: "message",
      message: "Assistant message started."
    });
    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "Revenue ",
      text: "Revenue "
    });
    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "is up.",
      text: "is up."
    });
    progress.progress({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Revenue is up."
    });
    progress.stop();

    const output = stripAnsi(chunks.join(""));
    expect(output).toContain("╭─ Infinite ");
    expect(output).toContain("│ Revenue is up.");
    expect(output).toContain("╰");

    const rendered = stripAnsi(renderCliResultForStream(
      { ok: true, sessionId: "session-1", message: "Revenue is up.", provenance: [], actionCalls: [] },
      stream,
      {}
    ));
    expect(rendered).toContain("session session-1");
    expect(rendered).not.toContain("Revenue is up.");
  });

  it("renders app chrome after streamed TTY output without duplicating the assistant answer", () => {
    const chunks: string[] = [];
    const stream = {
      columns: 80,
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk) > 0
    };
    const progress = createInteractiveProgressReporter(stream, { animate: true, now: () => 1_000 });

    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "Revenue is up.",
      text: "Revenue is up."
    });
    progress.progress({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Revenue is up."
    });
    progress.stop();

    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "session-1",
        message: "Revenue is up.",
        provenance: ["queryable.vw_revenue_by_source"],
        actionCalls: [
          {
            actionId: "run_metric_query",
            input: { metric: "recognized_revenue" },
            status: "ok",
            envelope: {
              actionId: "run_metric_query",
              authority: "tool_agent",
              caveats: [],
              data: { rows: [{ recognized_revenue: 9800 }] },
              nextActions: [],
              ok: true,
              provenance: ["queryable.vw_revenue_by_source"],
              status: "ok",
              truncated: false
            }
          }
        ],
        modelProvider: "codex",
        modelName: "gpt-5.4",
        usage: { promptTokens: 12, completionTokens: 5 }
      },
      stream,
      { INFINITE_TUI_CHROME: "1" }
    );

    expect(chunks.join("")).toContain("Revenue is up.");
    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("tools 1");
    expect(rendered).toContain("Run Metric Query");
    expect(rendered).toContain("metric=recognized_revenue");
    expect(rendered).toContain("tokens 12/5");
    expect(rendered).not.toContain("Revenue is up.");
  });

  it("lets transcript-mode app chrome own streamed assistant text", () => {
    const chunks: string[] = [];
    const stream = {
      columns: 80,
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk) > 0
    };
    const progress = createInteractiveProgressReporter(stream, {
      animate: true,
      now: () => 1_000,
      renderSurface: "transcript"
    });

    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "Revenue is up.",
      text: "Revenue is up."
    });
    progress.progress({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Revenue is up."
    });
    progress.stop();

    const rendered = renderCliResultForStream(
      {
        ok: true,
        sessionId: "session-1",
        message: "Revenue is up.",
        provenance: [],
        actionCalls: [],
        modelProvider: "codex",
        modelName: "gpt-5.4"
      },
      stream,
      { INFINITE_TUI_CHROME: "1" }
    );

    expect(chunks.join("")).toContain("∞ Infinite");
    expect(chunks.join("")).toContain("Revenue is up.");
    expect(chunks.join("")).toContain("\u001b[");
    expect(rendered).toContain("∞ Infinite");
    expect(rendered).toContain("session session-1");
    expect(rendered).toContain("model codex:gpt-5.4");
    expect(rendered).toContain("Revenue is up.");
  });

  it("redraws app chrome around live reasoning and action progress", () => {
    const chunks: string[] = [];
    const stream = {
      columns: 88,
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk) > 0
    };
    const progress = createInteractiveProgressReporter(stream, {
      now: () => 1_000,
      renderSurface: "transcript",
      transcript: {
        prompt: { placeholder: "Type a message." },
        status: ["session session-1"]
      }
    });

    progress.progress({
      type: "reasoning.delta",
      stage: "thinking",
      message: "Checking source coverage.",
      text: "Checking source coverage."
    });
    progress.progress({
      type: "tool.start",
      stage: "tool",
      message: "Running run_metric_query.",
      toolId: "call_1",
      name: "run_metric_query",
      context: "recognized revenue"
    });
    progress.progress({
      type: "tool.progress",
      stage: "tool",
      message: "Fetching recognized revenue.",
      toolId: "call_1",
      name: "run_metric_query",
      preview: "recognized revenue by source"
    });
    progress.stop();

    const output = chunks.join("");
    expect(output).toContain("∞ Infinite");
    expect(output).toContain("thinking");
    expect(output).toContain("Checking source coverage.");
    expect(output).toContain("running 1");
    expect(output).toContain("Run Metric Query");
    expect(output).toContain("recognized revenue");
    expect(output).toContain("recognized revenue by source");
    expect(output).toContain("1 update");
    expect(output).toContain("call_1");
    expect(output).toContain("session session-1");
    expect(output).toContain("Type a message.");
    expect(output).toContain("\u001b[");
  });

  it("passes turn elapsed timing into the dependency-backed Ink progress reporter", async () => {
    const chunks: string[] = [];
    let now = 1_000;
    const stream = new PassThrough() as PassThrough & { columns?: number; isTTY?: boolean };
    stream.columns = 96;
    stream.isTTY = true;
    stream.on("data", (chunk) => chunks.push(String(chunk)));
    const progress = createInteractiveProgressReporter(stream, {
      now: () => now,
      renderSurface: "ink",
      transcript: {
        prompt: { placeholder: "Type a message." },
        status: ["session session-1"],
        title: "Infinite TUI"
      }
    });

    now = 2_300;
    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "Revenue is up.",
      text: "Revenue is up."
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    progress.stop();

    const output = chunks.join("");
    expect(output).toContain("Revenue is up.");
    expect(output).toContain("streaming");
    expect(output).toContain("1.3s");
    expect(output).toContain("session session-1");
  });

  it("keeps alternate-screen transcript progress as the simple-stream Ink fallback", () => {
    const chunks: string[] = [];
    const stream = {
      columns: 88,
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk) > 0
    };
    const progress = createInteractiveProgressReporter(stream, {
      now: () => 1_000,
      renderSurface: "alternate",
      transcript: {
        prompt: { placeholder: "Type a message." },
        status: ["session session-1"],
        title: "Infinite TUI"
      }
    });

    progress.progress({
      type: "reasoning.delta",
      stage: "thinking",
      message: "Checking source coverage.",
      text: "Checking source coverage."
    });
    progress.progress({
      type: "tool.start",
      stage: "tool",
      message: "Running run_metric_query.",
      toolId: "call_alt",
      name: "run_metric_query",
      context: "recognized revenue"
    });
    progress.stop();

    const output = chunks.join("");
    expect(output).toContain("\u001b[?1049h");
    expect(output).toContain("\u001b[?25l");
    expect(output).toContain("\u001b[H\u001b[2J");
    expect(output).toContain("∞ Infinite TUI");
    expect(output).toContain("thinking");
    expect(output).toContain("Checking source coverage.");
    expect(output).toContain("Run Metric Query");
    expect(output).toContain("recognized revenue");
    expect(output).toContain("session session-1");
    expect(output).toContain("Type a message.");
    expect(output).toContain("\u001b[?25h\u001b[?1049l");
  });

  it("renders final-only assistant completions in the alternate transcript surface", () => {
    const chunks: string[] = [];
    const progress = createInteractiveProgressReporter(
      {
        columns: 88,
        isTTY: true,
        write: (chunk: string) => chunks.push(chunk) > 0
      },
      {
        now: () => 1_000,
        renderSurface: "alternate",
        transcript: {
          prompt: { placeholder: "Type a message." },
          status: ["session session-1"],
          title: "Infinite TUI"
        }
      }
    );

    progress.progress({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "Final only answer."
    });
    progress.stop();

    const output = chunks.join("");
    expect(output).toContain("\u001b[?1049h");
    expect(output).toContain("∞ Infinite TUI");
    expect(output).toContain("Final only answer.");
    expect(output).toContain("session session-1");
    expect(output).toContain("Type a message.");
    expect(output).toContain("\u001b[?25h\u001b[?1049l");
  });

  it("realigns markdown tables in streamed assistant frames", () => {
    const chunks: string[] = [];
    const progress = createInteractiveProgressReporter(
      {
        columns: 88,
        isTTY: true,
        write: (chunk: string) => chunks.push(chunk) > 0
      },
      { animate: true, now: () => 1_000 }
    );

    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "| Metric | Value |",
      text: "| Metric | Value |\n| --- | ---: |\n| Revenue | $123 |\n"
    });
    progress.progress({
      type: "message.delta",
      stage: "message",
      message: "| Signups | 45 |",
      text: "| Signups | 45 |\n\nDone."
    });
    progress.progress({
      type: "message.complete",
      stage: "message",
      message: "Assistant message complete.",
      text: "done"
    });
    progress.stop();

    const streamed = stripAnsi(chunks.join(""));
    expect(streamed).toContain("│ Metric   Value");
    expect(streamed).toContain("│ Revenue  $123");
    expect(streamed).toContain("│ Signups  45");
    expect(streamed).toContain("│ Done.");
    expect(streamed).not.toContain("---:");
  });

  it("realigns markdown tables in final TTY assistant panels", () => {
    const panel = renderAssistantResponsePanel(
      ["| Metric | Value |", "| --- | ---: |", "| Revenue | $123 |", "| Signups | 45 |"].join("\n"),
      { color: false, columns: 88 }
    );

    expect(panel).toContain("Metric   Value");
    expect(panel).toContain("Revenue  $123");
    expect(panel).toContain("Signups  45");
    expect(panel).not.toContain("---:");
  });

  it("uses a transient carriage-return row for TTY output", () => {
    const chunks: string[] = [];
    let now = 1_000;
    const progress = createInteractiveProgressReporter(
      { isTTY: true, write: (chunk) => chunks.push(chunk) > 0 },
      { animate: true, now: () => now }
    );

    progress.progress({
      type: "tool.start",
      stage: "tool",
      message: "Running run_breakdown_query.",
      toolId: "call_1",
      name: "run_breakdown_query",
      context: "Running run_breakdown_query."
    });
    now = 2_250;
    progress.progress({
      type: "tool.complete",
      stage: "tool",
      message: "Finished run_breakdown_query.",
      toolId: "call_1",
      name: "run_breakdown_query",
      durationMs: 1_250,
      status: "ok"
    });
    progress.stop();

    const rendered = chunks.join("");
    expect(rendered).toContain("\r  ⠋ Run Breakdown Query · Running run_breakdown_query.  0.0s");
    expect(rendered).toMatch(/\r {40,}\r/);
    expect(rendered).toContain("┊ ⚡ tool      Run Breakdown Query (1.3s) ✓\n");
  });

  it("supports fallback single-choice prompts without a TTY", async () => {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    const outputChunks: Buffer[] = [];
    outputStream.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    inputStream.end("2\n");

    const selected = await promptChoice("Select provider:", ["codex", "claude"], 0, {
      description: "Backfills can take time.",
      io: {
        input: inputStream as unknown as NodeJS.ReadStream,
        output: outputStream as unknown as NodeJS.WriteStream
      }
    });

    expect(selected).toBe(1);
    expect(Buffer.concat(outputChunks).toString("utf8")).toContain("Backfills can take time.");
  });

  it("supports fallback checklist prompts without a TTY", async () => {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    inputStream.end("1,3\n");

    const selected = await promptChecklist(
      "Select platforms:",
      ["Slack", "Discord", "Email"],
      [],
      {
        io: {
          input: inputStream as unknown as NodeJS.ReadStream,
          output: outputStream as unknown as NodeJS.WriteStream
        }
      }
    );

    expect(selected).toEqual([0, 2]);
  });

  it("prefers interactive setup prompts by default on a TTY", () => {
    const io = {
      input: { isTTY: true } as NodeJS.ReadStream,
      output: { isTTY: true } as NodeJS.WriteStream
    };
    delete process.env.GROWTH_OS_CLI_FANCY_PROMPTS;
    expect(shouldUseInteractivePrompts(io)).toBe(true);
  });

  it("allows disabling interactive setup prompts explicitly", () => {
    const io = {
      input: { isTTY: true } as NodeJS.ReadStream,
      output: { isTTY: true } as NodeJS.WriteStream
    };
    process.env.GROWTH_OS_CLI_FANCY_PROMPTS = "0";
    expect(shouldUseInteractivePrompts(io)).toBe(false);
    delete process.env.GROWTH_OS_CLI_FANCY_PROMPTS;
  });

  it("prompts for freeform text with a default value", async () => {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    inputStream.end("\n");

    const value = await promptText("Project name", "Acme", {
      io: {
        input: inputStream as unknown as NodeJS.ReadStream,
        output: outputStream as unknown as NodeJS.WriteStream
      }
    });

    expect(value).toBe("Acme");
  });

  it("re-prompts for URLs until the input is valid", async () => {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    ["not a url\n", "acme.test\n"].forEach((chunk, index, items) => {
      setTimeout(() => {
        if (index === items.length - 1) {
          inputStream.end(chunk);
          return;
        }
        inputStream.write(chunk);
      }, index * 10);
    });

    const value = await promptUrl("Website URL", "", {
      io: {
        input: inputStream as unknown as NodeJS.ReadStream,
        output: outputStream as unknown as NodeJS.WriteStream
      }
    });

    expect(value).toBe("acme.test");
    const rendered = outputStream.read()?.toString() ?? "";
    expect(rendered).toContain("Website URL [https://]");
    expect(rendered).toContain("https://acme.test");
  });

  it("shows an https preview and only asks readiness for selected providers", async () => {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    ["1\n", "2\n"].forEach((chunk, index, items) => {
      setTimeout(() => {
        if (index === items.length - 1) {
          inputStream.end(chunk);
          return;
        }
        inputStream.write(chunk);
      }, index * 10);
    });

    const rows = await promptProviderMatrix(
      [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: true, installState: "installed", selected: false, recommended: false }
      ],
      {
        io: {
          input: inputStream as unknown as NodeJS.ReadStream,
          output: outputStream as unknown as NodeJS.WriteStream
        }
      }
    );

    expect(rows).toEqual([
      { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true },
      { provider: "x", hasAccount: true, installState: "installed", selected: false, recommended: false }
    ]);

    const rendered = outputStream.read()?.toString() ?? "";
    expect(rendered).toContain("Which of these should we help you set up first?");
    expect(rendered).toContain("GA4 (recommended)");
    expect(rendered).toContain("X (optional / advanced)");
    expect(rendered).toContain("Are you already using GA4?");
    expect(rendered.indexOf("Which of these should we help you set up first?")).toBeLessThan(
      rendered.indexOf("Are you already using GA4?")
    );
    expect(rendered).not.toContain("Are you already using X?");
    expect(rendered).not.toContain("already live on your site or app");
  });

  it("maps one-shot unknown argv text to chat", async () => {
    const calls: Array<{
      message: string;
      onProgress?: (event: ChatProgressEvent) => void;
      progressMode?: "legacy" | "rich" | "both";
      sessionId?: string;
    }> = [];
    const runtime = fakeAgentRuntime({
      async chat(input) {
        calls.push(input);
        return { ok: true, sessionId: "session-chat" };
      }
    });

    const progress = vi.fn();
    await runCliInput("How", ["much", "revenue", "this", "month?"], { GROWTH_OS_WORKSPACE_ID: "proj_test" }, runtime, progress);

    expect(calls[0]).toMatchObject({
      message: "How much revenue this month?",
      sessionId: undefined
    });
    expect(typeof calls[0]?.onProgress).toBe("function");
  });

  it("returns setup guidance when local chat is missing workspace runtime config", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-missing-config-"));
    try {
      const result = await runCliInput(
        "How",
        ["much", "revenue", "this", "month?"],
        {
          GROWTH_OS_WORKSPACE_ID: "proj_test",
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: mkdtempSync(join(tmpdir(), "growth-os-home-missing-config-"))
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "growth_os_workspace_not_ready" }
      });
      expect(JSON.stringify(result)).toContain("infinite setup");
      expect(JSON.stringify(result)).toContain("infinite start");
      expect(JSON.stringify(result)).toContain("infinite model use");
      expect(JSON.stringify(result)).toContain("infinite auth login");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns exact guidance for noninteractive model setup without provider input", async () => {
    const result = await runCommand("model", ["use"], {
      GROWTH_OS_CLI_NONINTERACTIVE: "1"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "growth_os_model_setup_requires_input"
      }
    });
    expect(JSON.stringify(result)).toContain("infinite setup model");
    expect(JSON.stringify(result)).toContain("infinite model use codex gpt-5.4 --auth login");
  });

  it("returns the same guidance for noninteractive setup model without provider input", async () => {
    const result = await runCommand("setup", ["model"], {
      GROWTH_OS_CLI_NONINTERACTIVE: "1"
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "growth_os_model_setup_requires_input"
      }
    });
  });

  it("prints parseable JSON for setup --json", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-json-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-json-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-setup-json-claude-home-"));
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-json-access",
            refreshToken: "claude-json-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      await runCli(
        ["setup", "--json", "--provider=claude", "--model", "claude-sonnet-4-5", "--auth", "reuse", "--no-start"],
        {
          DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth",
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          HOME: home
        }
      );

      const parsed = JSON.parse(writes.join(""));
      expect(parsed).toMatchObject({
        ok: false,
        section: "wizard",
        setupMode: expect.any(String),
        sections: expect.any(Array)
      });
    } finally {
      writeSpy.mockRestore();
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prints top-level Claude auth reuse without opening TUI progress chrome", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-cli-auth-output-"));
    const home = mkdtempSync(join(tmpdir(), "claude-cli-auth-output-"));
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const originalStderrIsTty = process.stderr.isTTY;
    const originalStderrColumns = process.stderr.columns;
    try {
      Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stderr, "columns", { configurable: true, value: 88 });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-cli-access",
            refreshToken: "claude-cli-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      await runCli(["auth", "login", "claude", "--mode", "reuse"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        INFINITE_RENDER_SURFACE: "ink"
      });

      expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
        ok: true,
        provider: "claude",
        mode: "reuse",
        hasCredentials: true
      });
      expect(stderrWrites.join("")).not.toContain("∞ Infinite");
      expect(stderrWrites.join("")).not.toContain("Running request.");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: originalStderrIsTty });
      Object.defineProperty(process.stderr, "columns", { configurable: true, value: originalStderrColumns });
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("renders setup guidance for noninteractive first run without opening the interactive shell", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-first-run-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-first-run-home-"));
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runCli([], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });

      const outputText = writes.join("");
      expect(outputText).toContain("Infinite is not set up yet.");
      expect(outputText).toContain("infinite setup");
      expect(outputText).not.toContain("Infinite OS session. Type a message");
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("interactive preflight defaults to continuing setup and proceeds when setup becomes ready", async () => {
    const writes: string[] = [];
    const proceed = await handleInteractiveSetupPreflight(
      {},
      {
        ok: false,
        error: { code: "growth_os_workspace_not_ready" }
      },
      {
        chooseAction: async () => "continue",
        runWizard: async () => ({
          ok: true,
          section: "wizard",
          sections: [],
          next: "Run `infinite`, then type your question."
        }),
        checkReadiness: async () => ({ ok: true }),
        writeLine: (text) => {
          writes.push(text);
        }
      }
    );

    expect(proceed).toBe(true);
    expect(writes.join("\n")).toContain("Infinite is not set up yet.");
    expect(writes.join("\n")).toContain("Continue setup");
  });

  it("interactive preflight can show current status without entering setup", async () => {
    const writes: string[] = [];
    const proceed = await handleInteractiveSetupPreflight(
      {},
      {
        ok: false,
        error: {
          code: "growth_os_workspace_not_ready",
          message: "Infinite is not ready to answer through the local LLM runtime."
        }
      },
      {
        chooseAction: async () => "status",
        writeLine: (text) => {
          writes.push(text);
        }
      }
    );

    expect(proceed).toBe(false);
    expect(writes.join("\n")).toContain("Show current status");
    expect(writes.join("\n")).toContain("Infinite is not ready to answer through the local LLM runtime.");
  });

  it("interactive preflight can exit without running setup", async () => {
    let wizardCalls = 0;
    const proceed = await handleInteractiveSetupPreflight(
      {},
      {
        ok: false,
        error: { code: "growth_os_workspace_not_ready" }
      },
      {
        chooseAction: async () => "exit",
        runWizard: async () => {
          wizardCalls += 1;
          return { ok: true };
        },
        writeLine: () => {}
      }
    );

    expect(proceed).toBe(false);
    expect(wizardCalls).toBe(0);
  });

  it("offers launch after a complete setup result and can launch the interactive session", async () => {
    let launched = 0;
    const didLaunch = await maybeLaunchInfiniteAfterSetup(
      {
        ok: true,
        section: "wizard"
      },
      {},
      {
        interactive: true,
        confirm: async () => true,
        launch: async () => {
          launched += 1;
        }
      }
    );

    expect(didLaunch).toBe(true);
    expect(launched).toBe(1);
  });

  it("does not offer launch after incomplete setup results", async () => {
    let launched = 0;
    const didLaunch = await maybeLaunchInfiniteAfterSetup(
      {
        ok: false,
        section: "wizard"
      },
      {},
      {
        interactive: true,
        confirm: async () => true,
        launch: async () => {
          launched += 1;
        }
      }
    );

    expect(didLaunch).toBe(false);
    expect(launched).toBe(0);
  });

  it("renders detected Codex and Claude credential status for interactive model setup", () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-detected-auth-home-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-detected-auth-user-home-"));
    const codexHome = mkCodexHome({
      access_token: "codex-access-token",
      refresh_token: "codex-refresh-token",
      expires_at: "2999-01-01T00:00:00.000Z"
    });
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );
      const rendered = renderDetectedModelAuthStatus({
        GROWTH_OS_HOME: growthHome,
        CODEX_HOME: codexHome,
        HOME: home
      });
      expect(rendered).toContain("Detected credentials:");
      expect(rendered).toContain("Codex:");
      expect(rendered).toContain("Claude:");
      expect(rendered).toContain("Codex CLI auth");
      expect(rendered).toMatch(/Claude: (Claude Code credentials|Infinite OS auth \(macos-keychain\)|Claude Code credentials \(macos-keychain\)|macos-keychain)/);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("renders workspace readiness failures as human first-run guidance", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-render-first-run-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-render-first-run-home-"));
    try {
      const readiness = await localChatReadiness({
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });
      const rendered = renderCliResult(readiness);

      expect(rendered).toContain("Infinite is not set up yet.");
      expect(rendered).toContain("runtime_config_incomplete");
      expect(rendered).toContain("model_missing");
      expect(rendered).toContain("Next:");
      expect(rendered).toContain("infinite setup");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("returns setup guidance when local chat is missing model and auth", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-chat-missing-model-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-chat-missing-model-home-"));
    try {
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });

      const result = await runCliInput(
        "How",
        ["much", "revenue", "this", "month?"],
        {
          GROWTH_OS_WORKSPACE_ID: "proj_test",
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "growth_os_workspace_not_ready"
        }
      });
      expect((result as { error: { reasons: Array<{ code: string }> } }).error.reasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "model_missing" })])
      );
      expect(JSON.stringify(result)).toContain("infinite setup");
      expect(JSON.stringify(result)).toContain("infinite model use");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("treats local Codex CLI auth as ready when Codex is selected", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-codex-readiness-workspace-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-readiness-home-"));
    const codexHome = mkCodexHome({
      access_token: "codex-cli-access",
      refresh_token: "codex-cli-refresh",
      expires_at: "2999-01-01T00:00:00.000Z"
    });
    try {
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });
      writeInfiniteOsModelSelection(
        { provider: "codex", model: "gpt-5.4" },
        { GROWTH_OS_HOME: growthHome } as NodeJS.ProcessEnv
      );

      await expect(
        localChatReadiness({
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          CODEX_HOME: codexHome,
          DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth"
        })
      ).resolves.toMatchObject({
        ok: false,
        setupReadiness: {
          model: "selected",
          auth: "ready"
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("maps interactive session slash commands to the local agent runtime", async () => {
    const requests: Array<[string, ...unknown[]]> = [];
    const runtime = fakeAgentRuntime({
      async listSessions() {
        requests.push(["listSessions"]);
        return { ok: true, sessions: [] };
      },
      async resumeSession(sessionId) {
        requests.push(["resumeSession", sessionId]);
        return { ok: true, sessionId };
      },
      async compactSession(sessionId, summaryText) {
        requests.push(["compactSession", sessionId, summaryText]);
        return { ok: true, sessionId };
      }
    });
    const chatState = { conversationId: "session-1" };

    await runSlashCommand("/sessions", {}, undefined, undefined, chatState, runtime);
    await runSlashCommand("/resume session-2", {}, undefined, undefined, chatState, runtime);
    await runSlashCommand("/compact keep the revenue context", {}, undefined, undefined, chatState, runtime);

    // `/resume` and `/compact` both pass the immutable conversation id; the real
    // runtime derives the per-workspace controller id from it (the fake forwards
    // verbatim). `/resume` re-points `conversationId`, and `/compact` then keys
    // the resumed conversation — no double-suffix, all three the same row.
    expect(requests).toEqual([
      ["listSessions"],
      ["resumeSession", "session-2"],
      ["compactSession", "session-2", "keep the revenue context"]
    ]);
    expect(chatState.conversationId).toBe("session-2");
  });

  it("maps confirmation slash command to the local agent runtime", async () => {
    const requests: string[] = [];
    const runtime = fakeAgentRuntime({
      async confirmAction(confirmationId) {
        requests.push(confirmationId);
        return { ok: true, confirmationId };
      }
    });

    await runSlashCommand("/confirm confirm_abc", { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }, undefined, undefined, undefined, runtime);

    expect(requests).toEqual(["confirm_abc"]);
    await expect(runSlashCommand("/confirm", {})).rejects.toThrow("confirm requires a confirmation id");
  });

  it("initializes local Infinite OS config files", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-cli-"));
    try {
      const result = await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: root });
      expect(result).toMatchObject({ ok: true });
      expect(readFileSync(join(root, ".growth-os", "config.yml"), "utf8")).toContain("runtime_mode: local");
      expect(readFileSync(join(root, ".growth-os", ".env"), "utf8")).toContain("DATABASE_URL=");
      expect(readFileSync(join(root, ".growth-os", ".env"), "utf8")).not.toContain("ANTHROPIC_API_KEY");
      expect(readFileSync(join(root, ".growth-os", ".env"), "utf8")).not.toContain("OPENAI_API_KEY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs Hermes-style one-time setup for local runtime, model, and auth", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-setup-claude-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-setup-access",
            refreshToken: "claude-setup-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const result = await runCommand(
        "setup",
        ["--provider=claude", "--model", "claude-opus-4-8", "--auth", "reuse"],
        {
          DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth",
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_CLI_DRY_RUN: "1",
          GROWTH_OS_COMPOSE_PROJECT: "growth-os-setup-test",
          HOME: home
        }
      );

      expect(result).toMatchObject({
        ok: false,
        section: "wizard",
        setupMode: "full",
        model: { ok: true, provider: "claude", model: "claude-opus-4-8" },
        auth: { ok: true, provider: "claude", mode: "reuse", hasCredentials: true },
        runtime: {
          mode: "local_docker",
          start: {
            ok: true,
            command: ["docker", "compose", "-p", "growth-os-setup-test", "up", "-d"]
          }
        }
      });
      expect((result as { next?: string }).next).toBe("Run `infinite setup status` to review blockers.");
      expect(readFileSync(join(workspaceRoot, ".growth-os", "config.yml"), "utf8")).toContain("runtime_mode: local");
      expect(readFileSync(join(growthHome, "config.yml"), "utf8")).toContain("model_provider: claude");
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("claude-setup-refresh");
      expect(existsSync(join(workspaceRoot, ".growth-os", "auth.json"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("supports quick setup mode for first-time installs", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-quick-setup-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-quick-setup-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-quick-setup-claude-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-quick-access",
            refreshToken: "claude-quick-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const result = await runCommand(
        "setup",
        ["--quick", "--provider=claude", "--model", "claude-sonnet-4-5", "--auth", "reuse", "--no-start"],
        {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          HOME: home
        }
      );

      expect(result).toMatchObject({
        section: "wizard",
        setupMode: "quick",
        existingInstall: false,
        model: { ok: true, provider: "claude", model: "claude-sonnet-4-5" }
      });
      expect(JSON.stringify(result)).toContain("connectors");
      expect(JSON.stringify(result)).toContain("skipped");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks setup as reconfigure mode when existing install state is present", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-reconfigure-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-reconfigure-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-reconfigure-claude-home-"));
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(join(growthHome, "config.yml"), "model_provider: claude\nmodel_name: claude-sonnet-4-5\n");
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-reconfigure-access",
              refreshToken: "claude-reconfigure-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-reconfigure-access",
            refreshToken: "claude-reconfigure-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const result = await runCommand(
        "setup",
        ["--reconfigure", "--provider=claude", "--model", "claude-sonnet-4-5", "--auth", "reuse", "--no-start"],
        {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          HOME: home
        }
      );

      expect(result).toMatchObject({
        section: "wizard",
        setupMode: "full",
        existingInstall: true
      });
      expect(renderCliResult(result)).toContain("Reconfigure (full)");
      expect(renderCliResult(result)).toContain("provider=claude");
      expect(renderCliResult(result)).toContain("mode=local_docker");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs runtime setup for local Docker without exposing raw secrets", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-runtime-local-"));
    try {
      const result = await runCommand("setup", ["runtime", "--mode", "local_docker"], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_CLI_DRY_RUN: "1",
        GROWTH_OS_COMPOSE_PROJECT: "growth-os-runtime-local"
      });

      expect(result).toMatchObject({
        ok: true,
        section: "runtime",
        runtime: {
          mode: "local_docker",
          start: {
            ok: true,
            command: ["docker", "compose", "-p", "growth-os-runtime-local", "up", "-d"]
          },
          migrations: {
            ok: true,
            skipped: true,
            mode: "compose_managed"
          }
        }
      });
      expect(readFileSync(join(workspaceRoot, ".growth-os", "config.yml"), "utf8")).toContain("runtime_target: local_docker");
      expect(readFileSync(join(workspaceRoot, ".growth-os", ".env"), "utf8")).toContain("DATABASE_URL=postgres://growth_os:growth_os_dev@localhost:5432/growth_os");
      expect(readFileSync(join(workspaceRoot, ".growth-os", ".env"), "utf8")).not.toContain("POSTHOG_API_KEY");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs runtime setup for external Postgres without invoking Docker compose", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-runtime-external-"));
    try {
      const result = await runCommand(
        "setup",
        [
          "runtime",
          "--mode",
          "external_postgres",
          "--database-url",
          "postgres://growth:supersecret@db.example.com:5432/growth"
        ],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_CLI_DRY_RUN: "1"
        }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "runtime",
        runtime: {
          mode: "external_postgres",
          start: { ok: true, skipped: true, reason: "external_runtime" },
          migrations: { ok: true, dryRun: true },
          databaseUrl: "postgres://growth:%5Bredacted%5D@db.example.com:5432/growth"
        }
      });
      expect(JSON.stringify(result)).not.toContain("supersecret");
      expect(readFileSync(join(workspaceRoot, ".growth-os", "config.yml"), "utf8")).toContain("runtime_target: external_postgres");
      expect(readFileSync(join(workspaceRoot, ".growth-os", ".env"), "utf8")).toContain("DATABASE_URL=postgres://growth:supersecret@db.example.com:5432/growth");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs runtime setup for Supabase through the same external Postgres migration path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-runtime-supabase-"));
    try {
      const result = await runCommand(
        "setup",
        [
          "runtime",
          "--mode",
          "supabase",
          "--database-url",
          "postgres://supabase:supersecret@db.supabase.example.com:5432/postgres"
        ],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_CLI_DRY_RUN: "1"
        }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "runtime",
        runtime: {
          mode: "supabase",
          start: { ok: true, skipped: true, reason: "external_runtime" },
          migrations: { ok: true, dryRun: true },
          databaseUrl: "postgres://supabase:%5Bredacted%5D@db.supabase.example.com:5432/postgres"
        }
      });
      expect(JSON.stringify(result)).not.toContain("supersecret");
      expect(readFileSync(join(workspaceRoot, ".growth-os", "config.yml"), "utf8")).toContain("runtime_target: supabase");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("routes setup model through the shared model/auth setup path", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-model-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-model-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-setup-model-claude-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-setup-model-access",
            refreshToken: "claude-setup-model-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const result = await runCommand(
        "setup",
        ["model", "claude", "claude-sonnet-4-5", "--auth", "reuse"],
        {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          HOME: home
        }
      );

      expect(result).toMatchObject({
        ok: true,
        provider: "claude",
        model: "claude-sonnet-4-5",
        auth: {
          ready: true,
          verifiedSource: "claude-code-credentials-file"
        }
      });
      expect(readFileSync(join(growthHome, "config.yml"), "utf8")).toContain("model_provider: claude");
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("claude-setup-model-refresh");
      expect(existsSync(join(workspaceRoot, ".growth-os", "auth.json"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dispatches setup runtime and setup status through their section handlers", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-sections-"));
    try {
      const runtime = await runCommand("setup", ["runtime", "--mode", "local_docker"], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_CLI_DRY_RUN: "1"
      });
      const status = await runCommand("setup", ["status"], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });

      expect(runtime).toMatchObject({
        ok: true,
        section: "runtime"
      });
      expect(status).toMatchObject({
        setupReadiness: expect.any(Object)
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not hang noninteractive setup without provider flags", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-no-input-"));
    try {
      const result = await runCommand("setup", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "growth_os_setup_requires_input" }
      });
      expect(existsSync(join(workspaceRoot, ".growth-os", "config.yml"))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("verifies provider auth before storing selected model in user-level Infinite OS config", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "claude-model-use-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-model-access",
            refreshToken: "claude-model-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );
      await runCommand("model", ["use", "claude", "claude-sonnet-4-5"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        HOME: home
      });

      expect(readFileSync(join(growthHome, "config.yml"), "utf8")).toContain("model_provider: claude");
      expect(readFileSync(join(growthHome, "config.yml"), "utf8")).toContain("model_name: claude-sonnet-4-5");
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("claude-model-refresh");
      expect(existsSync(join(workspaceRoot, ".growth-os", "config.yml"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not store explicit model selection when provider auth is missing", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-model-missing-auth-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-model-missing-auth-workspace-"));
    try {
      await expect(
        runCommand("model", ["use", "claude", "claude-sonnet-4-5"], {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          HOME: mkdtempSync(join(tmpdir(), "claude-model-no-creds-home-"))
        })
      ).rejects.toThrow("claude model auth is not ready");

      expect(existsSync(join(growthHome, "config.yml"))).toBe(false);
      expect(existsSync(join(workspaceRoot, ".growth-os", "config.yml"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to HOME for user-level setup model state when GROWTH_OS_HOME is unset", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-home-fallback-workspace-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-home-fallback-user-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-home-fallback-access",
            refreshToken: "claude-home-fallback-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      await runCommand("setup", ["model", "claude", "claude-sonnet-4-5", "--auth", "reuse"], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        HOME: home
      });

      expect(readFileSync(join(home, ".growth-os", "config.yml"), "utf8")).toContain("model_provider: claude");
      expect(readFileSync(join(home, ".growth-os", "auth.json"), "utf8")).toContain("claude-home-fallback-refresh");
      expect(existsSync(join(workspaceRoot, ".growth-os", "config.yml"))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects unsupported explicit model selections", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-unsupported-model-"));
    try {
      await expect(
        runCommand("model", ["use", "codex", "gpt-4o"], {
          GROWTH_OS_HOME: growthHome
        })
      ).rejects.toThrow("unsupported model for codex: gpt-4o");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("lists supported models from the shared provider catalog", async () => {
    const result = await runCommand("model", ["list"], {});

    expect(result).toMatchObject({
      ok: true,
      providers: [
        { provider: "codex", models: ["gpt-5.4"] },
        { provider: "claude", models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-5", "claude-haiku-4-5-20251001"] }
      ]
    });
  });

  it("imports Codex CLI auth into user-level Infinite OS auth state without project-local writes", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-auth-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-workspace-"));
    try {
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "codex-access-token",
            refresh_token: "codex-refresh-token",
            expires_at: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const result = await runCommand("auth", ["import", "codex"], {
        GROWTH_OS_HOME: growthHome,
        CODEX_HOME: codexHome,
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });
      const status = await runCommand("auth", ["status", "codex"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });

      expect(result).toMatchObject({ ok: true, provider: "codex", imported: true });
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("codex-refresh-token");
      expect(JSON.stringify(status)).not.toContain("codex-refresh-token");
      expect(existsSync(join(workspaceRoot, ".growth-os", "auth.json"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs Infinite OS-owned Codex device-code login without invoking Codex CLI", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-login-"));
    const binDir = mkdtempSync(join(tmpdir(), "codex-login-bin-"));
    const codexBin = join(binDir, "codex");
    const requests: Array<{ url: string; body: string }> = [];
    try {
      writeFileSync(
        codexBin,
        [
          "#!/usr/bin/env node",
          "process.exit(9);"
        ].join("\n")
      );
      chmodSync(codexBin, 0o755);
      vi.stubGlobal(
        "fetch",
        async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(url), body: String(init?.body ?? "") });
          const requestUrl = String(url);
          if (requestUrl.endsWith("/api/accounts/deviceauth/usercode")) {
            return new Response(
              JSON.stringify({
                user_code: "GROWTH-CODE",
                device_auth_id: "device-auth-1",
                interval: 0
              }),
              { status: 200 }
            );
          }
          if (requestUrl.endsWith("/api/accounts/deviceauth/token")) {
            return new Response(
              JSON.stringify({
                authorization_code: "authorization-code-1",
                code_verifier: "code-verifier-1"
              }),
              { status: 200 }
            );
          }
          if (requestUrl.endsWith("/oauth/token")) {
            return new Response(
              JSON.stringify({
                access_token: "growth-os-codex-access",
                refresh_token: "growth-os-codex-refresh",
                expires_at: "2999-01-01T00:00:00.000Z"
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
        }
      );

      const result = await runCommand("auth", ["login", "codex"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CODEX_BIN: codexBin,
        GROWTH_OS_CODEX_AUTH_BASE_URL: "https://auth.openai.test",
        GROWTH_OS_CODEX_TOKEN_URL: "https://auth.openai.test/oauth/token",
        GROWTH_OS_CODEX_AUTH_TIMEOUT_MS: "500",
        GROWTH_OS_CODEX_AUTH_POLL_MS: "0",
        GROWTH_OS_CODEX_AUTH_SILENT: "1"
      });

      expect(result).toMatchObject({
        ok: true,
        provider: "codex",
        mode: "login",
        source: "growth-os-codex",
        authMode: "device-code"
      });
      expect(requests.map((request) => request.url)).toEqual([
        "https://auth.openai.test/api/accounts/deviceauth/usercode",
        "https://auth.openai.test/api/accounts/deviceauth/token",
        "https://auth.openai.test/oauth/token"
      ]);
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("growth-os-codex-refresh");
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("growth-os-codex");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("reuses existing Infinite OS Codex auth on login without touching Codex CLI", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-reuse-"));
    const binDir = mkdtempSync(join(tmpdir(), "codex-reuse-bin-"));
    const codexBin = join(binDir, "codex");
    let codexHome: string | undefined;
    try {
      writeFileSync(
        codexBin,
        [
          "#!/usr/bin/env node",
          "process.exit(9);"
        ].join("\n")
      );
      chmodSync(codexBin, 0o755);
      codexHome = mkCodexHome({
        access_token: "existing-codex-access",
        refresh_token: "existing-codex-refresh",
        expires_at: "2999-01-01T00:00:00.000Z"
      });
      await runCommand("auth", ["import", "codex"], {
        GROWTH_OS_HOME: growthHome,
        CODEX_HOME: codexHome
      });
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "should not fetch" }), { status: 500 }));

      const result = await runCommand("auth", ["login", "codex"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CODEX_BIN: codexBin
      });

      expect(result).toMatchObject({
        ok: true,
        provider: "codex",
        mode: "login",
        source: "codex-cli-import",
        reused: true
      });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
      if (codexHome) {
        rmSync(codexHome, { recursive: true, force: true });
      }
    }
  });

  it("prefers importing Codex CLI credentials before device-code login", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-import-first-"));
    const codexHome = mkCodexHome({
      access_token: "codex-cli-access",
      refresh_token: "codex-cli-refresh",
      expires_at: "2999-01-01T00:00:00.000Z"
    });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error("device-code flow should not run when Codex CLI credentials are present");
      }) as typeof fetch;

      const result = await runCommand("auth", ["login", "codex"], {
        GROWTH_OS_HOME: growthHome,
        CODEX_HOME: codexHome
      });

      expect(result).toMatchObject({
        ok: true,
        provider: "codex",
        mode: "login",
        source: codexHome + "/auth.json",
        imported: true,
        reused: true
      });
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("codex-cli-refresh");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("surfaces local Codex CLI credentials in auth status before explicit import", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-status-importable-"));
    const codexHome = mkCodexHome({
      access_token: "codex-cli-access",
      refresh_token: "codex-cli-refresh",
      expires_at: "2999-01-01T00:00:00.000Z"
    });
    try {
      const status = await runCommand("auth", ["status", "codex"], {
        GROWTH_OS_HOME: growthHome,
        CODEX_HOME: codexHome
      });

      expect(status).toMatchObject({
        providers: [
          {
            provider: "codex",
            source: `${codexHome}/auth.json`,
            ready: true,
            reason: "codex_cli_auth_ready"
          }
        ]
      });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("refreshes stale Infinite OS Codex auth before reporting model auth ready", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-status-refresh-"));
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: string }> = [];
    try {
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            codex: {
              provider: "codex",
              source: "growth-os-codex",
              authMode: "device-code",
              token: "expired-codex-token",
              refreshToken: "codex-refresh-token",
              expiresAt: "2000-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(
          JSON.stringify({
            access_token: "fresh-codex-token",
            refresh_token: "fresh-codex-refresh",
            expires_at: "2999-01-01T00:00:00.000Z"
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const status = await runCommand("auth", ["status", "codex"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CODEX_TOKEN_URL: "https://auth.openai.test/oauth/token"
      });
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            codex: {
              provider: "codex",
              source: "growth-os-codex",
              authMode: "device-code",
              token: "expired-codex-token",
              refreshToken: "codex-refresh-token",
              expiresAt: "2000-01-01T00:00:00.000Z"
            }
          }
        })
      );
      const login = await runCommand("auth", ["login", "codex"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CODEX_TOKEN_URL: "https://auth.openai.test/oauth/token"
      });

      expect(status).toMatchObject({
        providers: [
          {
            provider: "codex",
            ready: true,
            reason: "stored_auth_refreshed"
          }
        ]
      });
      expect(login).toMatchObject({
        ok: true,
        provider: "codex",
        refreshed: true,
        reused: true
      });
      expect(requests[0]).toMatchObject({
        url: "https://auth.openai.test/oauth/token"
      });
      expect(requests[0].body).toContain("grant_type=refresh_token");
      expect(requests[0].body).toContain("refresh_token=codex-refresh-token");
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("fresh-codex-refresh");
      expect(JSON.stringify(status)).not.toContain("fresh-codex-token");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("records Claude Code credential reuse in user-level Infinite OS auth state", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-auth-"));
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-token",
            refreshToken: "claude-refresh-token",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const result = await runCommand("auth", ["login", "claude", "--mode", "reuse"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home
      });
      const status = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome
      });

      expect(result).toMatchObject({
        ok: true,
        provider: "claude",
        mode: "reuse",
        hasCredentials: true
      });
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("claude-refresh-token");
      expect(JSON.stringify(status)).not.toContain("claude-refresh-token");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs Claude setup-token mode and then reuses detected Claude Code credentials", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-setup-token-"));
    const home = mkdtempSync(join(tmpdir(), "claude-setup-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "claude-setup-bin-"));
    const claudeBin = join(binDir, "claude");
    try {
      writeFileSync(
        claudeBin,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "if (process.argv[2] !== 'setup-token') process.exit(2);",
          "const dir = path.join(process.env.HOME, '.claude');",
          "fs.mkdirSync(dir, { recursive: true });",
          "fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-setup-access', refreshToken: 'claude-setup-refresh', expiresAt: '2999-01-01T00:00:00.000Z' } }));"
        ].join("\n")
      );
      chmodSync(claudeBin, 0o755);

      const result = await runCommand("auth", ["login", "claude", "--mode", "setup-token"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CLAUDE_BIN: claudeBin,
        HOME: home
      });

      expect(result).toMatchObject({
        ok: true,
        provider: "claude",
        mode: "setup-token",
        hasCredentials: true,
        setupTokenExitCode: 0
      });
      expect(readFileSync(join(growthHome, "auth.json"), "utf8")).toContain("claude-setup-refresh");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("labels environment model auth as redacted dev fallback status", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-env-auth-status-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-env-auth-home-"));
    try {
      const codexStatus = await runCommand("auth", ["status", "codex"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        OPENAI_API_KEY: "sk-openai-secret"
      });
      const claudeBearerStatus = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret"
      });
      const claudeApiKeyStatus = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        ANTHROPIC_API_KEY: "sk-ant-secret"
      });

      expect(codexStatus).toMatchObject({
        providers: [
          {
            provider: "codex",
            source: "openai-api-key-dev-fallback",
            authMode: "api-key-fallback",
            hasToken: true,
            hasRefreshToken: false
          }
        ]
      });
      expect(claudeBearerStatus).toMatchObject({
        providers: [
          {
            provider: "claude",
            source: "claude-bearer-env",
            authMode: "setup-token-env",
            hasToken: true,
            hasRefreshToken: false
          }
        ]
      });
      expect(claudeApiKeyStatus).toMatchObject({
        providers: [
          {
            provider: "claude",
            source: "anthropic-api-key-dev-fallback",
            authMode: "api-key-fallback",
            hasToken: true,
            hasRefreshToken: false
          }
        ]
      });
      expect(JSON.stringify(codexStatus)).not.toContain("sk-openai-secret");
      expect(JSON.stringify(claudeBearerStatus)).not.toContain("claude-oauth-secret");
      expect(JSON.stringify(claudeApiKeyStatus)).not.toContain("sk-ant-secret");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports stale stored model auth as not ready", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-stale-auth-status-"));
    const home = mkdtempSync(join(tmpdir(), "claude-stale-home-"));
    try {
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "expired-claude-token",
              expiresAt: "2000-01-01T00:00:00.000Z"
            }
          }
        })
      );

      const status = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home
      });

      expect(status).toMatchObject({
        providers: [
          {
            provider: "claude",
            ready: false,
            reason: "stored_auth_expired"
          }
        ]
      });
      expect(JSON.stringify(status)).not.toContain("expired-claude-token");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not mark stale Claude setup-token auth ready when refresh fails", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-stale-claude-refresh-fail-"));
    const home = mkdtempSync(join(tmpdir(), "claude-refresh-fail-home-"));
    const originalFetch = globalThis.fetch;
    try {
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "expired-claude-token",
              refreshToken: "claude-refresh-token",
              expiresAt: "2000-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

      const status = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CLAUDE_REFRESH_URL: "https://claude.example.test/oauth/token",
        HOME: home
      });
      await expect(
        runCommand("model", ["use", "claude", "claude-sonnet-4-5"], {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_CLAUDE_REFRESH_URL: "https://claude.example.test/oauth/token",
          HOME: home
        })
      ).rejects.toThrow("claude model auth is not ready");

      expect(status).toMatchObject({
        providers: [
          {
            provider: "claude",
            ready: false,
            reason: "stored_auth_refresh_failed"
          }
        ]
      });
      expect(existsSync(join(growthHome, "config.yml"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not mark discovered local Claude credentials ready when refresh fails", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-local-refresh-fail-"));
    const home = mkdtempSync(join(tmpdir(), "claude-local-refresh-fail-home-"));
    const originalFetch = globalThis.fetch;
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-claude-token",
            refreshToken: "claude-refresh-token",
            expiresAt: "2000-01-01T00:00:00.000Z"
          }
        })
      );
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

      const status = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CLAUDE_REFRESH_URL: "https://claude.example.test/oauth/token",
        HOME: home
      });

      expect(status).toMatchObject({
        providers: [
          {
            provider: "claude",
            ready: false,
            reason: "claude_code_credentials_refresh_failed"
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not mark Claude Code OAuth (setup-token) credentials ready — OAuth completions are unsupported", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-setup-token-unsupported-"));
    const home = mkdtempSync(join(tmpdir(), "claude-setup-token-unsupported-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oat01-test-access-token",
            refreshToken: "sk-ant-ort01-test-refresh-token",
            expiresAt: "2999-01-01T00:00:00.000Z"
          }
        })
      );

      const status = await runCommand("auth", ["status", "claude"], {
        GROWTH_OS_HOME: growthHome,
        HOME: home
      });

      expect(status).toMatchObject({
        providers: [
          {
            provider: "claude",
            source: "claude-code-credentials-file",
            ready: false,
            reason: "Claude via OAuth (Claude Code setup-token/reuse credentials) is no longer supported. Set `ANTHROPIC_API_KEY` to use Claude, or run `infinite auth login codex` to use Codex."
          }
        ]
      });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks interactive chat when stored Claude auth points to stale discovered credentials", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-claude-chat-readiness-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-chat-readiness-home-"));
    const home = mkdtempSync(join(tmpdir(), "claude-chat-readiness-home-"));
    const originalFetch = globalThis.fetch;
    try {
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });
      mkdirSync(growthHome, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "stored-claude-token",
              refreshToken: "stored-claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-claude-token",
            refreshToken: "claude-refresh-token",
            expiresAt: "2000-01-01T00:00:00.000Z"
          }
        })
      );
      writeInfiniteOsModelSelection(
        { provider: "claude", model: "claude-opus-4-8" },
        { GROWTH_OS_HOME: growthHome } as NodeJS.ProcessEnv
      );
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

      await expect(
        localChatReadiness({
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_CLAUDE_REFRESH_URL: "https://claude.example.test/oauth/token",
          HOME: home
        })
      ).resolves.toMatchObject({
        ok: false,
        setupReadiness: {
          authProvider: {
            provider: "claude",
            source: "claude-code-credentials-file",
            reason: "claude_code_credentials_refresh_failed"
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("wraps Docker compose lifecycle commands for package-style startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-cli-lifecycle-"));
    const env = {
      GROWTH_OS_WORKSPACE_ROOT: root,
      GROWTH_OS_CLI_DRY_RUN: "1",
      GROWTH_OS_COMPOSE_PROJECT: "growth-os-test"
    };
    try {
      await expect(runCommand("start", [], env)).resolves.toMatchObject({
        ok: true,
        cwd: root,
        command: ["docker", "compose", "-p", "growth-os-test", "up", "-d"]
      });
      await expect(runCommand("migrate", [], env)).resolves.toMatchObject({
        ok: true,
        cwd: root,
        command: ["docker", "compose", "-p", "growth-os-test", "run", "--rm", "migrate"]
      });
      await expect(runCommand("status", [], env)).resolves.toMatchObject({
        ok: true,
        cwd: root,
        command: ["docker", "compose", "-p", "growth-os-test", "ps"]
      });
      await expect(runCommand("logs", ["worker"], env)).resolves.toMatchObject({
        ok: true,
        cwd: root,
        command: ["docker", "compose", "-p", "growth-os-test", "logs", "worker"]
      });
      await expect(runCommand("stop", [], env)).resolves.toMatchObject({
        ok: true,
        cwd: root,
        command: ["docker", "compose", "-p", "growth-os-test", "stop"]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps compose-managed migration failures during runtime setup to actionable guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-runtime-migrate-failure-"));
    const binDir = mkdtempSync(join(tmpdir(), "growth-os-runtime-migrate-failure-bin-"));
    try {
      const dockerBin = writeFakeDockerBin(binDir, [
        "[+] Running 4/4",
        "service \"migrate\" didn't complete successfully: exit 1",
        "Error response from daemon: container growth-os-migrate-1 exited (1)"
      ]);

      const result = await runCommand("setup", ["runtime", "--mode", "local_docker"], {
        GROWTH_OS_WORKSPACE_ROOT: root,
        GROWTH_OS_DOCKER_BIN: dockerBin
      });

      expect(result).toMatchObject({
        ok: false,
        section: "runtime",
        error: {
          code: "growth_os_local_workspace_migration_failed",
          message: "We couldn't start the local workspace because the database migration step failed."
        },
        next: "Run `infinite logs migrate`, fix the migration error, then retry `infinite setup` or `infinite start`."
      });

      const rendered = renderCliResult(result);
      expect(rendered).toContain("We couldn't start the local workspace because the database migration step failed.");
      expect(rendered).toContain("service \"migrate\" didn't complete successfully: exit 1");
      expect(rendered).toContain("infinite logs migrate");
      expect(rendered).not.toContain("Error response from daemon: container growth-os-migrate-1 exited (1)");
      expect(rendered).not.toContain("[+] Running 4/4");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("maps compose-managed migration failures during start to the same runtime guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-start-migrate-failure-"));
    const binDir = mkdtempSync(join(tmpdir(), "growth-os-start-migrate-failure-bin-"));
    try {
      const dockerBin = writeFakeDockerBin(binDir, [
        "service \"migrate\" didn't complete successfully: exit 1",
        "error: relation \"events\" does not exist"
      ]);

      const result = await runCommand("start", [], {
        GROWTH_OS_WORKSPACE_ROOT: root,
        GROWTH_OS_DOCKER_BIN: dockerBin
      });

      expect(result).toMatchObject({
        ok: false,
        section: "runtime",
        error: {
          code: "growth_os_local_workspace_migration_failed",
          message: "We couldn't start the local workspace because the database migration step failed."
        }
      });

      const rendered = renderCliResult(result);
      expect(rendered).toContain("We couldn't start the local workspace because the database migration step failed.");
      expect(rendered).toContain("service \"migrate\" didn't complete successfully: exit 1");
      expect(rendered).toContain("retry infinite setup or infinite start");
      expect(rendered).not.toContain("error: relation \"events\" does not exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("feeds docker-stack secrets from .growth-os/.env into the compose env (single source of truth)", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-compose-env-"));
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: root });
      const result = (await runCommand("status", [], {
        GROWTH_OS_WORKSPACE_ROOT: root,
        GROWTH_OS_CLI_DRY_RUN: "1"
      })) as { composeEnvKeys?: string[] };
      // key + tokens copied; postgres password/user/db derived from DATABASE_URL
      expect(result.composeEnvKeys).toEqual(
        expect.arrayContaining([
          "GROWTH_OS_ENCRYPTION_KEY",
          "GROWTH_OS_OPERATOR_TOKEN",
          "GROWTH_OS_READ_TOKEN",
          "POSTGRES_PASSWORD",
          "POSTGRES_USER",
          "POSTGRES_DB"
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // app/worker run bind-mounted code under long-lived node processes, so a
  // plain `docker compose up -d` after `git pull` leaves them executing stale
  // code. `infinite start` stamps the checkout's code identity into the compose
  // env (GROWTH_OS_CODE_VERSION); a changed value is config drift, which makes
  // compose recreate exactly app/worker.
  describe("start recreates app/worker when the code moved", () => {
    // Fake docker bin that records its argv and the GROWTH_OS_CODE_VERSION it
    // was handed, optionally emits compose-style progress lines, and succeeds.
    const writeRecordingDockerBin = (directory: string, stderrLines: string[] = []): string => {
      const dockerBin = join(directory, "docker");
      writeFileSync(
        dockerBin,
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$@" > "${join(directory, "args.txt")}"`,
          `printf '%s' "\${GROWTH_OS_CODE_VERSION:-unset}" > "${join(directory, "code-version.txt")}"`,
          ...stderrLines.map((line) => `printf '%s\\n' '${line.replace(/'/g, `'\"'\"'`)}' >&2`),
          "exit 0"
        ].join("\n")
      );
      chmodSync(dockerBin, 0o755);
      return dockerBin;
    };

    it("composeCodeVersion is the HEAD sha when clean, dev outside git, and drifts per dirty edit", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "growth-os-code-version-plain-"));
      const repo = mkdtempSync(join(tmpdir(), "growth-os-code-version-git-"));
      try {
        expect(composeCodeVersion(nonGit)).toBe("dev");

        const git = (...args: string[]): string => {
          const result = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], {
            encoding: "utf8"
          });
          expect(result.status).toBe(0);
          return result.stdout.trim();
        };
        git("init", "-q");
        writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
        git("add", "app.ts");
        git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
        const sha = git("rev-parse", "HEAD");

        expect(composeCodeVersion(repo)).toBe(sha);

        // A dirty tree must read as new code (recreate on next start)…
        writeFileSync(join(repo, "app.ts"), "export const v = 2;\n");
        const dirtyOnce = composeCodeVersion(repo);
        expect(dirtyOnce).toMatch(new RegExp(`^${sha}-dirty\\.[0-9a-f]{12}$`));

        // …and successive different edits must each read as new code too. A
        // bare "-dirty" suffix would only recreate for the first edit.
        writeFileSync(join(repo, "app.ts"), "export const v = 3;\n");
        const dirtyTwice = composeCodeVersion(repo);
        expect(dirtyTwice).toMatch(new RegExp(`^${sha}-dirty\\.[0-9a-f]{12}$`));
        expect(dirtyTwice).not.toBe(dirtyOnce);
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("start passes GROWTH_OS_CODE_VERSION through to docker compose", async () => {
      const root = mkdtempSync(join(tmpdir(), "growth-os-start-code-version-"));
      const binDir = mkdtempSync(join(tmpdir(), "growth-os-start-code-version-bin-"));
      try {
        const dockerBin = writeRecordingDockerBin(binDir);
        const result = await runCommand("start", ["--no-wait"], {
          GROWTH_OS_WORKSPACE_ROOT: root,
          GROWTH_OS_DOCKER_BIN: dockerBin,
          GROWTH_OS_CODE_VERSION: "abc123-dirty.feedfacecafe"
        });
        expect(result).toMatchObject({ ok: true, cwd: root });
        expect(readFileSync(join(binDir, "args.txt"), "utf8").trim().split("\n")).toEqual([
          "compose",
          "up",
          "-d"
        ]);
        // explicit env override wins (lets ops pin a version)
        expect(readFileSync(join(binDir, "code-version.txt"), "utf8")).toBe("abc123-dirty.feedfacecafe");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it("start derives the code version from the workspace checkout (dev outside git)", async () => {
      const root = mkdtempSync(join(tmpdir(), "growth-os-start-code-version-dev-"));
      const binDir = mkdtempSync(join(tmpdir(), "growth-os-start-code-version-dev-bin-"));
      try {
        const dockerBin = writeRecordingDockerBin(binDir);
        const result = await runCommand("start", ["--no-wait"], {
          GROWTH_OS_WORKSPACE_ROOT: root,
          GROWTH_OS_DOCKER_BIN: dockerBin
        });
        expect(result).toMatchObject({ ok: true });
        // tmp root is not a git checkout — compose still gets the documented default
        expect(readFileSync(join(binDir, "code-version.txt"), "utf8")).toBe("dev");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it("explains the recreate when compose reports app/worker were recreated", async () => {
      const root = mkdtempSync(join(tmpdir(), "growth-os-start-recreate-notice-"));
      const binDir = mkdtempSync(join(tmpdir(), "growth-os-start-recreate-notice-bin-"));
      const stderrChunks: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
      try {
        const dockerBin = writeRecordingDockerBin(binDir, [
          " Container growth-os-app-1  Recreated",
          " Container growth-os-worker-1  Recreated",
          " Container growth-os-postgres-1  Running"
        ]);
        const result = await runCommand("start", ["--no-wait"], {
          GROWTH_OS_WORKSPACE_ROOT: root,
          GROWTH_OS_DOCKER_BIN: dockerBin
        });
        expect(result).toMatchObject({ ok: true });
        const stderrText = stripAnsi(stderrChunks.join(""));
        expect(stderrText).toContain("code changed since containers started — recreating app/worker");
        // postgres only Running (never recreated) — it must not be named
        expect(stderrText).not.toContain("postgres");
      } finally {
        stderrSpy.mockRestore();
        rmSync(root, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it("stays quiet when compose left the containers alone", async () => {
      const root = mkdtempSync(join(tmpdir(), "growth-os-start-no-recreate-"));
      const binDir = mkdtempSync(join(tmpdir(), "growth-os-start-no-recreate-bin-"));
      const stderrChunks: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
      try {
        const dockerBin = writeRecordingDockerBin(binDir, [
          " Container growth-os-app-1  Running",
          " Container growth-os-worker-1  Running"
        ]);
        const result = await runCommand("start", ["--no-wait"], {
          GROWTH_OS_WORKSPACE_ROOT: root,
          GROWTH_OS_DOCKER_BIN: dockerBin
        });
        expect(result).toMatchObject({ ok: true });
        expect(stripAnsi(stderrChunks.join(""))).not.toContain("code changed since containers started");
      } finally {
        stderrSpy.mockRestore();
        rmSync(root, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });
  });

  // `infinite update` mirrors the install script's clean-tree/ff-pull update,
  // then restarts the stack via the same path as `infinite start`. These build
  // REAL temp git repos (no spawn mocking) so the fetch/pull and dirty-tree
  // gates are exercised exactly as they run in production.
  describe("infinite update", () => {
    const git = (repo: string, ...args: string[]): string => {
      const result = spawnSync(
        "git",
        ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        { encoding: "utf8" }
      );
      expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };

    // Fake docker bin that records its argv (so we can assert "compose up -d"
    // ran) and exits 0. Mirrors writeRecordingDockerBin in the start suite.
    const writeRecordingDockerBin = (directory: string): string => {
      const dockerBin = join(directory, "docker");
      writeFileSync(
        dockerBin,
        ["#!/usr/bin/env bash", `printf '%s\\n' "$@" > "${join(directory, "args.txt")}"`, "exit 0"].join("\n")
      );
      chmodSync(dockerBin, 0o755);
      return dockerBin;
    };

    // A bare "origin" repo plus a working clone pointed at it, so fetch/pull are
    // real and deterministic. `advanceOrigin` lands a new commit on origin so a
    // subsequent pull in the clone fast-forwards.
    const buildRepoWithOrigin = (): { origin: string; clone: string } => {
      const origin = mkdtempSync(join(tmpdir(), "growth-os-update-origin-"));
      const seed = mkdtempSync(join(tmpdir(), "growth-os-update-seed-"));
      git(origin, "init", "-q", "--bare", "--initial-branch=main");
      git(seed, "init", "-q", "--initial-branch=main");
      writeFileSync(join(seed, "app.ts"), "export const v = 1;\n");
      git(seed, "add", "app.ts");
      git(seed, "commit", "-q", "-m", "init");
      git(seed, "remote", "add", "origin", origin);
      git(seed, "push", "-q", "origin", "main");
      rmSync(seed, { recursive: true, force: true });
      const clone = mkdtempSync(join(tmpdir(), "growth-os-update-clone-"));
      git(clone, "clone", "-q", origin, ".");
      return { origin, clone };
    };

    const advanceOrigin = (origin: string): void => {
      const pusher = mkdtempSync(join(tmpdir(), "growth-os-update-push-"));
      git(pusher, "clone", "-q", origin, ".");
      writeFileSync(join(pusher, "app.ts"), "export const v = 2;\n");
      git(pusher, "add", "app.ts");
      git(pusher, "commit", "-q", "-m", "advance");
      git(pusher, "push", "-q", "origin", "main");
      rmSync(pusher, { recursive: true, force: true });
    };

    it("fast-forward pulls a clean tree and restarts the stack onto the new commit", async () => {
      const { origin, clone } = buildRepoWithOrigin();
      const binDir = mkdtempSync(join(tmpdir(), "growth-os-update-bin-"));
      try {
        const previousHead = git(clone, "rev-parse", "HEAD");
        advanceOrigin(origin);
        const dockerBin = writeRecordingDockerBin(binDir);
        const result = (await runCommand("update", ["--no-wait"], {
          GROWTH_OS_WORKSPACE_ROOT: clone,
          GROWTH_OS_DOCKER_BIN: dockerBin
        })) as Record<string, unknown>;
        const newHead = git(clone, "rev-parse", "HEAD");
        expect(newHead).not.toBe(previousHead);
        expect(result).toMatchObject({
          ok: true,
          command: "update",
          branch: "main",
          previousHead,
          newHead,
          pulled: true,
          codeChanged: true,
          updated: true
        });
        // It actually ran the start path (recorded compose up -d).
        expect((result.start as Record<string, unknown>).ok).toBe(true);
        expect(readFileSync(join(binDir, "args.txt"), "utf8").trim().split("\n")).toEqual(["compose", "up", "-d"]);
        expect(result.note).toContain("refreshes on the next");
      } finally {
        rmSync(origin, { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it("warns and does NOT pull or restart when the working tree is dirty", async () => {
      const { origin, clone } = buildRepoWithOrigin();
      const binDir = mkdtempSync(join(tmpdir(), "growth-os-update-dirty-bin-"));
      try {
        const previousHead = git(clone, "rev-parse", "HEAD");
        advanceOrigin(origin);
        // Local uncommitted edit → dirty tree.
        writeFileSync(join(clone, "app.ts"), "export const v = 999;\n");
        const dockerBin = writeRecordingDockerBin(binDir);
        const result = (await runCommand("update", ["--no-wait"], {
          GROWTH_OS_WORKSPACE_ROOT: clone,
          GROWTH_OS_DOCKER_BIN: dockerBin
        })) as Record<string, unknown>;
        expect(result).toMatchObject({
          ok: true,
          command: "update",
          pulled: false,
          updated: false,
          reason: "working_tree_dirty"
        });
        expect(result.warning).toContain("Local changes detected");
        // HEAD never moved (no pull) and docker was never invoked (no restart).
        expect(git(clone, "rev-parse", "HEAD")).toBe(previousHead);
        expect(existsSync(join(binDir, "args.txt"))).toBe(false);
      } finally {
        rmSync(origin, { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });

    it("returns a friendly message (no throw) outside a git checkout", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "growth-os-update-plain-"));
      try {
        const result = (await runCommand("update", [], {
          GROWTH_OS_WORKSPACE_ROOT: nonGit
        })) as Record<string, unknown>;
        expect(result).toMatchObject({ ok: false, updated: false, reason: "not_a_git_install" });
        expect(result.message).toContain("install script");
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });

  // The update notice is offline-first: ≤ one bounded `ls-remote` per 24h,
  // served from cache, stderr-only, and a complete no-op when offline / not a
  // git repo / cache fresh / already up to date. All branches are injected
  // (stderr stream, clock, cache path) so they're deterministic.
  describe("maybeNotifyUpdateAvailable", () => {
    const git = (repo: string, ...args: string[]): string => {
      const result = spawnSync(
        "git",
        ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        { encoding: "utf8" }
      );
      expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };

    const buildGitRepo = (): string => {
      const repo = mkdtempSync(join(tmpdir(), "growth-os-notify-"));
      git(repo, "init", "-q", "--initial-branch=main");
      writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
      git(repo, "add", "app.ts");
      git(repo, "commit", "-q", "-m", "init");
      return repo;
    };

    const collectStderr = (): { stream: { write(chunk: string): boolean }; text: () => string } => {
      const chunks: string[] = [];
      return {
        stream: {
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          }
        },
        text: () => chunks.join("")
      };
    };

    it("(a) cache fresh → no ls-remote, no output, cache untouched", () => {
      const repo = buildGitRepo();
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-cache-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        // Fresh cache from 1ms ago, with a remoteSha that matches HEAD so even if
        // it were read it wouldn't notify — but the point is it must not re-probe.
        const head = git(repo, "rev-parse", "HEAD");
        writeFileSync(cachePath, JSON.stringify({ lastCheckTs: 999_000, remoteSha: head }));
        const sink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: sink.stream, now: () => 1_000_000, cachePath }
        );
        expect(sink.text()).toBe("");
        // Untouched: lastCheckTs still the original (no probe → no rewrite).
        expect(JSON.parse(readFileSync(cachePath, "utf8")).lastCheckTs).toBe(999_000);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("(b) HEAD == cached remoteSha → no output even when due for a check", () => {
      const repo = buildGitRepo();
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-eq-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        const head = git(repo, "rev-parse", "HEAD");
        // No remote configured → the (stale) probe fails, but cached remoteSha
        // equals HEAD, so there is nothing to notify about.
        writeFileSync(cachePath, JSON.stringify({ lastCheckTs: 0, remoteSha: head }));
        const sink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: sink.stream, now: () => 10 * 24 * 60 * 60 * 1000, cachePath }
        );
        expect(sink.text()).toBe("");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("(c) cached remoteSha differs from HEAD (behind) → prints one stderr line, no network", () => {
      const repo = buildGitRepo();
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-behind-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        const head = git(repo, "rev-parse", "HEAD");
        const remoteSha = "0123456789abcdef0123456789abcdef01234567";
        // Fresh cache says we're behind → served instantly from cache, no probe.
        writeFileSync(cachePath, JSON.stringify({ lastCheckTs: 1_000_000, remoteSha }));
        const sink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: sink.stream, now: () => 1_000_001, cachePath }
        );
        const text = sink.text();
        expect(text).toContain("Update available");
        expect(text).toContain("infinite update");
        expect(text).toContain(head.slice(0, 7));
        expect(text).toContain(remoteSha.slice(0, 7));
        expect(text.trim().split("\n")).toHaveLength(1); // exactly one line
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("(d) offline / no remote → silent no-op, but lastCheckTs still advances", () => {
      const repo = buildGitRepo(); // no `origin` configured → ls-remote fails (offline-equivalent)
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-offline-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        const sink = collectStderr();
        const nowTs = 5_000_000;
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: sink.stream, now: () => nowTs, cachePath } // no cache file → due for a check
        );
        // No output (probe failed, nothing cached to notify from)…
        expect(sink.text()).toBe("");
        // …but lastCheckTs advanced so we don't re-probe every invocation.
        expect(JSON.parse(readFileSync(cachePath, "utf8")).lastCheckTs).toBe(nowTs);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("(e) suppressed for the `update` command and for --json invocations", () => {
      const repo = buildGitRepo();
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-suppress-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        const remoteSha = "0123456789abcdef0123456789abcdef01234567";
        writeFileSync(cachePath, JSON.stringify({ lastCheckTs: 1_000_000, remoteSha }));
        const updateSink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: updateSink.stream, now: () => 1_000_001, cachePath, command: "update" }
        );
        expect(updateSink.text()).toBe("");
        const jsonSink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: jsonSink.stream, now: () => 1_000_001, cachePath, command: "setup", args: ["--json"] }
        );
        expect(jsonSink.text()).toBe("");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("dirty working tree suppresses the notice (avoids dev false-positives)", () => {
      const repo = buildGitRepo();
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-dirty-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        const remoteSha = "0123456789abcdef0123456789abcdef01234567";
        writeFileSync(cachePath, JSON.stringify({ lastCheckTs: 1_000_000, remoteSha }));
        writeFileSync(join(repo, "app.ts"), "export const v = 2;\n"); // dirty
        const sink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: repo },
          { stderrStream: sink.stream, now: () => 1_000_001, cachePath }
        );
        expect(sink.text()).toBe("");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("is a no-op outside a git checkout (no output, no cache write)", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "growth-os-notify-plain-"));
      const cacheDir = mkdtempSync(join(tmpdir(), "growth-os-notify-plain-cache-"));
      const cachePath = join(cacheDir, "update-check.json");
      try {
        const sink = collectStderr();
        maybeNotifyUpdateAvailable(
          { GROWTH_OS_WORKSPACE_ROOT: nonGit },
          { stderrStream: sink.stream, now: () => 1_000_000, cachePath }
        );
        expect(sink.text()).toBe("");
        expect(existsSync(cachePath)).toBe(false);
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  });

  it("waitForAppReady resolves once the app /health endpoint responds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("fetch failed");
      }
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as typeof fetch;
    let clock = 0;
    const result = await waitForAppReady(
      { GROWTH_OS_API_URL: "http://127.0.0.1:3000" },
      {
        fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        intervalMs: 1000,
        timeoutMs: 60_000
      }
    );
    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.appUrl).toBe("http://127.0.0.1:3000/health");
  });

  it("waitForAppReady gives up after the timeout and reports the last error", async () => {
    let clock = 0;
    const progress: string[] = [];
    const result = await waitForAppReady(
      { GROWTH_OS_API_URL: "http://127.0.0.1:3000" },
      {
        fetchImpl: (async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
        }) as unknown as typeof fetch,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        intervalMs: 5000,
        timeoutMs: 12_000,
        onProgress: (message) => progress.push(message)
      }
    );
    expect(result.ready).toBe(false);
    expect(result.lastError).toContain("ECONNREFUSED");
    expect(result.waitedMs).toBeGreaterThanOrEqual(12_000);
    expect(progress.length).toBeGreaterThan(0);
  });

  it("waitForAppReady treats non-2xx /health responses as not ready", async () => {
    let clock = 0;
    const result = await waitForAppReady(
      { GROWTH_OS_API_URL: "http://127.0.0.1:3000" },
      {
        fetchImpl: (async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        intervalMs: 5000,
        timeoutMs: 8000
      }
    );
    expect(result.ready).toBe(false);
    expect(result.lastError).toBe("HTTP 503");
  });

  it("discovers the source checkout root for lifecycle commands run from the CLI package", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-cli-root-"));
    const nested = join(root, "apps", "cli");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    try {
      await expect(
        runCommand("status", [], {
          PWD: nested,
          GROWTH_OS_CLI_DRY_RUN: "1"
        })
      ).resolves.toMatchObject({
        ok: true,
        cwd: root,
        command: ["docker", "compose", "ps"]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the CLI's own checkout when run from outside any repo", async () => {
    // Simulates `infinite` launched from anywhere via the global wrapper: the
    // invocation dir has no docker-compose.yml/pnpm-workspace.yaml ancestor, so
    // the root must come from the CLI's own location instead of failing with
    // docker compose's "no configuration file provided: not found".
    const outside = mkdtempSync(join(tmpdir(), "growth-os-outside-repo-"));
    try {
      const result = (await runCommand("status", [], {
        PWD: outside,
        GROWTH_OS_CLI_DRY_RUN: "1"
      })) as { ok: boolean; cwd: string; command: string[] };
      expect(result.cwd).not.toBe(outside);
      expect(existsSync(join(result.cwd, "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(result.cwd, "pnpm-workspace.yaml"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps sync history on sync-runs so status can report runtime status", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await runCommand("sync-runs", [], { GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls[0]).toBe("http://127.0.0.1:3000/sync/runs");
  });

  it("reports setup readiness and blocks query readiness until a marketing connector exists", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-readiness-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-readiness-home-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-setup-readiness-user-home-"));
    const originalFetch = globalThis.fetch;
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "config.yml"),
        "model_provider: claude\nmodel_name: claude-sonnet-4-5\n"
      );
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-access",
              refreshToken: "claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { sources: [] }
          }),
          { status: 200 }
        )) as typeof fetch;

      const status = await runCommand("setup", ["status"], {
        DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999"
      });
      const query = await runCommand("setup", ["query"], {
        DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999"
      });
      const rendered = renderCliResult(query);

      expect(status).toMatchObject({
        ok: false,
        setupReadiness: {
          runtimeConfig: "configured",
          database: "migrated",
          model: "selected",
          auth: "ready",
          connectors: "none",
          llmQuery: "blocked"
        }
      });
      expect(JSON.stringify(status)).toContain("connectors_missing");
      expect(query).toMatchObject({ ok: false });
      expect(rendered).toContain("Infinite setup status");
      expect(rendered).toContain("Marketing data: none");
      expect(rendered).toContain("connectors_missing");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks runtime services ready when the DB path succeeds and app health is healthy", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-services-ready-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-services-ready-home-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-setup-services-ready-user-home-"));
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    const dbSpy = vi.spyOn(growthDb, "createInfiniteOsDb").mockReturnValue({
      query: async () => [],
      close: async () => undefined
    } as unknown as growthDb.InfiniteOsDb);

    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "config.yml"),
        "model_provider: claude\nmodel_name: claude-sonnet-4-5\n"
      );
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-access",
              refreshToken: "claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        fetchCalls.push(String(url));
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }) as typeof fetch;

      const readiness = await readSetupReadiness({
        DATABASE_URL: "postgres://growth:password@db.example.com:5432/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_WORKSPACE_ID: "proj_test",
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999"
      });

      expect(readiness).toMatchObject({
        runtimeConfig: "configured",
        runtimeServices: "ready",
        database: "migrated",
        connectors: "none"
      });
      expect(dbSpy).toHaveBeenCalled();
      expect(fetchCalls).toContain("http://127.0.0.1:3999/health");
    } finally {
      dbSpy.mockRestore();
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("cross-workspace readiness (direct DB): a PIN-LESS session is ready when ANY project has a connected source", async () => {
    // The crux of the cross-workspace change: chat-readiness must NOT be scoped to
    // the single active workspace. A no-pin session (no GROWTH_OS_WORKSPACE_ID)
    // would previously throw in `workspaceIdFor` and route to setup; now the source
    // query drops the `workspace_id` filter so "some other connected project" makes
    // the session ready (→ reaches chat + PR5's picker, not the setup wizard).
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-xws-readiness-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-xws-readiness-home-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-xws-readiness-user-home-"));
    const originalFetch = globalThis.fetch;
    const sqls: string[] = [];
    const params: Array<unknown[] | undefined> = [];
    const dbSpy = vi.spyOn(growthDb, "createInfiniteOsDb").mockReturnValue({
      query: async (sql: string, args?: unknown[]) => {
        sqls.push(sql);
        params.push(args);
        if (sql.includes("from sources")) {
          // A connected source belonging to SOME (unscoped) workspace.
          return [{ status: "connected" }];
        }
        return [];
      },
      close: async () => undefined
    } as unknown as growthDb.InfiniteOsDb);

    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "config.yml"),
        "model_provider: claude\nmodel_name: claude-sonnet-4-5\n"
      );
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-access",
              refreshToken: "claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;

      const readiness = await readSetupReadiness({
        DATABASE_URL: "postgres://growth:password@db.example.com:5432/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        // NO GROWTH_OS_WORKSPACE_ID — pin-less session.
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999"
      });

      expect(readiness).toMatchObject({
        database: "migrated",
        connectors: "connected",
        connectedSourceCount: 1,
        llmQuery: "ready"
      });
      // The source query ran WITHOUT a `workspace_id = $1` filter and WITHOUT a
      // resolved pin (no params), so it counts across ALL workspaces.
      const sourceSql = sqls.find((s) => s.includes("from sources"));
      expect(sourceSql).toBeDefined();
      expect(sourceSql).not.toContain("workspace_id");
      const sourceIdx = sqls.findIndex((s) => s.includes("from sources"));
      expect(params[sourceIdx]).toBeUndefined();
    } finally {
      dbSpy.mockRestore();
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not trust a default local app API for readiness unless GROWTH_OS_API_URL is explicit", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-readiness-local-api-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-readiness-local-api-home-"));
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "config.yml"),
        "model_provider: claude\nmodel_name: claude-sonnet-4-5\n"
      );
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-access",
              refreshToken: "claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        requests.push(String(url));
        return new Response(
          JSON.stringify({
            ok: true,
            data: { sources: [{ id: "src_1", provider: "google_analytics_4", status: "connected" }] }
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const status = await runCommand("setup", ["status"], {
        DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });

      expect(status).toMatchObject({
        ok: false,
        setupReadiness: {
          database: "missing",
          connectors: "none",
          llmQuery: "blocked"
        }
      });
      expect(requests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("marks LLM query readiness ready (app API, NO pin) when ANOTHER project has a connected source", async () => {
    // Cross-workspace readiness over the app API: a PIN-LESS session must pass
    // readiness when SOME project is connected. The app `/sources` route is
    // hard-scoped to one workspace, so readiness fans out over `/projects` and
    // checks each — here the FIRST project has no sources and the SECOND is
    // connected, so readiness is ready even though no pin is set.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-ready-query-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-ready-query-home-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-ready-query-user-home-"));
    const originalFetch = globalThis.fetch;
    const sourceWorkspaces: Array<string | undefined> = [];
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "config.yml"),
        "model_provider: claude\nmodel_name: claude-sonnet-4-5\n"
      );
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-access",
              refreshToken: "claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/projects")) {
          return new Response(
            JSON.stringify({
              ok: true,
              projects: [
                { id: "proj_empty", name: "Empty" },
                { id: "proj_connected", name: "Connected" }
              ]
            }),
            { status: 200 }
          );
        }
        if (target.endsWith("/sources")) {
          const header = (init?.headers as Record<string, string> | undefined)?.["X-Growth-Os-Workspace"];
          sourceWorkspaces.push(header);
          // Only the second project has a connected source.
          const sources =
            header === "proj_connected"
              ? [{ id: "src_1", provider: "google_analytics_4", status: "connected" }]
              : [];
          return new Response(JSON.stringify({ ok: true, data: { sources } }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }) as typeof fetch;

      await expect(
        localChatReadiness({
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          HOME: home,
          // NO GROWTH_OS_WORKSPACE_ID — a pin-less session must still pass.
          GROWTH_OS_API_URL: "http://127.0.0.1:3999",
          DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth"
        })
      ).resolves.toMatchObject({
        ok: true,
        setupReadiness: {
          connectors: "connected",
          llmQuery: "ready"
        }
      });
      // Both projects were scoped explicitly (per-project header), never a pin.
      expect(sourceWorkspaces).toContain("proj_empty");
      expect(sourceWorkspaces).toContain("proj_connected");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("hydrates app API URL and tokens from .growth-os config for CLI commands", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-api-hydration-"));
    const requests: Array<{ url: string; authorization?: string }> = [];
    const originalFetch = globalThis.fetch;
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      writeFileSync(join(workspaceRoot, ".growth-os", "config.yml"), "runtime_mode: local\napp_port: 3999\n");
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          authorization: init?.headers && "Authorization" in init.headers
            ? String(init.headers.Authorization)
            : undefined
        });
        return new Response(JSON.stringify({ ok: true, data: { sources: [] } }), { status: 200 });
      }) as typeof fetch;

      const guardedEnv = {
        GROWTH_OS_WORKSPACE_ID: "proj_test",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      };
      await runCommand("sources", [], guardedEnv);
      await runCommand("sync", ["src_1"], guardedEnv);

      expect(requests).toEqual([
        {
          url: "http://127.0.0.1:3999/sources",
          authorization: "Bearer dev-read-token"
        },
        {
          url: "http://127.0.0.1:3999/sources/src_1/sync",
          authorization: "Bearer dev-operator-token"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("sends the workspace header on app API calls and uses it for connector readiness", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-workspace-header-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-workspace-header-home-"));
    const home = mkdtempSync(join(tmpdir(), "growth-os-workspace-header-user-home-"));
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; workspace?: string; authorization?: string }> = [];
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      mkdirSync(growthHome, { recursive: true });
      writeFileSync(
        join(growthHome, "config.yml"),
        "model_provider: claude\nmodel_name: claude-sonnet-4-5\n"
      );
      writeFileSync(
        join(growthHome, "auth.json"),
        JSON.stringify({
          providers: {
            claude: {
              provider: "claude",
              source: "claude-code-credentials-file",
              authMode: "reuse",
              token: "claude-access",
              refreshToken: "claude-refresh",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        })
      );
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const target = String(url);
        const headers = new Headers(init?.headers);
        requests.push({
          url: target,
          workspace: headers.get("x-growth-os-workspace") ?? undefined,
          authorization: headers.get("authorization") ?? undefined
        });
        if (target.endsWith("/projects")) {
          // Cross-workspace readiness lists projects, then scopes `/sources` per id.
          return new Response(
            JSON.stringify({ ok: true, projects: [{ id: "proj_test", name: "Acme" }] }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            data: { sources: [{ id: "src_x", provider: "x", status: "connected", connectionName: "YourHandle Account" }] }
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const status = await runCommand("setup", ["status"], {
        GROWTH_OS_WORKSPACE_ID: "proj_test",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome,
        HOME: home,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999",
        DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth"
      });

      expect(status).toMatchObject({
        ok: true,
        setupReadiness: {
          connectors: "connected",
          llmQuery: "ready"
        }
      });
      // The per-project `/sources` call carries the (explicit) workspace header and
      // the read token — the cross-workspace fan-out still scopes each lookup.
      const sourcesCall = requests.find((r) => r.url === "http://127.0.0.1:3999/sources");
      expect(sourcesCall).toMatchObject({
        workspace: expect.stringMatching(/^proj_/),
        authorization: "Bearer dev-read-token"
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("project new/list/use/current manages projects via state.json", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-"));
    const env = { GROWTH_OS_HOME: growthHome, GROWTH_OS_API_URL: "http://127.0.0.1:3999",
      GROWTH_OS_OPERATOR_TOKEN: "op" } as Record<string, string>;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/projects")) {
        return new Response(JSON.stringify({ ok: true, project: { id: "proj_aaaaaaaaaaaaaaaa", name: "Acme" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      await runCommand("project", ["new", "Acme"], env);
      expect(readActiveProjectId(env as never)).toBe("proj_aaaaaaaaaaaaaaaa");
      const current = await runCommand("project", ["current"], env);
      expect(current).toMatchObject({ activeProjectId: "proj_aaaaaaaaaaaaaaaa" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("project default set/show/clear persists defaultProjectId without clobbering the active pointer", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-default-cmd-"));
    const env = {
      GROWTH_OS_HOME: growthHome,
      GROWTH_OS_API_URL: "http://127.0.0.1:3999",
      GROWTH_OS_OPERATOR_TOKEN: "op"
    } as Record<string, string>;
    // An existing active pointer (legacy/`project new`) that the default write
    // must preserve — this is the merge-preserving requirement.
    writeActiveProjectId("proj_active", env as never);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/projects")) {
        return new Response(
          JSON.stringify({ ok: true, projects: [{ id: "proj_default1", name: "Beta" }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const show0 = await runCommand("project", ["default", "show"], env);
      expect(show0).toMatchObject({ ok: true, defaultProjectId: null });

      const set = await runCommand("project", ["default", "set", "Beta"], env);
      expect(set).toMatchObject({ ok: true, defaultProjectId: "proj_default1", name: "Beta" });
      expect(readDefaultProjectId(env as never)).toBe("proj_default1");
      // The active pointer survived the default write.
      expect(readActiveProjectId(env as never)).toBe("proj_active");

      const show1 = await runCommand("project", ["default", "show"], env);
      expect(show1).toMatchObject({ ok: true, defaultProjectId: "proj_default1" });

      const clear = await runCommand("project", ["default", "clear"], env);
      expect(clear).toMatchObject({ ok: true, defaultProjectId: null });
      expect(readDefaultProjectId(env as never)).toBeUndefined();
      // Clearing the default still leaves the active pointer intact.
      expect(readActiveProjectId(env as never)).toBe("proj_active");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("project default set rejects an unknown project", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-default-unknown-"));
    const env = {
      GROWTH_OS_HOME: growthHome,
      GROWTH_OS_API_URL: "http://127.0.0.1:3999",
      GROWTH_OS_OPERATOR_TOKEN: "op"
    } as Record<string, string>;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, projects: [{ id: "proj_x", name: "Beta" }] }), {
        status: 200
      })) as typeof fetch;
    try {
      await expect(runCommand("project", ["default", "set", "Nope"], env)).rejects.toThrow(
        /Unknown project: Nope/
      );
      expect(readDefaultProjectId(env as never)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("project current reports the pin and the persisted default separately", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-current-"));
    const env = { GROWTH_OS_HOME: growthHome } as Record<string, string>;
    writeDefaultProjectId("proj_default", env as never);
    // No pin yet, but a default exists → not a "no_active_project" error.
    const current0 = await runCommand("project", ["current"], env);
    expect(current0).toMatchObject({ ok: true, pin: null, defaultProjectId: "proj_default" });

    // An in-process env pin (set by `--project`/CI/`@name`) is reported as the pin.
    const pinnedEnv = { ...env, GROWTH_OS_WORKSPACE_ID: "proj_pinned" } as Record<string, string>;
    const current1 = await runCommand("project", ["current"], pinnedEnv);
    expect(current1).toMatchObject({
      ok: true,
      pin: "proj_pinned",
      activeProjectId: "proj_pinned",
      defaultProjectId: "proj_default"
    });
  });

  it("project current returns no_active_project when there is neither pin nor default", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-current-empty-"));
    const env = { GROWTH_OS_HOME: growthHome } as Record<string, string>;
    const current = await runCommand("project", ["current"], env);
    expect(current).toMatchObject({ ok: false, error: { code: "no_active_project" } });
  });

  describe("applySessionDefaultPin (no default on load + migration notice)", () => {
    it("loads a persisted default into the in-process env pin and shows no notice", () => {
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pin-default-"));
      const env = { GROWTH_OS_HOME: growthHome } as Record<string, string>;
      writeDefaultProjectId("proj_default", env as never);
      const notice = applySessionDefaultPin(env as never);
      expect(env.GROWTH_OS_WORKSPACE_ID).toBe("proj_default");
      expect(notice).toBeUndefined();
    });

    it("leaves the session unpinned and emits no notice on a fresh install", () => {
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pin-fresh-"));
      const env = { GROWTH_OS_HOME: growthHome } as Record<string, string>;
      const notice = applySessionDefaultPin(env as never);
      expect(env.GROWTH_OS_WORKSPACE_ID).toBeUndefined();
      expect(notice).toBeUndefined();
    });

    it("does not overwrite an already-set env pin with the default", () => {
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pin-explicit-"));
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ID: "proj_explicit"
      } as Record<string, string>;
      writeDefaultProjectId("proj_default", env as never);
      applySessionDefaultPin(env as never);
      expect(env.GROWTH_OS_WORKSPACE_ID).toBe("proj_explicit");
    });

    it("emits a one-time migration notice for a legacy activeProjectId, then latches", () => {
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pin-legacy-"));
      const env = { GROWTH_OS_HOME: growthHome } as Record<string, string>;
      writeActiveProjectId("proj_legacy", env as never);
      const first = applySessionDefaultPin(env as never);
      expect(first).toMatch(/\/project default set|@name/);
      // No default existed → the legacy pointer is NOT promoted to the env pin.
      expect(env.GROWTH_OS_WORKSPACE_ID).toBeUndefined();
      expect(readMigrationNoticeShown(env as never)).toBe(true);
      // Second session: the notice does not repeat.
      const second = applySessionDefaultPin({ GROWTH_OS_HOME: growthHome } as never);
      expect(second).toBeUndefined();
    });
  });

  it("resetAgentRuntime closes the memoized runtime and rebuilds a new one", () => {
    let built = 0;
    const closed: number[] = [];
    const factory = (): CliAgentRuntime => {
      const id = ++built;
      return {
        chat: async () => ({ ok: true }),
        listSessions: async () => ({ ok: true }),
        resumeSession: async () => ({ ok: true }),
        compactSession: async () => ({ ok: true }),
        confirmAction: async () => ({ ok: true }),
        listMemory: async () => ({ ok: true }),
        addMemory: async () => ({ ok: true }),
        deleteMemory: async () => ({ ok: true }),
        close: async () => {
          closed.push(id);
        }
      };
    };
    try {
      const first = ensureActiveAgentRuntime(factory);
      // Memoized — same instance on a second call, no rebuild.
      expect(ensureActiveAgentRuntime(factory)).toBe(first);
      expect(built).toBe(1);
      resetAgentRuntime();
      const second = ensureActiveAgentRuntime(factory);
      expect(second).not.toBe(first);
      expect(built).toBe(2);
      expect(closed).toEqual([1]); // the prior runtime's close() ran on reset
    } finally {
      resetAgentRuntime();
    }
  });

  it("global --project resolves a project name to its id via direct DB lookup", async () => {
    const env = { GROWTH_OS_WORKSPACE_ROOT: "/tmp/whatever" } as Record<string, string>;
    const fakeDb = {
      async one(_sql: string, params?: unknown[]) {
        return { id: "proj_bbbbbbbbbbbbbbbb", name: String(params?.[0]), createdAt: "t" };
      },
      async close() {}
    };
    const resolved = await resolveProjectFlag(["--project", "Acme", "sources"], env, {
      createDb: () => fakeDb as never,
      databaseUrl: "postgres://test"
    });
    expect(resolved.command).toBe("sources");
    expect(resolved.args).toEqual(["sources"]);
    expect(env.GROWTH_OS_WORKSPACE_ID).toBe("proj_bbbbbbbbbbbbbbbb");
  });

  it("global --project throws for an unknown project", async () => {
    const env = { GROWTH_OS_WORKSPACE_ROOT: "/tmp/whatever" } as Record<string, string>;
    const fakeDb = {
      async one() {
        return null;
      },
      async close() {}
    };
    await expect(
      resolveProjectFlag(["--project=Ghost", "sources"], env, {
        createDb: () => fakeDb as never,
        databaseUrl: "postgres://test"
      })
    ).rejects.toThrow(/Unknown project: Ghost/);
  });

  it("global --project is skipped for DB-down-tolerant commands (status)", async () => {
    const env = { GROWTH_OS_WORKSPACE_ROOT: "/tmp/whatever" } as Record<string, string>;
    let opened = false;
    const resolved = await resolveProjectFlag(["--project", "Acme", "status"], env, {
      createDb: () => {
        opened = true;
        return { async one() { return null; }, async close() {} } as never;
      },
      databaseUrl: "postgres://test"
    });
    expect(resolved.command).toBe("status");
    expect(resolved.args).toEqual(["status"]);
    expect(opened).toBe(false); // no DB resolution for status
    expect(env.GROWTH_OS_WORKSPACE_ID).toBeUndefined();
  });

  it("first-run project step (--project-name) creates a project and writes the active pointer", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-project-step-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-step-home-"));
    let closed = false;
    const fakeDb = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("select id, name")) {
          return null;
        }
        return { id: String(params?.[0]), name: String(params?.[1]), createdAt: "t" };
      },
      async close() {
        closed = true;
      }
    };
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      const env = { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot, GROWTH_OS_HOME: growthHome };
      const result = await setupProjectStep(["--project-name", "Acme"], env, {
        createDb: () => fakeDb as never
      });
      expect(result).toMatchObject({ section: "project", status: "created", name: "Acme" });
      expect(readActiveProjectId(env as never)).toMatch(/^proj_/);
      expect(closed).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("first-run project step (interactive) prompts for a name when none is provided", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-project-prompt-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-prompt-home-"));
    const fakeDb = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("select id, name")) {
          return null;
        }
        return { id: String(params?.[0]), name: String(params?.[1]), createdAt: "t" };
      },
      async close() {}
    };
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      const env = { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot, GROWTH_OS_HOME: growthHome };
      const result = await setupProjectStep([], env, {
        prompt: true,
        promptName: async () => "Prompted Co",
        createDb: () => fakeDb as never
      });
      expect(result).toMatchObject({ section: "project", status: "created", name: "Prompted Co" });
      expect(readActiveProjectId(env as never)).toMatch(/^proj_/);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("reuses the active project when setup keeps the prompted project name", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-keep-home-"));
    const projects = new Map<string, { id: string; name: string; createdAt: string }>();
    const activeProject = { id: "proj_active", name: "Acme", createdAt: "t" };
    projects.set(activeProject.id, activeProject);
    projects.set(activeProject.name, activeProject);
    const fakeDb = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("select id, name")) {
          return (
            projects.get(String(params?.[0] ?? "")) ??
            projects.get(String(params?.[1] ?? "")) ??
            null
          );
        }
        throw new Error(`Unexpected SQL in keep-current-project test: ${sql}`);
      },
      async close() {}
    };
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeActiveProjectId(activeProject.id, env as never);

      const result = await setupProjectStep([], env, {
        interview: {
          projectName: activeProject.name,
          productSurface: "web",
          providerInventory: []
        },
        createDb: () => fakeDb as never
      });

      expect(result).toMatchObject({
        section: "project",
        status: "exists",
        activeProjectId: activeProject.id,
        name: activeProject.name
      });
      expect(readActiveProjectId(env as never)).toBe(activeProject.id);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("switches setup to an existing differently named project", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-switch-home-"));
    const projects = new Map<string, { id: string; name: string; createdAt: string }>();
    const activeProject = { id: "proj_active", name: "Acme", createdAt: "t" };
    const existingProject = { id: "proj_beta", name: "Beta", createdAt: "t" };
    for (const project of [activeProject, existingProject]) {
      projects.set(project.id, project);
      projects.set(project.name, project);
    }
    const fakeDb = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("select id, name")) {
          return (
            projects.get(String(params?.[0] ?? "")) ??
            projects.get(String(params?.[1] ?? "")) ??
            null
          );
        }
        throw new Error(`Unexpected SQL in switch-existing-project test: ${sql}`);
      },
      async close() {}
    };
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeActiveProjectId(activeProject.id, env as never);

      const result = await setupProjectStep([], env, {
        interview: {
          projectName: existingProject.name,
          productSurface: "web",
          providerInventory: []
        },
        createDb: () => fakeDb as never
      });

      expect(result).toMatchObject({
        section: "project",
        status: "selected",
        activeProjectId: existingProject.id,
        name: existingProject.name
      });
      expect(readActiveProjectId(env as never)).toBe(existingProject.id);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("creates and activates a newly named project during setup", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-project-create-new-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-create-new-home-"));
    const projects = new Map<string, { id: string; name: string; createdAt: string }>();
    const activeProject = { id: "proj_active", name: "Acme", createdAt: "t" };
    projects.set(activeProject.id, activeProject);
    projects.set(activeProject.name, activeProject);
    const fakeDb = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("select id, name")) {
          return (
            projects.get(String(params?.[0] ?? "")) ??
            projects.get(String(params?.[1] ?? "")) ??
            null
          );
        }
        if (sql.includes("insert into workspaces")) {
          const row = {
            id: String(params?.[0]),
            name: String(params?.[1]),
            createdAt: "t"
          };
          projects.set(row.id, row);
          projects.set(row.name, row);
          return row;
        }
        throw new Error(`Unexpected SQL in create-new-project test: ${sql}`);
      },
      async close() {}
    };
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      const env = { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot, GROWTH_OS_HOME: growthHome };
      writeActiveProjectId(activeProject.id, env as never);

      const result = await setupProjectStep([], env, {
        interview: {
          projectName: "Gamma",
          productSurface: "web",
          providerInventory: []
        },
        createDb: () => fakeDb as never
      });

      expect(result).toMatchObject({
        section: "project",
        status: "created",
        name: "Gamma"
      });
      expect(readActiveProjectId(env as never)).toMatch(/^proj_/);
      expect(readActiveProjectId(env as never)).not.toBe(activeProject.id);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds a setup interview from setup flags with normalized provider inventory", async () => {
    const interview = await runSetupInterview(
      [
        "--project-name",
        "Acme",
        "--website-url",
        "www.ACME.test/",
        "--providers",
        "ga4,posthog",
        "--ga4-account",
        "--ga4-installed",
        "installed",
        "--x-installed",
        "not_installed"
      ]
    );

    expect(interview).toEqual({
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: true, installState: "installed", selected: true, recommended: true },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "not_installed", selected: false, recommended: false }
      ]
    });
  });

  it("preserves deprecated setup flags via compatibility warnings instead of silently ignoring them", async () => {
    const warnings: string[] = [];

    const interview = await runSetupInterview(
      [
        "--project-name",
        "Acme",
        "--product-description",
        "AI bookkeeping software",
        "--product-surface",
        "mobile"
      ],
      { onWarning: (message) => warnings.push(message) }
    );

    expect(interview).toEqual({
      projectName: "Acme",
      productDescription: "AI bookkeeping software",
      websiteUrl: undefined,
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("--product-description is deprecated");
    expect(warnings[1]).toContain("--product-surface is deprecated");
    expect(warnings[1]).toContain("using web");
  });

  it("keeps explicit http URLs for common non-loopback development hosts", async () => {
    const interview = await runSetupInterview([
      "--project-name",
      "Acme",
      "--website-url",
      "http://app.local:3000/"
    ]);

    expect(interview?.websiteUrl).toBe("http://app.local:3000");
  });

  it("asks for project context and url before provider setup questions", async () => {
    const promptOrder: string[] = [];
    const promptTextSpy = vi.spyOn(setupPrompts, "promptText").mockImplementation(async (question, defaultValue = "") => {
      promptOrder.push(question);
      if (question === "What's your project name?") {
        return "Acme";
      }
      return defaultValue;
    });
    const promptChoiceSpy = vi.spyOn(setupPrompts, "promptChoice");
    const promptUrlSpy = vi.spyOn(setupPrompts, "promptUrl").mockImplementation(async (question) => {
      promptOrder.push(question);
      expect(question).toBe("What's your URL?");
      return "acme.test";
    });
    const promptProviderMatrixSpy = vi.spyOn(setupPrompts, "promptProviderMatrix").mockImplementation(async (rows) => {
      promptOrder.push("Which of these should we help you set up first?");
      expect(rows).toEqual([
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]);
      return rows;
    });

    try {
      const interview = await runSetupInterview([], { prompt: true });

      expect(promptOrder).toEqual([
        "What's your project name?",
        "What's your URL?",
        "Which of these should we help you set up first?"
      ]);
      expect(promptChoiceSpy).not.toHaveBeenCalled();
      expect(interview).toEqual({
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      });
    } finally {
      promptTextSpy.mockRestore();
      promptChoiceSpy.mockRestore();
      promptUrlSpy.mockRestore();
      promptProviderMatrixSpy.mockRestore();
    }
  });

  it("prompts for the project name before the url without prefilled active-project text", async () => {
    const promptOrder: string[] = [];

    const interview = await runSetupInterview([], {
      prompt: true,
      defaultProjectName: "Acme",
      promptProjectName: async (question, defaultValue = "") => {
        promptOrder.push(question);
        expect(question).toBe("What's your project name?");
        expect(defaultValue).toBe("");
        return "Acme";
      },
      promptWebsiteUrl: async (question) => {
        promptOrder.push(question);
        expect(question).toBe("What's your URL?");
        return "acme.test";
      },
      promptProviderInventory: async (rows) => {
        promptOrder.push("Which of these should we help you set up first?");
        return rows;
      }
    });

    expect(promptOrder).toEqual([
      "What's your project name?",
      "What's your URL?",
      "Which of these should we help you set up first?"
    ]);
    expect(interview).toEqual({
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    });
  });

  it("threads the setup interview through the project step result", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-project-interview-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-project-interview-home-"));
    const fakeDb = {
      async one(sql: string, params?: unknown[]) {
        if (sql.includes("select id, name")) {
          return null;
        }
        return { id: String(params?.[0]), name: String(params?.[1]), createdAt: "t" };
      },
      async close() {}
    };
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      const env = { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot, GROWTH_OS_HOME: growthHome };
      const interview = await runSetupInterview([], {
        prompt: true,
        promptProjectName: async () => "Prompted Co",
        promptWebsiteUrl: async () => "prompted.co",
        promptProviderInventory: async (rows) => rows.map((row) => ({ ...row, selected: row.provider !== "x" }))
      });

      const result = await setupProjectStep([], env, {
        prompt: true,
        interview,
        createDb: () => fakeDb as never
      });

      expect(result).toMatchObject({
        section: "project",
        status: "created",
        interview: {
          projectName: "Prompted Co",
          websiteUrl: "https://prompted.co",
          productSurface: "web",
          providerInventory: [
            expect.objectContaining({ provider: "ga4", selected: true }),
            expect.objectContaining({ provider: "posthog", selected: true }),
            expect.objectContaining({ provider: "x", selected: false })
          ]
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  // Drives the real setup wizard, whose setupProjectStep opens a pg pool against
  // the local dev Postgres — gate like the integration suites (ECONNREFUSED on CI).
  it.skipIf(!process.env.GROWTH_OS_INTEGRATION_DB)("runs analytics onboarding from the production setup wizard path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-onboarding-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-onboarding-home-"));
    const runSetupOnboarding = vi.fn<RunSetupOnboardingMock>(async ({ interview, workspaceId }: Parameters<RunSetupOnboardingMock>[0]) => ({
      ok: false,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview,
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4", "posthog"],
      completed: [],
      paused: ["ga4"],
      failed: [],
      providers: [
        {
          provider: "ga4" as const,
          selected: true,
          recommended: true,
          status: "paused_handoff" as const,
          runId: "run_ga4",
          handoff: {
            url: "https://accounts.google.com/",
            instructions: "Finish Google sign-in."
          }
        }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: "Run `infinite setup resume run_ga4` after completing the GA4 handoff."
    }));
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot, GROWTH_OS_HOME: growthHome });
      const result = await runSetupWizard(
        [
          "--provider",
          "codex",
          "--model",
          "gpt-5.4",
          "--auth",
          "none",
          "--project-name",
          "Acme",
          "--website-url",
          "acme.test",
          "--providers",
          "ga4"
        ],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_CLI_DRY_RUN: "1"
        },
        { runSetupOnboarding }
      );

      expect(runSetupOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: expect.stringMatching(/^proj_/),
          interview: expect.objectContaining({
            projectName: "Acme",
            websiteUrl: "https://acme.test",
            productSurface: "web"
          })
        })
      );
      expect(result).toMatchObject({
        section: "wizard",
        next: "Run `infinite setup resume run_ga4` after completing the GA4 handoff."
      });
      const rendered = renderCliResult(result);
      expect(rendered).toContain("GA4");
      expect(rendered).toContain("Run ID: run_ga4");
      expect(rendered).toContain("Resume: infinite setup resume run_ga4");
      expect(rendered).toContain("Action required: Finish Google sign-in.");
      expect(rendered).toContain("Open this page: https://accounts.google.com/");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  // Drives the real setup wizard, whose setupProjectStep opens a pg pool against
  // the local dev Postgres — gate like the integration suites (ECONNREFUSED on CI).
  it.skipIf(!process.env.GROWTH_OS_INTEGRATION_DB)("default setup with an active project skips the legacy reconfigure chooser and proceeds into onboarding", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-active-project-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-active-project-home-"));
    const originalStdinIsTty = process.stdin.isTTY;
    const promptQuestions: string[] = [];
    const promptTextQuestions: string[] = [];
    const projectNameDefaults: string[] = [];
    const runSetupRuntimeSection = vi.fn(async () => {
      throw new Error("runtime reconfigure should not run");
    });
    const runSetupOnboarding = vi.fn<RunSetupOnboardingMock>(async ({ interview, workspaceId }: Parameters<RunSetupOnboardingMock>[0]) => ({
      ok: true,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview,
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4", "posthog"],
      completed: ["ga4"],
      paused: [],
      failed: [],
      providers: [
        {
          provider: "ga4" as const,
          selected: true,
          recommended: true,
          status: "completed" as const
        }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: "Run `infinite` to continue."
    }));
    const promptChoiceSpy = vi.spyOn(setupPrompts, "promptChoice").mockImplementation(async (question, choices) => {
      promptQuestions.push(question);
      if (question === "How would you like to configure Infinite?") {
        throw new Error("legacy reconfigure chooser should not run");
      }
      if (question === "Runtime configuration") return 0;
      if (question === "Select provider:") return 0;
      if (question === "Select default model:") return 0;
      if (question === "Select auth mode:") return choices.indexOf("none");
      throw new Error(`Unexpected promptChoice question in test: ${question}`);
    });
    const promptTextSpy = vi.spyOn(setupPrompts, "promptText").mockImplementation(async (question, defaultValue = "") => {
      promptTextQuestions.push(question);
      if (question === "What's your project name?") {
        projectNameDefaults.push(defaultValue);
        return "New Project";
      }
      return defaultValue;
    });
    const promptUrlSpy = vi.spyOn(setupPrompts, "promptUrl").mockImplementation(async (question) => {
      expect(question).toBe("What's your URL?");
      return "acme.test";
    });
    const promptProviderMatrixSpy = vi.spyOn(setupPrompts, "promptProviderMatrix").mockImplementation(async (rows) =>
      rows.map((row, index) => ({ ...row, selected: index === 0 }))
    );
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });
      writeActiveProjectId("Acme", { GROWTH_OS_HOME: growthHome } as never);

      const result = await runSetupWizard(
        [],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ID: "Acme",
          GROWTH_OS_CLI_DRY_RUN: "1"
        },
        {
          runSetupOnboarding,
          runSetupRuntimeSection
        }
      );

      expect(runSetupOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "Acme",
          interview: expect.objectContaining({
            projectName: "New Project",
            websiteUrl: "https://acme.test",
            productSurface: "web"
          })
        })
      );
      expect(runSetupRuntimeSection).not.toHaveBeenCalled();
      expect(promptQuestions).not.toContain("How would you like to configure Infinite?");
      expect(promptQuestions).not.toContain("What are you instrumenting first?");
      expect(promptQuestions).not.toContain("Runtime configuration");
      expect(promptTextQuestions).toEqual(["What's your project name?"]);
      expect(projectNameDefaults).toEqual([""]);
      expect(result).toMatchObject({ section: "wizard" });
      expect(renderCliResult(result)).toContain("Using existing setup");
      expect(renderCliResult(result)).not.toContain("Reconfigure (full)");
      expect(promptChoiceSpy).toHaveBeenCalled();
      expect(promptUrlSpy).toHaveBeenCalled();
      expect(promptProviderMatrixSpy).toHaveBeenCalled();
    } finally {
      promptChoiceSpy.mockRestore();
      promptTextSpy.mockRestore();
      promptUrlSpy.mockRestore();
      promptProviderMatrixSpy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTty });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("default setup reuses existing runtime while explicit reconfigure still routes through runtime setup", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-runtime-routing-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-runtime-routing-home-"));
    const originalStdinIsTty = process.stdin.isTTY;
    const runSetupRuntimeSection = vi.fn(async (runtimeArgs: string[]) => ({
      ok: true,
      section: "runtime" as const,
      runtime: {
        mode: "local_docker",
        configPath: "/workspace/.growth-os/config.yml",
        envPath: "/workspace/.growth-os/.env",
        databaseUrl: "postgres://growth:[redacted]@127.0.0.1:5432/growth",
        migrations: { ok: true, skipped: true, mode: "compose_managed" },
        start: { ok: true, skipped: runtimeArgs.includes("--no-start") }
      }
    }));
    const runSetupOnboarding = vi.fn<RunSetupOnboardingMock>(async ({ interview, workspaceId }: Parameters<RunSetupOnboardingMock>[0]) => ({
      ok: true,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview,
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4"],
      completed: ["ga4"],
      paused: [],
      failed: [],
      providers: [
        {
          provider: "ga4" as const,
          selected: true,
          recommended: true,
          status: "completed" as const
        }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: `Run \`infinite\` to continue in ${workspaceId}.`
    }));
    const promptChoiceSpy = vi.spyOn(setupPrompts, "promptChoice").mockImplementation(async (question, choices) => {
      if (question === "Select provider:") return 0;
      if (question === "Select default model:") return 0;
      if (question === "Select auth mode:") return choices.indexOf("none");
      throw new Error(`Unexpected promptChoice question in test: ${question}`);
    });
    const promptTextSpy = vi.spyOn(setupPrompts, "promptText").mockImplementation(async (_question, defaultValue = "") => defaultValue);
    const promptUrlSpy = vi.spyOn(setupPrompts, "promptUrl").mockImplementation(async () => "acme.test");
    const promptProviderMatrixSpy = vi.spyOn(setupPrompts, "promptProviderMatrix").mockImplementation(async (rows) =>
      rows.map((row, index) => ({ ...row, selected: index === 0 }))
    );
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });
      writeActiveProjectId("proj_runtime", { GROWTH_OS_HOME: growthHome } as never);

      const reuseResult = await runSetupWizard(
        [],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ID: "proj_runtime",
          GROWTH_OS_CLI_DRY_RUN: "1"
        },
        {
          runSetupOnboarding,
          runSetupRuntimeSection
        }
      );

      expect(runSetupRuntimeSection).not.toHaveBeenCalled();
      expect(renderCliResult(reuseResult)).toContain("Using existing setup");

      await runSetupWizard(
        ["--reconfigure", "--provider=codex", "--model", "gpt-5.4", "--auth", "none", "--no-start"],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_WORKSPACE_ID: "proj_runtime",
          GROWTH_OS_CLI_DRY_RUN: "1"
        },
        {
          runSetupOnboarding,
          runSetupRuntimeSection
        }
      );

      expect(runSetupRuntimeSection).toHaveBeenCalledTimes(1);
      expect(runSetupRuntimeSection).toHaveBeenCalledWith(["--mode", "local_docker", "--no-start"], expect.any(Object));
    } finally {
      promptChoiceSpy.mockRestore();
      promptTextSpy.mockRestore();
      promptUrlSpy.mockRestore();
      promptProviderMatrixSpy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTty });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("default setup with no active project asks for project context before any legacy reconfigure chooser", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-project-first-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-project-first-home-"));
    const originalStdinIsTty = process.stdin.isTTY;
    const sentinel = new Error("__project_context_prompt_reached__");
    const promptQuestions: string[] = [];
    const promptChoiceSpy = vi.spyOn(setupPrompts, "promptChoice").mockImplementation(async (question) => {
      promptQuestions.push(question);
      if (question === "How would you like to configure Infinite?") {
        throw new Error("legacy reconfigure chooser should not run");
      }
      if (question === "Which project should Infinite set up?") {
        throw sentinel;
      }
      throw new Error(`Unexpected promptChoice question before project prompt: ${question}`);
    });
    const promptTextSpy = vi.spyOn(setupPrompts, "promptText").mockImplementation(async (question) => {
      if (question === "What's your project name?") {
        throw sentinel;
      }
      throw new Error(`Unexpected promptText question before project prompt: ${question}`);
    });
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      await runCommand("init", [], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });

      await expect(
        runSetupWizard([], {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_CLI_DRY_RUN: "1"
        })
      ).rejects.toBe(sentinel);

      expect(promptQuestions).not.toContain("How would you like to configure Infinite?");
    } finally {
      promptChoiceSpy.mockRestore();
      promptTextSpy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTty });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("does not auto-resume a paused active setup run before asking for project context", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-home-"));
    const originalStdinIsTty = process.stdin.isTTY;
    const sentinel = new Error("__project_context_prompt_reached__");
    const resumeSetupRun = vi.fn<ResumeSetupRunMock>(async () => ({
      ok: false,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "installed", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: true }
        ]
      },
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4"],
      completed: [],
      paused: ["ga4"],
      failed: [],
      providers: [
        { provider: "ga4" as const, selected: true, recommended: true, status: "paused_handoff" as const, runId: "run_active" }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: "Run `infinite setup resume run_active` after completing the GA4 handoff."
    }));
    const promptTextSpy = vi.spyOn(setupPrompts, "promptText").mockImplementation(async (question, defaultValue = "") => {
      if (question === "What's your project name?") {
        expect(defaultValue).toBe("");
        throw sentinel;
      }
      throw new Error(`Unexpected promptText question before project prompt: ${question}`);
    });

    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      const env = {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ID: "proj_resume"
      };
      writeActiveProjectId("proj_resume", env as never);

      await expect(
        runSetupWizard(
          [],
          env,
          {
            activeSetupRun: {
              id: "run_active",
              provider: "ga4",
              tool: "ga4",
              status: "paused_handoff"
            },
            resumeSetupRun
          },
        )
      ).rejects.toBe(sentinel);

      expect(resumeSetupRun).not.toHaveBeenCalled();
    } finally {
      promptTextSpy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTty });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("does not auto-resume a running active setup run without resumable onboarding state", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-running-no-resume-"));
    const resumeSetupRun = vi.fn<ResumeSetupRunMock>(async () => ({
      ok: true,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: []
      },
      selectedProviders: [],
      recommendedProviders: [],
      completed: [],
      paused: [],
      failed: [],
      providers: [],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: "Run `infinite` to continue."
    }));
    const sentinel = new Error("__runtime_section_reached__");
    const runSetupRuntimeSection = vi.fn(async () => {
      throw sentinel;
    });

    try {
      await expect(
        runSetupWizard(
          [],
          {
            GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
            GROWTH_OS_WORKSPACE_ID: "proj_running"
          },
          {
            activeSetupRun: {
              id: "run_running",
              provider: "ga4",
              tool: "ga4",
              status: "running"
            },
            resumeSetupRun,
            runSetupRuntimeSection
          }
        )
      ).rejects.toBe(sentinel);

      expect(resumeSetupRun).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("routes `setup resume <runId>` through the production resume path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-command-"));
    const resumeSetupRun = vi.fn<ResumeSetupRunMock>(async ({ runId }: Parameters<ResumeSetupRunMock>[0]) => ({
      ok: false,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "installed", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: true }
        ]
      },
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4", "posthog"],
      completed: [],
      paused: ["ga4"],
      failed: [],
      providers: [
        {
          provider: "ga4" as const,
          selected: true,
          recommended: true,
          status: "paused_handoff" as const,
          runId,
          handoff: {
            url: "https://accounts.google.com/",
            instructions: "Finish Google sign-in."
          }
        }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: `Run \`infinite setup resume ${runId}\` after completing the GA4 handoff.`
    }));

    try {
      const result = await runSetupWizard(
        ["resume", "run_resume"],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_WORKSPACE_ID: "proj_resume_explicit"
        },
        { resumeSetupRun }
      );

      expect(resumeSetupRun).toHaveBeenCalledWith({
        runId: "run_resume",
        env: expect.objectContaining({ GROWTH_OS_WORKSPACE_ID: "proj_resume_explicit" }),
        workspaceId: "proj_resume_explicit"
      });
      expect(result).toMatchObject({
        workflow: "onboarding",
        next: "Run `infinite setup resume run_resume` after completing the GA4 handoff."
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes a supplied PostHog resume key and API host through setup resume without rendering the secret", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-posthog-key-"));
    const posthogPersonalApiKey = "phx_personal_key";
    const resumeSetupRun = vi.fn<ResumeSetupRunMock>(async ({ runId }: Parameters<ResumeSetupRunMock>[0]) => ({
      ok: true,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      selectedProviders: ["posthog"],
      recommendedProviders: ["posthog"],
      completed: ["posthog"],
      paused: [],
      failed: [],
      providers: [],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: { projectId: "project_1", projectKey: "phc_project_1" },
        x: {}
      },
      next: `Run \`infinite setup resume ${runId}\` after completing the POSTHOG handoff.`
    }));

    try {
      const result = await runSetupWizard(
        [
          "resume",
          "run_posthog",
          "--personal-api-key",
          posthogPersonalApiKey,
          "--posthog-api-host",
          "https://eu.posthog.com"
        ],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_WORKSPACE_ID: "proj_resume_posthog"
        },
        { resumeSetupRun }
      );

      expect(resumeSetupRun).toHaveBeenCalledWith({
        runId: "run_posthog",
        env: expect.objectContaining({ GROWTH_OS_WORKSPACE_ID: "proj_resume_posthog" }),
        workspaceId: "proj_resume_posthog",
        posthogPersonalApiKey,
        posthogApiHost: "https://eu.posthog.com"
      });
      expect(renderCliResult(result)).not.toContain(posthogPersonalApiKey);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("loads a supplied PostHog resume key from a local file without rendering the secret or path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-posthog-key-file-"));
    const posthogPersonalApiKey = "phx_personal_key_from_file";
    const posthogPersonalApiKeyPath = join(workspaceRoot, "posthog-personal-api-key.txt");
    writeFileSync(posthogPersonalApiKeyPath, `${posthogPersonalApiKey}\n`);
    const resumeSetupRun = vi.fn<ResumeSetupRunMock>(async ({ runId }: Parameters<ResumeSetupRunMock>[0]) => ({
      ok: true,
      section: "connectors" as const,
      workflow: "onboarding" as const,
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "posthog", hasAccount: true, installState: "unknown", selected: true, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      selectedProviders: ["posthog"],
      recommendedProviders: ["posthog"],
      completed: ["posthog"],
      paused: [],
      failed: [],
      providers: [],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: { projectId: "project_1", projectKey: "phc_project_1" },
        x: {}
      },
      next: `Run \`infinite setup resume ${runId}\` after completing the POSTHOG handoff.`
    }));

    try {
      const result = await runSetupWizard(
        [
          "resume",
          "run_posthog",
          "--posthog-personal-api-key-file",
          posthogPersonalApiKeyPath,
          "--posthog-api-host",
          "https://eu.posthog.com"
        ],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_WORKSPACE_ID: "proj_resume_posthog"
        },
        { resumeSetupRun }
      );

      expect(resumeSetupRun).toHaveBeenCalledWith({
        runId: "run_posthog",
        env: expect.objectContaining({ GROWTH_OS_WORKSPACE_ID: "proj_resume_posthog" }),
        workspaceId: "proj_resume_posthog",
        posthogPersonalApiKey,
        posthogApiHost: "https://eu.posthog.com"
      });
      const rendered = renderCliResult(result);
      expect(rendered).not.toContain(posthogPersonalApiKey);
      expect(rendered).not.toContain(posthogPersonalApiKeyPath);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("prompts for a PostHog API host choice on the API-key handoff and defaults stale US handoff URLs to EU", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-posthog-host-"));
    const readRunSummary = vi.fn(async () => ({
      id: "run_posthog",
      provider: "posthog",
      status: "paused_handoff",
      pendingHandoff: {
        url: "https://us.posthog.com/settings/user-api-keys",
        instructions: "Create a PostHog personal API key."
      }
    }));
    const promptChoiceSpy = vi.spyOn(setupPrompts, "promptChoice").mockImplementation(async (_question, choices) => {
      const euIndex = choices.findIndex((choice) => choice.toLowerCase().includes("eu"));
      return euIndex === -1 ? 0 : euIndex;
    });
    const promptTextSpy = vi.spyOn(setupPrompts, "promptText").mockResolvedValue("https://custom.posthog.test");
    const promptSecretSpy = vi.fn(async () => "phx_prompted");
    try {
      const secrets = await resolveSetupResumePostHogResumeSecrets(
        ["resume", "run_posthog"],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_WORKSPACE_ID: "proj_resume_prompt"
        },
        "proj_resume_prompt",
        {
          interactive: true,
          readRunSummary,
          promptSecret: promptSecretSpy
        }
      );

      expect(secrets).toEqual({
        personalApiKey: "phx_prompted",
        apiHost: "https://eu.posthog.com"
      });
      expect(readRunSummary).toHaveBeenCalledWith("run_posthog");
      expect(promptSecretSpy).toHaveBeenCalledWith("Paste PostHog personal API key (starts with phx_; stored encrypted): ");
      expect(promptChoiceSpy).toHaveBeenCalledTimes(1);
      const [question, choices, defaultIndex] = promptChoiceSpy.mock.calls[0] ?? [];
      expect(String(question)).toContain("PostHog");
      expect(defaultIndex).toBe(0);
      expect(choices).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/us/i),
          expect.stringMatching(/eu/i),
          expect.stringMatching(/custom/i)
        ])
      );
      expect(promptTextSpy).not.toHaveBeenCalled();
    } finally {
      promptChoiceSpy.mockRestore();
      promptTextSpy.mockRestore();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("prompts for a PostHog personal API key only when the paused resume run is on the API-key handoff", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-posthog-prompt-"));
    const promptSecret = vi.fn(async () => "phx_prompted");
    const readRunSummary = vi.fn(async () => ({
      id: "run_posthog",
      provider: "posthog",
      status: "paused_handoff",
      pendingHandoff: {
        url: "https://us.posthog.com/settings/user-api-keys",
        instructions: "Create a PostHog personal API key."
      }
    }));

    try {
      const secret = await resolveSetupResumePostHogPersonalApiKey(
        ["resume", "run_posthog"],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_WORKSPACE_ID: "proj_resume_prompt"
        },
        "proj_resume_prompt",
        {
          interactive: true,
          readRunSummary,
          promptSecret
        }
      );

      expect(secret).toBe("phx_prompted");
      expect(readRunSummary).toHaveBeenCalledWith("run_posthog");
      expect(promptSecret).toHaveBeenCalledWith("Paste PostHog personal API key (starts with phx_; stored encrypted): ");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reads a PostHog personal API key from a local file before prompting", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-posthog-secret-file-"));
    const secretFilePath = join(workspaceRoot, "posthog-personal-api-key.txt");
    writeFileSync(secretFilePath, "phx_from_file\n");
    const promptSecret = vi.fn(async () => "phx_prompted");

    try {
      const secret = await resolveSetupResumePostHogPersonalApiKey(
        ["resume", "run_posthog", "--posthog-personal-api-key-file", secretFilePath],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_WORKSPACE_ID: "proj_resume_prompt"
        },
        "proj_resume_prompt",
        {
          interactive: true,
          promptSecret
        }
      );

      expect(secret).toBe("phx_from_file");
      expect(promptSecret).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-local PostHog personal API key file paths for setup resume", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-resume-posthog-secret-file-url-"));

    try {
      await expect(
        resolveSetupResumePostHogResumeSecrets(
          [
            "resume",
            "run_posthog",
            "--posthog-personal-api-key-file",
            "file:///tmp/posthog-personal-api-key"
          ],
          {
            GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
            GROWTH_OS_WORKSPACE_ID: "proj_resume_prompt"
          },
          "proj_resume_prompt",
          {
            interactive: false
          }
        )
      ).rejects.toThrow("PostHog personal API key file must be a local filesystem path.");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders onboarding handoffs with the provider, run id, url, and exact resume command", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "connectors",
      workflow: "onboarding",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "installed", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: true },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: true }
        ]
      },
      selectedProviders: ["ga4", "posthog"],
      recommendedProviders: ["ga4", "posthog"],
      completed: [],
      paused: ["ga4", "posthog"],
      failed: [],
      providers: [
        {
          provider: "ga4" as const,
          selected: true,
          recommended: true,
          status: "paused_handoff" as const,
          runId: "run_ga4",
          detail: "Detected a Google Analytics account but no property yet.",
          handoff: {
            url: "https://accounts.google.com/",
            instructions: "Finish Google sign-in."
          }
        },
        {
          provider: "posthog" as const,
          selected: true,
          recommended: true,
          status: "paused_handoff" as const,
          runId: "run_posthog",
          detail: "Create a PostHog personal API key.",
          handoff: {
            url: "https://us.posthog.com/settings/user-api-keys",
            instructions: "Log in to PostHog, create a scoped personal API key, then resume setup."
          }
        }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: "Run `infinite setup resume run_ga4` after completing the GA4 handoff."
    });

    expect(rendered).toContain("Infinite analytics onboarding");
    expect(rendered).toContain("GA4");
    expect(rendered).toContain("Run ID: run_ga4");
    expect(rendered).toContain("Resume: infinite setup resume run_ga4");
    expect(rendered).toContain("Action required: Finish Google sign-in.");
    expect(rendered).toContain("Open this page: https://accounts.google.com/");
    expect(rendered).toContain("Finish Google sign-in.");
    expect(rendered).toContain("PostHog");
    expect(rendered).toContain("Run ID: run_posthog");
    expect(rendered).toContain("Resume: infinite setup resume run_posthog");
    expect(rendered).toContain("Action required: Log in to PostHog, create a scoped personal API key, then resume setup.");
    expect(rendered).toContain("Open this page: https://us.posthog.com/settings/user-api-keys");
  });

  it("prints the complete infinite-tag install command as the final onboarding instruction", () => {
    const rendered = renderCliResult({
      ok: true,
      section: "connectors",
      workflow: "onboarding",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true }
        ]
      },
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4"],
      completed: ["ga4"],
      paused: [],
      failed: [],
      providers: [{ provider: "ga4" as const, selected: true, recommended: true, status: "completed" as const }],
      resolvedPublicArtifacts: {
        ga4: { measurementId: "G-ACME123", propertyId: "properties/123" },
        posthog: {},
        x: {}
      },
      installCommand: "npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes",
      installArtifactsPath: `${homedir()}/.infinite/artifacts/proj_1.json`,
      next: "Run `infinite setup query` or `infinite` to continue."
    });

    expect(rendered).toContain("Install your analytics tags — run this inside your website's code repo:");
    expect(rendered).toContain("npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes");
    expect(rendered).toContain(
      "(on this machine you can simply run: npx infinite-tag install — Infinite saved your public keys to ~/.infinite/artifacts/proj_1.json)"
    );
  });

  it("omits the same-machine hint when the artifacts handoff file was not written", () => {
    const rendered = renderCliResult({
      ok: true,
      section: "connectors",
      workflow: "onboarding",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true }
        ]
      },
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4"],
      completed: ["ga4"],
      paused: [],
      failed: [],
      providers: [{ provider: "ga4" as const, selected: true, recommended: true, status: "completed" as const }],
      resolvedPublicArtifacts: {
        ga4: { measurementId: "G-ACME123", propertyId: "properties/123" },
        posthog: {},
        x: {}
      },
      installCommand: "npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes",
      installArtifactsPath: null,
      next: "Run `infinite setup query` or `infinite` to continue."
    });

    expect(rendered).toContain("npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes");
    expect(rendered).not.toContain("on this machine you can simply run");
  });

  it("omits the install-command section when nothing installable was captured", () => {
    const rendered = renderCliResult({
      ok: true,
      section: "connectors",
      workflow: "onboarding",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true }
        ]
      },
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4"],
      completed: ["ga4"],
      paused: [],
      failed: [],
      providers: [{ provider: "ga4" as const, selected: true, recommended: true, status: "completed" as const }],
      resolvedPublicArtifacts: { ga4: {}, posthog: {}, x: {} },
      installCommand: null,
      next: "Run `infinite setup query` or `infinite` to continue."
    });

    expect(rendered).not.toContain("Install your analytics tags");
    expect(rendered).not.toContain("npx infinite-tag install");
  });

  it("carries the setup module's installCommand through to the onboarding result for --json consumers", () => {
    const result = buildSetupOnboardingResult(
      {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "unknown", selected: true, recommended: true }
        ]
      },
      {
        selectedProviders: ["ga4"],
        recommendedProviders: ["ga4"],
        completed: ["ga4"],
        paused: [],
        failed: [],
        runs: { ga4: { phases: {}, providerState: {} } },
        activeRuns: [],
        resolvedPublicArtifacts: { ga4: { measurementId: "G-ACME123" }, posthog: {}, x: {} },
        installCommand: "npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes",
        installArtifactsPath: "/founder-home/.infinite/artifacts/proj_1.json"
      }
    );

    expect(result.installCommand).toBe(
      "npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes"
    );
    expect(result.installArtifactsPath).toBe("/founder-home/.infinite/artifacts/proj_1.json");
    // `infinite setup --json` serializes this whole object — the command must ride along as data.
    expect(JSON.parse(JSON.stringify(result)).installCommand).toBe(
      "npx infinite-tag install --workspace proj_1 --ga4-measurement-id G-ACME123 --yes"
    );
    expect(JSON.parse(JSON.stringify(result)).installArtifactsPath).toBe(
      "/founder-home/.infinite/artifacts/proj_1.json"
    );
  });

  it("redacts OAuth query strings and fragments from onboarding handoff summaries", () => {
    const rendered = renderCliResult({
      ok: false,
      section: "connectors",
      workflow: "onboarding",
      interview: {
        projectName: "Acme",
        websiteUrl: "https://acme.test",
        productSurface: "web",
        providerInventory: [
          { provider: "ga4", hasAccount: true, installState: "installed", selected: true, recommended: true },
          { provider: "posthog", hasAccount: false, installState: "unknown", selected: false, recommended: false },
          { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
        ]
      },
      selectedProviders: ["ga4"],
      recommendedProviders: ["ga4"],
      completed: [],
      paused: ["ga4"],
      failed: [],
      providers: [
        {
          provider: "ga4" as const,
          selected: true,
          recommended: true,
          status: "paused_handoff" as const,
          runId: "run_ga4",
          detail: "Finish Google sign-in.",
          handoff: {
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ga-client-id&state=secret-state#keep-me-out",
            instructions: "Finish Google sign-in."
          }
        }
      ],
      resolvedPublicArtifacts: {
        ga4: {},
        posthog: {},
        x: {}
      },
      next: "Run `infinite setup resume run_ga4` after completing the GA4 handoff."
    });

    expect(rendered).toContain("Open this page: https://accounts.google.com/o/oauth2/v2/auth");
    expect(rendered).not.toContain("client_id=ga-client-id");
    expect(rendered).not.toContain("secret-state");
    expect(rendered).not.toContain("keep-me-out");
  });

  it("shows connector setup options and starts GA4 OAuth from the setup connector section", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-connectors-"));
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { sources: [] } }), { status: 200 });
      }) as typeof fetch;

      const checklist = await runCommand("setup", ["connectors"], {
        DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
      });
      const oauth = await runCommand(
        "setup",
        ["connectors", "google_analytics_4", "--client-id", "ga-client-id"],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot
        }
      );

      expect(checklist).toMatchObject({
        ok: false,
        section: "connectors"
      });
      expect((checklist as { providers: unknown[] }).providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "google_analytics_4",
            setup: "infinite setup connectors google_analytics_4 --client-id <google_oauth_client_id>"
          }),
          expect.objectContaining({
            provider: "shopify",
            setup: "infinite setup connectors shopify"
          }),
          expect.objectContaining({
            provider: "meta_ads",
            setup: "infinite setup connectors meta_ads"
          })
        ])
      );
      expect(renderCliResult(checklist)).toContain("Infinite connector setup");
      expect(renderCliResult(checklist)).toContain("Needs Google authorization for sync/query");
      expect(oauth).toMatchObject({ ok: true });
      expect(requests.at(-1)).toMatchObject({
        url: "http://127.0.0.1:3000/oauth/sessions",
        body: {
          provider: "google_analytics_4",
          clientId: "ga-client-id"
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("can complete GA4 setup inside the connector section when property id is provided", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-connectors-ga4-complete-"));
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        if (String(url).endsWith("/oauth/sessions")) {
          return new Response(JSON.stringify({ ok: true, sessionId: "oauth_session_1" }), { status: 200 });
        }
        if (String(url).endsWith("/oauth/sessions/oauth_session_1/exchange")) {
          return new Response(JSON.stringify({ ok: true, status: "connected" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "google_analytics_4",
          "--client-id",
          "ga-client-id",
          "--property-id",
          "properties/123",
          "--connection-name",
          "GA4 Website"
        ],
        {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_OPERATOR_TOKEN: "operator-token"
        }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "google_analytics_4",
        connectionName: "GA4 Website",
        status: "connected"
      });
      expect(requests).toEqual([
        {
          url: "http://127.0.0.1:3000/oauth/sessions",
          body: {
            provider: "google_analytics_4",
            clientId: "ga-client-id"
          }
        },
        {
          url: "http://127.0.0.1:3000/oauth/sessions/oauth_session_1/exchange",
          body: {
            propertyId: "properties/123",
            connectionName: "GA4 Website"
          }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("prepareConfig returns embedded client without prompting when GROWTH_OS_GA4_OAUTH_CLIENT_ID+SECRET are set", async () => {
    const bootstrap = createLocalGa4OauthBootstrap({
      env: {
        GROWTH_OS_GA4_OAUTH_CLIENT_ID: "embedded-id",
        GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "embedded-secret"
      },
      config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
    });
    const config = await bootstrap.prepareConfig();
    expect(config).toMatchObject({ clientId: "embedded-id", clientSecret: "embedded-secret" });
    expect(typeof config?.redirectUri).toBe("string");
  });

  it("prepareConfig returns null (self-hoster prompt path) when no embedded GA4 client is available", async () => {
    // Non-TTY + no env vars + no release file → prepareConfig returns null.
    // readReleaseConfig is injected so the test never reads the real machine file
    // (~/.infinite/app/ga4-oauth-client.json), which would otherwise leak real creds.
    const bootstrap = createLocalGa4OauthBootstrap({
      env: { GROWTH_OS_CLI_NONINTERACTIVE: "1" },
      readReleaseConfig: () => null,
      config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
    });
    const config = await bootstrap.prepareConfig();
    expect(config).toBeNull();
  });

  it("returns the embedded client even when non-interactive (headless/agent path)", async () => {
    // Guards against a future refactor that checks NONINTERACTIVE before the
    // embedded-client resolve — the embedded path must fire first.
    const bootstrap = createLocalGa4OauthBootstrap({
      env: {
        GROWTH_OS_GA4_OAUTH_CLIENT_ID: "embedded-id",
        GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "embedded-secret",
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      },
      config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
    });
    const config = await bootstrap.prepareConfig();
    expect(config).toMatchObject({ clientId: "embedded-id", clientSecret: "embedded-secret" });
  });

  it("prepareConfig never shows the connect chooser in --json mode, even on a TTY", async () => {
    // `infinite setup --json` with an embedded client must use it silently
    // (pre-chooser behavior): no prompt, no picker UI on stdout.
    // isTTY can be read-only on the worker's stdin Socket — stub via defineProperty.
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      const bootstrap = createLocalGa4OauthBootstrap({
        env: {},
        jsonMode: true,
        readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" }),
        config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
      });
      const config = await bootstrap.prepareConfig();
      expect(config).toMatchObject({ clientId: "rel-id", clientSecret: "rel-secret" });
      expect(writes.join("")).not.toContain("How do you want to connect Google Analytics?");
    } finally {
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      writeSpy.mockRestore();
    }
  });

  it("prepareConfig emits unverified-app disclosure when embedded client is present", async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const bootstrap = createLocalGa4OauthBootstrap({
        env: {
          GROWTH_OS_GA4_OAUTH_CLIENT_ID: "embedded-id",
          GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "embedded-secret"
        },
        config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
      });
      await bootstrap.prepareConfig();
      const combined = writes.join("");
      expect(combined).toContain("Advanced");
      expect(combined).toContain("hasn't verified");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("prepareConfig disclosure includes Infinite app name and sign-in language", async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const bootstrap = createLocalGa4OauthBootstrap({
        env: {
          GROWTH_OS_GA4_OAUTH_CLIENT_ID: "embedded-id",
          GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "embedded-secret"
        },
        config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
      });
      await bootstrap.prepareConfig();
      const combined = writes.join("");
      expect(combined).toContain("Infinite");
      expect(combined).toContain("sign in with Google");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("start() always prints the pasteable authorization URL, even when the browser opened (#7)", async () => {
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const originalFetch = globalThis.fetch;
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      // A TTY + a browser opener that exits 0 makes openBrowserForAuth report opened:true.
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            sessionId: "oauth_session_1",
            provider: "google_analytics_4",
            status: "pending",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=paste-me",
            redirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4"
          }),
          { status: 200 }
        )) as typeof fetch;

      const bootstrap = createLocalGa4OauthBootstrap({
        env: { GROWTH_OS_AUTH_BROWSER_BIN: "true" },
        config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
      });
      await bootstrap.start({ clientId: "id", clientSecret: "secret" });

      const combined = writes.join("");
      // The URL is surfaced AND the "Opened Google" success copy is present (opened:true path).
      expect(combined).toContain("Opened Google in your browser");
      expect(combined).toContain("Paste this link:");
      expect(combined).toContain("https://accounts.google.com/o/oauth2/v2/auth?state=paste-me");
    } finally {
      globalThis.fetch = originalFetch;
      writeSpy.mockRestore();
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("start() writes nothing to stdout in --json mode (keeps the JSON payload clean) (#7)", async () => {
    const originalFetch = globalThis.fetch;
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            sessionId: "oauth_session_1",
            provider: "google_analytics_4",
            status: "pending",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=json"
          }),
          { status: 200 }
        )) as typeof fetch;

      const bootstrap = createLocalGa4OauthBootstrap({
        env: {},
        jsonMode: true,
        config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"]
      });
      await bootstrap.start({ clientId: "id", clientSecret: "secret" });

      expect(writes.join("")).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
      writeSpy.mockRestore();
    }
  });

  it("start() uses the injected guidance renderer for the open-site block (#8 composes with #7)", async () => {
    const originalFetch = globalThis.fetch;
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const writes: string[] = [];
    const guidance = vi.fn(
      (step: string, ctx: { authorizationUrl?: string }) =>
        `GUIDANCE[${step}]: open ${ctx.authorizationUrl}`
    );
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            sessionId: "oauth_session_1",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=guide"
          }),
          { status: 200 }
        )) as typeof fetch;

      const bootstrap = createLocalGa4OauthBootstrap({
        env: { GROWTH_OS_AUTH_BROWSER_BIN: "true" },
        config: {} as Parameters<typeof createLocalGa4OauthBootstrap>[0]["config"],
        guidance: guidance as never
      });
      await bootstrap.start({ clientId: "id", clientSecret: "secret" });

      expect(guidance).toHaveBeenCalledWith(
        "quick_connect",
        expect.objectContaining({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=guide" })
      );
      expect(writes.join("")).toContain("GUIDANCE[quick_connect]");
    } finally {
      globalThis.fetch = originalFetch;
      writeSpy.mockRestore();
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  describe("createSetupInteractionWiring predicate (#7/#8 non-interactive safety)", () => {
    const fakeSetup = {
      providerGuidance: () => "guidance"
    } as unknown as Parameters<typeof createSetupInteractionWiring>[0]["setup"];

    function withTTY<T>(value: boolean | undefined, fn: () => T): T {
      const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      if (value === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
      }
      try {
        return fn();
      } finally {
        if (descriptor) {
          Object.defineProperty(process.stdin, "isTTY", descriptor);
        } else {
          delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
      }
    }

    it("installs NO interaction/gate/onProviderStart on a non-TTY (headless) run", () => {
      const wiring = withTTY(false, () =>
        createSetupInteractionWiring({ env: {}, setup: fakeSetup })
      );
      expect(wiring.ga4OauthInteraction).toBeUndefined();
      expect(wiring.awaitProviderHandoff).toBeUndefined();
      expect(wiring.onProviderStart).toBeUndefined();
      // dispose() is always safe to call.
      expect(() => wiring.dispose()).not.toThrow();
    });

    it("installs NO interaction/gate in --json mode even on a TTY", () => {
      const wiring = withTTY(true, () =>
        createSetupInteractionWiring({ env: {}, jsonMode: true, setup: fakeSetup })
      );
      expect(wiring.ga4OauthInteraction).toBeUndefined();
      expect(wiring.awaitProviderHandoff).toBeUndefined();
      expect(wiring.onProviderStart).toBeUndefined();
    });

    it("installs NO interaction/gate when GROWTH_OS_CLI_NONINTERACTIVE=1 even on a TTY", () => {
      const wiring = withTTY(true, () =>
        createSetupInteractionWiring({ env: { GROWTH_OS_CLI_NONINTERACTIVE: "1" }, setup: fakeSetup })
      );
      expect(wiring.ga4OauthInteraction).toBeUndefined();
      expect(wiring.awaitProviderHandoff).toBeUndefined();
      expect(wiring.onProviderStart).toBeUndefined();
    });

    it("installs the interaction/gate/boundary on an interactive TTY", () => {
      const wiring = withTTY(true, () => createSetupInteractionWiring({ env: {}, setup: fakeSetup }));
      expect(wiring.ga4OauthInteraction).toBeDefined();
      expect(wiring.awaitProviderHandoff).toBeDefined();
      expect(wiring.onProviderStart).toBeDefined();
      wiring.dispose();
    });

    it("dispose() resolves a still-armed wait to null without blocking (no leak / always torn down)", async () => {
      const rawModeCalls: boolean[] = [];
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown };
      const originalSetRawMode = stdin.setRawMode?.bind(stdin);
      // Spy on the real stdin's setRawMode so we can confirm it is restored, without swapping
      // out process.stdin (which is a non-configurable getter on some Node builds).
      stdin.setRawMode = ((mode: boolean) => {
        rawModeCalls.push(mode);
        return stdin;
      }) as typeof stdin.setRawMode;
      const wiring = withTTY(true, () => createSetupInteractionWiring({ env: {}, setup: fakeSetup }));
      try {
        // Arm the wait but never press a key — it must not block the test.
        const pending = wiring.ga4OauthInteraction?.waitForDecision?.();
        expect(rawModeCalls).toContain(true); // raw mode armed
        wiring.dispose();
        // dispose() cancels the armed keypress → raw mode restored AND the promise resolves null.
        expect(rawModeCalls).toContain(false);
        await expect(pending).resolves.toBeNull();
      } finally {
        stdin.setRawMode = originalSetRawMode as typeof stdin.setRawMode;
      }
    });
  });

  it("shows configured connector labels when sources already exist", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-setup-connectors-configured-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-setup-connectors-configured-home-"));
    const originalFetch = globalThis.fetch;
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      writeFileSync(join(workspaceRoot, ".growth-os", "config.yml"), "runtime_mode: local\napp_port: 3999\n");
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              sources: [
                { id: "src_stripe", provider: "stripe", status: "connected" },
                { id: "src_x", provider: "x", status: "degraded" }
              ]
            }
          }),
          { status: 200 }
        )) as typeof fetch;

      const checklist = await runCommand("setup", ["connectors"], {
        GROWTH_OS_WORKSPACE_ID: "proj_test",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });

      expect((checklist as { providers: Array<{ provider: string; status: string }> }).providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "stripe", status: "configured" }),
          expect.objectContaining({ provider: "x", status: "configured" }),
          expect.objectContaining({ provider: "posthog", status: "not_configured" })
        ])
      );
      expect((checklist as { configuredConnections: Array<{ provider: string; connectionName?: string; status?: string }> }).configuredConnections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "stripe", status: "connected" }),
          expect.objectContaining({ provider: "x", status: "degraded" })
        ])
      );
      expect((checklist as { summary: { configuredCount: number; degradedCount: number } }).summary).toMatchObject({
        configuredCount: 2,
        degradedCount: 1
      });
      expect(renderCliResult(checklist)).toContain("Configured connectors:");
      expect(renderCliResult(checklist)).toContain("x: configured (degraded)");
      expect(renderCliResult(checklist)).toContain("docs:");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("guides PostHog connector setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_posthog" } } }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "posthog",
          "--connection-name",
          "Product Analytics",
          "--project-id",
          "42",
          "--personal-api-key",
          "ph-key",
          "--api-host",
          "https://posthog.test"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "posthog",
        connectionName: "Product Analytics",
        configuredFields: ["projectId", "apiHost"]
      });
      expect(requests[0]).toMatchObject({
        url: "http://127.0.0.1:3000/sources/connect",
        body: {
          provider: "posthog",
          connectionName: "Product Analytics",
          credentialKind: "personal_api_key",
          credentialPayload: {
            mode: "live",
            projectId: 42,
            personalApiKey: "ph-key",
            apiHost: "https://posthog.test"
          }
        }
      });
      expect(JSON.stringify(result)).not.toContain("ph-key");
      expect(renderCliResult(result)).not.toContain("ph-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("guides Stripe connector setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_stripe" } } }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "stripe",
          "--connection-name",
          "Stripe Billing",
          "--secret-key",
          "sk-test",
          "--api-base-url",
          "https://stripe.test"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "stripe",
        connectionName: "Stripe Billing",
        configuredFields: ["apiBaseUrl"]
      });
      expect(requests[0]).toMatchObject({
        body: {
          provider: "stripe",
          connectionName: "Stripe Billing",
          credentialKind: "api_key",
          credentialPayload: {
            mode: "live",
            secretKey: "sk-test",
            apiBaseUrl: "https://stripe.test"
          }
        }
      });
      expect(JSON.stringify(result)).not.toContain("sk-test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("guides X connector setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              source: { id: "src_x" },
              initialSync: { queued: true, sourceId: "src_x", mode: "incremental" }
            }
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "x",
          "--connection-name",
          "X Public Metrics",
          "--bearer-token",
          "x-bearer-token",
          "--username",
          "@XDevelopers",
          "--api-base-url",
          "https://x.test"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "x",
        connectionName: "X Public Metrics",
        configuredFields: ["username", "apiBaseUrl"],
        initialSync: {
          queued: true,
          sourceId: "src_x",
          mode: "incremental"
        }
      });
      expect(requests[0]).toMatchObject({
        body: {
          provider: "x",
          connectionName: "X Public Metrics",
          credentialKind: "bearer_token",
          credentialPayload: {
            mode: "live",
            bearerToken: "x-bearer-token",
            username: "XDevelopers",
            apiBaseUrl: "https://x.test"
          }
        }
      });
      // Option C: the server enqueues the initial sync at the connect choke point, so the CLI
      // issues no second HTTP request — it only surfaces initialSync from the connect envelope.
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("x-bearer-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("guides Shopify connector setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_shopify" } } }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "shopify",
          "--connection-name",
          "Shopify Store",
          "--store-domain",
          "https://demo-shop.myshopify.com/",
          "--admin-access-token",
          "shpat_test",
          "--api-version",
          "2026-01"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "shopify",
        connectionName: "Shopify Store",
        configuredFields: ["storeDomain", "apiVersion"]
      });
      expect(requests[0]).toMatchObject({
        body: {
          provider: "shopify",
          connectionName: "Shopify Store",
          credentialKind: "admin_api_access_token",
          credentialPayload: {
            mode: "live",
            storeDomain: "demo-shop.myshopify.com",
            adminAccessToken: "shpat_test",
            apiVersion: "2026-01"
          }
        }
      });
      expect(JSON.stringify(result)).not.toContain("shpat_test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("guides Meta Ads connector setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads" } } }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "meta_ads",
          "--connection-name",
          "Meta Ads Main",
          "--ad-account-id",
          "act_1234567890",
          "--access-token",
          "meta-access-token",
          "--api-version",
          "v24.0",
          "--backfill-window",
          "3_months"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "meta_ads",
        connectionName: "Meta Ads Main",
        configuredFields: ["transport", "adAccountId", "apiVersion"],
        backfill: {
          queued: true,
          sourceId: "src_meta_ads",
          window: "3_months",
          windowLabel: "3 months",
          progress: {
            percent: 0,
            max: 100,
            bar: "[--------------------] 0%"
          },
          payload: {
            mode: "backfill",
            backfillWindow: "3_months",
            refreshWindowDays: 90
          }
        }
      });
      expect(requests[0]).toMatchObject({
        body: {
          provider: "meta_ads",
          connectionName: "Meta Ads Main",
          credentialKind: "marketing_api_access_token",
          credentialPayload: {
            mode: "live",
            transport: "marketing_api",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          }
        }
      });
      expect(requests[1]).toMatchObject({
        url: expect.stringContaining("/sources/src_meta_ads/sync"),
        body: {
          mode: "backfill",
          backfillWindow: "3_months",
          refreshWindowDays: 90
        }
      });
      expect(JSON.stringify(result)).not.toContain("meta-access-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("guides official Meta Ads CLI setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads_cli" } } }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "meta_ads",
          "--connection-name",
          "Meta Ads CLI",
          "--ad-account-id",
          "act_1234567890",
          "--meta-ads-cli-command",
          "meta"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "meta_ads",
        connectionName: "Meta Ads CLI",
        configuredFields: ["transport", "adAccountId", "cliCommand"]
      });
      expect(requests[0]).toMatchObject({
        body: {
          provider: "meta_ads",
          connectionName: "Meta Ads CLI",
          credentialKind: "ads_cli",
          credentialPayload: {
            mode: "live",
            transport: "meta_ads_cli",
            adAccountId: "1234567890",
            cliCommand: "meta"
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("guides Meta Ads MCP stdio connector setup without requiring raw JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads_mcp" } } }), { status: 200 });
      }) as typeof fetch;

      const result = await runCommand(
        "setup",
        [
          "connectors",
          "meta_ads",
          "--connection-name",
          "Meta Ads MCP",
          "--ad-account-id",
          "act_1234567890",
          "--mcp-stdio-command",
          "meta-ads-cli --mcp",
          "--mcp-tool-name",
          "get_campaign_insights"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );

      expect(result).toMatchObject({
        ok: true,
        section: "connectors",
        provider: "meta_ads",
        connectionName: "Meta Ads MCP",
        configuredFields: ["transport", "adAccountId", "mcpCommand", "mcpToolName"]
      });
      expect(requests[0]).toMatchObject({
        body: {
          provider: "meta_ads",
          connectionName: "Meta Ads MCP",
          credentialKind: "mcp_server_command",
          credentialPayload: {
            mode: "live",
            transport: "mcp_stdio",
            adAccountId: "1234567890",
            mcpCommand: "meta-ads-cli --mcp",
            mcpToolName: "get_campaign_insights"
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns actionable guidance when token connector setup is missing required fields", async () => {
    const result = await runCommand(
      "setup",
      ["connectors", "posthog", "--project-id", "42"],
      { GROWTH_OS_CLI_NONINTERACTIVE: "1" }
    );

    expect(result).toMatchObject({
      ok: false,
      section: "connectors",
      provider: "posthog",
      error: {
        code: "growth_os_connector_setup_requires_input"
      }
    });
    expect(JSON.stringify(result)).toContain("infinite setup connectors posthog");
    expect(JSON.stringify(result)).not.toContain("personalApiKey");
  });

  it("routes operator CLI commands through shared action endpoints", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await runCommand(
        "connect",
        [
          "stripe",
          "Stripe Live",
          JSON.stringify({
            mode: "live",
            secretKey: "sk-test",
            apiBaseUrl: "https://stripe.test"
          })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
      await runCommand(
        "connect",
        [
          "posthog",
          "PostHog Live",
          JSON.stringify({
            mode: "live",
            projectId: 42,
            personalApiKey: "ph-key",
            apiHost: "https://posthog.test"
          })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
      await runCommand(
        "connect",
        [
          "x",
          "X Public Metrics",
          JSON.stringify({
            mode: "live",
            bearerToken: "x-bearer-token",
            username: "XDevelopers"
          })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
      await runCommand("sync", ["src_123"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
      await runCommand("saved-report", ["export", "report_123", "json"], {
        GROWTH_OS_OPERATOR_TOKEN: "operator",
        GROWTH_OS_WORKSPACE_ID: "proj_test"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/connect",
      body: {
        provider: "stripe",
        connectionName: "Stripe Live",
        credentialKind: "api_key",
        credentialPayload: {
          mode: "live",
          secretKey: "sk-test",
          apiBaseUrl: "https://stripe.test"
        }
      }
    });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/connect",
      body: {
        provider: "posthog",
        connectionName: "PostHog Live",
        credentialKind: "personal_api_key",
        credentialPayload: {
          mode: "live",
          projectId: 42,
          personalApiKey: "ph-key",
          apiHost: "https://posthog.test"
        }
      }
    });
    expect(requests[2]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/connect",
      body: {
        provider: "x",
        connectionName: "X Public Metrics",
        credentialKind: "bearer_token",
        credentialPayload: {
          mode: "live",
          bearerToken: "x-bearer-token",
          username: "XDevelopers"
        }
      }
    });
    expect(requests[3]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_123/sync",
      body: {}
    });
    expect(requests[4]).toMatchObject({
      url: "http://127.0.0.1:3000/tools/call",
      body: {
        actionId: "export_saved_report",
        input: { reportId: "report_123", format: "json" }
      }
    });
  });

  it("does not silently connect sources with fixture credentials from the CLI", async () => {
    await expect(
      runCommand("connect", ["stripe", "Stripe Fixture"], {
        GROWTH_OS_OPERATOR_TOKEN: "operator",
        GROWTH_OS_WORKSPACE_ID: "proj_test"
      })
    ).rejects.toThrow("connect requires a JSON credential payload");
  });

  it("routes connector OAuth setup and polling through app-hosted OAuth sessions", async () => {
    const requests: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: init?.headers && "Authorization" in init.headers ? String(init.headers.Authorization) : undefined
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await runCommand(
        "connect",
        [
          "oauth",
          "google_analytics_4",
          "--client-id",
          "ga-client-id",
          "--redirect-uri",
          "http://localhost:3000/oauth/callback/google_analytics_4"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
      await runCommand("connect", ["oauth-status", "oauth_session_1"], {
        GROWTH_OS_OPERATOR_TOKEN: "operator-token",
        GROWTH_OS_WORKSPACE_ID: "proj_test"
      });
      await runCommand(
        "connect",
        [
          "oauth-exchange",
          "oauth_session_1",
          "--property-id",
          "properties/123",
          "--connection-name",
          "GA4 Website",
          "--client-secret",
          "ga-client-secret",
          "--token-url",
          "https://oauth2.test/token",
          "--api-base-url",
          "https://analyticsdata.test/v1beta"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3000/oauth/sessions",
        authorization: "Bearer operator-token",
        body: {
          provider: "google_analytics_4",
          clientId: "ga-client-id",
          redirectUri: "http://localhost:3000/oauth/callback/google_analytics_4"
        }
      },
      {
        url: "http://127.0.0.1:3000/oauth/sessions/oauth_session_1",
        authorization: "Bearer operator-token",
        body: null
      },
      {
        url: "http://127.0.0.1:3000/oauth/sessions/oauth_session_1/exchange",
        authorization: "Bearer operator-token",
        body: {
          propertyId: "properties/123",
          connectionName: "GA4 Website",
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token",
          apiBaseUrl: "https://analyticsdata.test/v1beta"
        }
      }
    ]);
  });

  it("allows OAuth token exchange before a GA4 property is known", async () => {
    const requests: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: init?.headers && "Authorization" in init.headers ? String(init.headers.Authorization) : undefined
      });
      return new Response(JSON.stringify({ ok: true, status: "authorized" }), { status: 200 });
    }) as typeof fetch;

    try {
      await runCommand(
        "connect",
        [
          "oauth-exchange",
          "oauth_session_1",
          "--client-secret",
          "ga-client-secret",
          "--token-url",
          "https://oauth2.test/token"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3000/oauth/sessions/oauth_session_1/exchange",
        authorization: "Bearer operator-token",
        body: {
          propertyId: undefined,
          connectionName: undefined,
          clientSecret: "ga-client-secret",
          tokenUrl: "https://oauth2.test/token",
          apiBaseUrl: undefined
        }
      }
    ]);
  });

  it("lists and runs curated recipes over existing action calls", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          ok: true,
          actionId: body?.actionId ?? "unknown",
          authority: "operator",
          status: "ok",
          data: body?.actionId === "create_saved_report" ? { report: { id: "report_1" } } : {},
          provenance: [],
          caveats: [],
          truncated: false,
          nextActions: []
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const recipes = await runCommand("recipes", [], {});
      await runCommand(
        "recipe",
        ["save_export_report", JSON.stringify({ name: "Revenue", toolPlan: { metric: "recognized_revenue" } })],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
      expect(JSON.stringify(recipes)).toContain("save_export_report");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map((request) => (request.body as { actionId: string }).actionId)).toEqual([
      "create_saved_report",
      "run_saved_report",
      "export_saved_report"
    ]);
    expect(requests[1]?.body).toMatchObject({
      input: { reportId: "report_1" }
    });
  });

  it("persists narrow memory preferences through slash commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-cli-memory-"));
    try {
      const store = createFileSessionMemoryStore(root);
      const memory = createOperatorSessionMemory({ workspaceRoot: root }, store);
      const result = await runSlashCommand(
        "/memory set timezone Europe/London",
        { GROWTH_OS_WORKSPACE_ROOT: root },
        memory,
        store
      );
      expect(String(result)).toContain("preferredTimezone: Europe/London");
      expect(JSON.parse(readFileSync(sessionMemoryPathForRoot(root), "utf8"))).toMatchObject({
        preferredTimezone: "Europe/London"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps curated memory slash commands to the local agent runtime", async () => {
    const requests: Array<[string, ...unknown[]]> = [];
    const runtime = fakeAgentRuntime({
      async listMemory(sessionId) {
        requests.push(["listMemory", sessionId]);
        return { ok: true, memories: [] };
      },
      async addMemory(sessionId, scope, fact) {
        requests.push(["addMemory", sessionId, scope, fact]);
        return { ok: true };
      },
      async deleteMemory(sessionId, memoryId) {
        requests.push(["deleteMemory", sessionId, memoryId]);
        return { ok: true };
      }
    });
    const chatState = { conversationId: "session-1" };

    await runSlashCommand("/memory", {}, undefined, undefined, chatState, runtime);
    await runSlashCommand(
      "/memory add workspace_preference Use UTC for weekly reports",
      { GROWTH_OS_OPERATOR_TOKEN: "operator-token" },
      undefined,
      undefined,
      chatState,
      runtime
    );
    await runSlashCommand(
      "/memory delete mem_1",
      { GROWTH_OS_OPERATOR_TOKEN: "operator-token" },
      undefined,
      undefined,
      chatState,
      runtime
    );

    expect(requests).toEqual([
      ["listMemory", "session-1"],
      ["addMemory", "session-1", "workspace_preference", "Use UTC for weekly reports"],
      ["deleteMemory", "session-1", "mem_1"]
    ]);
  });
});

function fakeAgentRuntime(overrides: Partial<CliAgentRuntime>): CliAgentRuntime {
  return {
    async chat() {
      throw new Error("unexpected chat call");
    },
    async listSessions() {
      throw new Error("unexpected listSessions call");
    },
    async resumeSession() {
      throw new Error("unexpected resumeSession call");
    },
    async compactSession() {
      throw new Error("unexpected compactSession call");
    },
    async confirmAction() {
      throw new Error("unexpected confirmAction call");
    },
    async listMemory() {
      throw new Error("unexpected listMemory call");
    },
    async addMemory() {
      throw new Error("unexpected addMemory call");
    },
    async deleteMemory() {
      throw new Error("unexpected deleteMemory call");
    },
    ...overrides
  };
}

function mkCodexHome(tokens: Record<string, string>): string {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens }));
  return codexHome;
}

describe("Meta backfill on connect and setup", () => {
  it("no longer exposes a standalone /backfill command", async () => {
    await expect(
      runCommand("backfill", ["src_meta"], { GROWTH_OS_WORKSPACE_ID: "proj_test" })
    ).rejects.toThrow("Unknown Infinite OS CLI command: backfill");
    expect(helpText()).not.toContain("backfill <source_id>");
  });

  it("connect meta_ads queues a default 30-day backfill after connecting", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(
        JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads" } } }),
        { status: 200 }
      );
    }) as typeof fetch;

    let result: unknown;
    try {
      result = await runCommand(
        "connect",
        [
          "meta_ads",
          "Meta Main",
          JSON.stringify({
            mode: "live",
            transport: "marketing_api",
            adAccountId: "1234567890",
            accessToken: "meta-access-token",
            apiVersion: "v24.0"
          })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/connect",
      body: { provider: "meta_ads", connectionName: "Meta Main" }
    });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_meta_ads/sync",
      body: { mode: "backfill", backfillWindow: "30_days", refreshWindowDays: 30 }
    });
    expect(result).toMatchObject({ backfill: { queued: true, sourceId: "src_meta_ads" } });
    expect(JSON.stringify(result)).not.toContain("meta-access-token");
  });

  it("connect meta_ads --no-backfill connects without queuing a sync", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(
        JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads" } } }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      await runCommand(
        "connect",
        [
          "meta_ads",
          "--no-backfill",
          "Meta Main",
          JSON.stringify({ mode: "live", transport: "marketing_api", adAccountId: "1", accessToken: "t" })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/connect",
      body: { provider: "meta_ads", connectionName: "Meta Main" }
    });
  });

  it("connect meta_ads honors an explicit --backfill-window", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(
        JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads" } } }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      await runCommand(
        "connect",
        [
          "meta_ads",
          "--backfill-window",
          "6_months",
          "Meta Main",
          JSON.stringify({ mode: "live", transport: "marketing_api", adAccountId: "1", accessToken: "t" })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_meta_ads/sync",
      body: { mode: "backfill", backfillWindow: "6_months", refreshWindowDays: 180 }
    });
  });

  it("connect meta_ads does not fail the connection when the backfill sync errors", async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads" } } }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }) as typeof fetch;

    let result: unknown;
    try {
      result = await runCommand(
        "connect",
        [
          "meta_ads",
          "Meta Main",
          JSON.stringify({ mode: "live", transport: "marketing_api", adAccountId: "1", accessToken: "t" })
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result).toMatchObject({ ok: true, backfill: { queued: false } });
  });

  it("setup connectors meta_ads stays connected when the backfill sync errors", async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ ok: true, data: { source: { id: "src_meta_ads" } } }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }) as typeof fetch;

    let result: unknown;
    try {
      result = await runCommand(
        "setup",
        [
          "connectors",
          "meta_ads",
          "--connection-name",
          "Meta Ads Main",
          "--ad-account-id",
          "act_1234567890",
          "--access-token",
          "meta-access-token",
          "--api-version",
          "v24.0"
        ],
        { GROWTH_OS_OPERATOR_TOKEN: "operator-token" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result).toMatchObject({
      ok: true,
      section: "connectors",
      provider: "meta_ads",
      backfill: { queued: false, reason: "sync_request_failed" }
    });
  });
});

describe("sync command (wizard + targets)", () => {
  function syncFetch(requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }>) {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      requests.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/sources") && method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              sources: [
                { id: "src_meta_a", provider: "meta_ads", connection_name: "Ultima" },
                { id: "src_stripe", provider: "stripe", connection_name: "Stripe Live" }
              ]
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  }

  it("keeps sync <id> with no window as a plain incremental sync", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await runCommand("sync", ["src_123"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_123/sync",
      method: "POST",
      body: {}
    });
  });

  it("polls an interactive slash sync job and emits queued/running/completed progress", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const progress: ChatProgressEvent[] = [];
    const originalFetch = globalThis.fetch;
    let jobPolls = 0;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      requests.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/sources/src_123/sync") && method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            actionId: "start_source_sync",
            authority: "operator",
            status: "queued",
            data: {
              job: {
                id: "job_sync_1",
                workspace_id: "default",
                job_type: "source_sync",
                status: "queued",
                payload: { sourceId: "src_123", mode: "incremental" }
              }
            },
            provenance: ["job_runs"]
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/jobs/job_sync_1") && method === "GET") {
        jobPolls += 1;
        const status = jobPolls === 1 ? "queued" : jobPolls === 2 ? "running" : "succeeded";
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              job: {
                id: "job_sync_1",
                workspace_id: "default",
                job_type: "source_sync",
                status,
                payload: { sourceId: "src_123", mode: "incremental" },
                created_at: "2026-06-06T15:34:30.604Z",
                started_at: jobPolls >= 2 ? "2026-06-06T15:34:32.357Z" : null,
                finished_at: jobPolls >= 3 ? "2026-06-06T15:34:33.105Z" : null,
                error: null
              },
              syncRun:
                status === "succeeded"
                  ? {
                      id: "sync_1",
                      status: "succeeded",
                      records_extracted: 4,
                      records_loaded: 4,
                      started_at: "2026-06-06T15:34:32.400Z",
                      finished_at: "2026-06-06T15:34:33.000Z"
                    }
                  : null
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as typeof fetch;

    let result: unknown;
    try {
      result = await runSlashCommand(
        "/sync src_123",
        {
          GROWTH_OS_OPERATOR_TOKEN: "operator",
          GROWTH_OS_WORKSPACE_ID: "proj_test",
          GROWTH_OS_SYNC_POLL_INTERVAL_MS: "0",
          GROWTH_OS_SYNC_WAIT_TIMEOUT_MS: "1000"
        },
        undefined,
        undefined,
        undefined,
        undefined,
        {
          onProgress: (event) => progress.push(event)
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "http://127.0.0.1:3000/sources/src_123/sync"],
      ["GET", "http://127.0.0.1:3000/jobs/job_sync_1"],
      ["GET", "http://127.0.0.1:3000/jobs/job_sync_1"],
      ["GET", "http://127.0.0.1:3000/jobs/job_sync_1"]
    ]);
    expect(progress.map((event) => ("text" in event ? event.text : event.message)).join("\n")).toMatch(
      /queued[\s\S]*running[\s\S]*completed/i
    );
    expect(renderCliResult(result)).toContain("Sync completed");
    expect(renderCliResult(result)).toContain("4 records loaded");
  });

  it("re-pulls a chosen window for sync <id> <window> as a source_sync (no backfill mode)", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await runCommand("sync", ["src_meta", "6_months"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_meta/sync",
      method: "POST",
      body: { backfillWindow: "6_months", refreshWindowDays: 180 }
    });
    expect(requests[0]?.body).not.toHaveProperty("mode");
  });

  it("re-pulls full history for sync <id> all_time", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await runCommand("sync", ["src_meta", "all_time"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests[0]?.body).toMatchObject({ backfillWindow: "all_time" });
    expect(requests[0]?.body).not.toHaveProperty("refreshWindowDays");
  });

  it("resolves a provider alias to its source via the live list", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await runCommand("sync", ["meta", "3_months"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests[0]).toMatchObject({ url: "http://127.0.0.1:3000/sources", method: "GET" });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_meta_a/sync",
      method: "POST",
      body: { backfillWindow: "3_months", refreshWindowDays: 90 }
    });
    expect(requests).toHaveLength(2);
  });

  it("asks for a sync window before provider-style sync mutates in non-interactive mode", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    let result: unknown;
    try {
      result = await runCommand("sync", ["meta"], {
        GROWTH_OS_OPERATOR_TOKEN: "operator",
        GROWTH_OS_WORKSPACE_ID: "proj_test",
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3000/sources",
        method: "GET",
        body: null
      }
    ]);
    expect(renderCliResult(result)).toContain("How far back should we sync meta?");
    expect(renderCliResult(result)).toContain("/sync meta 30_days");
    expect(renderCliResult(result)).toContain("infinite sync meta 30_days");
  });

  it("fans out sync all to every connected source", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await runCommand("sync", ["all", "30_days"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const synced = requests.filter((r) => r.method === "POST").map((r) => r.url);
    expect(synced).toContain("http://127.0.0.1:3000/sources/src_meta_a/sync");
    expect(synced).toContain("http://127.0.0.1:3000/sources/src_stripe/sync");
  });

  it("asks for a target when sync runs with no args in a non-interactive shell", async () => {
    await expect(runCommand("sync", [], { GROWTH_OS_WORKSPACE_ID: "proj_test" })).rejects.toThrow(/source/i);
  });

  it("rejects an unknown sync target", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await expect(
        runCommand("sync", ["nope", "30_days"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" })
      ).rejects.toThrow(/No connected source matches/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an unknown sync window", async () => {
    await expect(
      runCommand("sync", ["src_meta", "nonsense"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" })
    ).rejects.toThrow(/window/i);
  });

  it("accepts a leading --window flag without consuming the target", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await runCommand("sync", ["--window", "6_months", "src_meta"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/sources/src_meta/sync",
      method: "POST",
      body: { backfillWindow: "6_months", refreshWindowDays: 180 }
    });
  });

  it("explains when a known provider has no connected source", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = syncFetch(requests);
    try {
      await expect(
        runCommand("sync", ["ga4", "30_days"], { GROWTH_OS_OPERATOR_TOKEN: "operator", GROWTH_OS_WORKSPACE_ID: "proj_test" })
      ).rejects.toThrow(/No google_analytics_4 source is connected/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("documents sync targets in help", () => {
    expect(helpText()).toContain("sync <provider|source_id> [window]");
    expect(helpText()).toContain("sync all [window]");
  });
});

describe("active-project guard (cutover)", () => {
  it("setup status exits cleanly with no active project", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-noproj-status-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-noproj-status-home-"));
    try {
      const result = await runCommand("setup", ["status"], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_HOME: growthHome
      });
      // No NoActiveProjectError thrown — setup status is exempt and project-tolerant.
      expect(isRecordResult(result)).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("health exits cleanly with no active project", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;
    try {
      const result = await runCommand("health", [], { GROWTH_OS_API_URL: "http://127.0.0.1:3999" });
      expect(result).toMatchObject({ status: "ok" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("a guarded command with no active project throws NoActiveProjectError", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-noproj-guarded-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-noproj-guarded-home-"));
    try {
      await expect(
        runCommand("sources", [], {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome
        })
      ).rejects.toBeInstanceOf(NoActiveProjectError);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("the NoActiveProjectError message guides the user to setup or project new", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-noproj-message-"));
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-noproj-message-home-"));
    try {
      await expect(
        runCommand("sources", [], {
          GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
          GROWTH_OS_HOME: growthHome
        })
      ).rejects.toThrow(/No active project\. Run `infinite setup` or `infinite project new <name>`\./);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("a guarded command rethrows non-stale DB errors before calling the API", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-stale-pointer-"));
    writeActiveProjectId("proj_deleted", { GROWTH_OS_HOME: growthHome } as never);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { sources: [] } }), { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999",
        GROWTH_OS_ENCRYPTION_KEY: "test-encryption-key",
        // Unreachable DB → findProject throws connection error, which must surface.
        DATABASE_URL: "postgres://growth:password@127.0.0.1:1/growth"
      } as Record<string, string>;
      await expect(runCommand("sources", [], env)).rejects.toThrow(/ECONNREFUSED|connect|Connection terminated/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("functional isolation: requests carry the active project's id and switch with `project use`", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-isolation-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-isolation-workspace-"));
    const headers: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (String(url).endsWith("/projects")) {
        return new Response(
          JSON.stringify({
            ok: true,
            projects: [
              { id: "proj_aaaaaaaaaaaaaaaa", name: "Alpha" },
              { id: "proj_bbbbbbbbbbbbbbbb", name: "Beta" }
            ]
          }),
          { status: 200 }
        );
      }
      headers.push(h.get("x-growth-os-workspace") ?? "");
      return new Response(JSON.stringify({ ok: true, data: { sources: [] } }), { status: 200 });
    }) as typeof fetch;
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999",
        GROWTH_OS_OPERATOR_TOKEN: "op"
      } as Record<string, string>;
      writeActiveProjectId("proj_aaaaaaaaaaaaaaaa", env as never);
      await runCommand("sources", [], env);
      // PR4 [major]: `/project use` is a SESSION pin, not a persisted pointer. It
      // returns a pin-change signal instead of calling writeActiveProjectId; the
      // `onSubmitLine` wrapper applies it to the original session env. Here we
      // drive that wrapper step explicitly via `applySessionPin`.
      const useResult = await runCommand("project", ["use", "Beta"], env);
      const pinChange = readProjectPinChange(useResult);
      expect(pinChange).toEqual({ id: "proj_bbbbbbbbbbbbbbbb", name: "Beta" });
      // Not persisted: the legacy active pointer stays on Alpha.
      expect(readActiveProjectId(env as never)).toBe("proj_aaaaaaaaaaaaaaaa");
      applySessionPin(env as never, pinChange!);
      // The in-process env pin now wins (session-only, gone on restart).
      expect(env.GROWTH_OS_WORKSPACE_ID).toBe("proj_bbbbbbbbbbbbbbbb");
      await runCommand("sources", [], env);
      expect(headers).toEqual(["proj_aaaaaaaaaaaaaaaa", "proj_bbbbbbbbbbbbbbbb"]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("standalone `project use` carries (and renders) a hint that the pin is session-only", async () => {
    // Run NOT from the interactive wrapper (no GROWTH_OS_CLI_NONINTERACTIVE=1
    // marker): the [PROJECT_PIN_CHANGE] signal goes unconsumed, so the result
    // must explain that `/project use` only pins an interactive session and to
    // use `project default set` to persist. Confirm the hint is part of the
    // rendered, user-facing CLI output (not buried in a non-rendered field).
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-use-hint-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-use-hint-ws-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/projects")) {
        return new Response(
          JSON.stringify({ ok: true, projects: [{ id: "proj_bbbbbbbbbbbbbbbb", name: "Beta" }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999",
        GROWTH_OS_OPERATOR_TOKEN: "op"
      } as Record<string, string>;
      writeActiveProjectId("proj_bbbbbbbbbbbbbbbb", env as never);
      const result = await runCommand("project", ["use", "Beta"], env);
      const rendered = renderCliResult(result);
      expect(rendered).toContain("Pinned project: Beta");
      expect(rendered).toContain("interactive session only");
      expect(rendered).toContain("infinite project default set Beta");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("interactive `project use` (NONINTERACTIVE=1 wrapper marker) omits the standalone hint", async () => {
    // From the interactive wrapper the [PROJECT_PIN_CHANGE] signal IS consumed
    // (applySessionPin), so the redundant "persist with default set" hint would
    // be noise — it must not be attached.
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-use-nohint-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-use-nohint-ws-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/projects")) {
        return new Response(
          JSON.stringify({ ok: true, projects: [{ id: "proj_bbbbbbbbbbbbbbbb", name: "Beta" }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_API_URL: "http://127.0.0.1:3999",
        GROWTH_OS_OPERATOR_TOKEN: "op",
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      } as Record<string, string>;
      writeActiveProjectId("proj_bbbbbbbbbbbbbbbb", env as never);
      const result = await runCommand("project", ["use", "Beta"], env);
      expect(readProjectPinChange(result)).toEqual({ id: "proj_bbbbbbbbbbbbbbbb", name: "Beta" });
      expect((result as { hint?: string }).hint).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("expandHomePath", () => {
  it("expands a bare ~ and a ~/-prefixed path to the home directory", () => {
    expect(expandHomePath("~")).toBe(homedir());
    expect(expandHomePath("~/sites/app")).toBe(`${homedir()}/sites/app`);
  });

  it("leaves absolute, relative, and ~user paths untouched", () => {
    expect(expandHomePath("/srv/app")).toBe("/srv/app");
    expect(expandHomePath("./app")).toBe("./app");
    expect(expandHomePath("~deploy/app")).toBe("~deploy/app");
  });
});

describe("runGa4TagInstallOffer", () => {
  function fakeIo(overrides: Partial<Parameters<typeof runGa4TagInstallOffer>[0]["io"]> = {}) {
    const writes: string[] = [];
    const installGa4Tag = vi.fn(async (inp: { confirm?: (s: { framework: string; appRoot: string; packageManager: string; files: string[] }) => Promise<boolean> }) => {
      const ok = inp.confirm
        ? await inp.confirm({ framework: "next-app-router", appRoot: ".", packageManager: "pnpm", files: ["app/layout.tsx"] })
        : true;
      return ok
        ? { result: { status: "ok", detail: "Installed the GA4 tag (app/layout.tsx)." } }
        : { result: { status: "skipped", detail: "GA4 tag install skipped — no files were changed." } };
    });
    const io = {
      isInteractive: true,
      write: (message: string) => {
        writes.push(message);
      },
      promptText: async () => "",
      promptYesNo: async () => true,
      installGa4Tag,
      ...overrides
    };
    return { writes, installGa4Tag, io };
  }

  it("does nothing when GA4 did not complete or has no measurement id", async () => {
    const a = fakeIo();
    await runGa4TagInstallOffer({ completed: [], measurementId: "G-1", workspaceId: "ws", io: a.io });
    const b = fakeIo();
    await runGa4TagInstallOffer({ completed: ["ga4"], measurementId: undefined, workspaceId: "ws", io: b.io });
    expect(a.installGa4Tag).not.toHaveBeenCalled();
    expect(b.installGa4Tag).not.toHaveBeenCalled();
    expect(a.writes).toEqual([]);
    expect(b.writes).toEqual([]);
  });

  it("stays completely silent (no writes, no install) when non-interactive", async () => {
    const a = fakeIo({ isInteractive: false });
    await runGa4TagInstallOffer({ completed: ["ga4"], measurementId: "G-1", workspaceId: "ws", io: a.io });
    expect(a.installGa4Tag).not.toHaveBeenCalled();
    expect(a.writes).toEqual([]);
  });

  it("prints the manual gtag snippet and does not install when the founder skips the repo prompt", async () => {
    const a = fakeIo({ promptText: async () => "  " });
    await runGa4TagInstallOffer({ completed: ["ga4"], measurementId: "G-SKIP", workspaceId: "ws", io: a.io });
    expect(a.installGa4Tag).not.toHaveBeenCalled();
    const out = a.writes.join("");
    expect(out).toContain("googletagmanager.com/gtag/js?id=G-SKIP");
    expect(out).toContain("gtag('config', 'G-SKIP')");
  });

  it("installs against the resolved repo path and previews the manifest write", async () => {
    const a = fakeIo({ promptText: async () => "~/sites/app" });
    await runGa4TagInstallOffer({ completed: ["ga4"], measurementId: "G-OK", workspaceId: "ws_1", io: a.io });
    expect(a.installGa4Tag).toHaveBeenCalledTimes(1);
    const call = a.installGa4Tag.mock.calls[0]![0] as { repoRoot: string; measurementId: string; workspaceId: string };
    expect(call.measurementId).toBe("G-OK");
    expect(call.workspaceId).toBe("ws_1");
    expect(call.repoRoot).toBe(`${homedir()}/sites/app`);
    const out = a.writes.join("");
    expect(out).toContain("plus an Infinite install manifest");
    expect(out).toContain("app/layout.tsx");
    expect(out).toContain("Installed the GA4 tag");
  });

  it("falls back to the manual snippet when the founder declines the confirm", async () => {
    const a = fakeIo({ promptText: async () => "/srv/app", promptYesNo: async () => false });
    await runGa4TagInstallOffer({ completed: ["ga4"], measurementId: "G-NO", workspaceId: "ws", io: a.io });
    expect(a.installGa4Tag).toHaveBeenCalledTimes(1);
    const out = a.writes.join("");
    expect(out).toContain("skipped");
    expect(out).toContain("gtag('config', 'G-NO')");
  });

  it("falls back to the manual snippet when installGa4Tag throws", async () => {
    const a = fakeIo({
      promptText: async () => "/srv/app",
      installGa4Tag: vi.fn(async () => {
        throw new Error("ENOENT: no such directory");
      })
    });
    await runGa4TagInstallOffer({ completed: ["ga4"], measurementId: "G-ERR", workspaceId: "ws", io: a.io });
    const out = a.writes.join("");
    expect(out).toContain("Could not install the GA4 tag automatically");
    expect(out).toContain("ENOENT");
    expect(out).toContain("gtag('config', 'G-ERR')");
  });

  it("resolves without throwing when promptText rejects (e.g. readline closed mid-prompt) and falls back to the manual snippet", async () => {
    const a = fakeIo({
      promptText: async () => {
        throw new Error("readline was closed");
      }
    });
    // Must not throw — the offer must degrade gracefully so setup is not failed.
    await expect(
      runGa4TagInstallOffer({ completed: ["ga4"], measurementId: "G-RLCLOSE", workspaceId: "ws", io: a.io })
    ).resolves.toBeUndefined();
    expect(a.installGa4Tag).not.toHaveBeenCalled();
    const out = a.writes.join("");
    expect(out).toContain("gtag('config', 'G-RLCLOSE')");
  });
});

describe("createCliAgentRuntime local workspace validation", () => {
  function makeFakeDb(workspaceExists: boolean, calls: string[]): growthDb.InfiniteOsDb {
    return {
      async query() {
        return [];
      },
      async one(sql: string) {
        if (sql.includes("from workspaces")) {
          calls.push(sql);
          return workspaceExists ? { ok: 1 } : null;
        }
        return null;
      },
      async close() {
        return undefined;
      }
    } as unknown as growthDb.InfiniteOsDb;
  }

  it("throws NoActiveProjectError when the pinned workspace is not in workspaces", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-runtime-validate-missing-"));
    const calls: string[] = [];
    const dbSpy = vi
      .spyOn(growthDb, "createInfiniteOsDb")
      .mockReturnValue(makeFakeDb(false, calls));
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      const runtime = createCliAgentRuntime({
        DATABASE_URL: "postgres://growth:password@db.example.com:5432/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_WORKSPACE_ID: "proj_unknown"
      });
      try {
        await expect(runtime.listSessions()).rejects.toBeInstanceOf(NoActiveProjectError);
        // The validation reuses the gateway-path `select 1 ... from workspaces` check.
        expect(calls.some((sql) => /select\s+1.*from\s+workspaces/is.test(sql))).toBe(true);
      } finally {
        await runtime.close?.();
      }
    } finally {
      dbSpy.mockRestore();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes validation when the pinned workspace exists (memoized to one round-trip)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-runtime-validate-ok-"));
    const calls: string[] = [];
    const dbSpy = vi
      .spyOn(growthDb, "createInfiniteOsDb")
      .mockReturnValue(makeFakeDb(true, calls));
    try {
      await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
      const runtime = createCliAgentRuntime({
        DATABASE_URL: "postgres://growth:password@db.example.com:5432/growth",
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_WORKSPACE_ID: "proj_known"
      });
      try {
        await expect(runtime.listSessions()).resolves.toMatchObject({ ok: true });
        // Second call must not re-query workspaces (the check is memoized per runtime).
        await runtime.listSessions();
        expect(calls.length).toBe(1);
      } finally {
        await runtime.close?.();
      }
    } finally {
      dbSpy.mockRestore();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("createCliAgentRuntime per-project session id (PR2)", () => {
  // Records every SQL + params so we can assert the controller session id the
  // runtime keys rows on. `chat_sessions` rows live under `id` / `session_id`;
  // the workspaces check returns ok; compactSession reads back a parent row.
  function makeRecordingDb(workspaceId: string, calls: Array<{ sql: string; params: unknown[] }>): growthDb.InfiniteOsDb {
    return {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return [];
      },
      async one(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("from workspaces")) {
          return { ok: 1 };
        }
        if (/from\s+chat_sessions/i.test(sql)) {
          // compactSession reads the parent row before re-keying.
          return {
            id: params[0],
            workspaceId,
            sessionKey: params[0],
            actorId: "cli",
            surface: "cli"
          };
        }
        return null;
      },
      async close() {
        return undefined;
      }
    } as unknown as growthDb.InfiniteOsDb;
  }

  // Pull out the `chat_sessions` row keys (id / session_id) a sequence touched,
  // so we can assert exactly which controller session ids were used.
  function chatSessionRowKeys(calls: Array<{ sql: string; params: unknown[] }>): string[] {
    const keys: string[] = [];
    for (const { sql, params } of calls) {
      if (/insert\s+into\s+chat_sessions/i.test(sql)) {
        keys.push(String(params[0])); // id
      } else if (/update\s+chat_sessions[\s\S]*where\s+id\s*=\s*\$1/i.test(sql)) {
        keys.push(String(params[0]));
      } else if (/from\s+chat_sessions\s+where\s+id\s*=\s*\$1/i.test(sql)) {
        keys.push(String(params[0]));
      }
    }
    return keys;
  }

  function buildRuntime(workspaceId: string, calls: Array<{ sql: string; params: unknown[] }>, workspaceRoot: string) {
    const dbSpy = vi.spyOn(growthDb, "createInfiniteOsDb").mockReturnValue(makeRecordingDb(workspaceId, calls));
    const runtime = createCliAgentRuntime({
      DATABASE_URL: "postgres://growth:password@db.example.com:5432/growth",
      GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
      GROWTH_OS_WORKSPACE_ID: workspaceId,
      // Isolate the model/auth home under the (cleaned-up) workspace root so the
      // runtime never reads the developer's real ~/.growth-os/auth.json. Without
      // this, a developer with a live codex/claude token has chat() make a real
      // (slow) provider call and the 5s test times out — the test assumes "no
      // model client is configured", which is only true when the home is empty.
      GROWTH_OS_HOME: join(workspaceRoot, ".growth-os-home")
    });
    return { runtime, dbSpy };
  }

  it("keys two workspaces' rows distinctly for one conversation id (no PK collision)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-pr2-two-ws-"));
    await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
    const conversationId = "cli_conv_shared";
    const callsA: Array<{ sql: string; params: unknown[] }> = [];
    const callsB: Array<{ sql: string; params: unknown[] }> = [];
    try {
      // Same UI conversation id, two different pinned workspaces. The shared PK
      // path is `resumeSession` (no model call) — historically a re-insert of the
      // same `id` for a second workspace is the uncaught PK conflict that throws.
      const a = buildRuntime("proj_a", callsA, workspaceRoot);
      try {
        await a.runtime.resumeSession(conversationId);
      } finally {
        a.dbSpy.mockRestore();
        await a.runtime.close?.();
      }
      const b = buildRuntime("proj_b", callsB, workspaceRoot);
      try {
        await b.runtime.resumeSession(conversationId);
      } finally {
        b.dbSpy.mockRestore();
        await b.runtime.close?.();
      }

      const keysA = chatSessionRowKeys(callsA);
      const keysB = chatSessionRowKeys(callsB);
      // Each workspace keys its own per-project row; the two never collide.
      expect(keysA).toContain(`${conversationId}:proj_a`);
      expect(keysB).toContain(`${conversationId}:proj_b`);
      expect(keysA).not.toContain(`${conversationId}:proj_b`);
      expect(new Set([...keysA, ...keysB]).size).toBe(2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("chat() keys two workspaces' rows distinctly for one conversation id (no PK collision)", async () => {
    // The sibling test above exercises the `resumeSession` path; this one drives
    // the real `chat()` round-trip — the actual user path where `ensureSession`
    // inserts `chat_sessions (id, session_key)` and a second workspace re-using
    // the same conversation id would otherwise re-insert the same PK and throw.
    // No model client is configured in tests, so `modelClient.complete` returns
    // the benign "no model configured" response — `chat()` resolves
    // deterministically AFTER `ensureSession` has recorded the derived id.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-pr2-chat-two-ws-"));
    await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
    const conversationId = "cli_conv_chat_shared";
    const callsA: Array<{ sql: string; params: unknown[] }> = [];
    const callsB: Array<{ sql: string; params: unknown[] }> = [];
    try {
      const a = buildRuntime("proj_a", callsA, workspaceRoot);
      let replyA: { ok: boolean };
      try {
        replyA = (await a.runtime.chat({ message: "how many views", sessionId: conversationId })) as { ok: boolean };
      } finally {
        a.dbSpy.mockRestore();
        await a.runtime.close?.();
      }
      const b = buildRuntime("proj_b", callsB, workspaceRoot);
      let replyB: { ok: boolean };
      try {
        replyB = (await b.runtime.chat({ message: "how many views", sessionId: conversationId })) as { ok: boolean };
      } finally {
        b.dbSpy.mockRestore();
        await b.runtime.close?.();
      }

      // Both turns completed (no uncaught PK conflict throw).
      expect(replyA.ok).toBe(true);
      expect(replyB.ok).toBe(true);

      const keysA = chatSessionRowKeys(callsA);
      const keysB = chatSessionRowKeys(callsB);
      // Each workspace inserted its own per-project `chat_sessions` row.
      expect(keysA).toContain(`${conversationId}:proj_a`);
      expect(keysB).toContain(`${conversationId}:proj_b`);
      // The two never share a key — the PK is qualified by the bound workspace.
      expect(keysA).not.toContain(`${conversationId}:proj_b`);
      expect(keysB).not.toContain(`${conversationId}:proj_a`);
      expect(new Set([...keysA, ...keysB]).size).toBe(2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resume → compact → list all hit the same per-project row (no double-suffix)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-pr2-same-row-"));
    await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
    const conversationId = "cli_conv_resume";
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const { runtime, dbSpy } = buildRuntime("proj_x", calls, workspaceRoot);
    try {
      await runtime.resumeSession(conversationId);
      const compacted = await runtime.compactSession(conversationId, "keep the revenue context");
      const listed = (await runtime.listSessions()) as { ok: boolean };

      const derived = `${conversationId}:proj_x`;
      // Every chat_sessions row key the sequence touched is the SAME single-suffix
      // controller id — never the compounded `:proj_x:proj_x` a round-tripped id
      // would produce.
      for (const key of chatSessionRowKeys(calls)) {
        if (key.startsWith(conversationId)) {
          expect(key).toBe(derived);
        }
      }
      expect(chatSessionRowKeys(calls)).toContain(derived);
      // The runtime echoes back the immutable conversation id (suffix stripped),
      // so `/resume` and `/compact` round-trip to a re-derivable value.
      expect(compacted).toMatchObject({ ok: true });
      expect(listed.ok).toBe(true);
    } finally {
      dbSpy.mockRestore();
      await runtime.close?.();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("listSessions strips the workspace suffix so /resume round-trips the conversation id", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-pr2-list-strip-"));
    await runCommand("init", [], { GROWTH_OS_WORKSPACE_ROOT: workspaceRoot });
    const conversationId = "cli_conv_list";
    const dbSpy = vi.spyOn(growthDb, "createInfiniteOsDb").mockReturnValue({
      async query(sql: string) {
        if (/from\s+chat_sessions/i.test(sql)) {
          // A stored row carries the derived id; listSessions must surface the
          // bare conversation id (suffix stripped) for display / `/resume`.
          return [{ id: `${conversationId}:proj_list`, sessionKey: `${conversationId}:proj_list` }];
        }
        return [];
      },
      async one(sql: string) {
        return sql.includes("from workspaces") ? { ok: 1 } : null;
      },
      async close() {
        return undefined;
      }
    } as unknown as growthDb.InfiniteOsDb);
    const runtime = createCliAgentRuntime({
      DATABASE_URL: "postgres://growth:password@db.example.com:5432/growth",
      GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
      GROWTH_OS_WORKSPACE_ID: "proj_list"
    });
    try {
      const result = (await runtime.listSessions()) as { ok: boolean; sessions: Array<{ id: string }> };
      expect(result.sessions[0]?.id).toBe(conversationId);
    } finally {
      dbSpy.mockRestore();
      await runtime.close?.();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("@name project pin (PR4)", () => {
  const PROJECTS = [
    { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" },
    { id: "proj_bbbbbbbbbbbbbbbb", name: "Acme Co" }
  ];

  beforeEach(() => {
    setProjectListCacheForTest(PROJECTS);
  });

  afterEach(() => {
    setProjectListCacheForTest([]);
  });

  describe("resolveProjectPin — parse anywhere, case-insensitive, token strip", () => {
    it("resolves @name at the end and strips the token, keeping the question", () => {
      const result = resolveProjectPin("how many views @rtk");
      expect(result.status).toBe("switched");
      expect(result.project).toEqual({ id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" });
      expect(result.remainder).toBe("how many views");
    });

    it("resolves @name at the start and strips the token", () => {
      const result = resolveProjectPin("@rtk how many views");
      expect(result.status).toBe("switched");
      expect(result.remainder).toBe("how many views");
    });

    it("resolves a bare @name to an empty remainder (confirm-only switch)", () => {
      const result = resolveProjectPin("@rtk");
      expect(result.status).toBe("switched");
      expect(result.project?.name).toBe("rtk");
      expect(result.remainder).toBe("");
    });

    it("matches case-insensitively against the normalized slug", () => {
      expect(resolveProjectPin("@RTK").project?.id).toBe("proj_aaaaaaaaaaaaaaaa");
      // Whitespace is stripped from both the name and the token when normalizing.
      expect(resolveProjectPin("@acmeco numbers").project?.id).toBe("proj_bbbbbbbbbbbbbbbb");
    });

    it("matches against the raw project id", () => {
      expect(resolveProjectPin("revenue @proj_bbbbbbbbbbbbbbbb").project?.id).toBe("proj_bbbbbbbbbbbbbbbb");
    });

    it("reports unknown (never a silent fallback) when no project matches", () => {
      const result = resolveProjectPin("@nope how many views");
      expect(result.status).toBe("unknown");
      expect(result.token).toBe("nope");
      expect(result.project).toBeUndefined();
      // The remaining text is still stripped of the token.
      expect(result.remainder).toBe("how many views");
    });

    it("returns status none when there is no @token", () => {
      const result = resolveProjectPin("how many views");
      expect(result.status).toBe("none");
      expect(result.remainder).toBe("how many views");
    });

    it("normalizes slugs by lowercasing and stripping whitespace", () => {
      expect(normalizeProjectSlug("Acme Co")).toBe("acmeco");
      expect(normalizeProjectSlug("  RTK ")).toBe("rtk");
    });
  });

  describe("resolveProjectPin — slug collision is AMBIGUOUS, not an arbitrary first match (Change #2a)", () => {
    // Two distinct projects normalizing to the SAME `@`-slug (the classic case:
    // two "Default workspace" → `@Defaultworkspace`). A FIRST-match would silently
    // pin an arbitrary one; we surface the collision so it routes to the picker.
    const COLLIDING = [
      { id: "proj_default_a", name: "Default workspace" },
      { id: "proj_default_b", name: "Default workspace" },
      { id: "proj_unique", name: "rtk" }
    ];

    beforeEach(() => {
      setProjectListCacheForTest(COLLIDING);
    });

    it("returns status ambiguous with BOTH colliding projects as candidates", () => {
      const result = resolveProjectPin("how many views @Defaultworkspace");
      expect(result.status).toBe("ambiguous");
      expect(result.token).toBe("Defaultworkspace");
      expect(result.project).toBeUndefined();
      // Both colliding projects are offered (distinct by id), not just the first.
      expect(result.candidates).toEqual([
        { id: "proj_default_a", name: "Default workspace" },
        { id: "proj_default_b", name: "Default workspace" }
      ]);
      // The token is still stripped so the remainder is the real question.
      expect(result.remainder).toBe("how many views");
    });

    it("a UNIQUE slug still switches cleanly (no collision)", () => {
      const result = resolveProjectPin("@rtk how many views");
      expect(result.status).toBe("switched");
      expect(result.project).toEqual({ id: "proj_unique", name: "rtk" });
      expect(result.remainder).toBe("how many views");
    });

    it("a raw id resolves uniquely even when its NAME collides (disambiguation path)", () => {
      // `@<id>` matches exactly one project by id, so it is never ambiguous —
      // this is how the picker's colliding-option re-submit breaks the loop.
      const result = resolveProjectPin("@proj_default_b numbers");
      expect(result.status).toBe("switched");
      expect(result.project).toEqual({ id: "proj_default_b", name: "Default workspace" });
    });
  });

  describe("applySessionPin — session env pin, never persisted", () => {
    it("sets the in-process env pin and does NOT write state.json", () => {
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pr4-pin-"));
      try {
        const env = { GROWTH_OS_HOME: growthHome } as Record<string, string>;
        // No persisted active pointer before…
        expect(readActiveProjectId(env as never)).toBeUndefined();
        applySessionPin(env as never, { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" });
        // The env pin is set (infiniteOsWorkspaceId reads this above state.json)…
        expect(env.GROWTH_OS_WORKSPACE_ID).toBe("proj_aaaaaaaaaaaaaaaa");
        // …and nothing was persisted (gone on restart).
        expect(readActiveProjectId(env as never)).toBeUndefined();
      } finally {
        rmSync(growthHome, { recursive: true, force: true });
      }
    });
  });

  describe("readProjectPinChange — /project use fold-in signal", () => {
    it("extracts the {id,name} pin-change signal a /project use result carries", () => {
      expect(
        readProjectPinChange({ ok: true, __projectPinChange: { id: "p1", name: "n1" } })
      ).toEqual({ id: "p1", name: "n1" });
    });

    it("returns undefined for a result without the signal", () => {
      expect(readProjectPinChange({ ok: true })).toBeUndefined();
      expect(readProjectPinChange(null)).toBeUndefined();
      expect(readProjectPinChange("nope")).toBeUndefined();
    });
  });

  describe("Tab-completion — @name suggestions run ahead of path completion", () => {
    it("completes @rt → @rtk with replaceFrom at the @ and a non-path/-slash kind", () => {
      const completions = completeInteractiveInputForCli("how many views @rt", {
        GROWTH_OS_WORKSPACE_ROOT: tmpdir()
      });
      expect(completions).toEqual([
        { description: "project", kind: "at", replaceFrom: "how many views ".length, value: "@rtk" }
      ]);
      // The suggestion round-trips through applyCompletionSuggestion.
      expect(applyCompletionSuggestion("how many views @rt", completions[0]!)).toBe("how many views @rtk");
    });

    it("strips whitespace from multi-word names so the completed token resolves", () => {
      const completions = completeInteractiveInputForCli("@ac", { GROWTH_OS_WORKSPACE_ROOT: tmpdir() });
      expect(completions).toEqual([
        { description: "project", kind: "at", replaceFrom: 0, value: "@AcmeCo" }
      ]);
      // And the completed token resolves back to the project.
      expect(resolveProjectPin("@AcmeCo").project?.id).toBe("proj_bbbbbbbbbbbbbbbb");
    });

    it("does not let @<partial> fall through to (empty) path completion", () => {
      // `@rt` is treated as a path word by TAB_PATH_RE; without the earlier @ branch
      // this would route to path completion and return nothing.
      const completions = completeInteractiveInputForCli("@rt", { GROWTH_OS_WORKSPACE_ROOT: tmpdir() });
      expect(completions.map((c) => c.value)).toEqual(["@rtk"]);
    });

    it("returns no @ suggestions when the cache is empty", () => {
      setProjectListCacheForTest([]);
      expect(completeInteractiveInputForCli("@rt", { GROWTH_OS_WORKSPACE_ROOT: tmpdir() })).toEqual([]);
    });

    it("exposes the loaded project list via the cache reader", () => {
      expect(getProjectListCache()).toEqual(PROJECTS);
    });
  });
});

describe("@-pin picker — pre-turn gate (PR5)", () => {
  const PROJECTS = [
    { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" },
    { id: "proj_bbbbbbbbbbbbbbbb", name: "Acme Co" }
  ];

  beforeEach(() => {
    setProjectListCacheForTest(PROJECTS);
  });

  afterEach(() => {
    setProjectListCacheForTest([]);
  });

  describe("resolveDistinctProjectMentions — distinct matched projects", () => {
    it("returns both projects for @a @b (distinct)", () => {
      expect(resolveDistinctProjectMentions("@rtk vs @acmeco")).toEqual([
        { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" },
        { id: "proj_bbbbbbbbbbbbbbbb", name: "Acme Co" }
      ]);
    });

    it("de-dupes repeated mentions of the same project (@a @a → one)", () => {
      expect(resolveDistinctProjectMentions("@rtk and @RTK again")).toEqual([
        { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" }
      ]);
    });

    it("ignores unknown mentions, returning only matched projects", () => {
      expect(resolveDistinctProjectMentions("@rtk @nope")).toEqual([
        { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" }
      ]);
    });

    it("returns [] when there are no @mentions", () => {
      expect(resolveDistinctProjectMentions("how many views")).toEqual([]);
    });
  });

  describe("decidePreTurnProjectSelection — the three triggers", () => {
    function envWith(overrides: Record<string, string> = {}): never {
      // Fresh GROWTH_OS_HOME so readDefaultProjectId starts empty (no state.json).
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pr5-gate-"));
      return { GROWTH_OS_HOME: growthHome, ...overrides } as never;
    }

    it("(c) no pin + no @ + no default → picker of the full project list", () => {
      const selection = decidePreTurnProjectSelection(envWith(), "how many views");
      expect(selection).toEqual({ options: PROJECTS, originalLine: "how many views" });
    });

    it("(b) @unknown → picker of the full list, with the token-stripped question", () => {
      const selection = decidePreTurnProjectSelection(envWith(), "@nope how many views");
      expect(selection).toEqual({ options: PROJECTS, originalLine: "how many views" });
    });

    it("(a) multiple distinct @a @b → picker of {a,b} only, with ALL mentions stripped from the question", () => {
      const selection = decidePreTurnProjectSelection(envWith(), "compare @rtk and @acmeco views");
      expect(selection).toEqual({
        options: [
          { id: "proj_aaaaaaaaaaaaaaaa", name: "rtk" },
          { id: "proj_bbbbbbbbbbbbbbbb", name: "Acme Co" }
        ],
        // mentions stripped so the picker's re-submit resolves to a single switch
        originalLine: "compare and views"
      });
    });

    it("(a) the picker re-submit does NOT loop — a multi-mention pick re-enters the gate as a single switch", () => {
      const env = envWith();
      const first = decidePreTurnProjectSelection(env, "compare @rtk and @acmeco views");
      // The Ink picker re-submits `@<slug> <originalLine>` for the chosen project.
      const reSubmit = `@${"Acme Co".replace(/\s+/g, "")} ${(first as { originalLine: string }).originalLine}`;
      expect(reSubmit).toBe("@AcmeCo compare and views");
      // Second pass must NOT re-trigger the picker (single resolvable @ → dispatch).
      expect(decidePreTurnProjectSelection(env, reSubmit)).toBeUndefined();
    });

    it("does NOT prompt once a session pin is set (no re-prompt)", () => {
      const selection = decidePreTurnProjectSelection(
        envWith({ GROWTH_OS_WORKSPACE_ID: "proj_aaaaaaaaaaaaaaaa" }),
        "how many views"
      );
      expect(selection).toBeUndefined();
    });

    it("does NOT prompt when a persisted default exists", () => {
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pr5-default-"));
      const env = { GROWTH_OS_HOME: growthHome } as never;
      writeDefaultProjectId("proj_bbbbbbbbbbbbbbbb", env);
      expect(decidePreTurnProjectSelection(env, "how many views")).toBeUndefined();
    });

    it("LEGACY install (activeProjectId set, no default, no env pin) STILL reaches the picker", () => {
      // The crux of the PR3 minor: a legacy install must not silently inherit the
      // legacy `activeProjectId` and skip the picker. The gate keys off the real
      // session pin (env) + default, NOT `activeProjectId`, so it fires.
      const growthHome = mkdtempSync(join(tmpdir(), "growth-os-pr5-legacy-"));
      const env = { GROWTH_OS_HOME: growthHome } as never;
      writeActiveProjectId("proj_legacy_pointer", env);
      // applySessionDefaultPin would NOT promote the legacy pointer to the env pin…
      expect(applySessionDefaultPin(env)).toMatch(/\/project default set|@name/); // legacy notice
      expect((env as Record<string, string>).GROWTH_OS_WORKSPACE_ID).toBeUndefined();
      // …so the no-pin gate still routes to the picker.
      const selection = decidePreTurnProjectSelection(env, "how many views");
      expect(selection).toEqual({ options: PROJECTS, originalLine: "how many views" });
    });

    it("slash commands bypass the gate (they don't need a workspace pin)", () => {
      expect(decidePreTurnProjectSelection(envWith(), "/help")).toBeUndefined();
      expect(decidePreTurnProjectSelection(envWith(), "/project default set rtk")).toBeUndefined();
    });

    it("a resolvable @name (single switch) bypasses the gate — PR4 handles it", () => {
      expect(decidePreTurnProjectSelection(envWith(), "@rtk how many views")).toBeUndefined();
    });

    it("no projects in the cache → no picker (the line fail-closes to `project new` guidance)", () => {
      setProjectListCacheForTest([]);
      expect(decidePreTurnProjectSelection(envWith(), "how many views")).toBeUndefined();
    });

    it("@unknown with an empty cache → no picker (the wrapper shows a not-found message instead)", () => {
      setProjectListCacheForTest([]);
      expect(decidePreTurnProjectSelection(envWith(), "@nope how many views")).toBeUndefined();
    });

    it("blank input is a no-op (never a picker)", () => {
      expect(decidePreTurnProjectSelection(envWith(), "   ")).toBeUndefined();
    });

    it("(a2) a slug-colliding @token routes to the picker of ONLY the colliding projects (Change #2a)", () => {
      // Two projects normalize to the same `@`-slug → ambiguous → picker, the same
      // way `@unknown` routes — but offering ONLY the colliding pair, not the full
      // list, with the token-stripped question to answer once one is picked.
      setProjectListCacheForTest([
        { id: "proj_default_a", name: "Default workspace" },
        { id: "proj_default_b", name: "Default workspace" },
        { id: "proj_unique", name: "rtk" }
      ]);
      const selection = decidePreTurnProjectSelection(envWith(), "how many views @Defaultworkspace");
      expect(selection).toEqual({
        options: [
          { id: "proj_default_a", name: "Default workspace" },
          { id: "proj_default_b", name: "Default workspace" }
        ],
        originalLine: "how many views"
      });
    });

    it("(a2) a unique @slug still bypasses the gate even when OTHER names collide (Change #2a)", () => {
      setProjectListCacheForTest([
        { id: "proj_default_a", name: "Default workspace" },
        { id: "proj_default_b", name: "Default workspace" },
        { id: "proj_unique", name: "rtk" }
      ]);
      // `@rtk` resolves to one project → not ambiguous → PR4 handles the switch.
      expect(decidePreTurnProjectSelection(envWith(), "@rtk how many views")).toBeUndefined();
    });
  });
});

function isRecordResult(value: unknown): boolean {
  return value !== null && typeof value === "object";
}
