// The T12 wave's target (app links and follow-up keys: o t p g w e enter),
// kept for the frame goldens the one-column default (V1, River 2026-10-15)
// re-drew from the CLI's own renderer (`drawn_by`). Until then those frames
// were r4's design and sat on the expected-fail list with a T12 reason; as
// snapshots of today's CLI they match, so the ratchet no longer sees T12 there.
//
// Each entry names what r4 drew on that frame and the CLI does not draw yet:
// `keybar`, hints of the key bar (`o open`, whitespace collapsed), and `body`,
// texts above the composer (a card's `o open in Meta Ads` chip, an app link
// `Open in Library ↗ (o)`). The test (golden.test.ts) checks every one is
// still missing from the screen. When T12 draws one, the test fails: re-draw
// the frame (`apps/cli/scripts/redraw-goldens.mts <id> --write`, see goldens.ts),
// review it against the r4 text here, and drop what landed from this list.
//
// Derived once from the r4 goldens these frames replaced (infinite-os
// 68d6367, `__goldens__/`): the T12 key-bar hints and the T12 chips and app
// links that the re-drawn frame lacks. Synthetic data only.

/** What r4 draws on a re-drawn frame that waits for T12: its key-bar hints and body texts. */
export interface T12Gap {
  keybar: readonly string[];
  body: readonly string[];
}

