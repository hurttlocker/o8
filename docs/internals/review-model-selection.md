# Process-scoped review model selection

`O8_REVIEW_MODEL` optionally selects the initial dedicated Codex review model for
one app/server process. It does not write settings or change chat, worker, or
orchestrator model preferences. Restart that process without the variable to
restore normal model resolution, including the existing flagship cloud default.

The trimmed value must be an exact member of `CODEX_MODEL_IDS` in
`src/lib/models.ts`. Empty, unknown, local-provider, and other-backend model IDs
are refused before a reviewer session or inference starts. An explicit choice
also requires a Codex initial reviewer backend; it does not switch backends.

Reviews pass the canonical operator thinking effort to Codex. For a controlled
review, launch the process with `O8_REVIEW_MODEL=gpt-6.1-sol` and
`O8_THINKING_EFFORT=medium`. These are runtime environment choices, not new saved
settings or release flags.

Quota fallback still uses the existing subscription and cross-house policy. The
Codex override is never forwarded as another backend's model. The fallback model
and resolved backend must match the policy target before that attempt starts.
Without an override, the existing review fallback tier remains unchanged.

Routing receipts preserve the requested model and effort, mark a selected
process override as `env`, and record the effective backend turn receipt when
available, including existing runtime compatibility substitutions. Fallback
models and runtime substitutions have a `derived` model source. Refusals record
no effective route and cannot grant review approval.
