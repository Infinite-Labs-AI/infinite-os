// Stub for `react-devtools-core`. Upstream `ink` only imports it from `devtools.js`, which is
// reached solely via a `process.env.DEV === 'true'` guarded dynamic import in reconciler.js. The
// shipped desktop CLI never sets DEV, so this module is never executed — we alias it here to keep
// the bundle single-file and self-contained (no runtime resolution of an unshipped dev dependency).
export default {
  connectToDevTools() {}
};
