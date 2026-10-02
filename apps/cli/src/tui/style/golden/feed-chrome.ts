// R1's feed (chrome): what the entry point gives the session besides the turn —
// the top bar's workspace and connections, and the busy composer note.
//
// OWNED BY R1. R1 edits THIS file, not screen.ts, when it changes how the
// session's chrome is fed, so lanes never collide in one file.
//
// `ENTRY_SESSION_PROPS` mirrors the props `index.ts` passes the interactive
// session. Since the r4 restyle the entry point passes no placeholder: the
// session's own `COMPOSER_PLACEHOLDER` (`Ask Infinite…`) is what users see, so
// the composer goldens measure the session's default and not a harness string.
import type { HomeInventoryData, InkInteractiveSessionAppProps } from "../../ink/interactive-session.js";
import type { TopBarData } from "../../ink/top-bar.js";
import type { R4ScreenFixture } from "./fixtures.js";

/** The props the entry point gives every interactive session (injected into `renderR4Screen`). */
export type EntrySessionProps = Pick<InkInteractiveSessionAppProps, "promptPlaceholder">;

export const ENTRY_SESSION_PROPS: EntrySessionProps = {};

/** The entry point's home inventory builder (`index.ts` `homeInventoryData`). */
export type HomeInventoryBuilder = (workspace: string | undefined, connections: HomeInventoryData["connections"]) => HomeInventoryData;

/** The fixture's connections as the home inventory takes them (connected, or degraded). */
export function inventoryConnections(fixture: R4ScreenFixture): HomeInventoryData["connections"] {
  return fixture.session.connections.map((connection) => ({
    label: connection.name,
    ...(connection.status === "connected" ? {} : { degraded: true })
  }));
}

/** The fixture's workspace and connections as the top bar takes them (D1): the session runs through the app. */
export function topBarData(fixture: R4ScreenFixture): TopBarData {
  return {
    workspace: fixture.session.workspace,
    sources: fixture.session.connections.map((connection) => ({ label: connection.name, state: connection.status })),
    throughApp: true
  };
}

/**
 * The chrome props for one screen: the entry point's props, the top bar's
 * workspace and connections, and the running turn's busy note (`turn.busy`).
 * No home inventory: the r4 screens are a returning user's, and only the
 * first-ever run prints the inventory (D4). The builder stays in the signature
 * because screen.ts (no lane edits it) injects it.
 */
export function chromeProps(
  fixture: R4ScreenFixture,
  entry: EntrySessionProps,
  _homeInventory: HomeInventoryBuilder
): Partial<InkInteractiveSessionAppProps> {
  return {
    ...entry,
    topBar: topBarData(fixture),
    ...(fixture.turn?.busy ? { busyNote: fixture.turn.busy } : {})
  };
}
