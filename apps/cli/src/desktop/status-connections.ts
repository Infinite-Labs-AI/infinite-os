// Connection dots (`status.connections.v1`): `GET /v1/status` may add
//
//   connections: [{ name: "Catalog", status: "connected" | "broken" | "off" }]
//
// the workspace's sources as the app's own Connections page names them, in the
// app's order. The terminal cannot list them itself (they live in the app), so
// without this field the top bar draws no dots: it never guesses.
//
// The field is read only when the descriptor and the status both advertise the
// capability. Names are DISPLAY text: at most 24 characters and 12 entries,
// scrubbed, and never an id, an email or a URL (such an entry is dropped).
import type { TopBarData, TopBarSource } from "../tui/ink/top-bar.js";
import { isDisplayWords } from "./step-words.js";
import { boundedTerminalText, terminalText } from "./terminal-text.js";

export const STATUS_CONNECTIONS_CAPABILITY = "status.connections.v1" as const;

export const MAX_STATUS_CONNECTIONS = 12;
export const MAX_CONNECTION_NAME_CHARS = 24;

export type DesktopConnectionStatus = "connected" | "broken" | "off";

export interface DesktopConnection {
  name: string;
  status: DesktopConnectionStatus;
}

const STATUSES: ReadonlySet<string> = new Set<DesktopConnectionStatus>(["connected", "broken", "off"]);

/**
 * The status payload's `connections`, cleaned. Undefined when the field is
 * absent or not a list (the bar then draws no dots); an entry that does not
 * decode is dropped, the rest stay. A name said twice keeps its first entry.
 */
export function decodeStatusConnections(value: unknown): DesktopConnection[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const connections: DesktopConnection[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (connections.length >= MAX_STATUS_CONNECTIONS) {
      break;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = connectionName(record.name);
    if (!name || typeof record.status !== "string" || !STATUSES.has(record.status) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    connections.push({ name, status: record.status as DesktopConnectionStatus });
  }
  return connections;
}

function connectionName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = terminalText(value);
  if (!text || text.includes("@") || text.includes("/") || !isDisplayWords(text)) {
    return "";
  }
  const characters = Array.from(text);
  return characters.length <= MAX_CONNECTION_NAME_CHARS
    ? text
    : `${characters.slice(0, MAX_CONNECTION_NAME_CHARS - 1).join("").trimEnd()}…`;
}

/**
 * The connections as the top bar draws them (terminal-r4 row 0): `connected`
 * is the green `●`, `broken` the red `⊘`, `off` (not connected) the amber
 * `⊘`. The bar itself puts the amber and red ones first, and draws an amber
 * one only while it fits beside every connected and broken source: a source
 * that was never connected does not push a connected one off the bar.
 */
export function topBarSourcesFromConnections(connections: readonly DesktopConnection[]): TopBarSource[] {
  return connections.map((connection) => ({
    label: connection.name,
    state: connection.status === "connected" ? "connected" : connection.status === "broken" ? "broken" : "missing"
  }));
}

/** The longest workspace name the top bar takes (the bar cuts what does not fit the window). */
const MAX_WORKSPACE_NAME_CHARS = 80;

/**
 * The desktop session's top bar from a `/v1/status`: the workspace, one dot
 * per connection when the status carries them, and that the session runs
 * through the app. A status without `connections` (an old desktop) draws no
 * dots: the bar never guesses what is connected.
 */
export function desktopTopBarData(status: {
  workspace?: { name: string };
  connections?: readonly DesktopConnection[];
}): TopBarData {
  const workspace = status.workspace?.name
    ? boundedTerminalText(status.workspace.name, MAX_WORKSPACE_NAME_CHARS, "Unknown")
    : undefined;
  return {
    ...(workspace ? { workspace } : {}),
    ...(status.connections ? { sources: topBarSourcesFromConnections(status.connections) } : {}),
    throughApp: true
  };
}
