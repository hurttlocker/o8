# Product telemetry privacy

Product telemetry is optional and defaults off. The single source of consent is
`productTelemetryEnabled` in `~/.o8/operator-defaults.json` (or the active
`CORTEX_IDE_DATA_DIR`). Missing, malformed, or legacy browser-only state never
creates consent. Browser events and server events both re-check this persisted
choice, and server egress remains blocked without it.

The wire allowlist is intentionally complete and small:

- `app.opened`, `brain.asked`, and `orchestrator.message` carry no properties.
- `dispatch.started` carries only a known worker-runtime enum.
- `merge.approved` carries only a known worker-runtime enum and `pushed` boolean.
- `repo.added` carries only `hasRemote` and `isGitRepo` booleans.

Unknown events or invalid fields are rejected, and extra fields are discarded.
Code, prompts, repository names, paths, diffs, transcripts, file contents,
credentials, user identity, and machine identity are never allowed. Crash-log
upload, Sentry crash/error sharing, and user-initiated issue reports have their
own controls and do not inherit product-telemetry consent.

A dedicated local-only mode is planned but not yet shipped. The shared policy
predicate already gives local-only mode precedence over product consent, so
that future resolver can fail closed without adding another telemetry
preference.
