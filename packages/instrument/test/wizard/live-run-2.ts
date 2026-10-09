// Live run 2's lead + silent-form edits, replayed on the store fixture (`fixtures/store/site`, an invented brand). The
// agent's real transcript did the lead job first (the page's tracking signal and the API route's lead report), claimed
// it, then did the silent-form job on the same page (a second helper import, infiniteTrack("lead") after the site's own
// generate_lead, data-conversion on the form) and claimed that. The wizard then put the lead's lines back.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const SITE = resolve(here, "fixtures/store/site")

export const LEAD_PAGE = "pages/mailing-list.tsx"
export const LEAD_ROUTE = "pages/api/mailing-list.ts"
export const BASE_PAGE = readFileSync(resolve(SITE, LEAD_PAGE), "utf8")
export const BASE_ROUTE = readFileSync(resolve(SITE, LEAD_ROUTE), "utf8")

function replaced(text: string, pairs: ReadonlyArray<[string, string]>): string {
  let out = text
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`live-run-2 fixture: ${JSON.stringify(from.slice(0, 40))} is not in the store fixture`)
    out = out.replace(from, to)
  }
  return out
}

/** The lead job's page edit: the site's own consent reader as the request's tracking signal. */
export const leadPage = (page: string = BASE_PAGE): string => replaced(page, [
  ['import { generateLead } from "../src/analytics/events";\n', 'import { generateLead } from "../src/analytics/events";\nimport { getConsent } from "../src/analytics/tracking";\n'],
  ["body: JSON.stringify({ email, interests }),", 'body: JSON.stringify({ email, interests, adMatch: getConsent() === "granted" }),']
])

/** The lead job's route edit: the lead reported once the sign-up is real, with the page's signal. */
export const leadRoute = (route: string = BASE_ROUTE): string => replaced(route, [
  ['import type { NextApiRequest, NextApiResponse } from "next";\n', 'import type { NextApiRequest, NextApiResponse } from "next";\nimport { randomUUID } from "node:crypto";\nimport { reportInfiniteLead } from "../../lib/infinite-outcome";\n'],
  ["const body = (req.body ?? {}) as { email?: unknown; interests?: unknown };", "const body = (req.body ?? {}) as { email?: unknown; interests?: unknown; adMatch?: unknown };"],
  ['  res.status(200).json({ ok: true });\n', '  await reportInfiniteLead(req, {\n    type: "lead",\n    email,\n    trackingAllowed: body.adMatch === true,\n    fallbackPath: "/mailing-list",\n    fallbackId: randomUUID(),\n  });\n\n  res.status(200).json({ ok: true });\n']
])

/** The silent-form job's page edit, on top of the lead's. */
export const silentFormPage = (page: string = leadPage()): string => replaced(page, [
  ['import { getConsent } from "../src/analytics/tracking";\n', 'import { getConsent } from "../src/analytics/tracking";\nimport { infiniteTrack, infiniteTrackThenNavigate } from "../lib/infinite-analytics";\n'],
  ["      generateLead(interests);\n", '      generateLead(interests);\n      infiniteTrack("lead");\n'],
  ['<form className="form" onSubmit={onSubmit} noValidate>', '<form className="form" data-conversion="lead" onSubmit={onSubmit} noValidate>']
])
