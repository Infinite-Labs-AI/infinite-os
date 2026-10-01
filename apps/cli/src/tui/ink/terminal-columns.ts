// Live terminal size for the interactive session.
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
