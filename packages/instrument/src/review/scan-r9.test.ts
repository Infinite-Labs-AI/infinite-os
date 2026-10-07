// All credential-shaped values here are synthetic and constructed at runtime.
import { describe, expect, it } from "vitest"
import { maskIdentifier } from "../checks/result.js"
import { buildReport, renderMarkdown, renderTerminal, reportPayload } from "../wizard/report.js"
import { verdictFactsFor } from "../wizard/verdict-facts.js"
import { buildFinalComment, buildPrBody, buildReply, buildReviewPost } from "./post.js"
import { createScanner } from "./scan.js"

const TOKEN = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY"
const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const CASES = [
  ["Stripe webhook", "whsec_" + TOKEN],
  ["Stripe secret", ["sk", "live", TOKEN].join("_")],
  ["Supabase secret", "sb_secret_" + TOKEN],
  ["Anthropic", ["sk", "ant", "api03", TOKEN + "-" + TOKEN + "_AA"].join("-")],
  ["OpenAI project", ["sk", "proj", TOKEN + "_" + TOKEN].join("-")],
  ["OpenAI service account", ["sk", "svcacct", TOKEN].join("-")],
  ["OpenAI legacy", "sk-" + TOKEN + TOKEN],
  ["GitHub", "github_pat_" + TOKEN],
  ["Slack", "xoxb-" + TOKEN],
  ["AWS temporary access id", "ASIA" + "A1B2C3D4E5F6G7H8"],
  ["Google API", "AIza" + (TOKEN + TOKEN).slice(0, 35)],
  ["PostHog personal", "phx_" + TOKEN],
  ["Meta", "EAA" + TOKEN],
  ["AWS secret access key", TOKEN + "/+xQ5R2Z", "AWS_SECRET_ACCESS_KEY="],
  ["generic key", TOKEN + "_newVendor", "API_KEY: "],
  ["generic camelCase token", TOKEN, 'accessToken = "'],
  ["generic prose key", TOKEN, "signing key "],
  ["generic JSON key", TOKEN + "/+=", '"secretAccessKey": "', '"'],
  ["generic YAML key", TOKEN + "_-", "api-key: "],
  ["generic quoted punctuation", TOKEN.slice(0, 16) + "$#:([])!" + TOKEN.slice(16), 'password="', '"'],
  ["generic unquoted punctuation", TOKEN.slice(0, 16) + "$#:@" + TOKEN.slice(16), "password="],
  ["DB raw colon password", "p:ass:word", "mysql://user:", "@db.example/app"],
  ["generic hex secret", "9a5d83b6c2f407e1".repeat(2), 'client_secret="'],
  ["DB password", TOKEN, "postgresql://user:", "@db.example/app"],
  ["short DB password", "p%40ss%3Aword", "postgres://user:", "@db.example/app"],
  ["DB URL punctuation", "pass%2Fword%3F", "mongodb+srv://user:", "@db.example/app"],
  ["Redis password", TOKEN, "redis://:", "@cache.example:6379/0"]
].map(([name, secret, prefix = "", suffix = ""]) => ({ name: name!, secret: secret!, text: `${prefix}${secret}${suffix}` }))

