# Meta write diagnostics

Meta write errors carry an additive `metaWrite` version-1 diagnostic. The server CLI lane keeps bounded, redacted stdout/stderr, exit code, signal and duration. It parses the actual meta-ads 1.1.0 exit-4 API header and the following user-message lines. It does not treat arbitrary JSON embedded in stderr as a provider response. Direct Graph writes additionally preserve HTTP status and structured provider code/subcode where available; CLI output cannot recover fields the CLI has already discarded.

`phase` distinguishes `not_dispatched`, `provider_response` and `dispatch_unknown`. Handler input/credential checks run inside an invocation-local context. The dispatch marker is set before the HTTP request or child process can send, never after the awaited result. A failed spawn is proven pre-dispatch. A killed child, lost response, malformed success or missing entity ID stays uncertain.

Known validation/auth refusals and known throttle responses have distinct outcomes. Internal/service errors (1/2), unknown codes and incomplete diagnostics remain conservative. All writes remain non-retryable at the transport. A host must scope definite outcomes to one operation: a rejected second operation cannot erase an earlier successful operation in a compound change.

Diagnostics are bounded by serialized JSON bytes, after removing credential material. Explicit truncation flags accompany bounded streams. Normal two-line provider errors retain both lines. Hosts should persist this diagnostic alongside their coarse outcome and expose only the redacted `metaMessage` to users.

The fixture `src/fixtures/meta-cli-1.1.0-refusal.json` is real CLI output obtained offline by replaying recorded provider-response fields. Its provenance explicitly distinguishes replay from a live CLI failure capture. Unit tests never contact the provider.
