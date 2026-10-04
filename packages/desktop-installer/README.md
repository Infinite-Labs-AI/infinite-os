# infinite-os

Install the signed and notarized [Infinite](https://infinite.fast) AI marketing Desktop app:

```bash
npx infinite-os@latest
```

Infinite is an Apple-silicon macOS app. The Desktop download includes its signed runtime,
database, and `infinite` CLI.

`infinite-os@1.0.2` needs Desktop v0.3.21 or later, the first signed and notarized release with the
onboarding handoff (`infinite://onboarding` and the bundled CLI). The installer installs or upgrades to the latest
release and refuses to open anything older than v0.3.21.

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
