# Fresh media observer

[Codex] The optional SyncRequest.metaAdsOnMedia callback receives image/thumbnail URLs already returned by the ads edge, before sanitization. It runs once per provider page, follows the caller's normal account binding, and does not add Graph requests. The hosting layer owns downloading and private storage; the engine remains cloud-agnostic.

[Codex] Hints include account, creative, slot, kind, stable fingerprint, provider asset identity/type and the transient URL. URLs may contain expiring capabilities: never persist or log the callback payload. Durable entity metadata/descriptors keep the existing redaction. Full video retrieval is unchanged; a video ID alone is not a video file.

[Codex] The cloud sink must bound work and handle failures. Observer failure cannot fail otherwise valid insight extraction; missing media remains recoverable through the existing archive process. Callers that omit this observer preserve existing behavior.

[Codex] Verification: real PGlite sync test asserts the callback gets the signed URL while persisted metadata does not. Full engine suite3,516passed (bounded4workers); default high-parallelism runs exposed unrelated timing-sensitive CLI tests, which pass isolated. Typecheck and public tripwire passed. Independent5.6high review covered the engine and consuming cloud implementation; cloud delivery must re-vendor this merged engine and exercise the actual frozen bundle, not just mocks.
