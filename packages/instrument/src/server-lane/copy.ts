// ALL server-lane prose lives here — the agent brief (INSTALL-SERVER-LANE.md / `server-lane --brief`),
// the CLI narration, and the verify PASS/FAIL wording. Edit words here; code lives in
// helpers.ts (recipe), runtime-source.ts (generated Next.js code), snippets.ts (reference
// implementations), install.ts (files), verify.ts (network check).
import type { ServerLaneMode } from "../types.js"
import {
  infiniteServerEventsDestination,
  infiniteServerLaneReceiptUrl
} from "../workspace-artifacts.js"

import {
  DOCUMENT_REQUEST_EVENT_NAME,
  SERVER_LANE_DELIVERY_TIMEOUT_MS,
  SERVER_LANE_SECRET_ENV,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_ENV,
  SERVER_LANE_SOURCE_KEY_HEADER,
  VISIT_BUCKET_SECONDS
} from "./helpers.js"
import {
  NEXT_DOCUMENT_MATCHER,
  buildCreatedMiddlewareSource,
  buildServerLaneModuleSource
} from "./runtime-source.js"
import {
  cloudflareWorkerSnippet,
  expressSnippet,
  manualNextMiddlewareAddition,
  netlifyEdgeSnippet,
  nextOutcomeSnippet,
  nodeHelperSnippet,
  outcomeRouteSnippet,
  outcomeSnippet,
  webCryptoHelperSnippet
} from "./snippets.js"

export const SERVER_LANE_POSITIONING =
  "server-side analytics: every page your server serves and every outcome it confirms, counted where ad-blockers can't reach. A floor for people, never an exact share — installed by your agent in ten minutes."

export const SERVER_LANE_BRIEF_FILE = "INSTALL-SERVER-LANE.md"

/** First line of the written brief; `removeManagedFile` keys off "Managed by Infinite". */
export const SERVER_LANE_BRIEF_BANNER =
  "<!-- Managed by Infinite (infinite-tag). Regenerate any time with: npx infinite-tag server-lane --brief -->"

export type ServerLaneBriefStatus =
  | { kind: "created"; middlewarePath: string; modulePath: string }
  | { kind: "patched"; middlewarePath: string; modulePath: string }
  | { kind: "kept"; middlewarePath: string; modulePath: string }
  | { kind: "unpatchable"; middlewarePath: string; modulePath: string; reason: string }
  | { kind: "next-manual"; modulePath: string }
  | {
      /** A non-Next target (Vercel / Netlify / Cloudflare Pages / Node) that wrote real files. */
      kind: "target"
      mode: ServerLaneMode
      label: string
      /** Root-relative files written, in write order. */
      created: string[]
      /** Files that could not be written, with the exact contents to add by hand. */
      manual: Array<{ path: string; reason: string; contents: string }>
      /** Packages the generated entry imports that the repo may not depend on yet. */
      installPackages: string[]
      /** The node target's exact mount lines; absent for every other target. */
      mount?: string
    }
  | { kind: "other-stack"; framework: string }

export interface ServerLaneBriefInput {
  status: ServerLaneBriefStatus
  siteSourceKey?: string
  productionHosts?: string[]
  /** Import specifier from the middleware to the managed module. */
  moduleImportPath?: string
  /** The resolved `--infinite-api-origin`, so the brief's URLs match the code that was written. */
  apiOrigin?: string
}

const DEFAULT_MODULE_IMPORT_PATH = "./lib/infinite-server-lane"

