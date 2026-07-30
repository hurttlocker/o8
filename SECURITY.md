# Security

## Supported platform and secret storage

o8's supported production platform is macOS. Provider voice secrets saved through the app are stored in the macOS Keychain. The current Windows and Linux paths fall back to a plaintext `dictation.json` file; the writer enforces mode `0600` on Unix platforms, but this is not equivalent to a platform credential store. Windows and Linux builds are unsupported today for storing provider voice secrets.

The at-rest encryption master key also uses the macOS Keychain when it is available. If Keychain storage is unavailable, o8 persists a randomly generated key in a plaintext `master-key` file with mode `0600`. This preserves a stable encryption key across restarts, but it provides weaker protection than Keychain-backed storage, so production support assumes that the macOS Keychain path is available.

## Known dependency risk

The current `next` dependency inherits known high-severity `sharp` and libvips advisories. The automated npm remediation would move the application across a breaking Next.js major version, so that change is deferred until it can be migrated and tested safely. This remains a tracked residual risk and is surfaced by the scheduled dependency-audit job.

CodeQL is managed through GitHub's default setup in repository settings rather than a checked-in workflow. This repository intentionally does not include a separate CodeQL workflow file.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting form for `hurttlocker/o8`. Include the affected version, impact, reproduction steps, and any suggested remediation. Do not publish exploit details in a public issue. If the private form is unavailable, open a public issue containing only a request for a private reporting channel.