export const T12_GAPS: Readonly<Record<string, T12Gap>> = {
  "flow-email-03-done--c100": { keybar: ["p pause sending", "o open"], body: ["p pause sending", "o open in Email Campaigns"] },
  "flow-email-03-done--c160": { keybar: ["p pause sending", "o open"], body: ["p pause sending", "o open in Email Campaigns"] },
  "flow-email-03-done--c60": { keybar: ["p pause sending", "o open"], body: ["p pause sending", "o open in Email Campaigns"] },
  "flow-email-05-not-approved-yet--c100": { keybar: ["o open"], body: ["Approve it in Email Campaigns ↗"] },
  "flow-email-05-not-approved-yet--c160": { keybar: ["o open"], body: ["Approve it in Email Campaigns ↗"] },
  "flow-email-05-not-approved-yet--c60": { keybar: ["o open"], body: ["Approve it in Email Campaigns ↗"] },
  "flow-images-03-partial--c100": { keybar: ["o open", "g redo 3rd"], body: ["Open the 2 in Library ↗ (o)", "g redo the 3rd (~$0.17)"] },
  "flow-images-03-partial--c160": { keybar: ["o open", "g redo 3rd"], body: ["Open the 2 in Library ↗ (o)", "g redo the 3rd (~$0.17)"] },
  "flow-images-03-partial--c60": { keybar: ["o open", "g redo 3rd"], body: ["Open the 2 in Library ↗ (o)", "g redo the 3rd (~$0.17)"] },
  "flow-images-04-done--c100": { keybar: ["o open in Library"], body: ["Open in Library ↗ (o)"] },
  "flow-images-04-done--c160": { keybar: ["o open in Library"], body: ["Open in Library ↗ (o)"] },
  "flow-images-04-done--c60": { keybar: ["o open in Library"], body: ["Open in Library ↗ (o)"] },
  "flow-images-07-cmd-l-only--c100": { keybar: ["o open Cmd+L", "g make 3 here"], body: ["o open Cmd+L", "g make 3 here (~$0.52)"] },
  "flow-images-07-cmd-l-only--c160": { keybar: ["o open Cmd+L", "g make 3 here"], body: ["o open Cmd+L", "g make 3 here (~$0.52)"] },
  "flow-images-07-cmd-l-only--c60": { keybar: ["o open Cmd+L", "g make 3 here"], body: ["o open Cmd+L", "g make 3 here (~$0.52)"] },
  "flow-numbers-05-not-connected--c100": { keybar: ["o connect"], body: ["Connect it in the app ↗ (o)"] },
  "flow-numbers-05-not-connected--c160": { keybar: ["o connect"], body: ["Connect it in the app ↗ (o)"] },
  "flow-numbers-05-not-connected--c60": { keybar: ["o connect"], body: ["Connect it in the app ↗ (o)"] },
  "flow-pause-03-done--c100": { keybar: ["t turn back on", "o open"], body: ["t turn back on", "o open in Meta Ads"] },
  "flow-pause-03-done--c160": { keybar: ["t turn back on", "o open"], body: ["t turn back on", "o open in Meta Ads"] },
  "flow-pause-03-done--c60": { keybar: ["t turn back on", "o open"], body: ["t turn back on", "o open in Meta Ads"] },
  "flow-pause-05-nothing-to-change--c100": { keybar: ["o open"], body: ["Live refresh in Meta Ads ↗"] },
  "flow-pause-05-nothing-to-change--c160": { keybar: ["o open"], body: ["Live refresh in Meta Ads ↗"] },
  "flow-pause-05-nothing-to-change--c60": { keybar: ["o open"], body: [] },
  "flow-pause-07-still-running--c100": { keybar: [], body: ["o open Meta Ads"] },
  "flow-pause-07-still-running--c160": { keybar: [], body: ["o open Meta Ads"] },
  "flow-pause-07-still-running--c60": { keybar: [], body: ["o open Meta Ads"] },
  "view-01-numbers--c100": { keybar: ["o open"], body: ["Open in Google Ads ↗"] },
  "view-01-numbers--c160": { keybar: ["o open"], body: ["Open in Google Ads ↗"] },
  "view-01-numbers--c60": { keybar: ["o open"], body: ["Open in Google Ads ↗"] },
  "view-02-list--c100": { keybar: ["enter open", "p pause"], body: ["enter details", "p pause", "o open in Meta Ads"] },
  "view-02-list--c160": { keybar: ["enter open", "p pause"], body: ["enter details", "p pause", "o open in Meta Ads"] },
  "view-02-list--c60": { keybar: ["enter open", "p pause"], body: ["enter details", "p pause", "o open in Meta Ads"] },
  "view-03-record--c100": { keybar: ["p pause", "o open"], body: [] },
  "view-03-record--c160": { keybar: ["p pause", "o open"], body: [] },
  "view-03-record--c60": { keybar: ["p pause", "o open"], body: [] },
  "view-04-document--c100": { keybar: ["o open"], body: ["o open in Email Campaigns"] },
  "view-04-document--c160": { keybar: ["o open"], body: ["o open in Email Campaigns"] },
  "view-04-document--c60": { keybar: ["o open"], body: ["o open in Email Campaig"] },
  "view-05-images--c100": { keybar: ["o open in Library"], body: ["Open in Library ↗ (o)"] },
  "view-05-images--c160": { keybar: ["o open in Library"], body: ["Open in Library ↗ (o)"] },
  "view-05-images--c60": { keybar: ["o open in Library"], body: ["Open in Library ↗ (o)"] },
  "view-06-change--c100": { keybar: [], body: ["o open in Meta Ads"] },
  "view-06-change--c160": { keybar: [], body: ["o open in Meta Ads"] },
  "view-06-change--c60": { keybar: [], body: ["o open in Meta Ads"] },
  "view-07-launch--c100": { keybar: ["o previews"], body: ["o previews"] },
  "view-07-launch--c160": { keybar: ["o previews"], body: ["o previews"] },
  "view-07-launch--c60": { keybar: ["o previews"], body: ["o previews"] },
  "view-08-job--c100": { keybar: ["w watch", "o open"], body: [] },
  "view-08-job--c160": { keybar: ["w watch", "o open"], body: [] },
  "view-08-job--c60": { keybar: ["w watch", "o open"], body: [] },
  "view-09-compare--c60": { keybar: ["o open"], body: ["Open the test in Website ↗"] },
  "view-10-health--c100": { keybar: ["o reconnect"], body: ["Reconnect Shopify ↗ (o)"] },
  "view-10-health--c160": { keybar: ["o reconnect"], body: ["Reconnect Shopify ↗ (o)"] },
  "view-10-health--c60": { keybar: ["o reconnect"], body: ["Reconnect Shopify ↗ (o)"] },
  "view-11-link--c100": { keybar: ["e edit"], body: ["e edit in the app"] },
  "view-11-link--c160": { keybar: ["e edit"], body: ["e edit in the app"] },
  "view-11-link--c60": { keybar: ["e edit"], body: ["e edit in the app"] }
};
