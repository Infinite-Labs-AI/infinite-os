// R1's feed (chrome): what the entry point gives the session besides the turn —
// the composer placeholder, the boot home inventory, and (when R1 wires them)
// the top bar's workspace and connections and the busy composer note.
//
// OWNED BY R1. R1 edits THIS file, not screen.ts, when it changes how the
// session's chrome is fed, so lanes never collide in one file.
//
// `ENTRY_SESSION_PROPS` mirrors the props `index.ts` passes the interactive
// session (its `promptPlaceholder` literal at the interactive entry). R1: export
// those props (or a `SESSION_PROMPT_PLACEHOLDER`) from `index.ts` and import
// them in golden.test.ts in place of this copy, so the composer goldens measure
// what the entry point passes and not the harness's own string.
import type { HomeInventoryData, InkInteractiveSessionAppProps } from "../../ink/interactive-session.js";
import type { R4ScreenFixture } from "./fixtures.js";

/** The props the entry point gives every interactive session (injected into `renderR4Screen`). */
export type EntrySessionProps = Pick<InkInteractiveSessionAppProps, "promptPlaceholder">;

export const ENTRY_SESSION_PROPS: EntrySessionProps = { promptPlaceholder: "Type a message, /help, or /exit." };

/** The entry point's home inventory builder (`index.ts` `homeInventoryData`). */
export type HomeInventoryBuilder = (workspace: string | undefined, connections: HomeInventoryData["connections"]) => HomeInventoryData;

/** The fixture's connections as the home inventory takes them (connected, or degraded). */
export function inventoryConnections(fixture: R4ScreenFixture): HomeInventoryData["connections"] {
  return fixture.session.connections.map((connection) => ({
    label: connection.name,
    ...(connection.status === "connected" ? {} : { degraded: true })
  }));
}

/**
 * The chrome props for one screen: the entry point's props, plus the home
 * inventory at boot. Today the top bar's workspace and connections reach the
 * session ONLY through the boot inventory, and the busy note (`turn.busy`) not
 * at all: R1 adds them here.
 */
export function chromeProps(
  fixture: R4ScreenFixture,
  entry: EntrySessionProps,
  homeInventory: HomeInventoryBuilder
): Partial<InkInteractiveSessionAppProps> {
  return {
    ...entry,
    ...(fixture.turn ? {} : { homeInventory: homeInventory(fixture.session.workspace, inventoryConnections(fixture)) })
  };
}
