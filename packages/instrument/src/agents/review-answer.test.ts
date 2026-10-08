// The reviewer's answer, from the model service to a ReviewResult: the schema strict structured outputs must take,
// the answer a real Codex returns under it, the prose or fences an agent may wrap it in, and the refusal that is
// not an answer at all. Built from a live run (2026-10-08, codex-cli 0.160.1) whose review failed twice.
import { describe, expect, it } from "vitest"

import { isReviewResult } from "../review/brief.js"
import { CLAIMS_SCHEMA, REVIEW_SCHEMA } from "../wizard/contracts/agents.js"
import { codexRequestRejected, parseCodexLine } from "./codex.js"
import { answerJson, parseReview, parseStructuredClaims, schemaErrors } from "./schema-check.js"

/** Every object in the schema, with its path. */
function objects(node: unknown, path = "schema", out: Array<{ path: string; node: Record<string, unknown> }> = []) {
  if (node === null || typeof node !== "object") return out
  const record = node as Record<string, unknown>
  if (record.properties) {
    out.push({ path, node: record })
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) objects(child, `${path}.properties.${key}`, out)
  }
  if (record.items) objects(record.items, `${path}.items`, out)
  return out
}

// What `codex exec -o` wrote under the fixed schema (real Codex, real service).
const REAL_ANSWER = `{"verdict":"changes_suggested","summary":"x","checklist":[{"item":"R1","status":"pass","note":"ok"}],"findings":[{"id":"F1","category":"analytics","item":"R2","severity":"nit","path":"a.ts","line":3,"body":"b","suggested_fix":null},{"id":"F2","category":null,"item":"R3","severity":"should","path":"b.ts","line":null,"body":"c","suggested_fix":"d"}]}`

// The two stream lines the real CLI printed when the service refused the old schema.
const REFUSAL = `{"type":"error","message":"{\\"type\\":\\"error\\",\\"error\\":{\\"message\\":\\"Invalid schema for response_format 'codex_output_schema': 'schema.properties.findings.items.required' is required to include every key in properties. Missing 'category'.\\",\\"type\\":\\"invalid_request_error\\",\\"param\\":\\"text.format.schema\\",\\"code\\":\\"invalid_json_schema\\"},\\"status\\":400}"}`
const TURN_FAILED = `{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"message\\":\\"Invalid schema for response_format 'codex_output_schema': 'schema.properties.findings.items.required' is required to include every key in properties. Missing 'category'.\\",\\"type\\":\\"invalid_request_error\\",\\"param\\":\\"text.format.schema\\",\\"code\\":\\"invalid_json_schema\\"},\\"status\\":400}"}}`

describe("the schemas Codex sends to strict structured outputs", () => {
  it.each([["review", REVIEW_SCHEMA], ["claims", CLAIMS_SCHEMA]] as const)("%s: every object closes additionalProperties and requires every key", (_name, schema) => {
    const found = objects(schema)
    expect(found.length).toBeGreaterThan(1)
    for (const { path, node } of found) {
      expect(node.additionalProperties, path).toBe(false)
      expect([...(node.required as string[])].sort(), path).toEqual(Object.keys(node.properties as object).sort())
    }
  })

  it("a finding's category is required but may be null (no category)", () => {
    const finding = REVIEW_SCHEMA.properties.findings.items
    expect(finding.required).toContain("category")
    expect(finding.properties.category.enum).toContain(null)
    expect(schemaErrors(JSON.parse(REAL_ANSWER), REVIEW_SCHEMA as never)).toEqual([])
  })
})

describe("reading a real Codex answer", () => {
  it("reads the live answer; a null category is dropped, a set one kept", () => {
    const review = parseReview(REAL_ANSWER)!
    expect(review).not.toBeNull()
    expect(review.findings[0]!.category).toBe("analytics")
    expect("category" in review.findings[1]!).toBe(false)
    expect(review.findings[1]!.suggested_fix).toBe("d")
  })

  it("reads the same answer wrapped in prose or in one ```json fence", () => {
    const expected = parseReview(REAL_ANSWER)
    expect(parseReview(`Here is my review:\n\n\`\`\`json\n${REAL_ANSWER}\n\`\`\`\n`)).toEqual(expected)
    expect(parseReview(`\`\`\`\n${REAL_ANSWER}\n\`\`\``)).toEqual(expected)
    expect(parseReview(`My review follows. ${REAL_ANSWER} That is all.`)).toEqual(expected)
    expect(parseReview(`  ${REAL_ANSWER}\n`)).toEqual(expected)
  })

  it("never guesses between two fenced answers", () => {
    expect(answerJson(`\`\`\`json\n${REAL_ANSWER}\n\`\`\`\n\`\`\`json\n{"verdict":"looks_good"}\n\`\`\``)).toBeUndefined()
  })

  it("never accepts an answer missing a required field, with an unknown key, or a wrong type (negatives)", () => {
    const answer = () => JSON.parse(REAL_ANSWER) as Record<string, any>
    const noSummary = answer(); delete noSummary.summary
    const noBody = answer(); delete noBody.findings[0].body
    const noLine = answer(); delete noLine.findings[1].line
    const extraTop = { ...answer(), confidence: 0.9 }
    const extraFinding = answer(); extraFinding.findings[0].confidence = "high"
    const numericCategory = answer(); numericCategory.findings[0].category = 3
    const badChecklist = answer(); badChecklist.checklist[0].status = "ok"
    for (const bad of [noSummary, noBody, noLine, extraTop, extraFinding, numericCategory, badChecklist]) {
      expect(parseReview(JSON.stringify(bad))).toBeNull()
      expect(parseReview(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``)).toBeNull()
    }
    expect(parseReview("I could not finish the review.")).toBeNull()
    expect(parseReview("")).toBeNull()
  })

  it("an absent category still reads (the brief path and older answers), as before", () => {
    const answer = JSON.parse(REAL_ANSWER) as { findings: Array<Record<string, unknown>> }
    delete answer.findings[0]!.category
    expect(isReviewResult(answer)).toBe(true)
  })

  it("claims read through the same extraction, and still fail on a missing field", () => {
    expect(parseStructuredClaims('```json\n{"claims":[{"job_id":"j1","status":"done","note":"n"}],"questions":[]}\n```')).toEqual({ claims: [{ job_id: "j1", status: "done", note: "n" }], questions: [] })
    expect(parseStructuredClaims('{"claims":[{"job_id":"j1","status":"done"}],"questions":[]}')).toBeNull()
  })
})

describe("a refused request is not an answer", () => {
  it("the live refusal lines are recognised", () => {
    const error = parseCodexLine(REFUSAL)
    const failed = parseCodexLine(TURN_FAILED)
    expect(error).toMatchObject({ kind: "error" })
    expect(failed).toMatchObject({ kind: "error", fatal: true })
    expect(codexRequestRejected((error as { message: string }).message)).toBe(true)
    expect(codexRequestRejected((failed as { message: string }).message)).toBe(true)
  })

  it("a reconnect notice, a usage limit or a model refusal is not a refused request (negatives)", () => {
    expect(codexRequestRejected("Reconnecting... 1/5")).toBe(false)
    expect(codexRequestRejected("You've hit your usage limit. Try again later.")).toBe(false)
    expect(codexRequestRejected("The 'gpt-x' model is not supported when using Codex with a ChatGPT account.")).toBe(false)
  })
})