export const serverLaneCopy = {
  title: "Infinite server lane — install brief for your coding agent",

  whatAndWhy: [
    "Client-side tags (GA4, PostHog, pixels) see well under half of real traffic — ad-blockers, consent gates, and privacy browsers drop them before the first byte. The Infinite server lane counts on the other side of that wall: your server records every HTML document it serves and every conversion it confirms, signs each record, and posts it to Infinite. The board you get back — Visitors, your outcome (downloads, sign-ups, purchases), and the rate between them — matches your server logs, not a sample.",
    "It is private by construction. Your server hashes the visitor identity itself (IP + user agent + a 30-minute window, keyed by a secret only you hold) and sends the hash; the raw IP and full user agent never leave your infrastructure. No cookies, no query strings, no request bodies. Delivery is fire-and-forget with a two-second ceiling, so it can never slow down or break a page."
  ],

  statusHeading: "Where you are",
  status: {
    created: (middlewarePath: string, modulePath: string) =>
      `infinite-tag CREATED \`${middlewarePath}\` and \`${modulePath}\`. Nothing else to write. Set the two environment variables below, deploy, then run the verify command.`,
    patched: (middlewarePath: string, modulePath: string) =>
      `infinite-tag PATCHED your existing \`${middlewarePath}\` (fenced \`// infinite-tag:server-lane:start … :end\` blocks; your handler body is unchanged, now wrapped by \`withInfiniteServerLane\`) and created \`${modulePath}\`. Review \`git diff\`, set the two environment variables below, deploy, then run the verify command.`,
    kept: (middlewarePath: string, modulePath: string) =>
      `\`${middlewarePath}\` already carries the infinite-tag server-lane fence, so it was left as is; \`${modulePath}\` is the managed module. Set the two environment variables below, deploy, then run the verify command.`,
    unpatchable: (middlewarePath: string, modulePath: string, reason: string) =>
      `infinite-tag did NOT touch your existing \`${middlewarePath}\` — ${reason} It DID create \`${modulePath}\` (the managed module). Your job: wire the module into the middleware by hand using the exact addition below, keep your own logic scoped by path, and make sure the matcher lets every HTML document through.`,
    nextManual: (modulePath: string) =>
      `This is a Next.js project. Create \`${modulePath}\` from the "Next.js" reference below (or run \`npx infinite-tag install --server-lane\` in the repo), then wire the middleware as shown.`,
    target: (label: string, created: string[]) =>
      created.length > 0
        ? `infinite-tag installed the ${label} server lane and wrote ${created.map((path) => `\`${path}\``).join(", ")}. Everything below is already in the repo — review \`git diff\`, then set the two environment variables, deploy, and run the verify command.`
        : `infinite-tag chose the ${label} server lane but wrote nothing this run (see the notes below). Add the files by hand from the code in this brief, set the two environment variables, deploy, then run the verify command.`,
    targetPackages: (packages: string[]) =>
      `The generated entry imports ${packages.map((name) => `\`${name}\``).join(", ")}. infinite-tag never installs packages, so add it yourself: \`npm install ${packages.join(" ")}\` (or your package manager's equivalent). Without it the build fails at the import.`,
    targetMount:
      "Nothing was wired into your server file: there is no safe, reversible place to guess. Add these two lines yourself, BEFORE your routes and your static handler.",
    targetManual: (path: string, reason: string) =>
      `\`${path}\` was NOT written — ${reason}. Create it with exactly this content:`,
    otherStack: (framework: string) =>
      `This project was detected as "${framework}" — infinite-tag does not patch it automatically. Pick the reference implementation below that matches your runtime (Express / any Node server, Cloudflare Workers, Netlify Edge; anything else follows the generic Node helper), add it in front of your HTML routes, then report outcomes from wherever they become real.`
  },
  exactAdditionHeading: "Exactly what to add to your middleware",
  targetPackagesHeading: "One package to install",
  targetMountHeading: "Mount it in your server",
  targetManualHeading: "Files to add by hand",
  outcomeRouteHeading: "Post a purchase from a server route",
  outcomeRouteIntro:
    "The lane counts page views on its own. Outcomes are yours to report, from the moment they become REAL — a committed row, a captured payment, a served file — never from a click. The generated `lib/infinite-outcome` helper does the signing, the visit-key derivation, and the timeout, so a route needs three lines:",
  outcomeRouteVercel:
    "A Vercel serverless function (`api/checkout-status.ts`) confirming a paid session:",
  outcomeRouteNote:
    "`type` is the exact name from Infinite → Conversions. Pass the incoming request as `visitKeyInputs` and the outcome carries the same `visitKey` as the page view that produced it, which is what makes the same-lane conversion rate real. Give each outcome a stable `eventId` (an order id) so a retry never double counts. It resolves `false` instead of throwing, so a failed report can never fail the checkout.",
  adMatchHeading: "Optional: forward the conversion to Meta",
  adMatch: [
    "Only if you run **Meta ads and do not use PostHog** — PostHog already ships its own Meta destination, and two senders for one conversion is a double count.",
    "Add an `adMatch` block to the outcome and turn the relay on in Infinite → Site → Settings → “Send outcomes to Meta Conversions API”. The outcome is then forwarded to Meta's Conversions API as it is ingested, and the match data is **discarded**: Infinite never stores it, never writes it to your ledger, never logs it. Nothing happens without both the block and the toggle.",
    "```ts",
    'import { createHash } from "node:crypto"',
    "",
    "await postInfiniteOutcome({",
    '  type: "purchase",',
    '  eventId: "purchase:" + order.id,   // Meta gets the same event_id, so your browser pixel dedupes',
    "  adMatch: {",
    '    em: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),',
    '    fbc: cookies.get("_fbc"),        // Meta\u2019s own first-party cookies, on YOUR domain',
    '    fbp: cookies.get("_fbp")',
    "  }",
    "})",
    "```",
    "- **You hash; Infinite never does.** `em` and `external_id` are sha256 hex of the trimmed, lowercased value. A raw email never leaves your server, and a value that is not a 64-character hex digest is rejected with a `400` rather than forwarded — so a mistake shows up now, not as an empty match rate in three months.",
    "- **`fbc` / `fbp` are Meta's own cookies** on your domain, which your server can read from the request ([fbp and fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc)).",
    "- **`eventId` is passed to Meta as `event_id`**, so a browser pixel firing the same id deduplicates instead of counting the conversion twice.",
    "- **The IP and user agent Meta wants** are read from the outcome request's own headers at forwarding time and are never stored — the lane's rule that neither ever reaches the ledger is unchanged.",
    "- `adMatch` rides inside the SIGNED body, so nobody without your secret can inject one. It is never valid on a document request."
  ],

  contractHeading: "The contract (implement exactly)",
  contract: {
    transport: (apiOrigin?: string) => [
      `**Transport.** Signed \`POST ${infiniteServerEventsDestination(apiOrigin)}\` with \`content-type: application/json\`.`,
      `**Headers.** \`${SERVER_LANE_SOURCE_KEY_HEADER}: <site source key>\` and \`${SERVER_LANE_SIGNATURE_HEADER}: <lowercase hex HMAC-SHA256 of the RAW request body under the secret>\`. Sign the exact bytes you send.`,
      `**Environment.** \`${SERVER_LANE_SECRET_ENV}\` — the source's server-event secret, minted once in the Infinite desktop → Site Analytics → Settings → Conversions → Server events (shown once; store it only in your host's environment). \`${SERVER_LANE_SOURCE_KEY_ENV}\` — the public site source key (the same one the browser pixel uses).`
    ],
    documentRequest: [
      `**1. Document request** — one per HTML page load (GET, non-asset, non-API):`,
      "```json",
      `{ "eventId": "doc:<hex>", "eventName": "${DOCUMENT_REQUEST_EVENT_NAME}", "occurredAt": "<ISO now>",`,
      `  "properties": { "path": "/pricing", "host": "example.com", "visitKey": "<hex>", "userAgentFamily": "browser", "referrerHost": "google.com" } }`,
      "```",
      `- \`visitKey\` = hex HMAC-SHA256(secret, \`"visit:" + clientIp + "|" + userAgent + "|" + floor(epochSeconds / ${VISIT_BUCKET_SECONDS})\`) — computed on YOUR server; the IP never leaves it.`,
      "- `eventId` = `\"doc:\" + hex HMAC-SHA256(secret, visitKey + \"|\" + path + \"|\" + occurredAtMs)` — deterministic, so a retry with the same values is safe (the server dedupes on eventId).",
      "- `userAgentFamily` ∈ `browser | automation | unknown` from a small conservative bot list (bot, crawler, spider, headless, preview, monitor, curl, wget, python-requests, …); empty UA → `unknown`.",
      "- `path` is the pathname only (no query string, no fragment). `host` is the request host and must be one of the site's verified production hosts — Infinite rejects others.",
      "- `referrerHost` is optional: the hostname of the Referer header when present, never its path."
    ],
    outcome: [
      "**2. Outcome** — your conversions (sign-up completed, purchase, download served), same endpoint and headers:",
      "```json",
      `{ "eventId": "signup:12345", "eventName": "sign_up", "occurredAt": "<ISO now>", "accountKey": "12345",`,
      `  "properties": { "visitKey": "<hex, when computed for that request>" } }`,
      "```",
      "- `eventName` is the exact taxonomy name shown in Infinite → Conversions for that outcome (`sign_up`, `purchase`, `download`, …). Undeclared names are rejected, never stored.",
      "- Send it from where the outcome becomes REAL (row committed, payment captured, file served) — never from a click.",
      "- `properties.visitKey`: include it when you can compute it for that request (same recipe) — it is what lets Infinite show the same-lane conversion rate.",
      "- `accountKey` is optional and opaque (a user or order id); Infinite hashes it at rest and uses it for account-deduped outcomes.",
      "- Use a stable `eventId` per outcome (order id, signup id). Retries with the same eventId are safe; the server dedupes.",
      "- `properties` may hold up to 16 keys; keys are lowercase snake_case (`^[a-z][a-z0-9_]{0,63}$` — `visitKey` is the one camelCase exception); values are short whitespace-free tokens, numbers, or booleans — no free text.",
      "- `adMatch` is OPTIONAL and outcome-only: `{ em?, fbc?, fbp?, external_id? }` where `em`/`external_id` are sha256 hex YOU computed and `fbc`/`fbp` are Meta's own first-party cookies. It is consumed by the Meta Conversions API relay at ingest and then discarded — never stored. Omit it entirely unless you run Meta ads without PostHog."
    ],
    delivery: [
      `**Delivery.** Fire-and-forget; never block or fail the response. Timeout ${SERVER_LANE_DELIVERY_TIMEOUT_MS} ms. Never throw into the request path. Next.js middleware: \`event.waitUntil(fetch(...))\`; Cloudflare: \`ctx.waitUntil\`; Netlify Edge: \`context.waitUntil\`; Node/Express: fire the promise and \`.catch(() => {})\`.`,
      "**Skip.** Static assets (by extension and `/_next/`), `/api/*`, non-GET requests, prefetch/HEAD, and any request whose `accept` header does not include `text/html`.",
      "**Never send.** The raw IP, the full user agent (only the family), cookies, query strings (path only), or request bodies."
    ]
  },

  referenceHeading: "Reference implementations",
  reference: {
    next: "Next.js — `lib/infinite-server-lane.ts` (managed module) + `middleware.ts`. This is byte-for-byte what `infinite-tag install --server-lane` writes.",
    nextOutcome: "Next.js — reporting an outcome with the managed module:",
    node: "Express / any Node server — the generic helper (`infinite-server-lane.mjs`) and an Express middleware:",
    nodeOutcome: "Node — reporting an outcome:",
    webCrypto: "Edge runtimes — the WebCrypto helper (`infinite-server-lane-edge.js`) shared by the two snippets below:",
    cloudflare: "Cloudflare Workers:",
    netlify: "Netlify Edge Functions:"
  },

  envHeading: "Environment variables",
  env: [
    `- \`${SERVER_LANE_SECRET_ENV}\` — server-event secret. Mint it in the Infinite desktop → Site Analytics → Settings → Conversions → Server events. It is shown once. Put it in \`.env.local\` for local runs and in your host's environment for production (Vercel: \`vercel env add ${SERVER_LANE_SECRET_ENV} production\`, or Project → Settings → Environment Variables). Never commit it; infinite-tag never writes it to a file.`,
    `- \`${SERVER_LANE_SOURCE_KEY_ENV}\` — the public site source key (\`site_…\`). Same places. (The Next.js module falls back to the key baked at install time when this is unset.)`,
    "",
    "Example `.env.local`:",
    "```",
    `${SERVER_LANE_SOURCE_KEY_ENV}=site_xxxxxxxxxxxxxxxx`,
    `${SERVER_LANE_SECRET_ENV}=<paste the secret shown once in Infinite>`,
    "```"
  ],

  privacyHeading: "Privacy and honesty rules",
  privacy: [
    "Hash on your server. The visit key is derived from IP + user agent + a 30-minute window under YOUR secret; only the hash travels.",
    "Never send the raw IP, the full user agent, cookies, query strings, or bodies. Path and host only.",
    "Skip assets, API routes, prefetches, and non-HTML requests, so a page counts once. Classify obvious bots as `automation` — Infinite never sees the user agent, so the family you send is what it records (automation rows are split out, never counted as visitors).",
    "Report outcomes from the moment they are real, never from intent (a click is intent; a committed row is an outcome). Use stable event ids so retries never double count.",
    "Local, loopback, and preview hosts are ignored on Infinite's side (only verified production hosts count); the generated Next.js module also stays dormant on loopback and off-list hosts.",
    "The optional `adMatch` block is the ONE thing this lane forwards anywhere else, it goes only to Meta's Conversions API, only when you turn the relay on, and only from values your own server hashed. It is discarded after the send: Infinite never stores it, and the IP and user agent Meta is given come from the request itself and are never written down."
  ],

  verifyHeading: "Verify",
  verify: (apiOrigin?: string) => [
    "Deploy with both environment variables set, then from any machine that has the secret:",
    "```",
    `${SERVER_LANE_SECRET_ENV}=<secret> ${SERVER_LANE_SOURCE_KEY_ENV}=site_… npx infinite-tag verify --server-lane https://<your-production-host>/`,
    "```",
    `It loads the page once as \`infinite-tag-verify\` — a self-identified automation user agent, so the check records a flagged agent row and never a visitor in your own numbers — then polls Infinite's receipt endpoint (\`GET ${infiniteServerLaneReceiptUrl(apiOrigin)}?since=<iso>\`, same two source headers; the signature covers the raw query string, e.g. \`since=2026-08-18T20%3A00%3A00.000Z\`) for up to a minute and prints PASS with received / lastPath / lastReceivedAt, or FAIL with the most likely cause.`,
    "That one request is real and is recorded — proving your middleware runs is the whole point — but it is filed as automation, so it stays out of visits and out of any human rate. If bot protection sits in front of the page it may refuse the check; allow the user agent, or load the page yourself while the check polls."
  ],

  doneHeading: "Done when",
  done: [
    "Every HTML document request on a production host produces one signed `site_document_request` (check: `verify --server-lane` prints PASS).",
    "Each declared outcome (`sign_up`, `purchase`, `download`, …) is reported from your server at the moment it becomes real, with a stable eventId and, where possible, `properties.visitKey`.",
    "The two environment variables are set in production; the secret is not committed anywhere.",
    "No page is slower or breaks when Infinite is unreachable (delivery is fire-and-forget with a 2 s cap).",
    "In Infinite → Site Analytics the server-side Visitors / outcome / rate board is filling from your site."
  ],

  /** CLI narration (install / plan). */
  cli: {
    sectionTitle: "Server lane (lossless analytics)",
    created: (path: string) => `+ ${path}  records every HTML document request (fire-and-forget)`,
    patched: (path: string) => `~ ${path}  wrapped your middleware in a fenced infinite-tag block`,
    kept: (path: string) => `= ${path}  already carries the server-lane fence; left as is`,
    unpatchable: (path: string) => `! ${path}  left untouched — see ${SERVER_LANE_BRIEF_FILE} for the exact addition`,
    module: (path: string) => `+ ${path}  managed module (WebCrypto; secrets from env only)`,
    brief: (path: string) => `+ ${path}  the agent brief (contract + reference code + verify)`,
    briefOnly: (path: string) =>
      `+ ${path}  this stack is not patched automatically — the brief below is the install`,
    targetChosen: (label: string, evidence?: string) =>
      `→ ${label}${evidence ? `  (chosen because this repo has ${evidence})` : ""}`,
    targetFile: (path: string) => `+ ${path}  records every HTML document request (fire-and-forget)`,
    targetOutcomeFile: (path: string) => `+ ${path}  postInfiniteOutcome() for your server routes`,
    targetKeptFile: (path: string) => `= ${path}  edited since infinite-tag wrote it; left as is`,
    targetManualFile: (path: string) =>
      `! ${path}  left untouched — ${SERVER_LANE_BRIEF_FILE} carries the exact file to add`,
    targetInstall: (packages: string[]) =>
      `→ then run: npm install ${packages.join(" ")}   (the generated entry imports it)`,
    targetMount: (path: string) =>
      `→ then add one line to your server: see "Mount it in your server" in ${SERVER_LANE_BRIEF_FILE} (${path})`,
    envIntro: "Set two environment variables (never written to files by infinite-tag):",
    envLines: [
      `  ${SERVER_LANE_SOURCE_KEY_ENV}=site_…              your public site source key`,
      `  ${SERVER_LANE_SECRET_ENV}=…              Infinite → Site Analytics → Settings → Conversions → Server events (shown once)`,
      `  .env.local for local runs; production: vercel env add ${SERVER_LANE_SECRET_ENV} production (or your host's env settings)`
    ],
    verifyHint: (host: string) =>
      `Then deploy and confirm receipts:  ${SERVER_LANE_SECRET_ENV}=… npx infinite-tag verify --server-lane https://${host}/`,
    briefPrinted: "The full agent brief follows (also written into the project):",
    briefPrintedNoWrite:
      "The full agent brief follows. Save it with:  npx infinite-tag server-lane --brief > INSTALL-SERVER-LANE.md",
    briefHelp: "server-lane --brief   Print the agent brief for the lossless server lane (no install)"
  },

  /** `verify --server-lane` wording. */
  verifyCli: {
    header: "Infinite OS · server-lane verify",
    loading: (url: string) =>
      `Loading ${url} once, identified as automation — the check records a flagged agent row, never a visitor…`,
    polling: (seconds: number) => `Polling Infinite for the receipt (up to ${seconds}s)…`,
    pass: (received: number, lastPath: string | null, lastReceivedAt: string | null) =>
      `PASS — Infinite received ${received} server-lane event${received === 1 ? "" : "s"} since the check started` +
      (lastPath ? ` (last path ${lastPath}` + (lastReceivedAt ? ` at ${lastReceivedAt}` : "") + ")" : "") +
      ".",
    fail: "FAIL — no server-lane receipt arrived.",
    likelyCause: "Most likely cause:",
    causes: {
      siteUnreachable: (status: string) =>
        `The site did not return a page (${status}). Check the URL and that the deployment is live.`,
      botProtection: (status: number, userAgent: string) =>
        `Your edge or WAF answered ${status}. The check identifies itself honestly as automation ("${userAgent}") rather than impersonating Chrome, so bot protection can refuse it. Allow that user agent for one path, or just open the page in your own browser while this check keeps polling — any document request on the lane produces the receipt.`,
      missingSecret: `${SERVER_LANE_SECRET_ENV} is not set in this shell; the receipt endpoint needs it to sign the check.`,
      missingSourceKey: `No site source key: pass --infinite-site-source-key <site_…> or set ${SERVER_LANE_SOURCE_KEY_ENV}.`,
      unauthorized:
        "Infinite rejected the source key + secret pair (401/403). Either the secret in this shell differs from the one minted for this source, or the server lane is not provisioned for it yet — mint/rotate it in Infinite → Site Analytics → Settings → Conversions → Server events.",
      receiptUnavailable: (status: number) =>
        `The receipt endpoint answered ${status}; the server lane may not be live on Infinite's side yet, or the source key is unknown.`,
      noReceipt: [
        "No middleware/proxy is recording document requests on the deployment you hit (was the server lane deployed? does the matcher include this page?).",
        `The deployment's ${SERVER_LANE_SECRET_ENV} differs from the one this shell used, or ${SERVER_LANE_SOURCE_KEY_ENV} is unset there — the lane stays dormant without both.`,
        "The host you loaded is not one of the site's verified production hosts (Infinite rejects others; the Next.js module also stays dormant off-list).",
        "Only assets/API routes were requested — load an HTML page (accept: text/html) that is not under /api or a file path."
      ]
    }
  }
} as const

