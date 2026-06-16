import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  applyComposerEdit,
  applyCompletionSuggestion,
  buildProjectSelectionPrompt,
  completeAtMentions,
  completeInteractiveInput,
  composerCursorLayout,
  formatQueuedStatus,
  isForwardDeleteInput,
  previewQueuedLine,
  renderInkInteractiveSessionToString,
  resolveRestampTitle,
  runInkInteractiveSession,
  type InkInteractiveLineResult
} from "./interactive-session.js";
import { inkTranscriptRowCount, renderInkTranscriptToString } from "./transcript-app.js";

const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");

describe("Ink busy input handling", () => {
  // These two drive a fake-PTY Ink render loop that never ticks on headless
  // GitHub runners (predicates stay false past any timeout) while passing in
  // milliseconds locally. TODO: root-cause the runner incompatibility.
  it.skipIf(process.env.CI === "true")("queues a submitted line while busy and drains it after the active turn settles", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const errorOutput = ttyOutput();
    const submitted: string[] = [];
    let resolveFirst: (result: InkInteractiveLineResult) => void = () => {};
    const firstTurn = new Promise<InkInteractiveLineResult>((resolve) => {
      resolveFirst = resolve;
    });

    const session = runInkInteractiveSession({
      columns: 80,
      errorOutput,
      input,
      async onSubmitLine(line) {
        submitted.push(line);
        if (line === "first turn") {
          return firstTurn;
        }
        return { exit: true, messages: [{ role: "assistant", text: "second done" }] };
      },
      output,
      promptPlaceholder: "Ask Infinite.",
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("ready"), 4_000, output.text);

    await sendKeys(input, "first turn\r");
    await waitFor(() => submitted.length === 1, 4_000, output.text);

    await sendKeys(input, "second turn\r");
    await waitFor(() => output.text().includes('queued: "second turn"'), 4_000, output.text);
    expect(submitted).toEqual(["first turn"]);

    resolveFirst({ messages: [{ role: "assistant", text: "first done" }] });
    await waitFor(() => submitted.length === 2, 4_000, output.text);
    await session;

    expect(submitted).toEqual(["first turn", "second turn"]);
  });

  it("does not discard line input while a turn is busy", () => {
    expect(source).not.toMatch(/if \(busy\) {\s*return;\s*}/);
  });

  it.skipIf(process.env.CI === "true")("lets arrow-key choices turn a line into a follow-up command before confirmation", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const errorOutput = ttyOutput();
    const submitted: string[] = [];

    const session = runInkInteractiveSession({
      columns: 80,
      errorOutput,
      input,
      output,
      title: "Infinite TUI",
      requiresSelection: (line) =>
        line === "/sync x"
          ? {
              question: "How far back should we sync x?",
              description: "No sync has been queued yet.",
              options: [
                { label: "Since last sync (new data only)", line: "/sync x incremental" },
                { label: "Re-pull last 30 days", line: "/sync x 30_days" }
              ]
            }
          : undefined,
      requiresConfirmation: (line) => line === "/sync x 30_days" ? "confirm sync" : undefined,
      async onSubmitLine(line) {
        submitted.push(line);
        return { exit: true, messages: [{ role: "assistant", text: "sync queued" }] };
      }
    });

    await waitFor(() => output.text().includes("ready"));
    await sendKeys(input, "/sync x\r");
    await waitFor(() => output.text().includes("How far back should we sync x?"), 4_000, output.text);
    expect(submitted).toEqual([]);

    await sendRaw(input, "\x1b[B");
    // Wait for the down-arrow to actually move the highlight onto "/sync x 30_days"
    // (rendered with a "> " marker) before pressing Enter. Relying on sendRaw's fixed
    // delay alone races the re-render under load and can confirm the wrong option.
    await waitFor(() => output.text().includes("> /sync x 30_days"), 4_000, output.text);
    await sendKeys(input, "\r");
    await waitFor(() => output.text().includes("confirm sync"), 4_000, output.text);
    expect(submitted).toEqual([]);

    await sendKeys(input, "confirm\r");
    await waitFor(() => submitted.length === 1, 4_000, output.text);
    await session;

    expect(submitted).toEqual(["/sync x 30_days"]);
  });

  it("completes @<partial> before path completion, with replaceFrom at the @ (PR4)", () => {
    const projects = [{ id: "proj_1", name: "rtk" }, { id: "proj_2", name: "Acme Co" }];
    // `@rt`+Tab → `@rtk`, replacing from the `@` index (not the path word).
    const completions = completeInteractiveInput("how many views @rt", [], { projects });
    expect(completions).toEqual([
      { description: "project", kind: "at", replaceFrom: "how many views ".length, value: "@rtk" }
    ]);
    expect(applyCompletionSuggestion("how many views @rt", completions[0]!)).toBe("how many views @rtk");

    // Multi-word names strip whitespace so the completed token resolves as one word.
    expect(completeAtMentions("@ac", { projects }).map((c) => c.value)).toEqual(["@AcmeCo"]);
    // No project list → no @ suggestions (degrades to path completion upstream).
    expect(completeAtMentions("@rt", {})).toEqual([]);
  });

  it("treats Terminal DEL/backspace as a backward delete in the composer", () => {
    expect(isForwardDeleteInput("\x7f")).toBe(false);
    expect(isForwardDeleteInput("\x1b[3~")).toBe(true);
    expect(isForwardDeleteInput({ keypress: { raw: "\x1b[3;" } })).toBe(true);

    expect(applyComposerEdit({ cursor: 3, value: "abc" }, { type: "backspace" })).toMatchObject({
      cursor: 2,
      value: "ab"
    });
    expect(applyComposerEdit({ cursor: 1, value: "abc" }, { type: "delete-forward" })).toMatchObject({
      cursor: 1,
      value: "ac"
    });
  });

  it("boosts stream batching while typing during a busy turn", () => {
    expect(source).toContain("turnController.boostStreamingForTyping");
    expect(source).toContain("TYPING_IDLE_MS");
  });

  it("formats queued follow-up status without multiline noise", () => {
    expect(previewQueuedLine("  first line\nsecond line  ")).toBe("first line second line");
    expect(formatQueuedStatus(["hello world", "next"])).toEqual(['queued: "hello world" (+1)']);
  });

  it("wraps composer cursor layout at the input width", () => {
    expect(composerCursorLayout("abcdefgh", 8, 8)).toEqual({ column: 0, line: 1 });
    expect(composerCursorLayout("abcdefghi", 9, 8)).toEqual({ column: 1, line: 1 });
  });

  it("keeps the composer cursor row in lockstep with the animated transcript height", () => {
    // Regression: the busy status indicator's animated face changes width as it
    // cycles, so the rendered transcript height changes per animation tick. The
    // composer's native cursor row is predicted by inkTranscriptRowCount(); if that
    // prediction uses a different tick than the live <InkTranscriptApp> render, the
    // cursor lands a row off — on the "session …" status line instead of the input.
    const base = {
      busy: true,
      columns: 86,
      showComposer: false as const,
      status: ["session cli_735d6486-cbc8-415d-8eca-ede1f0a9b2c3"],
      title: "Infinite TUI",
      turnStartedAt: 0,
      nowMs: 5_000
    };
    const renderedRows = (tick: number) =>
      renderInkTranscriptToString({ ...base, indicatorTick: tick, spinnerTick: tick }, { columns: base.columns })
        .replace(/\n$/, "")
        .split("\n").length;
    const predictedRows = (tick: number) =>
      inkTranscriptRowCount({ ...base, indicatorTick: tick, spinnerTick: tick });

    const ticks = [0, 1, 2, 3, 4, 5, 6];
    // The rendered height genuinely depends on the animation tick (the bug's trigger)…
    expect(new Set(ticks.map(renderedRows)).size).toBeGreaterThan(1);
    // …and the cursor-row prediction must equal the render at the SAME tick.
    for (const tick of ticks) {
      expect(predictedRows(tick)).toBe(renderedRows(tick));
    }
    // Pre-fix the prediction was pinned to tick 0 and diverged from later ticks.
    const divergentTick = ticks.find((tick) => renderedRows(tick) !== renderedRows(0));
    expect(divergentTick).toBeDefined();
    expect(predictedRows(0)).not.toBe(renderedRows(divergentTick ?? 0));
  });

  it("wires the shared animation clock into the composer (guards a caller regression)", () => {
    // Lightweight wiring guard. The lockstep test above proves the row prediction
    // and the render agree *for the same tick*, but it can't observe whether the
    // caller actually threads ONE clock into both — and a fully behavioural check
    // would have to advance real animation timers (non-deterministic). This catches
    // the most likely regression: dropping the shared clock so the cursor-row
    // prediction falls back to its tick-0 / fresh-Date.now() defaults again.
    expect(source).toContain("useInfiniteTranscriptClock");
  });

  it("renders long active input without truncating the tail", () => {
    const longInput = "if i type too long it looks like things get cut off before wrapping";
    const rendered = renderInkInteractiveSessionToString({
      columns: 40,
      initialInputValue: longInput,
      onSubmitLine: async () => ({}),
      title: "Infinite TUI"
    }, { columns: 40 });

    expect(rendered).not.toContain("…");
    expect(rendered).toContain("before wrapping");
  });

  // PR4: the `@name` switch happens INSIDE onSubmitLine, after the pre-call title
  // capture. So submitExecutableLine must re-stamp this turn's answer from the
  // resolved pin (the live label, updated by the switch), not the frozen title.
  it.skipIf(process.env.CI === "true")("re-stamps an answer's label from the project an @name switch resolved", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const errorOutput = ttyOutput();
    // Mirrors the real wiring: getAgentTitle reads a mutable label the switch flips.
    let currentLabel = "Acme";

    const session = runInkInteractiveSession({
      columns: 80,
      errorOutput,
      input,
      output,
      title: "Infinite TUI",
      getAgentTitle: () => `Infinite — ${currentLabel}`,
      async onSubmitLine(line) {
        if (line.includes("@beta")) {
          // The wrapper switches the pin (flips the live label) before answering…
          currentLabel = "Beta";
          return { messages: [{ role: "assistant", text: "beta answer" }], project: { id: "proj_beta", name: "Beta" } };
        }
        return { exit: true, messages: [{ role: "assistant", text: "second" }] };
      }
    });

    await waitFor(() => output.text().includes("ready"));
    await sendKeys(input, "@beta how many views\r");
    // The answer is labeled for the resolved pin (Beta), not the pre-call Acme.
    await waitFor(() => output.text().includes("Infinite — Beta"), 2_000, output.text);
    expect(output.text()).toContain("Infinite — Beta");

    // Exit the session cleanly.
    await sendKeys(input, "bye\r");
    await session;
  });

  // CI-runnable (non-PTY) coverage of the same core assertion as the skipped PTY
  // test above: a turn that switched projects via `@name` re-stamps its answer's
  // title from the POST-switch label, while a non-switched turn keeps the frozen
  // pre-call title. `submitExecutableLine` routes the non-streaming branch through
  // `resolveRestampTitle`, so testing that seam exercises the production decision
  // without the fake-PTY event loop that never ticks on headless runners.
  describe("re-stamp title seam (deterministic, PR4)", () => {
    it("re-stamps a switched turn from the post-switch live label, not the frozen title", () => {
      // The pin flipped Acme → Beta inside onSubmitLine after the pre-call capture.
      expect(
        resolveRestampTitle({
          switched: true,
          liveTitle: "Infinite — Beta",
          turnTitle: "Infinite — Acme"
        })
      ).toBe("Infinite — Beta");
    });

    it("keeps the frozen title for a non-switched turn (ignores any live label drift)", () => {
      expect(
        resolveRestampTitle({
          switched: false,
          liveTitle: "Infinite — Beta",
          turnTitle: "Infinite — Acme"
        })
      ).toBe("Infinite — Acme");
    });

    it("falls back to the frozen title when the live label is unavailable on a switch", () => {
      expect(
        resolveRestampTitle({
          switched: true,
          liveTitle: undefined,
          turnTitle: "Infinite — Acme"
        })
      ).toBe("Infinite — Acme");
    });

    it("renders the chosen (post-switch) label on the answer end-to-end", () => {
      // Prove the re-stamped title actually lands on a rendered assistant answer:
      // feed the message the title `resolveRestampTitle` selected for a switched
      // turn and confirm the per-answer border label reads the resolved project.
      const restamped = resolveRestampTitle({
        switched: true,
        liveTitle: "Infinite — Beta",
        turnTitle: "Infinite — Acme"
      });
      const rendered = renderInkInteractiveSessionToString(
        {
          columns: 80,
          onSubmitLine: async () => ({}),
          title: "Infinite TUI",
          initialMessages: [{ role: "assistant", text: "beta answer", title: restamped }]
        },
        { columns: 80 }
      );
      expect(rendered).toContain("Infinite — Beta");
      expect(rendered).not.toContain("Infinite — Acme");
    });
  });

  // PR5: the picker re-uses the SelectionMenu renderer. buildProjectSelectionPrompt
  // turns a `needsProjectSelection` result into a prompt whose option lines are
  // re-submittable `@<slug> <originalLine>` — flowing back through the PR4 resolver.
  it("builds a re-submittable @<slug> <original> picker prompt (PR5)", () => {
    const prompt = buildProjectSelectionPrompt({
      options: [{ id: "p1", name: "rtk" }, { id: "p2", name: "Acme Co" }],
      originalLine: "how many views"
    });
    expect(prompt.options.map((o) => o.line)).toEqual([
      "@rtk how many views",
      "@AcmeCo how many views"
    ]);
    // The readable label is the project name; whitespace is stripped only in the slug.
    expect(prompt.options.map((o) => o.label)).toEqual(["rtk", "Acme Co"]);
    expect(prompt.question).toBe("Which project should answer this?");
  });

  it("builds a bare @<slug> line when the original message is just the switch (PR5)", () => {
    const prompt = buildProjectSelectionPrompt({
      options: [{ id: "p1", name: "rtk" }],
      originalLine: ""
    });
    expect(prompt.options[0]!.line).toBe("@rtk");
    expect(prompt.question).toBe("Which project should this session use?");
  });

  // Slug-collision guard (Change #2a): two projects normalizing to the SAME slug
  // must re-submit `@<id>` (unique) — re-submitting the colliding `@<slug>` would
  // re-trigger the ambiguous-pin gate and loop the picker forever.
  it("re-submits @<id> for colliding-slug options so the pick does not loop (Change #2a)", () => {
    const prompt = buildProjectSelectionPrompt({
      options: [
        { id: "proj_default_a", name: "Default workspace" },
        { id: "proj_default_b", name: "Default workspace" },
        { id: "proj_unique", name: "rtk" }
      ],
      originalLine: "how many views"
    });
    expect(prompt.options.map((o) => o.line)).toEqual([
      // Colliding slugs fall back to the unique id…
      "@proj_default_a how many views",
      "@proj_default_b how many views",
      // …a unique slug keeps the readable `@<slug>` form.
      "@rtk how many views"
    ]);
    // Labels stay the readable project names.
    expect(prompt.options.map((o) => o.label)).toEqual([
      "Default workspace",
      "Default workspace",
      "rtk"
    ]);
  });

  // PR5 end-to-end layer-bridge: onSubmitLine returns needsProjectSelection (the
  // wrapper does NOT build the runtime); the component renders the picker, and on a
  // pick re-submits `@<name> <original>` back through onSubmitLine — which sets the
  // pin and answers. Once "pinned", the wrapper no longer returns a selection, so
  // there is no re-prompt.
  it.skipIf(process.env.CI === "true")("renders the no-pin picker and a pick pins + answers, then no re-prompt", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const errorOutput = ttyOutput();
    const submitted: string[] = [];
    let pinned: string | undefined;

    const session = runInkInteractiveSession({
      columns: 80,
      errorOutput,
      input,
      output,
      title: "Infinite TUI",
      async onSubmitLine(line) {
        submitted.push(line);
        // Mirror the real wrapper: no pin + a plain question → ask the picker.
        if (!pinned && !line.startsWith("@")) {
          return {
            needsProjectSelection: {
              options: [{ id: "p1", name: "rtk" }, { id: "p2", name: "Acme Co" }],
              originalLine: line
            }
          };
        }
        // The re-submitted `@<name> <original>` sets the pin and answers.
        if (line.startsWith("@rtk")) {
          pinned = "rtk";
          return { messages: [{ role: "assistant", text: "rtk answer" }], project: { id: "p1", name: "rtk" } };
        }
        return { exit: true, messages: [{ role: "assistant", text: "second answer" }] };
      }
    });

    await waitFor(() => output.text().includes("ready"));

    // First message in a pin-less session → the picker appears (no answer yet).
    await sendKeys(input, "how many views\r");
    await waitFor(() => output.text().includes("Which project should answer this?"), 2_000, output.text);
    expect(submitted).toEqual(["how many views"]);

    // Pick the first option (rtk) → re-submits `@rtk how many views`, which answers.
    await sendKeys(input, "\r");
    await waitFor(() => output.text().includes("rtk answer"), 2_000, output.text);
    expect(submitted).toEqual(["how many views", "@rtk how many views"]);

    // Once pinned, a subsequent no-@ turn does NOT re-prompt — it answers directly.
    await sendKeys(input, "another question\r");
    await waitFor(() => submitted.length === 3, 2_000, output.text);
    expect(output.text()).not.toContain("Which project should this session use?");
    await session;

    expect(submitted).toEqual(["how many views", "@rtk how many views", "another question"]);
  });
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
