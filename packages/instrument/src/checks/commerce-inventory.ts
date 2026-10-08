// The event × tool inventory the checks and the prove step read: which commerce and conversion events the site
// already sends to each tool, and which ones this run promised to add.
//
// The checks' own view of the scan's inventory (`src/scan/event-inventory.ts`, owned by the scan): one cell per event
// × tool, `already_sent` / `will_add` / `cannot`. `readEventInventory` reads the scan's shape (`events`, Meta split
// into meta_browser / meta_server, gaps in `missing`) or this one (`rows`); the checks read only `promisesOf` and
// `alreadySentOf` below.
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

/** The scan's tool names (`src/scan/event-inventory.ts`): Meta is split by lane there. */
const SCAN_TOOLS: Readonly<Record<string, { tool: InventoryTool; lane: "browser" | "server" }>> = {
  ga4: { tool: "ga4", lane: "browser" },
  posthog: { tool: "posthog", lane: "browser" },
  meta_browser: { tool: "meta", lane: "browser" },
  meta_server: { tool: "meta", lane: "server" },
  infinite: { tool: "infinite", lane: "server" }
}

/**
 * The scan's own inventory shape (`buildEventInventory(snapshot)` → `{ events: [{ event, sites, tools, missing }] }`):
 * a tool with sites already gets the event; a tool in `missing` is a gap this run fills (the plan's promise).
 */
function fromScanShape(events: unknown[]): EventInventory {
  const rows: InventoryRow[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as { event?: unknown; sites?: unknown; tools?: unknown; missing?: unknown }
    if (!isEvent(entry.event)) continue
    const tools: InventoryRow["tools"] = {}
    const sitesOf = (value: unknown) => (Array.isArray(value) ? value.filter((site): site is { file: string; line: number } => !!site && typeof site === "object" && typeof (site as { file?: unknown }).file === "string").map((site) => ({ file: site.file, line: Number(site.line) || 1 })) : [])
    for (const [name, sites] of Object.entries(entry.tools && typeof entry.tools === "object" ? entry.tools : {})) {
      const known = SCAN_TOOLS[name]
      const evidence = sitesOf(sites)
      if (known && evidence.length > 0) tools[known.tool] = { state: "already_sent", lane: known.lane, evidence: [...(tools[known.tool]?.evidence ?? []), ...evidence] }
    }
    for (const name of Array.isArray(entry.missing) ? entry.missing : []) {
      const known = typeof name === "string" ? SCAN_TOOLS[name] : undefined
      if (known && tools[known.tool]?.state !== "already_sent") tools[known.tool] = { state: "will_add", lane: known.lane }
    }
    const sites = sitesOf(entry.sites)
    rows.push({ event: entry.event, tools, ...(sites.length > 0 ? { sites } : {}) })
  }
  return { rows }
}

/**
 * A loose read of an unknown value (a JSON file, or the scan's own result): rows with a known event and tool cells
 * with a known state. Both this file's shape (`rows`) and the scan's (`events`) are read.
 */
export function readEventInventory(value: unknown): EventInventory | null {
  if (value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)) return fromScanShape((value as { events: unknown[] }).events)
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
