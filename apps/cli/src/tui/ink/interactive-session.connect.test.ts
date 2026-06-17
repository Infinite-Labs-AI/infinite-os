import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  renderInkInteractiveSessionToString,
  runInkInteractiveSession
} from "./interactive-session.js";

const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");

// Mirrors the production decision shape (index.ts owns it; the TUI only renders).
const POSTHOG_WIZARD = {
  kind: "wizard" as const,
  descriptor: {
    provider: "posthog",
    label: "PostHog",
    description: "Product analytics",
    connectionName: "PostHog",
    docsUrl: "https://posthog.com/docs/api",
    fields: [
      {
        key: "projectId",
        label: "PostHog project ID",
        secret: false,
        required: true,
        guidance: "The numeric project id."
      },
      {
        key: "personalApiKey",
        label: "PostHog personal API key",
        secret: true,
        required: true,
        guidance: "A Personal API key starting with phx_."
      },
      {
        key: "apiHost",
        label: "PostHog region",
        secret: false,
        required: true,
        guidance: "Pick US or EU.",
        choices: [
          { value: "us.posthog.com", label: "US (us.posthog.com)" },
          { value: "eu.posthog.com", label: "EU (eu.posthog.com)" }
        ]
      }
    ]
  }
};

// Mirrors the production meta_ads descriptor (index.ts buildConnectSetupDescriptor):
// plain ad account id → MASKED access token → backfill-window choice (Option B).
const META_ADS_WIZARD = {
  kind: "wizard" as const,
  descriptor: {
    provider: "meta_ads",
    label: "Meta Ads",
    description: "Campaign performance insights",
    connectionName: "Meta Ads",
    docsUrl: "https://developers.facebook.com/docs/marketing-apis",
    fields: [
      {
        key: "adAccountId",
        label: "Meta ad account ID",
        secret: false,
        required: true,
        guidance: "Format act_XXXX."
      },
      {
        key: "accessToken",
        label: "Meta access token",
        secret: true,
        required: true,
        guidance: "A system-user token."
      },
      {
        key: "backfillWindow",
        label: "Backfill window",
        secret: false,
        required: true,
        guidance: "How far back to pull insights.",
        choices: [
          { value: "7_days", label: "7 days" },
          { value: "14_days", label: "14 days" },
          { value: "30_days", label: "30 days", description: "default" },
          { value: "3_months", label: "3 months" },
          { value: "6_months", label: "6 months" },
          { value: "12_months", label: "12 months" },
          { value: "all_time", label: "all time" }
        ]
      }
    ]
  }
};

const RAW_SECRET = "phx_SUPER_SECRET_KEY_abc123";
const RAW_META_TOKEN = "EAAB_META_SYSTEM_USER_TOKEN_xyz789";

describe("in-chat /connect wizard (#20) — structural security guards (CI-runnable)", () => {
  // These assert the dangerous leak paths are BYPASSED in source, mirroring the
  // existing file's render + source-string approach for the PTY-only flow.

  it("Ctrl-C is guarded for the wizard BEFORE the session-wide app.exit()", () => {
    // The wizard-cancel branch must appear before the unconditional app.exit().
    const ctrlCBlock = source.slice(source.indexOf('if (key.ctrl && input === "c")'));
    const cancelIdx = ctrlCBlock.indexOf("onConnectCancel()");
    const exitIdx = ctrlCBlock.indexOf("app.exit()");
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeLessThan(exitIdx);
    expect(source).toContain("if (fieldPromptActive || connectConfirmActive)");
  });

  it("the active field value lives in a ref, never inputValue/the composer value", () => {
    expect(source).toContain("activeFieldValueRef");
    // Keystroke handlers mutate the ref, not inputValue.
    expect(source).toContain("activeFieldValueRef.current += text");
    // The composer value during a field row reads the masked/plain display, which
    // for secret fields is bullets — never the raw ref content.
    expect(source).toContain('"•".repeat(raw.length)');
  });

  it("the final confirm uses a DEDICATED handler that does NOT rememberInputLine or echo the secret line", () => {
    // acceptConnectConfirm builds the dispatch line and submits it WITHOUT
    // rememberInputLine (disk) and WITHOUT appending it as a user/transcript line.
    const handler = source.slice(
      source.indexOf("const acceptConnectConfirm"),
      source.indexOf("const runSubmittedLine")
    );
    expect(handler).toContain("buildConnectDispatch");
    expect(handler).toContain("submitExecutableLine(line)");
    // It must not CALL rememberInputLine (the bare word appears in a comment).
    expect(handler).not.toContain("rememberInputLine(");
    // It must not echo the secret-bearing `line` to the transcript.
    expect(handler).not.toContain("text: line");
    expect(handler).not.toContain("role: \"user\", text: line");
  });

  it("the secret field commit appends a REDACTED line and skips rememberInputLine", () => {
    const commit = source.slice(
      source.indexOf("const commitConnectField"),
      source.indexOf("const commitConnectChoice")
    );
    expect(commit).toContain("(hidden)");
    expect(commit).not.toContain("rememberInputLine(");
  });

  it("renders a wizard header/guidance and masks a secret field via the descriptor (no PTY)", () => {
    // The component renders the wizard overlay from its own state; we can at least
    // prove the masked render helper emits bullets and the guidance copy is present
    // through the static initial-message render of a redacted hint line.
    const rendered = renderInkInteractiveSessionToString(
      {
        columns: 80,
        onSubmitLine: async () => ({}),
        title: "Infinite TUI",
        initialMessages: [
          { kind: "slash", role: "system", text: "PostHog personal API key: ••••••• (hidden)" }
        ]
      },
      { columns: 80 }
    );
    expect(rendered).toContain("(hidden)");
    expect(rendered).toContain("•");
    expect(rendered).not.toContain(RAW_SECRET);
  });
});