function codeBlock(language: string, code: string): string[] {
  return ["```" + language, code.replace(/\n$/, ""), "```"]
}

export function renderStatusParagraph(status: ServerLaneBriefStatus): string {
  switch (status.kind) {
    case "created":
      return serverLaneCopy.status.created(status.middlewarePath, status.modulePath)
    case "patched":
      return serverLaneCopy.status.patched(status.middlewarePath, status.modulePath)
    case "kept":
      return serverLaneCopy.status.kept(status.middlewarePath, status.modulePath)
    case "unpatchable":
      return serverLaneCopy.status.unpatchable(status.middlewarePath, status.modulePath, status.reason)
    case "next-manual":
      return serverLaneCopy.status.nextManual(status.modulePath)
    case "target":
      return serverLaneCopy.status.target(status.label, status.created)
    case "other-stack":
      return serverLaneCopy.status.otherStack(status.framework)
  }
}

/** The complete brief as Markdown. Pure; deterministic for a given input. */
export function renderServerLaneBrief(input: ServerLaneBriefInput): string {
  const moduleImportPath = input.moduleImportPath ?? DEFAULT_MODULE_IMPORT_PATH
  const lines: string[] = [
    SERVER_LANE_BRIEF_BANNER,
    `# ${serverLaneCopy.title}`,
    "",
    `> ${SERVER_LANE_POSITIONING}`,
    "",
    "## What this is (and why)",
    "",
    serverLaneCopy.whatAndWhy[0],
    "",
    serverLaneCopy.whatAndWhy[1],
    "",
    `## ${serverLaneCopy.statusHeading}`,
    "",
    renderStatusParagraph(input.status),
    ""
  ]

  if (input.status.kind === "target") {
    const status = input.status
    if (status.installPackages.length > 0) {
      lines.push(
        `### ${serverLaneCopy.targetPackagesHeading}`,
        "",
        serverLaneCopy.status.targetPackages(status.installPackages),
        ""
      )
    }
    if (status.mount) {
      lines.push(
        `### ${serverLaneCopy.targetMountHeading}`,
        "",
        serverLaneCopy.status.targetMount,
        "",
        ...codeBlock("js", status.mount),
        ""
      )
    }
    if (status.manual.length > 0) {
      lines.push(`### ${serverLaneCopy.targetManualHeading}`, "")
      for (const file of status.manual) {
        lines.push(
          serverLaneCopy.status.targetManual(file.path, file.reason),
          "",
          ...codeBlock(file.path.endsWith(".js") ? "js" : "ts", file.contents),
          ""
        )
      }
    }
  }

  if (input.status.kind === "unpatchable" || input.status.kind === "next-manual") {
    lines.push(
      `### ${serverLaneCopy.exactAdditionHeading}`,
      "",
      ...codeBlock("ts", manualNextMiddlewareAddition({ moduleImportPath, matcher: NEXT_DOCUMENT_MATCHER })),
      ""
    )
  }

  lines.push(
    `## ${serverLaneCopy.contractHeading}`,
    "",
    ...serverLaneCopy.contract.transport(input.apiOrigin).flatMap((line) => [line, ""]),
    ...serverLaneCopy.contract.documentRequest,
    "",
    ...serverLaneCopy.contract.outcome,
    "",
    ...serverLaneCopy.contract.delivery.flatMap((line) => [line, ""]),
    `## ${serverLaneCopy.referenceHeading}`,
    "",
    `### ${serverLaneCopy.reference.next}`,
    "",
    "`lib/infinite-server-lane.ts`:",
    "",
    ...codeBlock(
      "ts",
      buildServerLaneModuleSource({
        siteSourceKey: input.siteSourceKey,
        productionHosts: input.productionHosts,
        ...(input.apiOrigin ? { apiOrigin: input.apiOrigin } : {})
      })
    ),
    "",
    "`middleware.ts` (when the project has none; `proxy.ts` on Next.js 16+):",
    "",
    ...codeBlock("ts", buildCreatedMiddlewareSource({ moduleImportPath })),
    "",
    serverLaneCopy.reference.nextOutcome,
    "",
    ...codeBlock("ts", nextOutcomeSnippet(moduleImportPath.replace(/^\.\/lib\//, "@/lib/"))),
    "",
    `### ${serverLaneCopy.reference.node}`,
    "",
    ...codeBlock("js", nodeHelperSnippet(input.apiOrigin)),
    "",
    ...codeBlock("js", expressSnippet()),
    "",
    serverLaneCopy.reference.nodeOutcome,
    "",
    ...codeBlock("js", outcomeSnippet()),
    "",
    `### ${serverLaneCopy.reference.webCrypto}`,
    "",
    ...codeBlock("js", webCryptoHelperSnippet(input.apiOrigin)),
    "",
    `### ${serverLaneCopy.reference.cloudflare}`,
    "",
    ...codeBlock("js", cloudflareWorkerSnippet()),
    "",
    `### ${serverLaneCopy.reference.netlify}`,
    "",
    ...codeBlock("js", netlifyEdgeSnippet()),
    "",
    `## ${serverLaneCopy.outcomeRouteHeading}`,
    "",
    serverLaneCopy.outcomeRouteIntro,
    "",
    serverLaneCopy.outcomeRouteVercel,
    "",
    ...codeBlock("ts", outcomeRouteSnippet()),
    "",
    serverLaneCopy.outcomeRouteNote,
    "",
    `### ${serverLaneCopy.adMatchHeading}`,
    "",
    ...serverLaneCopy.adMatch,
    "",
    `## ${serverLaneCopy.envHeading}`,
    "",
    ...serverLaneCopy.env,
    "",
    `## ${serverLaneCopy.privacyHeading}`,
    "",
    ...serverLaneCopy.privacy.map((line) => `- ${line}`),
    "",
    `## ${serverLaneCopy.verifyHeading}`,
    "",
    ...serverLaneCopy.verify(input.apiOrigin),
    "",
    `## ${serverLaneCopy.doneHeading}`,
    "",
    ...serverLaneCopy.done.map((line) => `- [ ] ${line}`),
    ""
  )
  return lines.join("\n")
}
