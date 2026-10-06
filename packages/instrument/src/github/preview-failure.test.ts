import { describe, expect, it } from "vitest"

import type { GhClient } from "./gh.js"
import { previewFailureForSha, previewUrlForSha } from "./preview.js"

const SHA = "a".repeat(40)
const gh = (deployments: unknown[], statuses: unknown[] | Record<string, unknown[]>, commitStatuses: unknown[] = []): GhClient => ({
  json: async (argv: string[]) => {
    const path = argv[1] ?? ""
    if (path.includes("/deployments/") && path.includes("/statuses")) return Array.isArray(statuses) ? statuses : statuses[/\/deployments\/(\d+)\/statuses/.exec(path)?.[1] ?? ""] ?? []
    if (path.includes("/deployments?")) return deployments
    if (path.includes("/commits/")) return { statuses: commitStatuses }
    throw new Error(`unexpected ${path}`)
  }
}) as unknown as GhClient

describe("a preview's terminal GitHub status", () => {
  it("returns a failed deployment's reason immediately", async () => {
    const client = gh([{ id: 7, environment: "Preview", creator: { login: "vercel[bot]" } }], [{ state: "error", description: "Build failed" }])
    expect(await previewFailureForSha(client, SHA, null)).toEqual({ reason: "Build failed", blocked: false })
  })

  it("reads the Vercel commit status when a deployment row has not appeared yet", async () => {
    const client = gh([], [], [{ context: "Vercel", state: "failure", description: "Deployment was blocked" }])
    expect(await previewFailureForSha(client, SHA, null)).toEqual({ reason: "Deployment was blocked", blocked: true })
  })

  it("does not ascribe another project's failure or a pending deployment to this site", async () => {
    const rows = [
      { id: 7, environment: "Preview - other-project", creator: { login: "vercel[bot]" } },
      { id: 8, environment: "Preview - chosen-project", creator: { login: "vercel[bot]" } }
    ]
    expect(await previewFailureForSha(gh(rows, { "7": [{ state: "failure", description: "Deployment was blocked" }], "8": [{ state: "pending" }] }), SHA, "chosen-project")).toBeNull()
    expect(await previewFailureForSha(gh([rows[0]!], [{ state: "pending" }]), SHA, null)).toBeNull()
  })

  it("lets a newer redeploy continue instead of reusing an older failed attempt", async () => {
    const rows = [
      { id: 8, environment: "Preview - chosen-project", creator: { login: "vercel[bot]" }, created_at: "2026-10-06T21:05:00Z" },
      { id: 7, environment: "Preview - chosen-project", creator: { login: "vercel[bot]" }, created_at: "2026-10-06T21:00:00Z" }
    ]
    expect(await previewFailureForSha(gh(rows, { "8": [{ state: "pending" }], "7": [{ state: "failure", description: "old failure" }] }), SHA, "chosen-project")).toBeNull()
    expect(await previewUrlForSha(gh(rows, { "8": [{ state: "pending" }], "7": [{ state: "success", environment_url: "https://chosen-project-old.vercel.app" }] }), SHA, "chosen-project")).toBeNull()
  })
})
