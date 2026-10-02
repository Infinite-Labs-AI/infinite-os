import { EventEmitter } from "node:events";

import React from "react";
import { describe, expect, it } from "vitest";

import { Text, render } from "./renderer.js";
import { FrameTracker, guardResizeReflow } from "./reflow-guard.js";
import { useTerminalColumns } from "./terminal-columns.js";

// Eval M2: resizing 160 → 60 left torn rows of the old frame above the redraw.
// A tiny terminal model that re-wraps long rows on a narrowing resize, as
// iTerm2, Terminal.app, VS Code and xterm.js do, replays what the renderer
// writes; after the resize only the scrollback and the new frame may remain.
const ESC = "\u001b";

class Screen {
  rows: string[] = [""];
  r = 0;
  c = 0;
  constructor(public cols: number) {}

  write(data: string): void {
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i]!;
      if (ch === ESC && data[i + 1] === "[") {
        let end = i + 2;
        while (end < data.length && !/[@-~]/.test(data[end]!)) end += 1;
        const params = data.slice(i + 2, end);
        const n = Number.parseInt(params.replace(/^\?/, ""), 10);
        const count = Number.isFinite(n) && n > 0 ? n : 1;
        switch (data[end]) {
          case "A": this.r = Math.max(0, this.r - count); break;
          case "B": this.r = Math.min(this.rows.length - 1, this.r + count); break;
          case "G": this.c = (Number.isFinite(n) ? n : 1) - 1; break;
          case "K": if (params === "2") this.rows[this.r] = ""; break;
          default: break;
        }
        i = end;
        continue;
      }
      if (ch === "\n") {
        this.r += 1;
        this.c = 0;
        if (this.r >= this.rows.length) this.rows.push("");
        continue;
      }
      if (ch === "\r") {
        this.c = 0;
        continue;
      }
      const row = this.rows[this.r]!.padEnd(this.c, " ");
      this.rows[this.r] = `${row.slice(0, this.c)}${ch}${row.slice(this.c + 1)}`;
      this.c += 1;
    }
  }

  /** The window narrows: rows wider than it re-wrap; the cursor stays on its cell. */
  reflow(cols: number): void {
    let r = 0;
    const next: string[] = [];
    this.rows.forEach((row, index) => {
      const text = row.trimEnd();
      const chunks = text.length <= cols ? [text] : Array.from({ length: Math.ceil(text.length / cols) }, (_, k) => text.slice(k * cols, (k + 1) * cols));
      if (index === this.r) r = next.length + Math.min(chunks.length - 1, Math.floor(this.c / cols));
      next.push(...chunks);
    });
    this.c %= cols;
    this.rows = next;
    this.r = r;
    this.cols = cols;
  }

  text(): string[] {
    return this.rows.map((row) => row.trimEnd()).filter(Boolean);
  }
}

