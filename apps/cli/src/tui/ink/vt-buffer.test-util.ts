// Test helper: a small terminal with scrollback that RE-WRAPS on resize, the
// way xterm.js, iTerm2 and Terminal.app do. It knows just the escapes Ink and
// the session write (cursor up/down/column/home, erase line/display, SGR and
// OSC ignored), so a test can read the WHOLE buffer — scrollback included —
// after a resize, which is where a torn copy of an old frame hides (run-r2
// MUST 4). Every glyph is one column (r4 draws no wide glyph).
const ESC = "\u001b";

interface Row {
  text: string[];
  /** This row continues the row above it (a soft wrap), so a resize re-joins them. */
  wrapped: boolean;
}

export class VtBuffer {
  private rows: Row[];
  private x = 0;
  private y = 0;

  constructor(private cols: number, private readonly height: number) {
    this.rows = Array.from({ length: height }, () => ({ text: [], wrapped: false }));
  }

  /** First buffer row of the viewport. */
  private get base(): number {
    return this.rows.length - this.height;
  }

  private row(y = this.y): Row {
    return this.rows[this.base + y]!;
  }

  private lineFeed(wrapped: boolean): void {
    if (this.y < this.height - 1) {
      this.y += 1;
      if (wrapped) this.row().wrapped = true;
      return;
    }
    this.rows.push({ text: [], wrapped });
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i]!;
      if (ch === ESC) {
        i = this.escape(chunk, i);
        continue;
      }
      if (ch === "\n") {
        this.x = 0;
        this.lineFeed(false);
      } else if (ch === "\r") {
        this.x = 0;
      } else if (ch >= " ") {
        const glyph = String.fromCodePoint(chunk.codePointAt(i)!);
        if (this.x >= this.cols) {
          this.x = 0;
          this.lineFeed(true);
        }
        const text = this.row().text;
        while (text.length < this.x) text.push(" ");
        text[this.x] = glyph;
        this.x += 1;
        i += glyph.length;
        continue;
      }
      i += 1;
    }
  }

  /** The window becomes `cols` wide: every soft-wrapped line re-wraps, as a terminal reflows its buffer. */
  resize(cols: number): void {
    const cursorRow = this.base + this.y;
    const logical: { text: string[]; cursor: boolean; cursorCol: number }[] = [];
    this.rows.forEach((row, index) => {
      const offset = row.wrapped && logical.length ? logical[logical.length - 1]!.text.length : 0;
      if (!row.wrapped || !logical.length) logical.push({ text: [], cursor: false, cursorCol: 0 });
      const line = logical[logical.length - 1]!;
      if (row.wrapped) while (line.text.length < offset) line.text.push(" ");
      line.text.push(...row.text);
      if (index === cursorRow) {
        line.cursor = true;
        line.cursorCol = offset + this.x;
      }
    });
    const rows: Row[] = [];
    let cursorAt = 0;
    let cursorX = 0;
    for (const line of logical) {
      const trimmed = line.text.join("").replace(/\s+$/u, "");
      const parts = Math.max(1, Math.ceil([...trimmed].length / cols));
      const chars = [...trimmed];
      for (let part = 0; part < parts; part += 1) {
        rows.push({ text: chars.slice(part * cols, (part + 1) * cols), wrapped: part > 0 });
      }
      if (line.cursor) {
        const lineStart = rows.length - parts;
        cursorAt = lineStart + Math.min(parts - 1, Math.floor(line.cursorCol / cols));
        cursorX = line.cursorCol % cols;
      }
    }
    // Blank rows below the cursor fold away first, as a terminal keeps the cursor near the bottom.
    while (rows.length - 1 > cursorAt && rows[rows.length - 1]!.text.join("").trim() === "") rows.pop();
    while (rows.length < this.height) rows.push({ text: [], wrapped: false });
    this.rows = rows;
    this.cols = cols;
    this.y = Math.max(0, cursorAt - this.base);
    this.x = cursorX;
  }

  /** Every row, scrollback first, as text (trailing spaces dropped). */
  allText(): string[] {
    return this.rows.map((row) => row.text.join("").replace(/\s+$/u, ""));
  }

  /** The visible rows only. */
  screenText(): string[] {
    return this.allText().slice(this.base);
  }

  private eraseInLine(mode: string): void {
    const text = this.row().text;
    if (mode === "2") this.row().text = [];
    else if (mode === "" || mode === "0") text.length = Math.min(text.length, this.x);
    else if (mode === "1") for (let k = 0; k <= this.x && k < text.length; k += 1) text[k] = " ";
  }

  private escape(chunk: string, start: number): number {
    const next = chunk[start + 1];
    if (next === "]") {
      const bel = chunk.indexOf("\u0007", start);
      const st = chunk.indexOf(`${ESC}\\`, start);
      const ends = [bel, st].filter((at) => at >= 0);
      if (!ends.length) return chunk.length;
      const end = Math.min(...ends);
      return end === st ? end + 2 : end + 1;
    }
    if (next !== "[") return Math.min(chunk.length, start + 2);
    let end = start + 2;
    while (end < chunk.length && !/[@-~]/u.test(chunk[end]!)) end += 1;
    const params = chunk.slice(start + 2, end);
    const n = Number.parseInt(params.replace(/^\?/u, ""), 10);
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    switch (chunk[end]) {
      case "A": this.y = Math.max(0, this.y - count); break;
      case "B": this.y = Math.min(this.height - 1, this.y + count); break;
      case "G": this.x = Math.max(0, count - 1); break;
      case "K": this.eraseInLine(params); break;
      case "H": {
        const [row = 1, col = 1] = params.split(";").map((value) => Number.parseInt(value, 10) || 1);
        this.y = Math.min(this.height - 1, row - 1);
        this.x = col - 1;
        break;
      }
      case "J":
        if (params === "3") {
          this.rows = this.rows.slice(this.base);
        } else if (params === "2") {
          for (let y = 0; y < this.height; y += 1) this.rows[this.base + y] = { text: [], wrapped: false };
        } else if (params === "" || params === "0") {
          this.eraseInLine("0");
          for (let y = this.y + 1; y < this.height; y += 1) this.rows[this.base + y] = { text: [], wrapped: false };
        }
        break;
      default:
        break;
    }
    return end + 1;
  }
}
