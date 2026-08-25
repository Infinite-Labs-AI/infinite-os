// The big "INFINITE" ANSI-Shadow block-letter wordmark, shared by the first-run
// welcome (`infinite-welcome.tsx`) and the every-launch home inventory
// (`home-inventory.tsx`) so the art lives in ONE place and is reused, never
// re-hand-drawn. Six fixed-width rows; the dither shimmer only swaps █ for a
// lighter block glyph per row and never changes a row's width or count, so every
// frame is the same size.
export const INFINITE_ART: readonly string[] = [
  " ██╗███╗   ██╗███████╗██╗███╗   ██╗██╗████████╗███████╗",
  " ██║████╗  ██║██╔════╝██║████╗  ██║██║╚══██╔══╝██╔════╝",
  " ██║██╔██╗ ██║█████╗  ██║██╔██╗ ██║██║   ██║   █████╗  ",
  " ██║██║╚██╗██║██╔══╝  ██║██║╚██╗██║██║   ██║   ██╔══╝  ",
  " ██║██║ ╚████║██║     ██║██║ ╚████║██║   ██║   ███████╗",
  " ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚══════╝"
];

/** Render width of the block art (every row is this wide). */
export const ART_WIDTH = INFINITE_ART[0]!.length; // 54

/** Minimum terminal columns to draw the big block art (vs. the compact ∞ INFINITE). */
export const MIN_BIG_COLUMNS = ART_WIDTH + 4;
