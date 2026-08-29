# Verify packet receipts

o8 creates a signed JSON receipt when a packet is merged or discarded. Copy
that receipt to another machine and verify it with the operator's published
receipt public key. Verification is local: it does not contact a running o8
server.

Packet receipts use a dedicated Ed25519 identity. The private key is stored at
`~/.o8/receipt-identity.key` with mode `0600`. It is separate from the mobile
encryption identity and from every release or updater signing key.

## Create and list receipts

Merged and discarded packets create receipts automatically. To create another
receipt for a closed packet or write it to a particular path, run:

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

The signed review and approval arrays capture the governance record that was
available when the receipt was created. A later receipt for the same packet is
a new signed observation with its own receipt ID and creation time.

Receipt verification does not use the o8 updater key and has no code path to
the updater key material. Release download verification remains a separate
process described in [Verify o8 release downloads](release-verification.md).
