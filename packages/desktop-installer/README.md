# infinite-os

Install the signed and notarized [Infinite](https://infinite.fast) AI marketing Desktop app:

```bash
npx infinite-os@latest
```

Infinite is an Apple-silicon macOS app. The Desktop download includes its local engine, embedded
database, and `infinite` CLI. Docker and a separate engine checkout are not required.

The npm artifact includes the exact reviewed installer published from the
[`Infinite-Labs-AI/infinite-os`](https://github.com/Infinite-Labs-AI/infinite-os) repository. It
downloads the Desktop release through `https://infinite.fast/download`, verifies the production
bundle identifier, Developer ID team, signature, and notarization, then installs and opens
`Infinite.app`.
