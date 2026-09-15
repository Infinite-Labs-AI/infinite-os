# Meta Ads CLI on a shared server

The local desktop CLI runner supports ambient `ACCESS_TOKEN` and an operator-selected
`cliCommand`. A shared worker must not inherit either one: a long-lived process can serve
different workspaces concurrently.

The server constructs action handlers for one request with a trusted policy:

```ts
createActionHandlers(db, {
  encryptionKey: workspaceKey,
  metaAdsCliExecution: {
    mode: "isolated_server",
    executable: "/app/meta-cli/bin/meta",
    path: "/app/meta-cli/bin:/usr/bin:/bin"
  }
});
```

The option is process-only and never part of `connect_source`, a stored credential, or a
task payload. The handler decrypts the workspace/source credential, checks that the
connected source's `account_external_id` matches its `adAccountId`, then binds the
policy to that invocation. The runner requires a stored `accessToken` and ignores
`credential.cliCommand` and ambient authentication. It starts the fixed executable
without a shell in a new private HOME/XDG/cwd, passes a minimal environment, caps
stdout at 128 KiB and stderr at 8 KiB, waits for child `close`, and removes the
directory on success and failure. Provider stderr is not returned to callers because
it can echo a token. Existing local execution remains the default when the option is
omitted.

This is subprocess and credential isolation, not actor authorization. The cloud
caller must authenticate and authorize the actor, bind the workspace/source at
enqueue and again at worker execution, choose the fixed image executable and PATH,
and provide the workspace encryption key. Stored-token Meta reads retain the
engine's direct Graph path; Meta CLI writes retain paused-create, confirmation,
idempotency, and non-retryable money-write rules. No Meta calls or ad writes are
required to verify this isolation contract: tests use fake executables and tokens.
