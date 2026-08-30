# Security Policy

This document covers vulnerability reporting and the trust model for **Infinite OS**, a self-hosted, local-first growth-analytics runtime by Ultima AI, Inc.

## Reporting a Vulnerability

There is no bug-bounty program. Report security issues privately by emailing **support@ultima.inc**, or via [GitHub Security Advisories](https://github.com/Infinite-Labs-AI/infinite-os/security/advisories/new). Please do not open public issues for security vulnerabilities.

Please include:

- **Summary & severity:** a concise description and your estimated severity.
- **Affected component:** the exact file path and line range.
- **Environment:** commit SHA, OS, and Node.js version.
- **Reproduction:** step-by-step proof of concept against `main`.
- **Impact:** which trust boundary is crossed.

## Trust Model

Infinite OS is a **self-hosted, single-operator** system. It protects the operator's own data and credentials; it does not provide multi-user isolation. Multi-tenant separation, if needed, must happen at the OS/host level.

### Data and secrets

- Your analytics data lives in **your own Postgres** (a local Docker volume by default). It never leaves your machine unless you send it somewhere.
- Local secrets — `DATABASE_URL`, `GROWTH_OS_ENCRYPTION_KEY`, operator/read tokens — live in gitignored `.env` files and the `.growth-os/` directory. They are never committed; `.env.example` documents the variable names with placeholders only.
- **Connector credentials** (provider API keys and OAuth tokens) are stored as encrypted `connection_credentials` rows in Postgres, keyed by `GROWTH_OS_ENCRYPTION_KEY`. That key is load-bearing: rotating it orphans existing connections and forces re-authentication. Do not place provider keys in queryable views, logs, or committed files.
- The app and worker services are intended for local or private networks. Do not expose them to the public internet without a VPN, Tailscale, or firewall in front of them.

### Model tools

For natural-language questions and operator turns, Infinite OS can send prompts to your configured model provider — your own Codex login or Claude API key — using your own credentials. Model output is routed through local Infinite OS code, but the enforcement boundary depends on which tool surface is in use.

- **Built-in/native Infinite OS actions** are looked up by ID in the typed action registry. The registry enforces action authority; handlers own action-specific input validation, provenance, and policy checks. Native live/destructive operator actions are converted to `requires_confirmation` before execution and require operator confirmation.
- **Scoped app/MCP tools** can be supplied per request by an operator-authorized host over the supported app-tools bridge. Infinite OS structurally checks the scoped catalog, allowlist, loopback proxy URL, and caller-described input-schema shape before advertising those tools, then calls the host's loopback handler. The host/tool handler owns that tool's semantic validation and confirmation contract.
- **Scoped confirmations may be returned after proposal/tool invocation.** A host-supplied tool can return `requiresConfirmation` for follow-up execution, but Infinite OS does not pre-classify every caller-supplied scoped tool as live/destructive before the handler runs.
- **No built-in arbitrary execution:** the native Infinite OS catalog does not include a shell script, code patch, or free-form command runner for model output. Do not expose scoped app/MCP tools that provide shell, filesystem, browser, secret, or other broad host access unless you intend the model to have that host-mediated capability.
- It uses **your** provider credentials; Ultima AI never receives them. Prompt and response content goes only to the provider you authenticate with.

## Out of Scope

- Reports that require pre-existing write access to operator-owned state (`.env`, `.growth-os/`, local config). These are trusted by definition.
- Deploying the services to the public internet without external authentication or network protection.
- Data you knowingly send to a third-party LLM provider for completions — that content's handling is governed by that provider's terms.
- Prompt injection, unless it results in a concrete bypass of credential encryption or another stated boundary.

## Disclosure Process

- **Coordinated disclosure:** a 90-day window, or until a fix is released, whichever comes first.
- **Communication:** via the GitHub Security Advisory thread or email.
- **Credit:** reporters are credited in release notes unless they request anonymity.
