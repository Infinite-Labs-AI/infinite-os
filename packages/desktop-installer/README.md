# infinite-os

Install the signed and notarized [Infinite](https://infinite.fast) AI marketing Desktop app:

```bash
npx infinite-os@latest
```

Infinite is an Apple-silicon macOS app. The Desktop download includes its signed runtime,
database, and `infinite` CLI.

The npm artifact includes the exact reviewed installer published from the
[`Infinite-Labs-AI/infinite-os`](https://github.com/Infinite-Labs-AI/infinite-os) repository. It
downloads the Desktop release through `https://infinite.fast/download`, verifies the production
bundle identifier, Developer ID team, signature, and notarization, then installs and opens
`Infinite.app` at:

```bash
open 'infinite://onboarding'
```

Finish setup in the app: tell Infinite about your business, sign in with an email code, create or
connect your workspace, and connect Codex or Claude.

Use the same Infinite agent either way:

- App: Press `⌘L`
- Terminal: Run `infinite "…"`

Same account. Same workspace. Same agent.
