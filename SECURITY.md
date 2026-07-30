# Security

## Pre-launch security review

o8's surface was adversarially reviewed before the repository was made public. Twenty findings were identified and fixed; the public summary — classes, severities, and how each was resolved — is [issue #1643](https://github.com/hurttlocker/o8/issues/1643).

Root-cause write-ups for those findings are retained privately rather than published. Every one is fixed in current releases, but signed builds of earlier versions remain downloadable, and a published exploit chain would apply to anyone still running one. The redaction protects those users; it does not indicate an unresolved issue. Accepted residual risks are tracked as open issues rather than carried silently.

## Supported platform and secret storage

o8's supported production platform is macOS. Provider voice secrets saved through the app are stored in the macOS Keychain. The current Windows and Linux paths fall back to a plaintext `dictation.json` file; the writer enforces mode `0600` on Unix platforms, but this is not equivalent to a platform credential store. Windows and Linux builds are unsupported today for storing provider voice secrets.

The at-rest encryption master key also uses the macOS Keychain when it is available. If Keychain storage is unavailable, o8 persists a randomly generated key in a plaintext `master-key` file with mode `0600`. This preserves a stable encryption key across restarts, but it provides weaker protection than Keychain-backed storage, so production support assumes that the macOS Keychain path is available.

## Known dependency risk

The current `next` dependency inherits known high-severity `sharp` and libvips advisories. The automated npm remediation would move the application across a breaking Next.js major version, so that change is deferred until it can be migrated and tested safely. This remains a tracked residual risk and is surfaced by the scheduled dependency-audit job.

CodeQL is managed through GitHub's default setup in repository settings rather than a checked-in workflow. This repository intentionally does not include a separate CodeQL workflow file.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting form for `hurttlocker/o8`. Include the affected version, impact, reproduction steps, and any suggested remediation. Do not publish exploit details in a public issue. If the private form is unavailable, open a public issue containing only a request for a private reporting channel.
