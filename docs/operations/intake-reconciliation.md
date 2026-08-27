# External intake reconciliation

External intake reconciliation mirrors private reports into the release operator's local ledger. It is an operations capability, not an application runtime dependency, and an intentionally disabled intake does not block a release.

## Configuration states

`npm run sync:reports -- --dry-run` and the ship preflight distinguish four states:

- `configured`: a read credential is available through `O8_DISCORD_BOT_TOKEN` or the runtime credential file.
- `disabled`: `O8_INTAKE_RECONCILIATION=disabled` intentionally limits reconciliation to the local ledger.
- `missing`: reconciliation is enabled, but no read credential is available.
- `misconfigured`: the mode is invalid, or the runtime credential file is empty, unreadable, not a regular file, or accessible to other users.

The default mode is `enabled`. Set `O8_INTAKE_RECONCILIATION=disabled` only for an environment that intentionally ships from its local report ledger. Diagnostics report the state and credential source, never the credential value.

## Credential ownership and rotation

The release operator owns the read credential. Prefer runtime injection through `O8_DISCORD_BOT_TOKEN`. For a workstation-managed credential, write it to `~/.o8/discord-bot-token` and set mode `0600`. Never place it in source, packaged configuration, logs, screenshots, or release receipts.

To rotate it:

1. Issue the replacement credential in the external intake service.
2. Replace the runtime injection or credential file without printing the value.
3. Run the dry-run canary below.
4. Revoke the old credential after the canary succeeds.

## Canary and recovery

Run the real reconciliation entry point without writing the ledger:

```bash
npm run sync:reports -- --dry-run
```

A configured canary reports the number of messages scanned. A disabled canary reports that the local ledger is unchanged. Missing and misconfigured states fail with a capability-level diagnostic.

If the canary fails, confirm the intended mode, credential injection, runtime file mode, and external service access. Restore one credential source, rerun the dry-run canary, and only then resume reconciliation. Release may continue from the local ledger when the mode is deliberately set to `disabled`.
