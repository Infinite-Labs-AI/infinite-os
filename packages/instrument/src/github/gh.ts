// The `gh` wrapper (lane O4, §3g.2). Every call is argv-only; request bodies and GraphQL documents travel on
// stdin (`--input -`, `--body-file -`), so no value lands in argv or a shell. The guard refuses everything
// the wizard must never do on GitHub: merge (`gh pr merge`, auto-merge, `--admin`), rebase, fork, approve
// or request changes (reviews are `event: COMMENT` only), and closing or deleting anything.
import { spawnProcess, type ProcessResult, type ProcessRunner } from "../git/run.js"

export class GhSafetyError extends Error {
  constructor(message: string) {
    super(`refused gh call: ${message}`)
    this.name = "GhSafetyError"
  }
}

export type GhFailureKind =
  | "not_installed"
  | "not_authenticated"
  /** A 422 that mentions drafts: the repo's plan has no draft PRs (§3g.2). */
  | "draft_unsupported"
  /** Any other 422 / "Unprocessable" (e.g. an inline comment outside the diff). */
  | "unprocessable"
  | "not_found"
  | "other"

export class GhError extends Error {
  constructor(
    readonly kind: GhFailureKind,
    readonly args: readonly string[],
    readonly result: ProcessResult
  ) {
    super(`gh ${args.slice(0, 2).join(" ")} failed (${kind})`)
    this.name = "GhError"
  }
}

const FORBIDDEN_FLAGS = ["--admin", "--rebase", "--squash", "--merge", "--auto", "--approve", "--request-changes", "--force", "--delete-branch"]
const FORBIDDEN_PR_SUBCOMMANDS = new Set(["merge", "close", "review", "lock", "revert"])
const FORBIDDEN_REPO_SUBCOMMANDS = new Set(["fork", "delete", "archive", "rename", "edit", "sync"])
/** GraphQL mutations the wizard may send. Everything else (mergePullRequest, enablePullRequestAutoMerge, …) is refused. */
const ALLOWED_MUTATIONS = new Set(["addPullRequestReview", "addPullRequestReviewThreadReply", "resolveReviewThread"])

function mutationNames(query: string): string[] {
  if (!/\bmutation\b/.test(query)) return []
  const body = query.slice(query.indexOf("{") + 1)
  return [...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*input\s*:/g)].map((match) => match[1]!)
}

/**
 * Throws GhSafetyError when an argv (or a GraphQL body on stdin) would merge, approve, request changes,
 * rebase, fork or delete. A review event other than COMMENT is refused here too, whatever builds it.
 */
export function assertSafeGhCall(args: readonly string[], input?: string): void {
  const [group, sub] = args
  for (const arg of args) {
    for (const flag of FORBIDDEN_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) throw new GhSafetyError(`${arg} is never used`)
    }
  }
  if (group === "pr" && sub && FORBIDDEN_PR_SUBCOMMANDS.has(sub)) throw new GhSafetyError(`gh pr ${sub} is never used`)
  if (group === "repo" && sub && FORBIDDEN_REPO_SUBCOMMANDS.has(sub)) throw new GhSafetyError(`gh repo ${sub} is never used`)
  if (group === "pr" && sub === "update-branch" && args.includes("--rebase")) throw new GhSafetyError("update-branch is merge-commit only")
  if (group === "api") {
    // Every spelling of the method flag: `-X M`, `--method M`, `-XM`, `--method=M`.
    const methods: string[] = []
    args.forEach((arg, index) => {
      if (arg === "-X" || arg === "--method") methods.push(args[index + 1] ?? "")
      else if (arg.startsWith("--method=")) methods.push(arg.slice("--method=".length))
      else if (/^-X./.test(arg)) methods.push(arg.slice(2))
    })
    for (const method of methods.map((value) => value.toUpperCase())) {
      if (method === "DELETE" || method === "PUT") throw new GhSafetyError(`gh api -X ${method} is never used`)
    }
    const path = args[1] ?? ""
    if (/\/merge(s)?\b|\/pulls\/\d+\/merge|\/git\/refs/.test(path)) throw new GhSafetyError(`gh api ${path} is never used`)
    if (path === "graphql") {
      // The query goes on stdin (`--input -`) only, where the mutation allowlist reads it: a field flag could carry
      // a query (`-f query='mutation{mergePullRequest…}'`) past it.
      if (args.slice(2).some((arg) => /^(-f|-F|--raw-field|--field)/.test(arg))) throw new GhSafetyError("gh api graphql takes its query on stdin only")
      const query = input === undefined ? "" : (() => {
        try {
          const parsed = JSON.parse(input) as { query?: unknown }
          return typeof parsed.query === "string" ? parsed.query : ""
        } catch {
          return ""
        }
      })()
      for (const name of mutationNames(query)) {
        if (!ALLOWED_MUTATIONS.has(name)) throw new GhSafetyError(`GraphQL mutation ${name} is never used`)
      }
      if (/\bevent\s*:\s*(APPROVE|REQUEST_CHANGES|DISMISS)\b/.test(query) || /"event"\s*:\s*"(APPROVE|REQUEST_CHANGES|DISMISS)"/.test(input ?? "")) {
        throw new GhSafetyError("reviews are event: COMMENT only")
      }
    } else if (input !== undefined && /"event"\s*:\s*"(APPROVE|REQUEST_CHANGES|DISMISS)"/.test(input)) {
      throw new GhSafetyError("reviews are event: COMMENT only")
    }
  }
}

