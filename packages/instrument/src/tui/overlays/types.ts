// One overlay per ask kind (§3d.3). An overlay is pure: `init` builds its local state from the payload,
// `render` draws it into lines for a box of a given width, and `onKey` returns the next state and, when the
// user finished, the answer. The TTY UI owns the box, the terminal and the store.
import type { AskAnswer, AskKind, AskPayloads } from "../../wizard/contracts/asks.js"
import type { Styles } from "../ansi.js"
import type { Key } from "../keys.js"
import type { UntrustedSanitizer } from "../ui.js"

export interface OverlayContext {
  /** Inner width of the box (columns available for text). */
  width: number
  /** Lines available for the body (the overlay scrolls its own list inside this). */
  maxBodyLines: number
  styles: Styles
  /** Every payload string an overlay draws goes through this (lane O3's sanitizeUntrusted). */
  sanitize: UntrustedSanitizer
  /** The current spinner frame (for "waiting…" lines). */
  spinner: string
}

export interface OverlayView {
  /** Small line above the question (the design's `n`: "Question 1 of 1", "The plan (one screen)"). */
  heading: string
  /** The question (the design's `q`). */
  question: string
  body: string[]
  /** Key hints, e.g. ["ENTER choose", "↑↓ move"]: the first word is the key. */
  keys: string[]
}

export type KeyOutcome<K extends AskKind, S> = { state: S } | { state: S; answer: AskAnswer<K> }

export interface Overlay<K extends AskKind, S> {
  kind: K
  init(payload: AskPayloads[K]): S
  render(payload: AskPayloads[K], state: S, ctx: OverlayContext): OverlayView
  /**
   * `ctx` is the box the overlay was last drawn in (the TTY UI passes it), for an overlay whose keys depend on
   * what was on screen (the plan: scrolling, and ENTER never approving an unread line).
   */
  onKey(payload: AskPayloads[K], state: S, key: Key, ctx?: OverlayContext): KeyOutcome<K, S>
}

export function answered<K extends AskKind, S>(outcome: KeyOutcome<K, S>): outcome is { state: S; answer: AskAnswer<K> } {
  return "answer" in outcome
}

/** Caps for untrusted text in overlays. */
export const OVERLAY_TEXT_CAPS = { question: 300, option: 120, excerpt: 300, line: 400, label: 120 } as const

/** A selectable list row: `▸ text` when selected, `  text` otherwise. */
export function selectRow(text: string, selected: boolean, styles: Styles): string {
  return selected ? `${styles.accent("▸")} ${styles.bold(text)}` : `  ${text}`
}

/** Keep the window of `items` (each possibly several lines) around `cursor` within `max` lines. */
export function windowAround<T>(items: readonly T[], cursor: number, max: number): { start: number; end: number } {
  if (items.length <= max) return { start: 0, end: items.length }
  const half = Math.floor(max / 2)
  let start = Math.max(0, cursor - half)
  let end = start + max
  if (end > items.length) {
    end = items.length
    start = Math.max(0, end - max)
  }
  return { start, end }
}
