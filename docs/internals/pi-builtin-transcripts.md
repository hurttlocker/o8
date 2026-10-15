# Built-in Pi packet transcripts

The shared packet transcript reader reads the built-in Pi worker's sanitized
`runs/<run-id>.jsonl` logs. It does not read raw Pi SDK session files or provider
configuration. The operator's `o8_packet_transcript` command and the packet pane
use the same API reader.

The reader validates the exact owned session identity and regular-file paths,
including archived sessions. Archive rebasing only accepts the matching run's
original active-session path. Missing, malformed, redirected or oversized
metadata and unsafe log paths produce no transcript from those sources.

Each read shares a 256,000-byte budget across the most recent 32 recorded runs,
prioritizing newer runs. Only complete newline-terminated records are eligible.
Assistant text, tool calls and results are bounded when normalized. Successful
settlement emits `done` with exit code zero; failed or interrupted settlement
emits a visible error summary. Invalid timestamps use a stable epoch fallback.

Sequence numbers are snapshot-local, as with the existing shared reader. If the
bounded tail advances or older runs leave the retained history, events can be
renumbered. Cursor pagination is useful within an unchanged snapshot; it is not
a durable resume cursor. Tail polling is the packet pane's readback mode.

Persisted-fixture tests prove operator/API readback and mounted-pane delivery.
They do not establish a newly dispatched SDK worker's execution or a live
provider run; those are separate real-dispatch acceptance boundaries.
