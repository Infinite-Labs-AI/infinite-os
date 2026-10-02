// Live terminal size (width, and height for the live-region cap) for the
// interactive session.
//
// The session used to read `output.columns` once at launch and pass it down as a
// prop, so a resized terminal kept drawing at the launch width (rows wider than the
// window wrapped into garbage, or a widened window stayed narrow). These helpers
// follow the stream's "resize" events instead, so every resize re-renders the
// frame at the new width. `columns` props stay as a test-only override.
import { useEffect, useState } from "react";
import { useStdout } from "./renderer.js";

type SizedStream = Pick<NodeJS.WriteStream, "on" | "off"> & { columns?: number; rows?: number };

function usableSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function subscribeTerminalSize(
  stream: SizedStream | undefined,
  read: (stream: SizedStream) => number | null,
  onChange: (value: number) => void
): () => void {
  if (!stream || typeof stream.on !== "function") {
    return () => {};
  }
  const listener = () => {
    const value = read(stream);
    if (value !== null) {
      onChange(value);
    }
  };
  stream.on("resize", listener);
  return () => {
    stream.off("resize", listener);
  };
}

/**
 * Calls `onChange` with the stream's width after every "resize" event (a resize
 * that reports no usable width is ignored). Returns the unsubscribe function.
 */
export function subscribeTerminalColumns(
  stream: NodeJS.WriteStream | undefined,
  onChange: (columns: number) => void
): () => void {
  return subscribeTerminalSize(stream, (s) => usableSize(s.columns), onChange);
}

/** The live terminal width: the stream's width now, then again after every resize. */
export function useTerminalColumns(fallback: number): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => usableSize(stdout?.columns) ?? fallback);

  useEffect(() => {
    // Re-read once on (re)subscribe: the stream may have resized between the first
    // render and this effect.
    const now = usableSize(stdout?.columns);
    if (now !== null) {
      setColumns(now);
    }
    return subscribeTerminalColumns(stdout, setColumns);
  }, [stdout]);

  return columns;
}

/** Same as `subscribeTerminalColumns`, for the terminal height. */
export function subscribeTerminalRows(
  stream: NodeJS.WriteStream | undefined,
  onChange: (rows: number) => void
): () => void {
  return subscribeTerminalSize(stream, (s) => usableSize(s.rows), onChange);
}

/**
 * The live terminal height, or `undefined` when the output is not a TTY (piped
 * output, string renders). Ink only switches to its scrollback-clearing
 * fullscreen redraw on a TTY, so a non-TTY needs no live-region cap.
 */
export function useTerminalRows(): number | undefined {
  const { stdout } = useStdout();
  const tty = Boolean(stdout?.isTTY);
  const [rows, setRows] = useState<number | undefined>(() => (tty ? usableSize(stdout?.rows) ?? undefined : undefined));

  useEffect(() => {
    if (!tty) {
      setRows(undefined);
      return;
    }
    const now = usableSize(stdout?.rows);
    if (now !== null) {
      setRows(now);
    }
    return subscribeTerminalRows(stdout, setRows);
  }, [stdout, tty]);

  return rows;
}