// ansi-escapes, as Ink's log-update uses them.
const eraseLines = (n: number) => Array.from({ length: n }, (_, i) => `${ESC}[2K${i < n - 1 ? `${ESC}[1A` : ""}`).join("") + (n ? `${ESC}[G` : "");
const OLD = ["─".repeat(160), "❯ question", "x".repeat(150), "y".repeat(100), "❯ ", `keys ${"k".repeat(80)}`];
const NEW = ["─".repeat(60), "❯ question", "x".repeat(50), "y".repeat(40), "❯ ", "keys k"];

/** One Ink frame and its cursor park on the composer row (y = 4, x = 2), as log-update writes them. */
function inkFrame(lines: readonly string[], previousLineCount: number): string {
  const str = `${lines.join("\n")}\n`;
  const prefix = previousLineCount ? `${ESC}[?25l${ESC}[${previousLineCount - 1 - 4}B${ESC}[1G` : "";
  return `${prefix}${eraseLines(previousLineCount)}${str}${ESC}[${lines.length - 4}A${ESC}[3G${ESC}[?25h`;
}

/** Ink's `resized()` on a narrower window: `log.clear()`, then the frame at the new width. */
function inkResize(previousLineCount: number): string {
  return `${ESC}[?25l${ESC}[${previousLineCount - 1 - 4}B${ESC}[1G${eraseLines(previousLineCount)}`;
}

describe("a narrowing resize leaves no torn frame (eval M2)", () => {
  function run(guarded: boolean): string[] {
    const screen = new Screen(160);
    const tracker = new FrameTracker();
    const write = (data: string) => {
      tracker.feed(data);
      screen.write(data);
    };
    write("scroll A\nscroll B\n");
    write(inkFrame(OLD, 0));
    screen.reflow(60);
    if (guarded) screen.write(tracker.narrowTo(60));
    write(inkResize(OLD.length + 1));
    write(inkFrame(NEW, 0));
    return screen.text();
  }

  it("without the guard, the old frame's top survives above the redraw (the bug)", () => {
    const text = run(false);
    expect(text.slice(0, 2)).toEqual(["scroll A", "scroll B"]);
    expect(text.slice(2, 4)).toEqual(["─".repeat(60), "─".repeat(60)]);
  });

  it("with the guard, only the scrollback and the new frame remain", () => {
    expect(run(true)).toEqual(["scroll A", "scroll B", ...NEW.map((line) => line.trimEnd())]);
  });

  it("does nothing when nothing re-wraps", () => {
    const tracker = new FrameTracker();
    tracker.feed(inkFrame(["short", "rows", "only", "here", "❯ ", "keys"], 0));
    expect(tracker.narrowTo(60)).toBe("");
  });

  it("forgets the scrollback: a frame drawn after static output is measured from its own top", () => {
    const screen = new Screen(160);
    const tracker = new FrameTracker();
    const write = (data: string) => {
      tracker.feed(data);
      screen.write(data);
    };
    write(inkFrame(OLD, 0));
    // A turn commits: Ink clears its frame, prints the static lines, then the frame again.
    write(`${ESC}[?25l${ESC}[2B${ESC}[1G${eraseLines(OLD.length + 1)}`);
    write(`${"s".repeat(150)}\nshort static\n`);
    write(inkFrame(OLD, 0));
    screen.reflow(60);
    screen.write(tracker.narrowTo(60));
    write(inkResize(OLD.length + 1));
    write(inkFrame(NEW, 0));
    expect(screen.text()).toEqual(["s".repeat(60), "s".repeat(60), "s".repeat(30), "short static", ...NEW.map((line) => line.trimEnd())]);
  });
});

describe("guardResizeReflow", () => {
  function fakeTty(columns: number) {
    const emitter = new EventEmitter() as EventEmitter & { columns: number; rows: number; isTTY: boolean; write: (chunk: string) => boolean; chunks: string[] };
    emitter.columns = columns;
    emitter.rows = 40;
    emitter.isTTY = true;
    emitter.chunks = [];
    emitter.write = (chunk: string) => {
      emitter.chunks.push(chunk);
      return true;
    };
    return emitter;
  }

  it("is the stream itself when it is not a terminal, or when turned off", () => {
    const pipe = { ...fakeTty(80), isTTY: false } as unknown as NodeJS.WriteStream;
    expect(guardResizeReflow(pipe)).toBe(pipe);
    const tty = fakeTty(80) as unknown as NodeJS.WriteStream;
    expect(guardResizeReflow(tty, { INFINITE_REFLOW_GUARD: "0" })).toBe(tty);
  });

  it("gives the same stream the same guard, and runs before any later resize listener", () => {
    const tty = fakeTty(160);
    const stream = tty as unknown as NodeJS.WriteStream;
    const guarded = guardResizeReflow(stream, {});
    expect(guardResizeReflow(stream, {})).toBe(guarded);
    const order: string[] = [];
    guarded.on("resize", () => order.push(`listener saw ${tty.chunks.length} writes`));
    guarded.write(inkFrame(OLD, 0));
    tty.columns = 60;
    tty.emit("resize");
    // The guard's erase was written before the later listener (Ink's) ran.
    expect(order).toEqual(["listener saw 2 writes"]);
    expect(tty.chunks[1]).toContain(`${ESC}[2K`);
    expect(guarded.columns).toBe(60);
  });

  it.skipIf(process.env.CI === "true")("real Ink: 160 → 60 redraws with no torn rows", { timeout: 10_000 }, async () => {
    const tty = fakeTty(160);
    const screen = new Screen(160);
    tty.write = (chunk: string) => {
      tty.chunks.push(chunk);
      screen.write(chunk);
      return true;
    };
    const stream = guardResizeReflow(tty as unknown as NodeJS.WriteStream, {});
    function Wide() {
      const columns = useTerminalColumns(80);
      return React.createElement(Text, null, [`top ${"t".repeat(columns - 6)}`, `mid ${"m".repeat(columns - 10)}`, "end"].join("\n"));
    }
    screen.write("scroll A\n");
    tty.chunks.push("scroll A\n");
    const instance = render(React.createElement(Wide), { stdout: stream, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.text()).toEqual(["scroll A", `top ${"t".repeat(154)}`, `mid ${"m".repeat(150)}`, "end"]);
    tty.columns = 60;
    screen.reflow(60);
    tty.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.text()).toEqual(["scroll A", `top ${"t".repeat(54)}`, `mid ${"m".repeat(50)}`, "end"]);
    instance.unmount();
  });
});
