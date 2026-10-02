// No torn frame when the window narrows (eval M2).
//
// Ink redraws its live frame by erasing the rows it last wrote, one row per
// line of that frame. When the window gets narrower, the terminal first
// re-wraps every line of the old frame that is now too wide, so the old frame
// takes MORE rows than Ink erases, and the top of it (a table header, a rule)
// stays on screen above the redraw.
//
// This guard sits between Ink and the terminal. It follows what Ink writes
// (just enough of the escapes Ink uses to know the live frame's rows, their
// widths and the cursor), and on a narrowing resize, BEFORE Ink's own resize
// handler runs, it erases the whole re-wrapped frame and leaves the cursor
// where Ink expects it, so Ink's own erase lands on blank rows and the redraw
// starts at the old frame's top. Scrollback above the frame is never touched.
//
// Terminals that do not re-wrap on resize (rare today) would lose the rows the
// guard thinks the frame gained; `INFINITE_REFLOW_GUARD=0` turns it off.
import { displayWidth } from "../lib/display-width.js";

const ESC = "\u001b";

/** What the guard knows of the live frame: its rows (visible widths) and the cursor. */
export class FrameTracker {
  /** Visible width of each row, from the top of the live frame (row 0) to the last row written. */
  private widths: number[] = [0];
  private row = 0;
  private col = 0;
  private cursorShown = false;

  /** Follow one chunk the renderer wrote. */
  feed(chunk: string): void {
    let textStarted = false;
    let index = 0;
    while (index < chunk.length) {
      const char = chunk[index]!;
      if (char === ESC) {
        index = this.escape(chunk, index);
        continue;
      }
      if (!textStarted) {
        // The most recent write with text starts the live frame (an erase, if any, came first).
        textStarted = true;
        this.startFrameAt(this.row);
      }
      if (char === "\n") {
        this.row += 1;
        this.col = 0;
        if (this.row >= this.widths.length) this.widths.push(0);
      } else if (char === "\r") {
        this.col = 0;
      } else {
        const codePoint = chunk.codePointAt(index)!;
        const glyph = String.fromCodePoint(codePoint);
        const width = displayWidth(glyph);
        if (glyph.trim()) {
          this.widths[this.row] = Math.max(this.widths[this.row] ?? 0, this.col + width);
        }
        this.col += width;
        index += glyph.length;
        continue;
      }
      index += 1;
    }
  }

  /**
   * What to write when the window narrows to `columns`, before the renderer's
   * own resize handler: move to the bottom of the re-wrapped frame, erase every
   * row it now takes, then stand where the renderer believes its cursor is
   * (relative to the frame's top), so its erase covers only blank rows. Empty
   * when the frame gained no rows.
   */
  narrowTo(columns: number): string {
    const cols = Math.max(1, Math.floor(columns));
    const rowsOf = (width: number) => Math.max(1, Math.ceil(width / cols));
    const frame = this.widths;
    const logical = frame.length;
    const physical = frame.reduce((sum, width) => sum + rowsOf(width), 0);
    if (physical <= logical) {
      return "";
    }
    const cursorAt = frame.slice(0, this.row).reduce((sum, width) => sum + rowsOf(width), 0) + Math.floor(Math.min(this.col, Math.max(0, (frame[this.row] ?? 0) - 1)) / cols);
    const down = physical - 1 - cursorAt;
    let out = down > 0 ? `${ESC}[${down}B` : "";
    out += "\r";
    for (let row = 0; row < physical; row += 1) {
      out += `${ESC}[2K${row < physical - 1 ? `${ESC}[1A` : ""}`;
    }
    // Now at the frame's top. The renderer erases its own row count up from
    // where it believes the cursor is (the bottom row, or the parked cursor).
    const back = this.cursorShown ? this.row : logical - 1;
    out += back > 0 ? `${ESC}[${back}B` : "";
    // From here the frame is blank rows: the model restarts on them.
    this.widths = Array.from({ length: logical }, () => 0);
    this.row = back;
    this.col = 0;
    return out;
  }

  private startFrameAt(row: number): void {
    // Rows above the frame are scrollback: forget them.
    if (row > 0) {
      this.widths = this.widths.slice(row);
      this.row -= row;
    }
    if (!this.widths.length) this.widths = [0];
  }

  private escape(chunk: string, start: number): number {
    const next = chunk[start + 1];
    if (next === "]") {
      // OSC: up to BEL or ST. Nothing visible.
      const bel = chunk.indexOf("\u0007", start);
      const st = chunk.indexOf(`${ESC}\\`, start);
      const ends = [bel, st].filter((at) => at >= 0);
      if (!ends.length) return chunk.length;
      const end = Math.min(...ends);
      return end === st ? end + 2 : end + 1;
    }
    if (next !== "[") {
      return Math.min(chunk.length, start + 2);
    }
    let end = start + 2;
    while (end < chunk.length && !/[@-~]/.test(chunk[end]!)) end += 1;
    const params = chunk.slice(start + 2, end);
    const final = chunk[end];
    const n = Number.parseInt(params.replace(/^\?/, ""), 10);
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - count);
        break;
      case "B":
        this.row = Math.min(this.widths.length - 1, this.row + count);
        break;
      case "G":
        this.col = Math.max(0, (Number.isFinite(n) ? n : 1) - 1);
        break;
      case "K":
        if (params === "2") this.widths[this.row] = 0;
        else if (params === "" || params === "0") this.widths[this.row] = Math.min(this.widths[this.row] ?? 0, this.col);
        break;
      case "J":
        if (params === "2" || params === "3") {
          this.reset();
        } else if (params === "" || params === "0") {
          this.widths = this.widths.slice(0, this.row + 1);
          this.widths[this.row] = Math.min(this.widths[this.row] ?? 0, this.col);
        }
        break;
      case "H":
        this.reset();
        break;
      case "h":
      case "l":
        if (params === "?25") this.cursorShown = final === "h";
        break;
      default:
        break;
    }
    return end + 1;
  }

  private reset(): void {
    this.widths = [0];
    this.row = 0;
    this.col = 0;
  }
}

type GuardedStream = NodeJS.WriteStream;

const GUARDED = new WeakMap<object, GuardedStream>();

/**
 * The stream Ink should draw to: the same terminal, with the guard following
 * its writes and erasing a re-wrapped frame on a narrowing resize. Not a
 * terminal, or turned off: the stream itself. The same stream always gets the
 * same guard (Ink keeps one instance per stream).
 */
export function guardResizeReflow(stream: GuardedStream, env: NodeJS.ProcessEnv = process.env): GuardedStream {
  if (!stream?.isTTY || typeof stream.prependListener !== "function" || env.INFINITE_REFLOW_GUARD === "0") {
    return stream;
  }
  const known = GUARDED.get(stream);
  if (known) {
    return known;
  }
  const tracker = new FrameTracker();
  let columns = stream.columns ?? 0;
  // Prepended: it must run before Ink's own resize handler erases and redraws.
  stream.prependListener("resize", () => {
    const now = stream.columns ?? 0;
    if (now > 0 && now < columns) {
      const erase = tracker.narrowTo(now);
      if (erase) stream.write(erase);
    }
    columns = now;
  });
  const write = (chunk: unknown, ...rest: unknown[]) => {
    tracker.feed(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return (stream.write as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  const guarded = new Proxy(stream, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
  GUARDED.set(stream, guarded);
  return guarded;
}
