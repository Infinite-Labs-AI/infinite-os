Third-party notices — vendored terminal-UI tree (ui-tui/packages/ink)
=====================================================================

Infinite OS is MIT-licensed (see LICENSE). One subtree in this repository is
vendored third-party work carrying its own copyrights. This file records what
it is, where it came from, and what we changed, so the notices travel with
every copy — including the ones that ship inside a distributable.

This matters practically, not just legally: `ui-tui/packages/ink/` is bundled
into the CLI that ships in the Infinite desktop app
(`Infinite.app/Contents/Resources/cli/infinite.mjs`), which is publicly
downloadable. Copies of that bundle are copies of this code.


ui-tui/packages/ink/
--------------------

A vendored, modified terminal-UI renderer — roughly 25.7k lines of TypeScript.
It is what draws the interactive `infinite` CLI. Three copyrights apply; all
three are MIT, and the combined notice lives beside the code in
[`ui-tui/packages/ink/LICENSE`](ui-tui/packages/ink/LICENSE).

| Upstream | What we took | License |
| --- | --- | --- |
| **Ink** — <https://github.com/vadimdemedes/ink> — Copyright (c) Vadym Demedes, Copyright (c) Sindre Sorhus | The renderer itself: the React reconciler, the DOM/output model, `Box`/`Text` components, focus and input handling, ANSI output. `src/ink/` (~22.6k lines). Ink is the origin of this tree; it reaches us second-hand, via the fork below. | MIT |
| **Hermes Agent** — <https://github.com/NousResearch/hermes-agent>, `ui-tui/packages/hermes-ink` — Copyright (c) 2025 Nous Research | The actual bytes. Our `ui-tui/packages/ink/` is a copy of Nous Research's fork of Ink, renamed from `hermes-ink` to `ink`. Their fork is what added the terminal querier, selection/hit-testing, the caches, and the pure-TypeScript Yoga port below. | MIT |
| **Yoga** — <https://github.com/facebook/yoga> — Copyright (c) Facebook, Inc. and its affiliates. | `src/native-ts/yoga-layout/` (2,438 lines): a hand-written TypeScript reproduction of Meta's flexbox layout engine — its layout algorithm in `index.ts`, its public enum API (`Align`, `FlexDirection`, `MeasureMode`, `Edge`, …) in `enums.ts`. It exists so the CLI needs no native/WASM binding. | MIT |

Ink's own attribution is inherited rather than direct: the Hermes Agent fork
does not carry an Ink or Yoga notice of its own, so the table above is
reconstructed from the provenance of the code (upstream Ink issue links and
`TODO(vadimdemedes):` comments survive in `src/ink/`; the Yoga port reproduces
Yoga's public API verbatim). Naming all three is the conservative reading of
MIT's notice requirement, and the correct one.

**What we changed.** Package renamed to `@infinite-os/ink`, dependencies
re-pointed at the workspace, and the renderer adapted to the `infinite` CLI's
chrome. Modifications are Copyright (c) 2026 Ultima AI, Inc, also MIT.


Everything else
---------------

The rest of this repository — `apps/`, `packages/`, `scripts/`, `tests/`, and
`docs/` — is original work, Copyright (c) 2026 Ultima AI, Inc, MIT-licensed
under the root LICENSE. Ordinary npm dependencies are not listed here; their
licenses ship with them in `node_modules/` and are resolvable from
`pnpm-lock.yaml`.
