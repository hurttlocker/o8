# Product telemetry privacy

Usage analytics are optional and default on for installs without an earlier
choice. An earlier explicit off stays off after an update. The preference is
`productTelemetryEnabled`: `null` means never chosen, `true` means explicitly
on, and `false` means explicitly off. Unset resolves to on. The canonical file
is `settings.toml` in the active data directory; `operator-defaults.json`
remains the last-good fallback. In TOML, `telemetry.product_enabled = ""`
means unset, and booleans retain their meaning. Unrelated settings saves
preserve this distinction. The operator-defaults API reads and writes the
same three values. Browser-only state never overrides the persisted choice.

On first run, o8 lists exactly what usage events contain, shows an example,
and provides one visible **Turn off** control. That click persists the opt-out
immediately without changing crash sharing or waiting for the screen's save
button. Completing the screen writes `productTelemetryEnabled`, the separate
`crashReportsEnabled` choice, and `telemetryConsentAnswered` together. Leaving
analytics at its default records `null`, not an explicit opt-in. Crash reports
still require a separate choice.

Default-on emits nothing until that screen is completed. The startup event
`app.opened` is then sent once for the dashboard opening if analytics remain
on. An existing explicit opt-in keeps working. Browser and server events both
re-check persisted state before egress; Settings → General → Privacy turns
sharing off immediately. Missing or malformed state cannot bypass the first-run
gate. Crash-report consent and the always-on desktop update ping are unchanged.

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

For example, adding a Git project with a remote sends this usage payload:

```json
{"event":"repo.added","props":{"hasRemote":true,"isGitRepo":true}}
```

Usage event payloads have no identity fields. No identity is collected beyond
sign-in; authenticated delivery uses the existing sign-in entitlement.

The default-on change must remain unmerged until the maintainer confirms that
the [o8.run privacy page](https://o8.run/privacy) covers default-on analytics and
approves the change. That page is maintained separately. The README and next
release notes in this repository describe the same default before shipping.

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
