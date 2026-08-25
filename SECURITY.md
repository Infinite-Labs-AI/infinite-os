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

### Model completions

For natural-language questions, the CLI forwards prompts to your configured model provider — your own Codex login or a Claude API key — for completions. Its boundary is narrow by design:

- It is a **completion proxy only** — it forwards prompts to your chosen LLM provider and returns the response. It executes no tools and runs no shell commands.
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
