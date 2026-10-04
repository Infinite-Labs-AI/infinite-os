# Desktop CLI bundle

Build the workspace, then run `pnpm --filter ./apps/cli build:bundle`.
Ship the whole `apps/cli/dist/bundle` directory, not just `infinite.mjs`.

The `infinite-tag/` sidecar preserves the published package layout: metadata, license,
compiled runtime and public contracts. The analytics command loads it through a relative
import. It must remain outside `node_modules` because desktop staging deliberately removes
the duplicate PGlite dependency tree there. The tag currently has no runtime dependencies;
the bundler refuses to ship it if dependencies are added without updating staging.

Inlining the tag into `infinite.mjs` breaks its package-relative metadata lookup and makes
`infinite analytics --check` fail before inspection. The bundle regression test therefore
relocates the distribution outside the checkout and invokes analytics through an executable
symlink against a static HTML fixture. A successful audit is a seven-provider report; it is
not proof that any provider received an event.
