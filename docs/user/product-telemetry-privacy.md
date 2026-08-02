# Product telemetry privacy

Product telemetry is optional and defaults off. The single source of consent is
`productTelemetryEnabled` in `~/.o8/operator-defaults.json` (or the active
`CORTEX_IDE_DATA_DIR`). Missing, malformed, or legacy browser-only state never
creates consent. Browser events and server events both re-check this persisted
choice, and server egress remains blocked without it.

On first run, o8 asks separately about product usage and crash reports. Saving
the card writes `productTelemetryEnabled`, `crashReportsEnabled`, and
`telemetryConsentAnswered` in one operator-defaults update. The first two keys
record the independent choices; the answered key prevents another prompt.
Missing or malformed answered state means only that the card may appear. It
never enables either sharing path.

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

## Crash-report initialization

In a packaged build with a configured crash endpoint, the crash-report clients
initialize behind a blocking `beforeSend` consent check even while sharing is
off. This is deliberate: a first-run choice can take effect without relaunching,
and turning sharing off stops event egress immediately or within the 30-second
native/browser refresh budget. Off means no crash event leaves the machine; the
client code may still be loaded. The native minidump reporter is stricter and is
not started while crash sharing is off at launch.

A dedicated local-only mode is planned but not yet shipped. The shared policy
predicate already gives local-only mode precedence over product consent, so
that future resolver can fail closed without adding another telemetry
preference.
