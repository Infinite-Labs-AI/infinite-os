# infinite-os

Install the signed and notarized [Infinite](https://infinite.fast) AI marketing Desktop app:

```bash
npx infinite-os@latest
```

Infinite is an Apple-silicon macOS app. The Desktop download includes its signed runtime,
database, and `infinite` CLI.

This source package prepares `infinite-os@1.0.2` for the Desktop v0.3.20 handoff release. It must
not be published until the signed and notarized Desktop v0.3.20 DMG is live and verified; that
handoff behavior is not live in `@latest` while npm still resolves to the earlier package.

When the release dependency is satisfied, this package downloads the Desktop release through
`https://infinite.fast/download`, verifies the production bundle identifier, Developer ID team,
signature, and notarization, installs or updates `Infinite.app`, opens `infinite://onboarding`, and
then hands the terminal to the bundled `infinite` CLI after app-owned setup is ready.

Finish setup in the app: tell Infinite about your business, sign in with an email code, create or
connect your workspace, and connect Codex or Claude.

Use the same Infinite agent either way:

- App: Press `⌘L`
- Terminal: Run `infinite "…"`

Same account. Same workspace. Same agent.
