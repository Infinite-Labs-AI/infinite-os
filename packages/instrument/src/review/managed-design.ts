// What the second reviewer is told about Infinite's managed files (live run 3). Step 9's reviewer read the generated
// outcome helper and blocked the owner's merge on "checkout and lead reporting discard the delivery result and stop
// waiting after 800 ms … no retry": a deliberate, documented choice (a visitor-facing route never waits on Infinite;
// purchases go through the payment webhook, which the payment provider retries). The reviewer now gets, beside the
// diff, which files are Infinite's and their documented design choices. Triage enforces the rest whatever the reviewer
// says: a finding on one of these files goes to Infinite (`triage` INFINITE) and never blocks the owner's pull request
// (`ownerBlockers`).

/** The first line every managed file the install writes carries. */
export const MANAGED_BANNER = /^\s*(?:\/\/|\/\*|<!--)\s*Managed by Infinite\b/

export interface ManagedFileDesign {
  path: string
  /** The file's documented design choices, in plain words (empty = only the general rule applies). */
  design: string[]
}

/** The documented design of each kind of managed file, by its file name (the same words as the hand-off guide). */
const DESIGN: ReadonlyArray<{ name: RegExp; design: readonly string[] }> = [
  {
    name: /(?:^|\/)infinite-outcome\.[cm]?[jt]sx?$/,
    design: [
      "Visitor-facing routes (a checkout start, a sign-up, a lead) report through reportInfiniteOutcomeInBackground: it hands the send to the site's own waitUntil or Next's after(), and with neither it waits at most 800 ms, then lets the route answer the visitor. It does not retry and never fails or slows the visitor's request; an occasional lost checkout-start or lead report is the accepted cost.",
      "Purchases are reported from the signed payment webhook, which awaits the report (bounded at 2 s) and answers 500 only when a retry can deliver it, so the payment provider retries.",
      "reportInfiniteOutcome never throws: it resolves null when nothing reached Infinite, and it sends nothing until its environment variables are set.",
      "Meta match data is hashed with sha256 on the server and rides only when the page's tracking signal allowed it; a phone number is never sent."
    ]
  },
  {
    name: /(?:^|\/)infinite-server-lane\.[cm]?[jt]sx?$/,
    design: ["The page-view recorder runs fire-and-forget inside the host's waitUntil: it never holds or fails a page response."]
  },
  {
    name: /(?:^|\/)infinite-analytics(?:-client)?\.[cm]?[jt]sx?$/,
    design: [
      "Infinite's browser tag starts when the site's own analytics start and stops when they stop; it never reads or changes the cookie banner.",
      "It stays silent off the production hosts by its own host check; a browser Meta event carries only the event id the site's server got back from Infinite."
    ]
  }
]

/** The managed files among `paths` (their text carries the managed banner), each with its documented design. */
export function managedFileDesigns(files: ReadonlyArray<{ path: string; text: string | null }>): ManagedFileDesign[] {
  return files
    .filter((file) => file.text !== null && MANAGED_BANNER.test(file.text.slice(0, 200)))
    .map((file) => ({ path: file.path, design: [...(DESIGN.find((entry) => entry.name.test(file.path))?.design ?? [])] }))
}

/**
 * The reviewer brief's paragraph on Infinite's managed files: which they are, that their documented choices are not
 * findings, and that a real defect in one is reported for Infinite and never blocks this pull request.
 */
export function managedFilesBrief(files: readonly ManagedFileDesign[]): string | null {
  if (files.length === 0) return null
  const lines = [
    `Infinite's managed files in this change: ${files.map((file) => file.path).join(", ")}. infinite-tag generates them, the same for every site, and Infinite reviews and fixes them in its own code; the site's agent never edits them. Review how the site's code CALLS them.`,
    "Their documented design choices below are deliberate: never report one as a finding.",
    ...files.filter((file) => file.design.length > 0).flatMap((file) => [`- ${file.path}:`, ...file.design.map((line) => `  - ${line}`)]),
    "A real defect you still see inside a managed file goes in a finding as usual, with severity \"should\" at most: it is sent to Infinite, never to the site owner, and it never blocks this pull request."
  ]
  return lines.join("\n")
}
