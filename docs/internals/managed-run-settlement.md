# External settlement for managed commands

`o8 run` owns a tmux terminal and its marked descendants. A command can also
coordinate independently supervised local or remote work. The optional settlement
contract requires the host to seal that work as quiet before o8 claims completion
or stop. It is a managed-command ledger, without task or packet adoption.

## Host reservation

Authenticated `GET /api/panel/managed-runs` advertises
`settlementContract: "o8/managed-run-settlement/v1"`. The host can refuse an
unsupported server before reservation writes. This identifies API support;
registration acknowledgement and measured settlement are still required.

Before the operator launches `o8 run`, set `O8_MANAGED_RUN_SETTLEMENT_BINDING` to a
JSON file of at most 8192 bytes:

```json
{
  "schema": "o8/managed-run-settlement-binding/v1",
  "executionKey": "opaque-execution-key",
  "generation": 1,
  "branch": "work/owned-branch",
  "providerSessionId": null,
  "profileDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "receiptId": "opaque-receipt-id"
}
```

The actual command, cwd, execution key, branch, profile digest, generation, and
receipt identity are immutable. The CLI derives the run ID from the execution key
and generation. Repeating the launch returns the existing ledger record with
`replayed: true` and `launched: false`; it does not resume execution. A new attempt
needs a new generation. Bound records remain retained to reject delayed replay.

The CLI holds the command behind its launch gate until registration persists.
The acknowledgement must still be running, without a stop request, finish, or
quiet seal. A replay response cannot release an already-cancelled reservation.
It removes the binding-file variable from the command environment and supplies
`O8_MANAGED_RUN_ID` to the host. The host must keep operator credentials and its
receipt/probe inputs outside worker context. This API enforces operator principal
separation; it does not create an operating-system sandbox for host files.

## Provider acknowledgement and receipts

The operator-only `POST /api/panel/managed-runs` actions use the registered ID and
`settlement.bindingDigest` from registration or operator `GET`:

```json
{
  "action": "bind-session",
  "id": "registered-id",
  "bindingDigest": "registered-digest",
  "providerSessionId": "00000000-0000-4000-8000-000000000001"
}
```

A reservation can bind its provider UUID once. Exact replay succeeds. Rebinding
conflicts. Then the host reports its measured state:

```json
{
  "action": "settlement",
  "id": "registered-id",
  "bindingDigest": "registered-digest",
  "receiptId": "opaque-receipt-id",
  "sequence": 1,
  "state": "quiet",
  "providerSessionId": "00000000-0000-4000-8000-000000000001",
  "stopRequestId": null
}
```

States are `active`, `unknown`, and `quiet`. Sequence numbers increase; exact
receipt replay succeeds, conflicting or older replay fails. `quiet` is a final
seal: the host guarantees that this execution cannot start more external work.
It cannot revert to `active` or `unknown`. A never-launched reservation uses a null
provider UUID and `cancelledBeforeLaunch: true` to seal cancellation. A bound
provider cannot use that cancellation claim. The API accepts identity and observed
state only. It does not run supplied shell commands or read supplied receipt paths.

## Stop and finish

Stop first persists `settlement.stopRequestId` and `stopRequestedAt`, requests
`SIGINT`, and allows up to ten seconds for the coordinator and host to settle
external work before normal termination escalation. A final quiet receipt must
acknowledge the exact stop request ID. Stop succeeds only after both the owned
tmux/marker probes and the external receipt are quiet. Missing, stale, mismatched,
or unknown evidence returns an unverified result and keeps the run `settling`.

Natural finish also requires the owned process tree and the external quiet seal.
The host can publish the seal before the wrapper exits. The seal alone cannot
mark the wrapper finished. Reconciliation after a server restart keeps unknown
settlement pending and can confirm a late matching receipt after the process
tree is quiet. Persistence mutations use a bounded file lock and compare the
previous durable record. An unavailable store or contested write fails closed.
An abandoned lock needs operator reconciliation; o8 does not break it automatically.

Workers may request finish or stop for their existing packet-owned run. They cannot
reserve a host binding, bind a provider, publish a receipt, or read host receipt
contents. The UI retains the pending run and keeps stop busy until the server
returns verified settlement.
