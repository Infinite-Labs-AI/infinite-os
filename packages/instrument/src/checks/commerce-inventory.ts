// The event × tool inventory the checks and the prove step read: which commerce and conversion events the site
// already sends to each tool, and which ones this run promised to add.
//
// LOCAL COPY of the scan's inventory shape (`src/scan/event-inventory.ts`, owned by the scan). The checks only read
// it, through `promisesOf` and `alreadySentOf` below, so when the scan's own type lands the copy is replaced by an
// import and nothing else here changes. Every field the checks need is listed; anything else on a row is ignored.
//
// Where the run keeps it: `before-facts.json` → `eventInventory` (read by `src/wizard/deps.ts` for the static checks,
// and by the prove step). Absent = the plan's promises are unknown, and every check that needs them reads
// `undetermined`, never a pass.

/** The events the inventory tracks, by their canonical (GA4-style) name. */
export const INVENTORY_EVENTS = ["view_item", "add_to_cart", "begin_checkout", "purchase", "lead", "sign_up", "start_trial"] as const
export type InventoryEvent = (typeof INVENTORY_EVENTS)[number]

export const INVENTORY_TOOLS = ["meta", "ga4", "posthog", "infinite"] as const
export type InventoryTool = (typeof INVENTORY_TOOLS)[number]

/** One event × tool cell: the site sends it already, this run adds it, or it cannot be added (with the reason). */
export interface InventoryCell {
  state: "already_sent" | "will_add" | "cannot"
  /** Where the tool gets it: from the page, or from the site's server through Infinite (Meta's relay). */
  lane?: "browser" | "server"
  /** The name the site already uses for it in that tool (`product_added` in PostHog for `add_to_cart`). */
  siteEventName?: string
  reason?: string
  evidence?: Array<{ file: string; line: number }>
}

export interface InventoryRow {
  event: InventoryEvent
  tools: Partial<Record<InventoryTool, InventoryCell>>
  /** Where the event happens in the site's code (the trigger points: a Buy handler, a success branch, an API route). */
  sites?: Array<{ file: string; line: number }>
}

export interface EventInventory {
  rows: InventoryRow[]
}

export interface InventoryPromise {
  event: InventoryEvent
  tool: InventoryTool
  lane: "browser" | "server"
}

/** Browser-only Meta events: everything else reaches Meta from the server, through Infinite. */
export const META_BROWSER_EVENTS: ReadonlySet<InventoryEvent> = new Set<InventoryEvent>(["view_item", "add_to_cart"])

function isEvent(value: unknown): value is InventoryEvent {
  return typeof value === "string" && (INVENTORY_EVENTS as readonly string[]).includes(value)
}

/** A loose read of an unknown value (a JSON file): rows with a known event and tool cells with a known state. */
export function readEventInventory(value: unknown): EventInventory | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { rows?: unknown }).rows)) return null
  const rows: InventoryRow[] = []
  for (const raw of (value as { rows: unknown[] }).rows) {
    if (!raw || typeof raw !== "object") continue
    const record = raw as Record<string, unknown>
    if (!isEvent(record.event) || !record.tools || typeof record.tools !== "object") continue
    const tools: InventoryRow["tools"] = {}
    for (const tool of INVENTORY_TOOLS) {
      const cell = (record.tools as Record<string, unknown>)[tool]
      if (!cell || typeof cell !== "object") continue
      const state = (cell as { state?: unknown }).state
      if (state !== "already_sent" && state !== "will_add" && state !== "cannot") continue
      tools[tool] = cell as InventoryCell
    }
    const sites = Array.isArray(record.sites) ? (record.sites as InventoryRow["sites"]) : undefined
    rows.push({ event: record.event, tools, ...(sites ? { sites } : {}) })
  }
  return { rows }
}

/** What the plan promised: each event × tool cell this run adds, with its lane (Meta's server events default to server). */
export function promisesOf(inventory: EventInventory): InventoryPromise[] {
  const out: InventoryPromise[] = []
  for (const row of inventory.rows) {
    for (const tool of INVENTORY_TOOLS) {
      const cell = row.tools[tool]
      if (cell?.state !== "will_add") continue
      const lane = cell.lane ?? (tool === "meta" && !META_BROWSER_EVENTS.has(row.event) ? "server" : "browser")
      out.push({ event: row.event, tool, lane })
    }
  }
  return out
}

/** The event × tool pairs the site already sends (a new send of one of these counts it twice). */
export function alreadySentOf(inventory: EventInventory): Array<{ event: InventoryEvent; tool: InventoryTool; evidence: Array<{ file: string; line: number }> }> {
  const out: Array<{ event: InventoryEvent; tool: InventoryTool; evidence: Array<{ file: string; line: number }> }> = []
  for (const row of inventory.rows) {
    for (const tool of INVENTORY_TOOLS) {
      const cell = row.tools[tool]
      if (cell?.state === "already_sent") out.push({ event: row.event, tool, evidence: cell.evidence ?? [] })
    }
  }
  return out
}
