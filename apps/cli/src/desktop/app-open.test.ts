// P33-S2: what `o` says when the app refuses to open a place. Words for the
// user, never the bridge's developer words. Pure, CI-run. Synthetic data only.
import { describe, expect, it } from "vitest";

import { DesktopAppClientError } from "../desktop-app-client.js";
import { appOpenLines } from "./app-open.js";

const GENERIC = "! The app can't open that place right now.";

describe("`o` when the app refuses", () => {
  it.each([
    ["invalid_request", "place must be a registered app place."],
    ["invalid_request", "params do not fit this place."],
    ["app_open_failed", "Router threw: Cannot read properties of undefined"],
    ["capability_unavailable", "app.open.v1 is not available."],
    ["some_new_bridge_code", "internal detail"]
  ])("%s prints the generic line, never the bridge's words", (code, message) => {
    const lines = appOpenLines(new DesktopAppClientError(code, message));
    expect(lines).toEqual([GENERIC]);
    expect(lines.join("\n")).not.toContain(message);
  });

  it("an error without a code prints the generic line", () => {
    expect(appOpenLines(new Error("fetch failed: ECONNRESET"))).toEqual([GENERIC]);
  });

  it.each([
    ["desktop_update_required", "Opening places from the terminal needs a newer Infinite Desktop. Update Desktop and try again."],
    ["desktop_app_usage", "There is no app place to open here."],
    ["desktop_not_running", "Infinite Desktop is not running for this runtime. Start Desktop and try again."],
    ["desktop_unreachable", "Infinite Desktop stopped responding. Start or restart Desktop and try again."],
    ["desktop_not_ready", "Sign in to Infinite Desktop first."]
  ])("%s keeps its own user words", (code, message) => {
    expect(appOpenLines(new DesktopAppClientError(code, message))).toEqual([`! ${message}`]);
  });
});
