// What `data-conversion` MEANS, read out of the runtime that consumes it.
//
// The rule is never written down here. It is parsed from `INFINITE_BROWSER_RUNTIME_SOURCE`, so a
// selector edited in `runtime/infinite-browser.ts` changes what these checks say without anyone
// remembering to update a second list. The wrong-element bug survived precisely because two places
// held two different beliefs about this one attribute: `harness/marking.ts` treated its presence as
// "already handled" while the runtime read it through two listeners with two different tag rules.
//
// If the parse comes back empty the checks report `undetermined` and say so. It must never be read
// as "nothing marked wrong" — a contract we could not read is not a clean bill of health.
import { INFINITE_BROWSER_RUNTIME_SOURCE } from "../runtime/infinite-browser.js"

/** One way the runtime reacts to a `data-conversion` value: an event type plus a tag requirement. */
export interface ConversionLane {
  /** The attribute value this lane matches, e.g. `signup`. */
  value: string
  /** The DOM event whose listener holds the selector. */
  event: string
  /** The tag the selector demands (`form`), or null when any element matches. */
  requiredTag: string | null
  /** The selector exactly as the runtime spells it — quoted back to the customer verbatim. */
  selector: string
}

/**
 * Every quoted CSS selector in the source that mentions `data-conversion`, attributed to the
 * listener it sits inside.
 *
 * The listener is decided by the NEAREST PRECEDING `addEventListener("<type>"`, which is how the
 * source actually reads: each selector is used inside the handler that lexically precedes it.
 */
export function parseConversionLanes(runtimeSource: string): ConversionLane[] {
  const listeners = [...runtimeSource.matchAll(/addEventListener\(\s*["'](\w+)["']/g)].map(
    (match) => ({ index: match.index ?? 0, event: match[1] as string })
  )
  const lanes: ConversionLane[] = []
  const selectors = runtimeSource.matchAll(
    /["'`](([a-zA-Z][\w-]*)?\[data-conversion=["']([^"'\]]+)["']\])["'`]/g
  )
  for (const match of selectors) {
    const at = match.index ?? 0
    let event = "unknown"
    for (const listener of listeners) {
      if (listener.index < at) event = listener.event
      else break
    }
    const selector = match[1] as string
    const requiredTag = match[2] ? match[2].toLowerCase() : null
    const value = match[3] as string
    if (lanes.some((lane) => lane.selector === selector && lane.event === event)) continue
    lanes.push({ value, event, requiredTag, selector })
  }
  return lanes
}

/** The lanes of the runtime this build ships. Empty means the parse failed — never "all clear". */
export function runtimeConversionLanes(): ConversionLane[] {
  return parseConversionLanes(INFINITE_BROWSER_RUNTIME_SOURCE)
}

/** The values the runtime reads at all, de-duplicated and sorted for stable copy. */
export function knownConversionValues(lanes: readonly ConversionLane[]): string[] {
  return [...new Set(lanes.map((lane) => lane.value))].sort()
}

/** Lanes that would fire for this value on an element with this tag. */
export function lanesFor(
  lanes: readonly ConversionLane[],
  value: string,
  tag: string
): ConversionLane[] {
  return lanes.filter(
    (lane) => lane.value === value && (lane.requiredTag === null || lane.requiredTag === tag)
  )
}

/** Lanes for this value that this element's tag LOCKS OUT — the ones the author may have meant. */
export function lanesMissedBy(
  lanes: readonly ConversionLane[],
  value: string,
  tag: string
): ConversionLane[] {
  return lanes.filter(
    (lane) => lane.value === value && lane.requiredTag !== null && lane.requiredTag !== tag
  )
}
