# infinite-os

Install the signed and notarized [Infinite](https://infinite.fast) AI marketing Desktop app:

```bash
npx infinite-os@latest
```

Infinite is an Apple-silicon macOS app. The Desktop download includes its signed runtime,
database, and `infinite` CLI.

The npm artifact (`infinite-os@1.0.2`) includes the exact reviewed installer published from the
[`Infinite-Labs-AI/infinite-os`](https://github.com/Infinite-Labs-AI/infinite-os) repository. The
Infinite download sits behind sign-up, so the installer opens `https://infinite.fast/get-started` in
your browser; the signed and notarized app downloads right after you sign up. With `Infinite.app`
already installed it starts the app's bundled `infinite` command. This behavior is
not promised by `@latest` until `1.0.2` is published.

Finish setup in the app: tell Infinite about your business, sign in with an email code, create or
connect your workspace, and connect Codex or Claude.

Use the same Infinite agent either way:

- App: Press `⌘L`
- Terminal: Run `infinite "…"`

Same account. Same workspace. Same agent.
