# Bounded worktree maintenance

Completion, startup and periodic reconciliation use one deterministic scheduler. No model call or
operator confirmation is needed for an eligible, already authorized retirement. The existing
worktree manager owns preservation, liveness, retention holds, identity checks and exact journal
replay. Discovery records never grant removal authority.

Each pass admits at most 20 candidates and 27 candidate page requests, with a three-second admission
deadline and a shared 16 MiB metadata read allowance. An admitted retirement settles before another
pass starts; its completion can occur after the admission deadline. A process-identity verified
SQLite lease excludes concurrent API and WebSocket passes through settlement. Startup and interval timers are
both cancelled on stop.

SQLite keyset cursors and finite cycle boundaries rotate between active lanes, terminal lanes,
known metadata roots, exact managed metadata entries, persisted retirement claims, legacy metadata
roots and queued completions. The cursor advances after the attempt settles, including a refusal or
absence. A crash retries the candidate through its existing journal. New arrivals cannot extend a
cycle indefinitely. Held candidates do not pin a cursor at the front of the queue.

Metadata writes project exact discovery paths and creation-time lane/packet associations in the
same transaction as the authoritative metadata blob. Before acting, reconciliation rereads metadata,
requires revision agreement, and checks the current terminal lane association. Packet collision
slots remain discoverable after a lane's public worktree path becomes null. Renamed retirement
claims remain discoverable when the public source name disappears. Unregistered directories are
never inferred from a directory listing.

Automatic reconciliation admits a whole metadata root or repository registry only when it is a
regular file of at most 256 KiB and contains at most 256 entries. The limit applies before copying
SQL blobs or reading pinned file handles, and downstream manager metadata reads share the same
pass allowance. Oversized, invalid, unassociated or incompatible legacy roots remain held with an
explicit persisted reason. They are never reported empty or fully reconciled. The bounded policy
does not provide unrestricted automatic coverage of larger legacy inventories; those require a
separate explicit migration or policy change. Other eligible roots continue progressing.
Lane ownership discovery indexes basenames and ambiguous dot-component tails, reads at most 33
candidate paths, and refuses an inventory above 32. Fresh normalization then preserves exact-path
conflicts across repositories and canonical repository matching through aliases. NULL-path history
and unrelated basenames do not consume the query allowance. Repository registry reads freshly admit the file during retirement,
including when an interactive registry cache exists.

Authenticated operators can inspect the last pass, policy limits and a bounded page of root holds
at `GET /api/orchestrator/workspace/maintenance`. A repository-registry admission hold is included
in the last-pass receipt. This endpoint does not release holds or delete resources.
