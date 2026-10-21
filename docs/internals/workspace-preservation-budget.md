# Workspace preservation bank admission

New writes to `workspace-preservation` share a 4 GiB aggregate byte limit and a
10,000-entry inspection limit. The policy is defined in
[`preservation-bank-budget.ts`](../../src/lib/workspace/preservation-bank-budget.ts).
It is admission control for this bank, not an operating-system quota or a bound
on all application storage.

Each new capture reserves 2 GiB and 128 entries under the existing cross-process
lifecycle lock. The bank is bound to that lock's database. Retained regular files,
including legacy or partial evidence, count at the greater of allocated bytes
and logical length, rounded to at least 64 KiB per entry. Directories also count.
Unresolved reservations, preparation/publication staging, unsafe links and unknown
directory layouts refuse new growth. The scan stops at the entry or byte bound;
it does not load file contents or infer that old evidence is reclaimable.

The reservation covers three copies of the existing maximum 512 MiB bundle
(capture, packed verifier and publication), a maximum 64 MiB manifest, index
storage, and metadata. Git output already has a 32 MiB bound: at least 41 bytes
per SHA-1 object line. The verifier allows 128 bytes per observed object plus
4 KiB for index and temporary index overhead, 128 entries at 64 KiB, and another
16 MiB for fixed metadata. This remains below the 2 GiB reservation without an
additional object-count ceiling. The verifier keeps packed objects and disables
automatic maintenance. These are conservative implementation allowances, not
measured exact peak allocation for every filesystem.

Process custody uses identity-before-execution and observed-close receipts for
owned wrappers and nested writers. A failed capture releases only its own exact
reservation after all writers have settled and fresh bank accounting and identity
checks succeed. Manifest handles must close even when writing or syncing fails.
A crash, missing close, interrupted child or failed handle close retains capacity;
requesting a stop, deleting staging or observing PID absence is not closure proof.
Reservation and store directory entries are synced for durability. This policy
adds no automatic restart reconciliation or stale-reservation deletion.

Refusal preserves the source workspace and its retention hold. Existing reads,
Git bundle recovery, selected artifact restoration and verified identical retries
remain independent of new-write admission, including when the bank is full or
held. A retry must still match current source, captured artifacts, ownership,
snapshot generation and the immutable receipt.

This policy does not purge or expire banks, release existing holds, change external
provider transcript retention, or count an owned-session archive rename as a new
copy. Generated-output banks and other retained evidence have separate lifecycles.
