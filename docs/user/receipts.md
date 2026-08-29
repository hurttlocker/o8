# Verify packet receipts

o8 creates a signed JSON receipt when a packet is merged or discarded. Copy
that receipt to another machine and verify it with the operator's published
receipt public key. Verification is local: it does not contact a running o8
server.

Packet receipts use a dedicated Ed25519 identity. The private key is stored at
`~/.o8/receipt-identity.key` with mode `0600`. It is separate from the mobile
encryption identity and from every release or updater signing key.

## Create and list receipts

Merged and discarded packets create receipts automatically. Receipt creation
and listing are operator-only governance operations. To create another receipt
for a closed packet or write it to a particular path, run from an operator
session:

```bash
o8 packet receipt <packet-id> --out ./packet-receipt.json
```

The command refuses to overwrite an existing file. List the receipt artifacts
stored for a packet with:

```bash
o8 packet receipts <packet-id>
```

Receipt artifacts remain in the configured o8 data directory under
`artifacts/<packet-id>/`. Their stored paths are relative to that data
directory, so a copied o8 data directory remains readable at its new location.

The same operations are available to an operator MCP client as
`o8_packet_receipt` and `o8_verify_receipt`.

## Truth queries

An operator can mint a spectator token that can read signed answers for only
the named repositories. Repeat `--repo` to grant more than one repository. A
grant should normally be the receipt's normalized remote or the absolute path
of a repository registered in o8.

```bash
o8 broadcast token mint --label "release spectator" \
  --repo example.com/operator/repository
```

Save the returned bearer in the spectator environment. `o8 truth` prefers the
dedicated variable, while `O8_API_TOKEN` remains accepted for operator sessions
and existing integrations.

```bash
export O8_SPECTATOR_TOKEN='<returned bearer>'
```

The three truth queries read the stored receipt ledger:

```bash
o8 truth merged --repo example.com/operator/repository --since 24h --human
o8 truth packet packet-123 --human
o8 truth packet '#1998' --human
o8 truth approvals packet-123 --human
```

Use `--json` for the structured route shape. Use `--save-receipts` to write the
stored receipt text without changing a byte. The human output prints the exact
verification command for every saved answer.

```bash
o8 truth merged --repo example.com/operator/repository --since 7d \
  --save-receipts ./truth-receipts --human
o8 verify ./truth-receipts/<receipt-id>.json --key ./receipt-public.key
```

Copy the saved receipt and the separately published public key to another
machine to verify the answer without access to the o8 server. Repository grants
are enforced before results leave the server. A spectator with no grants gets a
403 response, and packet or approval queries omit receipts from ungranted
repositories.

Prefer remote or absolute-path grants. For a single local repository with no
remote, use the explicit `name:<repo>` form, such as `--repo name:repository`.
The name must resolve to exactly one registered repository path, and it covers
only remote-less receipts whose artifact was recorded for that path. If no
registered path or more than one registered path has that name, truth queries
fail with `grant_ambiguous`; a bare repository name does not grant truth access.

## Publish the public key

On the signing machine, create the dedicated identity if necessary and print
only its public key:

```bash
o8 verify --show-key
```

Publish the printed base64 public key and its key ID through a channel outside
the receipt itself, such as a trusted project website or repository. Never
publish, copy, or commit `~/.o8/receipt-identity.key`.

A verifier can save the published base64 value as
`~/.o8/receipt-public.key`, or pass it directly or by file path:

```bash
o8 verify ./packet-receipt.json --key ./receipt-public.key
o8 verify ./packet-receipt.json --key '<base64-public-key>'
```

The key ID is the first 16 hexadecimal characters of the SHA-256 digest of the
public key. It identifies the expected key; it is not a substitute for obtaining
that key through a trusted channel.

## Verify repository evidence

When verification runs inside a Git repository, o8 also checks a merged
receipt's Git evidence. Use `--repo` when the repository is elsewhere:

```bash
o8 verify ./packet-receipt.json --repo /path/to/repository
```

An accepted merged receipt proves all of the following:

- the receipt signature is valid for the supplied public key;
- the receipt's key ID matches that public key;
- the recorded merge commit exists in the selected repository; and
- the commit's tree matches the tree recorded in the receipt.

A discarded receipt has no merge commit or tree, so its verdict covers the
signature, key identity, and signed discard record. Editing any signed field,
including the disposition, review trail, approval trail, runtime, or model,
causes verification to reject the receipt. A different public key is also
rejected.

## Receipt format

Version 1 receipts use the schema `o8/packet-receipt/v1`. The detached
signature covers the UTF-8 bytes of the complete receipt except `signature`,
serialized as compact JSON with object keys sorted recursively. A merged
disposition records the persisted release evidence plus its Git tree; a
discarded disposition records the close reason and any preserved branches.

The signed `repo` object contains `name`, optional `remote`, and `baseBranch`.
The remote is reduced to `host/owner/name`; credentials, URL schemes, and local
or file remotes are not included. A receipt never stores the local repository
path. The path supplied through `o8 verify --repo <path>` exists only for that
verification process and is not written back to the receipt.

The signed review and approval arrays capture the governance record that was
available when the receipt was created. A later receipt for the same packet is
a new signed observation with its own receipt ID and creation time.

Receipt verification does not use the o8 updater key and has no code path to
the updater key material. Release download verification remains a separate
process described in [Verify o8 release downloads](release-verification.md).