function classify(result: ProcessResult): GhFailureKind {
  const text = `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`
  if (/ENOENT|not found: gh|command not found/i.test(result.error ?? "")) return "not_installed"
  if (/not logged in|gh auth login|authentication required|HTTP 401|Bad credentials/i.test(text)) return "not_authenticated"
  if (/draft/i.test(text) && /(422|Unprocessable|not supported|not available|draft pull requests are not supported)/i.test(text)) {
    return "draft_unsupported"
  }
  if (/HTTP 422|Unprocessable|could not be resolved|must be part of the diff|pull_request_review_thread/i.test(text)) return "unprocessable"
  if (/HTTP 404|Could not resolve to|no pull requests found/i.test(text)) return "not_found"
  return "other"
}

export interface GhClient {
  /** Runs gh; throws GhError on a non-zero exit unless `okExitCodes` lists it. */
  run(args: readonly string[], options?: { input?: string; okExitCodes?: readonly number[] }): Promise<ProcessResult>
  json<T>(args: readonly string[], options?: { input?: string; okExitCodes?: readonly number[] }): Promise<T>
  /** Every call made: argv and stdin (tests assert nothing secret reached either). */
  readonly calls: ReadonlyArray<{ args: readonly string[]; input: string | undefined }>
}

export function createGhClient(options: {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  runner?: ProcessRunner
  ghBin?: string
  timeoutMs?: number
}): GhClient {
  const runner = options.runner ?? spawnProcess
  const calls: Array<{ args: readonly string[]; input: string | undefined }> = []
  const env = { ...options.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GH_PAGER: "cat", PAGER: "cat" }
  const client: GhClient = {
    get calls() {
      return calls
    },
    async run(args, runOptions = {}) {
      assertSafeGhCall(args, runOptions.input)
      calls.push({ args: [...args], input: runOptions.input })
      const result = await runner(options.ghBin ?? "gh", args, {
        cwd: options.cwd,
        env,
        input: runOptions.input,
        timeoutMs: options.timeoutMs ?? 60_000
      })
      const ok = result.status === 0 || (result.status !== null && (runOptions.okExitCodes ?? []).includes(result.status))
      if (!ok || result.error) throw new GhError(classify(result), args, result)
      return result
    },
    async json<T>(args: readonly string[], runOptions: { input?: string; okExitCodes?: readonly number[] } = {}) {
      const result = await client.run(args, runOptions)
      try {
        return JSON.parse(result.stdout) as T
      } catch {
        throw new GhError("other", args, { ...result, stderr: `${result.stderr}\nunparseable JSON from gh` })
      }
    }
  }
  return client
}

/** A GraphQL call: the document and variables go on stdin (`gh api graphql --input -`). */
export async function ghGraphql<T>(gh: GhClient, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await gh.json<{ data?: T; errors?: Array<{ message?: string; type?: string }> }>(["api", "graphql", "--input", "-"], {
    input: JSON.stringify({ query, variables })
  })
  if (response.errors && response.errors.length > 0) {
    const message = response.errors.map((error) => error.message ?? error.type ?? "error").join("; ")
    const kind: GhFailureKind = /draft/i.test(message) ? "draft_unsupported" : /diff|resolve|unprocessable|line/i.test(message) ? "unprocessable" : "other"
    throw new GhError(kind, ["api", "graphql"], { status: 1, stdout: "", stderr: message })
  }
  if (!response.data) throw new GhError("other", ["api", "graphql"], { status: 1, stdout: "", stderr: "no data" })
  return response.data
}