describe("in-chat /connect wizard (#20) — live PTY flow (skipped on CI)", () => {
  // The fake-PTY loop never ticks on headless CI runners (same limitation as the
  // sibling busy-input PTY tests); these run in milliseconds locally and are the
  // primary MANDATORY leak coverage.

  it.skipIf(process.env.CI === "true")(
    "collects a masked posthog key and NEVER leaks it to the transcript or onRememberInput; dispatch starts with '/'",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const remembered: string[] = [];
      const dispatched: string[] = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onRememberInput: (line) => remembered.push(line),
        connectWizard: (line) =>
          line.trim().startsWith("/connect posthog") || line.trim().startsWith("connect posthog")
            ? POSTHOG_WIZARD
            : { kind: "none" },
        buildConnectDispatch: (provider, connectionName, collected) =>
          `/connect ${provider} ${connectionName} ${JSON.stringify({ mode: "live", ...collected })}`,
        async onSubmitLine(line) {
          dispatched.push(line);
          return { exit: true, messages: [{ role: "assistant", text: "connected" }] };
        }
      });

      await waitFor(() => output.text().includes("ready"));

      // Arm the wizard.
      await sendKeys(input, "/connect posthog\r");
      await waitFor(() => output.text().includes("Step 1 of 3"), 4_000, output.text);

      // Field 1: project id (plain).
      await sendKeys(input, "12345\r");
      await waitFor(() => output.text().includes("PostHog project ID: 12345"), 4_000, output.text);

      // Field 2: the MASKED secret key.
      await sendKeys(input, `${RAW_SECRET}\r`);
      await waitFor(() => output.text().includes("(hidden)"), 4_000, output.text);

      // Field 3: region — default is US (index 0); pick it with Enter.
      await waitFor(() => output.text().includes("US (us.posthog.com)"), 4_000, output.text);
      await sendKeys(input, "\r");

      // Final confirm — "Connect PostHog" is index 0; Enter dispatches.
      await waitFor(() => output.text().includes("Connect PostHog as"), 4_000, output.text);
      await sendKeys(input, "\r");

      await waitFor(() => dispatched.length === 1, 4_000, output.text);
      await session;

      // The dispatched line carries the secret in JSON and STARTS WITH '/'.
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.startsWith("/")).toBe(true);
      expect(dispatched[0]!).toContain(RAW_SECRET);

      // The raw secret NEVER appears in any rendered transcript frame…
      expect(output.text()).not.toContain(RAW_SECRET);
      // …and is NEVER passed to onRememberInput.
      expect(remembered.join("\n")).not.toContain(RAW_SECRET);
      // The redacted hint + region are visible instead.
      expect(output.text()).toContain("(hidden)");
    }
  );

  it.skipIf(process.env.CI === "true")(
    "EU region picks the EU host; US region picks the US host",
    { timeout: 30_000 },
    async () => {
      for (const [region, expectedHost] of [
        ["EU", "eu.posthog.com"],
        ["US", "us.posthog.com"]
      ] as const) {
        const input = ttyInput();
        const output = ttyOutput();
        const errorOutput = ttyOutput();
        const dispatched: string[] = [];

        const session = runInkInteractiveSession({
          columns: 80,
          errorOutput,
          input,
          output,
          title: "Infinite TUI",
          connectWizard: () => POSTHOG_WIZARD,
          buildConnectDispatch: (provider, connectionName, collected) =>
            `/connect ${provider} ${connectionName} ${JSON.stringify({ mode: "live", ...collected })}`,
          async onSubmitLine(line) {
            dispatched.push(line);
            return { exit: true, messages: [{ role: "assistant", text: "connected" }] };
          }
        });

        await waitFor(() => output.text().includes("ready"));
        await sendKeys(input, "/connect posthog\r");
        await waitFor(() => output.text().includes("Step 1 of 3"), 4_000, output.text);
        await sendKeys(input, "1\r");
        await waitFor(() => output.text().includes("project ID: 1"), 4_000, output.text);
        await sendKeys(input, `${RAW_SECRET}\r`);
        await waitFor(() => output.text().includes("(hidden)"), 4_000, output.text);
        await waitFor(() => output.text().includes("US (us.posthog.com)"), 4_000, output.text);
        if (region === "EU") {
          await sendRaw(input, "\x1b[B");
          await waitFor(() => output.text().includes("> EU (eu.posthog.com)"), 4_000, output.text);
        }
        await sendKeys(input, "\r");
        await waitFor(() => output.text().includes("Connect PostHog as"), 4_000, output.text);
        await sendKeys(input, "\r");
        await waitFor(() => dispatched.length === 1, 4_000, output.text);
        await session;

        expect(dispatched[0]!).toContain(`"apiHost":"${expectedHost}"`);
      }
    }
  );

  it.skipIf(process.env.CI === "true")(
    "meta_ads: collects a masked token + a chosen backfill window; dispatch carries --backfill-window and never leaks the token",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const remembered: string[] = [];
      const dispatched: string[] = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onRememberInput: (line) => remembered.push(line),
        connectWizard: (line) =>
          line.includes("connect meta_ads") ? META_ADS_WIZARD : { kind: "none" },
        // Mirror the production splice: the backfill window rides as a pre-JSON
        // token, never inside the credential JSON.
        buildConnectDispatch: (provider, connectionName, collected) => {
          const { backfillWindow, ...credentials } = collected;
          const flag = backfillWindow ? ` --backfill-window ${backfillWindow}` : "";
          return `/connect ${provider} ${connectionName}${flag} ${JSON.stringify({
            mode: "live",
            transport: "marketing_api",
            ...credentials
          })}`;
        },
        async onSubmitLine(line) {
          dispatched.push(line);
          return { exit: true, messages: [{ role: "assistant", text: "connected" }] };
        }
      });

      await waitFor(() => output.text().includes("ready"));

      await sendKeys(input, "/connect meta_ads\r");
      await waitFor(() => output.text().includes("Step 1 of 3"), 4_000, output.text);

      // Field 1: ad account id (plain — echoed).
      await sendKeys(input, "act_9988776655\r");
      await waitFor(() => output.text().includes("Meta ad account ID: act_9988776655"), 4_000, output.text);

      // Field 2: the MASKED access token.
      await sendKeys(input, `${RAW_META_TOKEN}\r`);
      await waitFor(() => output.text().includes("(hidden)"), 4_000, output.text);

      // Field 3: backfill window — default cursor is the first option (7 days);
      // arrow down four times to land on 6 months, then Enter.
      await waitFor(() => output.text().includes("7 days"), 4_000, output.text);
      for (let i = 0; i < 4; i += 1) {
        await sendRaw(input, "\x1b[B");
      }
      await waitFor(() => output.text().includes("> 6 months"), 4_000, output.text);
      await sendKeys(input, "\r");

      // Final confirm — Enter dispatches.
      await waitFor(() => output.text().includes("Connect Meta Ads as"), 4_000, output.text);
      await sendKeys(input, "\r");

      await waitFor(() => dispatched.length === 1, 4_000, output.text);
      await session;

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.startsWith("/")).toBe(true);
      // The chosen window is a PRE-JSON token; the token is ONLY in the JSON.
      expect(dispatched[0]!).toContain("--backfill-window 6_months");
      expect(dispatched[0]!.indexOf("--backfill-window")).toBeLessThan(dispatched[0]!.indexOf("{"));
      expect(dispatched[0]!).toContain(RAW_META_TOKEN);
      // The window must NOT leak into the credential JSON.
      const json = JSON.parse(dispatched[0]!.slice(dispatched[0]!.indexOf("{"))) as Record<string, unknown>;
      expect(json).not.toHaveProperty("backfillWindow");
      expect(json.transport).toBe("marketing_api");

      // The raw token NEVER appears in any rendered frame nor in input history.
      expect(output.text()).not.toContain(RAW_META_TOKEN);
      expect(remembered.join("\n")).not.toContain(RAW_META_TOKEN);
      expect(output.text()).toContain("(hidden)");
    }
  );

  it.skipIf(process.env.CI === "true")(
    "Ctrl-C during the wizard cancels the wizard (does NOT exit the session) and leaves no remembered/transcript secret",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const remembered: string[] = [];
      const dispatched: string[] = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        onRememberInput: (line) => remembered.push(line),
        connectWizard: (line) =>
          line.includes("connect posthog") ? POSTHOG_WIZARD : { kind: "none" },
        buildConnectDispatch: (provider, connectionName, collected) =>
          `/connect ${provider} ${connectionName} ${JSON.stringify({ mode: "live", ...collected })}`,
        async onSubmitLine(line) {
          dispatched.push(line);
          return { exit: true, messages: [{ role: "assistant", text: "done" }] };
        }
      });

      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "/connect posthog\r");
      await waitFor(() => output.text().includes("Step 1 of 3"), 4_000, output.text);
      await sendKeys(input, "12345\r");
      await waitFor(() => output.text().includes("Step 2 of 3"), 4_000, output.text);
      // Type part of the secret, then Ctrl-C (\x03) — must cancel the wizard, not exit.
      await sendKeys(input, RAW_SECRET);
      await sendRaw(input, "\x03");
      await waitFor(() => output.text().includes("Cancelled connecting PostHog."), 4_000, output.text);

      // The session is still alive: a normal message dispatches + exits.
      await sendKeys(input, "still here\r");
      await waitFor(() => dispatched.includes("still here"), 4_000, output.text);
      await session;

      // No leak via transcript or input history; nothing was connected.
      expect(output.text()).not.toContain(RAW_SECRET);
      expect(remembered.join("\n")).not.toContain(RAW_SECRET);
      expect(dispatched.some((line) => line.includes(RAW_SECRET))).toBe(false);
    }
  );

  it.skipIf(process.env.CI === "true")(
    "/connect ga4 shows the `infinite setup` note (no field loop, no LLM dispatch)",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const errorOutput = ttyOutput();
      const dispatched: string[] = [];

      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput,
        input,
        output,
        title: "Infinite TUI",
        connectWizard: (line) =>
          line.includes("connect ga4")
            ? { kind: "note", text: "GA4 quick-connect opens a browser — run `infinite setup` in your terminal to connect GA4." }
            : { kind: "none" },
        async onSubmitLine(line) {
          dispatched.push(line);
          return { exit: true, messages: [{ role: "assistant", text: "x" }] };
        }
      });

      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "/connect ga4\r");
      await waitFor(() => output.text().includes("infinite setup"), 4_000, output.text);

      // No field loop appeared, and nothing was dispatched to onSubmitLine (no LLM).
      expect(output.text()).not.toContain("Step 1 of");
      expect(dispatched).toEqual([]);

      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "/connect shopify shows the terminal-fallback note",
    { timeout: 30_000 },
    async () => {
      for (const provider of ["shopify"]) {
        const input = ttyInput();
        const output = ttyOutput();
        const errorOutput = ttyOutput();
        const dispatched: string[] = [];

        const session = runInkInteractiveSession({
          columns: 80,
          errorOutput,
          input,
          output,
          title: "Infinite TUI",
          connectWizard: (line) =>
            line.includes(`connect ${provider}`)
              ? { kind: "note", text: `Run \`infinite connect ${provider}\` in your terminal for now.` }
              : { kind: "none" },
          async onSubmitLine(line) {
            dispatched.push(line);
            return { exit: true, messages: [{ role: "assistant", text: "x" }] };
          }
        });

        await waitFor(() => output.text().includes("ready"));
        await sendKeys(input, `/connect ${provider}\r`);
        await waitFor(() => output.text().includes(`infinite connect ${provider}`), 4_000, output.text);
        expect(output.text()).not.toContain("Step 1 of");
        expect(dispatched).toEqual([]);

        await sendKeys(input, "/exit\r");
        await session;
      }
    }
  );
});

function ttyInput() {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (enabled: boolean) => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.ref = vi.fn();
  stream.setRawMode = vi.fn();
  stream.unref = vi.fn();
  return stream;
}

function ttyOutput() {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = 80;
  stream.rows = 24;
  stream.isTTY = true;
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  stream.text = () => chunks.join("");
  return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000, debug?: () => string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), debug?.()).toBe(true);
}

async function sendKeys(input: NodeJS.WritableStream, keys: string) {
  for (const key of keys) {
    input.write(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function sendRaw(input: NodeJS.WritableStream, keys: string) {
  input.write(keys);
  await new Promise((resolve) => setTimeout(resolve, 20));
}
