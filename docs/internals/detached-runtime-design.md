Design for #4229; Codex packet identity/rebind slice implemented.

Owned CLI workers already detach to files. Direct PTYs and RPC sessions still depend on server I/O.

Use a small per-session supervisor, spawned detached+unref, for PTY/RPC work; keep detached batch workers. macOS detached spawn creates a session, but PTY master loss hangs up; server-owned pipes still close. The supervisor keeps master/stdin; control reconnects over a private socket.

Append output/events and exit receipts to durable data-root files; server tails offsets, never owns output pipes.

Persist surface/run/lane/provider session IDs, worker/supervisor PIDs, boot ID and kernel start time. At launch verify process identities and any supervisor handshake, then rebind lane and replay cursor. Reject reused PIDs.

Target restart: close mutation admission; drain only git/publication. Journal intent, child identity and settlement. Recover crashed/pre-Git intents within 30s using monotonic deadlines and outcome reconciliation (#4189). Live operations defer restart; unknown publication is reconciled before retry.

First slice: Codex packets, kernel identity and survivor rebind. Out: other RPC migrations, native voice, Windows/Linux, global idle-guard removal until all paths pass.

Proof: real launch route -> worker -> TERM/KILL server -> fresh server; same PID/start, session and lane, growing transcript, no duplicate. Test PID reuse, offline output, stop after reattach, and crash before Git/publication.
