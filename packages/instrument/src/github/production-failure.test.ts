import { expect, it } from "vitest"
import { productionDeploymentForSha } from "./deployments.js"

const SHA = "a".repeat(40)
const reason = "Vercel - Git author must have access to the project on Vercel to create deployments"
it.each([false, true])("returns the author-block reason with or without a deployment row (%s)", rowExists => {
  const gh = { json: async (args: string[]) => {
    if (args[1]!.includes("deployments?")) return rowExists ? [{ id: 1, environment: "Production", created_at: "2026-10-07T00:00:00Z" }] : []
    if (args[1]!.includes("/statuses?")) return [{ state: "failure", description: reason }]
    if (args[1]!.endsWith("/status")) return { statuses: [{ context: "Vercel", state: "failure", description: reason }] }
    throw new Error(`Unexpected API ${args[1]}`)
  } }
  return expect(productionDeploymentForSha(gh as never, SHA, null)).resolves.toEqual({ state: "failed", blocked: true, reason })
})