async function surfaces(text: string): Promise<Record<string, string>> {
  const scanner = createScanner({ literals: [], allowedIds: [] })
  // Keep enough useful prose that the review publishes a redacted finding, rather than withholding all of it.
  const content = `Inspect the named credential in the local source and replace the literal with a server environment lookup. ${text}`
  const review = buildReviewPost({ review: { verdict: "changes_suggested", summary: content, checklist: [{ item: "R1", status: "fail", note: content }], findings: [{ id: "F1", item: "R1", severity: "blocker", category: "security", path: "src/main.ts", line: 1, body: content, suggested_fix: content }] }, diffFiles: [{ path: "src/main.ts", added: [], removed: [], hunks: [{ start: 1, end: 2 }] }], scanner, runId: RUN, round: 1, head: "a".repeat(40), reviewer: "codex" })
  const ctx = { root: "/synthetic-scanner-fixture", appRoot: ".", runId: RUN, state: { get: () => ({ runId: RUN, jobs: [{ id: "posthog_improve:fixture", jobId: "posthog_improve", state: "left_for_you", title: "PostHog handoff", note: content, allow: { files: [], create: [] }, ownerBoundary: { kind: "frozen_unit", file: "src/main.ts" } }], git: null }) } }
  const facts = await verdictFactsFor(ctx as never, { env: {}, bridge: {}, git: {}, fs: { readText: async () => null } } as never)
  const report = buildReport({ runId: RUN, tagVersion: "0.12.2", site: { repoLabel: "example/repo", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: facts })
  return {
    "PR body": buildPrBody({ reportMarkdown: content, howToReview: content, notes: [content], runId: RUN, isPrivate: true, diffText: "", connectionIds: [], scanner }),
    "review body": review.body,
    "review thread": review.threads[0]!.body,
    reply: buildReply(scanner, { action: "ASK", reason: content } as never, null),
    "final comment": buildFinalComment({ runId: RUN, reportMarkdown: content, reviewer: "codex", reviewed: true, jobs: [], decisions: [], untrusted: [], notes: [content], scanner }),
    "report markdown": renderMarkdown(report),
    "terminal report": renderTerminal(report, 160),
    "cloud note": JSON.stringify(reportPayload(report).notes)
  }
}

describe("R9 provider and contextual secret redaction", () => {
  it.each(CASES)("redacts $name on every publication surface without env literals", async ({ secret, text }) => {
    for (const [surface, output] of Object.entries(await surfaces(text))) {
      expect(output.includes(secret), `${surface} exposed the synthetic credential`).toBe(false)
      expect(output, `${surface} must exercise the credential-bearing text`).toContain("redacted:")
    }
  })

  it.each(CASES)("blocks $name in newly committed content", ({ text }) => {
    const hits = createScanner({ literals: [], allowedIds: [] }).findInCommit([{ path: "src/main.ts", added: [{ line: 7, text }] }], () => false)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(hit => hit.file === "src/main.ts" && hit.line === 7)).toBe(true)
  })

  it("detects a named token split over contiguous added lines without bridging unrelated hunks", () => {
    const scanner = createScanner({ literals: [], allowedIds: [] })
    const text = `const apiToken =\n  "${TOKEN}"`
    expect(scanner.redact(text).text).not.toContain(TOKEN)
    expect(scanner.findInCommit([{ path: "src/main.ts", added: [{ line: 7, text: "const apiToken =" }, { line: 8, text: `  "${TOKEN}"` }] }], () => false)).toEqual([{ kind: "generic_secret", file: "src/main.ts", line: 8 }])
    expect(scanner.findInCommit([{ path: "src/main.ts", added: [{ line: 7, text: "const apiToken =" }, { line: 15, text: `  "${TOKEN}"` }] }], () => false)).toEqual([])
  })

  it("does not let a misleading label consume the following real secret assignment", () => {
    const scanner = createScanner({ literals: [], allowedIds: [] })
    const text = `The monkey API_KEY=${TOKEN}`
    expect(scanner.redact(text).text).toBe("The monkey API_KEY=[redacted: generic_secret]")
  })

  it("provider credentials still redact if incorrectly supplied as allowed public IDs", () => {
    const secret = "whsec_" + TOKEN
    expect(createScanner({ literals: [], allowedIds: [secret] }).redact(secret).text).not.toContain(secret)
  })

  it("leaves allowed public IDs and provider publishable keys intact", () => {
    const ids = ["G-ABC123XYZ9", "1234567890123456", "phc_" + TOKEN, "sb_publishable_" + TOKEN, ["pk", "live", TOKEN].join("_"), TOKEN]
    const scanner = createScanner({ literals: [], allowedIds: ids })
    for (const id of ids) {
      for (const text of [id, `apiKey: '${id}'`, `public token ${id}`, `Public key ${id}.`, `Public token ${id}...`]) expect(scanner.redact(text)).toEqual({ text, hits: [] })
    }
    expect(scanner.redact(`Meta ${maskIdentifier(ids[1]!)}`).hits).toEqual([])
  })

  it("does not turn ordinary code, placeholders, URLs, hashes or IDs into generic secrets", () => {
    const scanner = createScanner({ literals: [], allowedIds: [] })
    for (const text of [
      "API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "API_KEY=process.env.SYNTHETIC_SERVICE_API_KEY",
      "api_key = env.SERVICE_APPLICATION_API_KEY",
      "api_key = config.SERVICE_APPLICATION_API_KEY",
      "apiKey: import.meta.env.VITE_PUBLIC_APPLICATION_KEY",
      `commit ${"9a5d83b6c2f407e1".repeat(2)}`,
      `request_id=${TOKEN}`,
      `https://docs.example/${TOKEN}`,
      `https://docs.example:443/path/test@example.com`,
      `https://user@docs.example/${TOKEN}`,
      `API_KEY=${"phc_" + TOKEN}`,
      `API_KEY=${"sb_publishable_" + TOKEN}`,
      `API_KEY=${["pk", "test", TOKEN].join("_")}`
    ]) expect(scanner.redact(text)).toEqual({ text, hits: [] })
  })
})

it("does not mistake quoted configuration instructions for a credential token", () => {
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const prose = 'key: "Use your provider dashboard to create a key"'
  expect(scanner.redact(prose)).toEqual({ text: prose, hits: [] })
  expect(scanner.findInCommit([{ path: "docs/config.ts", added: [{ line: 1, text: prose }] }], () => false)).toEqual([])
})
