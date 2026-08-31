# Cross-device continuity protocol

Status: phase 1 protocol and implementation inventory. This document does not add a transfer runtime.

Cross-device continuity is a cold continuation of one governed packet, not migration of one operating-system process. A session is an aggregate whose authorities live in separate stores. The protocol therefore transfers portable evidence, fences the source, rebuilds machine-local state, and records a new ownership generation. It must not treat a transcript or provider thread as a substitute for mission, packet, lane, reviewed `HEAD`, or approval state.

## 1. Session state inventory

### Governance identity and history

The durable lane row is the execution identity. It records the project and repository, worktree and branch, runtime and model, attached session key, packet and pull-request identity, status, outcome, writer ownership, and timestamps. Lane events are separate append-only rows with a lane identifier, verb, actor, JSON payload, and timestamp. Creating a lane persists the workspace and runtime binding; attaching or detaching a runtime changes the lane's session key and appends an event. (`src/lib/db/schema.ts:428-459`, `src/lib/db/schema.ts:607-617`, `src/lib/lane/registry.ts:125-145`, `src/lib/lane/registry.ts:266-317`, `src/lib/lane/registry.ts:574-619`)

Lane reconciliation already distinguishes durable governance from observed runtime state. Terminal or review lanes remain authoritative, while an active lane can be detached and paused after its runtime session is missing beyond a grace period. Reattachment requires a runtime, working-directory, and branch match. A transfer must preserve the lane and its events while changing the machine-local session binding through an explicit ownership transition. (`src/lib/lane/registry.ts:696-875`)

### Mission and packet state

The active mission lifecycle is the versioned `orchestrator-state.json` file. Reads normalize the mission, writes use a temporary file and rename, and every locked mutation reconciles the stored mission with lane/runtime evidence before writing. Read-time status evidence is intentionally stripped from persistence. (`src/lib/orchestrator/control-plane.ts:19-21`, `src/lib/orchestrator/control-plane.ts:139-173`, `src/lib/orchestrator/control-plane.ts:247-269`, `src/lib/orchestrator/control-plane.ts:300-324`, `src/lib/orchestrator/persisted-mission.ts:4-17`)

That mission contains packet identity, target workspace and branch, runtime selection, dependency and queue state, retry and spend state, blocking and completion records, storage and recovery state, review state, and its lane binding. The mission also carries its own identifier, repository, constraints, creation receipt, packet list, lifecycle hold, and update time. (`src/lib/orchestrator/types.ts:272-357`, `src/lib/orchestrator/types.ts:561-590`)

The mission database is a historical sibling, not the authority for active packet lifecycle. Its upsert is idempotent by mission identifier and can retain a normalized mission snapshot; current packet status is reconstructed from live lanes. (`src/lib/db/missions-store.ts:1-14`, `src/lib/db/missions-store.ts:22-53`, `src/lib/db/missions-store.ts:112-150`)

### Workspace and branch materialization

A managed workspace comprises a local worktree path, branch and base branch, repository identity, isolation kind, dependency receipt, creation owner and `HEAD`, and a materialization identity containing the canonical path, device, and inode. The manager creates the branch and worktree at an admitted local storage root and persists those local identities. (`src/lib/worktree/types.ts:20-59`, `src/lib/worktree/types.ts:156-215`, `src/lib/worktree/manager.ts:481-590`)

Workspace snapshot state adds portable Git facts such as repository UUID, packet/mission/lane identifiers, branch/base branch, `HEAD`, tree, recovery ref, diff fingerprint, dependency and session identities, generation, version, and transition state. Snapshot creation is transactional and idempotent for a matching creation mutation and fingerprint. (`src/lib/worktree/snapshot-state-types.ts:43-69`, `src/lib/worktree/snapshot-state-types.ts:97-147`, `src/lib/worktree/snapshot-state.ts:388-424`, `src/lib/worktree/snapshot-state.ts:444-527`)

### Runtime-owned session state

Each owned runtime session has a private directory and `session.json`. The record includes lane and packet identity, working directory, repository and branch/`HEAD`, workspace binding, provider thread identity, prompt and summary metadata, model configuration, a local configuration-home reference, review metadata, retries, and run records. Each run records local process identifiers, command identity, process group, marker, output paths, outcome, and optional terminal multiplexer identity. (`src/lib/runtimes/shared/owned-session/types.ts:37-129`, `src/lib/runtimes/shared/owned-session/helpers.ts:27-35`, `src/lib/runtimes/shared/owned-session/session-io.ts:41-59`)

The store writes the session record before spawning a process. A cold resume starts a fresh process and requires a durable provider thread identifier; archived output paths are rebased only within the local archive directory. Rebinding is an idempotent local compare-and-set over logical workspace identity, repository UUID, packet, current path, binding version, and the absence of an active run. (`src/lib/runtimes/shared/owned-session/store.ts:140-249`, `src/lib/runtimes/shared/owned-session/store.ts:256-319`, `src/lib/runtimes/shared/owned-session/session-io.ts:73-88`, `src/lib/runtimes/shared/owned-session/store.ts:527-598`)

### Transcripts

The runtime contract normalizes transcript entries as role, content, timestamp, kind, tool metadata, and raw provider data. Runtime adapters own discovery and transcript reads. The current durable-thread adapter reads provider JSONL history under a registered local configuration home, while a synthetic live-process surface has no resumable transcript until it is bound to a durable thread. (`src/lib/runtimes/types.ts:164-193`, `src/lib/runtimes/types.ts:309-399`, `src/lib/codex/sessions.ts:209-245`, `src/lib/codex/sessions.ts:662-722`, `src/lib/runtimes/codex.ts:311-332`)

Orchestrator conversation history is a second transcript family. It is stored under the local data directory and replays durable user and assistant messages, including attributed handoff seams, into a stateless backend. (`src/lib/mobile/orchestrator-thread-path.ts:1-14`, `src/lib/mobile/orchestrator-thread-history.ts:54-67`, `src/lib/mobile/orchestrator-thread-history.ts:93-115`)

### WebSocket subscriptions and local boot trust

WebSocket client state is process memory: the selected session key, terminal subscriptions, realtime subscriptions and negotiated capabilities, packet-tail subscriptions, outbound queues, authentication kind, and per-connection encryption key. Connection close removes terminal and orchestrator subscriptions and deletes the client record. Realtime replay cursors are relative to a server epoch and retained event log, so they are reconnection aids rather than transferable session state. (`src/ws-server.ts:933-969`, `src/ws-server.ts:2828-2845`, `src/ws-server.ts:3580-3685`, `src/ws-server.ts:8170-8232`)

The packaged app chooses dynamic local API and WebSocket ports and writes `api-port` and `ws-port`; standalone callers resolve those local files after environment overrides. The WebSocket operator token lives in a separate mode-`0600` `ws-token` file and authenticates loopback operator access. These files describe one machine's current boot, not the governed session. (`src-tauri/src/lib.rs:720-733`, `src-tauri/src/lib.rs:7830-7837`, `src/lib/panel/api-port.ts:1-20`, `src/lib/panel/api-port.ts:90-142`, `src/lib/ws-auth.ts:6-43`, `src/ws-server.ts:7150-7162`)

## 2. Existing serialization and transforms

| Mechanism | What it already carries | What it does not carry |
| --- | --- | --- |
| Runtime normalization | Runtime/session key, cwd, branch and `HEAD`, lifecycle, capabilities, ownership, activity, process observations, and normalized transcript entries. (`src/lib/runtimes/types.ts:112-193`) | A mission or lane mutation, workspace bytes, credentials, or process migration. The interface exposes discovery, transcripts, lifecycle control, and transforms as separate operations. (`src/lib/runtimes/types.ts:309-399`) |
| Owned-session store | A mode-`0600` metadata file, per-run output paths, provider thread identity, workspace binding, and local process receipts. (`src/lib/runtimes/shared/owned-session/types.ts:37-129`, `src/lib/runtimes/shared/owned-session/session-io.ts:41-59`) | A portable store image. The record embeds cwd, local configuration-home references, PIDs, process groups, output paths, and terminal multiplexer identities. (`src/lib/runtimes/shared/owned-session/types.ts:37-129`) |
| Workspace snapshot state | Immutable Git truth, repository and governance identifiers, recovery and diff fingerprints, session identity, dependency receipt, generation, and idempotent transition receipts. (`src/lib/worktree/snapshot-state-types.ts:43-69`, `src/lib/worktree/snapshot-state.ts:444-527`) | A cross-machine materialization. Current park and restore require the registered repository UUID, exact original path, exact workspace binding, and quiescent local process state. (`src/lib/workspace/hibernator.ts:340-424`, `src/lib/workspace/restorer.ts:291-355`, `src/lib/workspace/restorer.ts:392-426`) |
| Session-transform catalog | Imported durable session identity, checkpoints with private provider references, lineage, operation receipts, catalog version, and review invalidation when a transform changes `HEAD`. Intent phases make provider side effects recoverable after interruption. (`src/lib/runtime/session-transform-catalog.ts:16-108`, `src/lib/runtime/session-transforms.ts:205-233`, `src/lib/runtime/session-transforms.ts:254-367`) | Transcript bytes, provider credentials, a running owned-process surface, workspace bytes, mission state, or lane ownership. Public catalog projection deliberately omits private provider references and mutation identifiers. (`src/lib/runtime/session-transform-catalog.ts:110-118`, `src/lib/runtime/session-transform-catalog.ts:169-205`) |
| Current durable-thread transforms | Import registers an existing durable provider thread; checkpoint selects a completed provider turn; fork and rewind create a new continuation while preserving the original. Live or owned-process-only surfaces are rejected, and configuration-home resolution stays server-local. (`src/lib/codex/session-transforms.ts:32-40`, `src/lib/codex/session-transforms.ts:86-133`, `src/lib/codex/session-transforms.ts:171-259`) | Machine trust, process state, or portable credentials. The transform result is provider identity and lineage, not a complete o8 session. (`src/lib/codex/session-transforms.ts:276-345`, `src/lib/runtime/session-transforms.ts:564-728`) |
| Outgoing mission snapshot | A structured clone of normalized mission state plus packet metadata and wave assignments, persisted as historical mission evidence. (`src/lib/orchestrator/operator-mission-service/mission-handoff.ts:5-23`, `src/lib/db/missions-store.ts:112-165`) | Runtime files, transcripts, subscriptions, trust material, or a receiving-machine ownership transition. The active lifecycle still belongs to the file-backed control plane. (`src/lib/db/missions-store.ts:1-14`, `src/lib/orchestrator/control-plane.ts:19-21`) |
| Handoff packet | Narrative and intent, observed repository/branch/`HEAD`/path/diff facts, packet/lane/session identifiers, approvals, retry counters, lane states, and at most 200 recent events. (`src/lib/orchestrator/handoff-packet.ts:19-24`, `src/lib/orchestrator/handoff-packet.ts:46-150`, `src/lib/orchestrator/handoff-packet.ts:381-456`) | An executable state replica. Its governance block is explicitly a summary, and narrative can be compacted before handoff. (`src/lib/orchestrator/handoff-packet.ts:464-584`) |
| Machine registry and attach relay | Account-scoped registered-machine identity, short-lived target relay tickets, one persistent outer connection, and relayed HTTP/WebSocket frames. The local operator token is injected only on the target machine's loopback hop. (`src/lib/connect/machine-registry.ts:106-160`, `src/lib/connect/machine-registry.ts:184-260`, `src/lib/connect/machine-registry.ts:276-323`, `src/lib/connect/machine-attach.ts:59-90`, `src/lib/connect/machine-attach.ts:334-380`, `src/lib/connect/machine-attach.ts:405-483`) | Session serialization or transfer authorization. The current ticket selects and connects a registered target; it does not name a mission, packet, lane, state generation, or payload digest. (`src/lib/connect/machine-registry.ts:8-34`) |

## 3. State that cannot move

### Live PTYs and operating-system processes

PTYs are local kernel objects owned through a process-local handle map. The terminal host forks a local child process; host failure clears the handles, and persistent terminals survive only through a local terminal-multiplexer session identified by name and cwd. Owned runtime receipts likewise contain local PID, process group, marker, and terminal identity. A transfer can carry a quiescence receipt and output transcript, but the receiver must spawn a new process. (`src/lib/ws-server/terminal-host-child.ts:1-24`, `src/lib/ws-server/terminal-host-child.ts:42-101`, `src/lib/ws-server/terminal-host-client.ts:119-189`, `src/lib/terminal/tmux.ts:17-28`, `src/lib/terminal/tmux.ts:63-123`, `src/lib/runtimes/shared/owned-session/store.ts:449-524`)

### Worktrees and APFS materializations

A worktree has machine-local absolute paths and Git administrative links. The copy-on-write isolation path is available only on the required operating system, requires an APFS source, and requires source and target on the same device. Materialization identity is re-proved from canonical path, device, and inode before mutation. Those values are evidence against local path replacement, not portable identity. The receiver must create a new admitted worktree and prove its own repository and Git facts. (`src/lib/worktree/manager.ts:481-590`, `src/lib/worktree/apfs.ts:76-131`, `src/lib/worktree/materialization-identity.ts:7-42`, `src/lib/worktree/manager.ts:707-835`)

### Keychain, signing, and provider configuration

The local database master key resolves from the machine Keychain, an explicit environment override, or a per-install fallback; a locked Keychain fails rather than silently rotating the key. Per-install encryption signing secrets are stored locally and never leave the host, and native credential APIs return presence rather than secret values. Provider configuration-home references in owned sessions are also local identity pointers. A transfer may name the required capability or public identity, but it must not copy these secrets. (`src/lib/db/master-key.ts:1-15`, `src/lib/db/master-key.ts:67-95`, `src/lib/db/master-key.ts:123-183`, `src/lib/mobile/e2ee-identity.ts:1-26`, `src/lib/mobile/e2ee-identity.ts:49-79`, `src-tauri/src/stt/keys.rs:159-217`, `src/lib/runtimes/shared/owned-session/types.ts:77-129`)

### Loopback ports, operator token, and subscriptions

The operator WebSocket token grants broad local operator authority. Enrolled devices use scoped credentials and must never receive it. Relay code injects the token only into the destination's loopback request and blocks it from outgoing relayed payloads. Port files, the token file, connection encryption keys, and subscription sets therefore remain on their source machine; the receiver resolves its own ports/token and re-subscribes from durable cursors or a fresh snapshot. (`src/app/api/panel/mobile-pairing/route.ts:53-91`, `src/middleware.ts:144-147`, `src/lib/connect/machine-attach.ts:405-483`, `src/ws-server.ts:933-969`, `src/ws-server.ts:2828-2845`)

## 4. Proposed phase-2 protocol

### Invariants

1. Transfer is a four-message, cold-continuation transaction: `offer`, `accept`, `transfer`, then `resume`.
2. The mission, packet, and lane identifiers remain stable. Machine ownership and runtime session binding advance to a new generation.
3. `offer` is read-only. `accept` reserves a receiving machine. Before `transfer`, the source must quiesce processes and durably fence new writes. Only a verified `resume` receipt completes ownership.
4. No message contains a loopback token, account bearer, relay ticket, private signing key, provider credential, local configuration-home contents, PID, PTY handle, inode, or source absolute path.
5. Approval state transfers only as evidence. The receiver revalidates reviewed `HEAD`, tree, diff fingerprint, and approval version before treating an approval as current. Existing transform code already invalidates governance when `HEAD` moves. (`src/lib/runtime/session-transforms.ts:205-233`, `src/lib/runtime/session-transforms.ts:633-728`)

### Common envelope

All messages use the following logical envelope. The shapes are a phase-2 wire proposal, not existing runtime types.

```ts
type ContinuityEnvelope<T> = {
  schema: 'o8/session-continuity/v1';
  type: 'offer' | 'accept' | 'transfer' | 'resume';
  transferId: string;       // stable across all four messages
  mutationId: string;       // stable for retries of this phase
  sourceMachineId: string;
  targetMachineId: string;
  missionId: string;
  packetId: string;
  laneId: string;
  generation: number;
  createdAt: string;
  expiresAt?: string;
  payloadDigest: string;    // digest of canonical payload bytes
  transferGrant: string;    // short-lived, transfer-scoped credential
  payload: T;
};
```

`generation` is a compare-and-set ownership epoch. The first `offer` names the source's observed generation. A successful `resume` records `generation + 1`; later source writes at the old generation fail.

### `offer`

```ts
type OfferPayload = {
  source: { laneStatus: string; sessionKey: string | null; runtime: string };
  repository: { repositoryUuid: string; branch: string; baseBranch: string; head: string; tree: string };
  workspace: { diffFingerprint: string; snapshotGeneration: number; snapshotVersion: number };
  mission: { updatedAt: string; packetStatus: string; retryCount: number };
  provider: { durableSession: boolean; catalogVersion: number; checkpointId?: string };
  available: Array<'mission' | 'lane-events' | 'workspace' | 'transcript' | 'provider-lineage'>;
};
```

The source builds this preview from current lane, mission, workspace-snapshot, and transform-catalog authorities. It does not fence work or send payload bytes. The target can reject unsupported runtime capabilities, a missing repository mapping, insufficient storage, or an unavailable local provider identity before either side mutates execution state.

### `accept`

```ts
type AcceptPayload = {
  offerMutationId: string;
  expectedSourceGeneration: number;
  targetReservationId: string;
  repositoryMapping: { repositoryUuid: string; localRepositoryId: string };
  capabilities: { runtime: string; canResumeProviderThread: boolean; isolationKinds: string[] };
  acceptedParts: OfferPayload['available'];
};
```

Acceptance creates an expiring target reservation keyed by `transferId`. It does not create a lane, worktree, provider continuation, or process. The mapping identifies a locally registered clone by repository UUID; it never accepts a source absolute path.

### `transfer`

```ts
type TransferPayload = {
  acceptMutationId: string;
  expectedSourceGeneration: number;
  sourceFence: { fencedAt: string; activeProcess: false; finalHead: string; finalTree: string };
  missionSnapshot: unknown;
  lane: { row: unknown; events: unknown[]; lastEventId: string | null };
  workspace: {
    manifest: unknown;
    recoveryRef?: string;
    gitObjectPack?: string;
    trackedPatch?: string;
    untrackedArchive?: string;
  };
  transcripts: Array<{ kind: 'runtime' | 'orchestrator'; encoding: 'jsonl'; bytes: string }>;
  providerLineage?: { publicCatalog: unknown; checkpointId?: string; providerExport?: string };
};
```

The source first proves no active owned run or terminal, records the fence with the final Git and governance generation, then emits one canonical, content-addressed payload. Private transform references stay source-side unless a runtime-specific export contract explicitly makes them portable. Workspace bytes are data only: the receiver rejects absolute or parent-traversing archive paths and does not run transferred hooks, setup commands, or executables during validation.

### `resume`

```ts
type ResumePayload = {
  transferMutationId: string;
  receivedDigest: string;
  previousGeneration: number;
  newGeneration: number;
  targetMaterialization: { repositoryUuid: string; branch: string; head: string; tree: string };
  runtime: { newSessionKey: string; resumedProviderThread: boolean; coldStart: boolean };
  lane: { status: string; lastImportedEventId: string | null };
  verification: { workspace: 'verified'; governance: 'verified'; trust: 'verified' };
};
```

The receiver writes imported durable state transactionally, creates and verifies a new local worktree, starts a fresh runtime process or a transcript-backed continuation, advances lane ownership, and returns the resulting receipt. If the durable provider thread cannot be resumed safely, the required fallback is a new thread seeded from the bounded handoff and transcript, with the discontinuity recorded in the lane events.

### Idempotency and failure recovery

- `transferId` is unique for one source lane generation. Each phase has one stable `mutationId`. An exact replay returns the stored receipt; reuse with different canonical payload bytes is a conflict.
- The continuity ledger stores phase, payload digest, source and target machine, expected generation, expiry, fence state, and receipt before acknowledging a mutation. This follows the existing durable-intent pattern that records provider intent before a side effect and recovers it by operation identifier. (`src/lib/runtime/session-transforms.ts:254-367`, `src/lib/runtime/session-transforms.ts:527-563`)
- `transfer` compares source generation, final `HEAD`, tree, workspace fingerprint, transform catalog version, and accepted offer. Any drift requires a new offer.
- Event import is deduplicated by event identifier; mission and lane writes compare their expected versions; workspace creation reuses its mutation and fingerprint semantics. (`src/lib/worktree/snapshot-state.ts:444-527`, `src/lib/orchestrator/control-plane.ts:300-324`)
- A crash before the source fence permits expiry and retry. A crash after the fence leaves the source fenced until the target returns the stored `resume` receipt or a transfer-scoped abort proves that no target resume was committed. Timeout alone must not create two writers.
- Provider operations with an unknown outcome use their existing operation recovery path. The receiver must not blindly repeat a fork or rewind. (`src/lib/codex/session-transforms.ts:276-345`, `src/lib/runtime/session-transforms.ts:254-367`)

### Trust boundaries

The credential that authorizes transfer is a new, short-lived `transferGrant`, not the relay ticket and never the loopback `ws-token`. The account service mints the grant only after an account credential proves ownership of both registered machines. It binds source machine, target machine, mission, packet, lane, source generation, accepted parts, payload size ceiling, audience, and expiry. Existing registry calls already authenticate with an account bearer and verify target-machine membership before issuing a short-lived relay ticket; the transfer grant adds the narrower execution-state authority that the current ticket lacks. (`src/lib/connect/machine-registry.ts:106-160`, `src/lib/connect/machine-registry.ts:184-260`, `src/lib/connect/machine-registry.ts:276-323`)

The relay ticket authorizes transport to one registered machine. The transfer grant authorizes one state transition. The receiving machine verifies the grant signature, audience, expiry, account and machine membership, identifiers, generation, accepted-part ceiling, and payload digest before parsing the payload. It then independently verifies its local repository UUID, availability of the required Git objects, branch/`HEAD`/tree and diff fingerprint, absence of a conflicting active writer, local runtime capability, local provider identity, storage admission, and approval validity. It uses its own loopback token and signing/key material for all local writes. The relay's existing token-blocking behavior remains mandatory. (`src/lib/connect/machine-attach.ts:334-380`, `src/lib/connect/machine-attach.ts:405-483`, `src/app/api/panel/mobile-pairing/route.ts:53-91`)

## 5. Ordered phase-2 and phase-3 carve list

1. **Phase 2: continuity schemas and fixtures.** Add versioned envelopes, canonical encoding and digest rules, explicit portable/redacted field lists, payload ceilings, and compatibility tests for every message.
2. **Phase 2: continuity ledger and source fence.** Add the transfer state machine, generation compare-and-set, phase receipts, expiration, safe abort, duplicate replay, and crash recovery. Prove that one lane generation cannot have two active writers.
3. **Phase 2: transfer-scoped authorization.** Add account-service grant issuance and verification bound to both registered machines and the exact packet/lane generation. Keep relay tickets transport-only and add negative tests for cross-account, expired, replayed, broadened, and digest-mismatched grants.
4. **Phase 2: portable snapshot builder.** Compose mission snapshot, lane/events, workspace manifest and bounded file payload, transcripts, and public provider lineage. Redact local paths, process identity, private provider references, configuration homes, tokens, credentials, and signing material before hashing.
5. **Phase 2: receiving validator and materializer.** Resolve repository UUID to a local clone, validate safe archive paths and Git objects, create a new admitted worktree, reproduce the final tree and diff fingerprint, and write imported state transactionally without executing transferred content.
6. **Phase 2: cold runtime continuation.** Create a new owned-session record and process on the target, use a runtime-specific durable-thread export/import only when supported, otherwise seed a new thread from the handoff/transcript, and invalidate review whenever verified Git truth differs.
7. **Phase 2: end-to-end fault suite.** Cover duplicate messages, disconnect at every phase, stale offers, changed `HEAD`, source crash after fence, target crash before receipt, missing Git objects, unavailable provider identity, conflicting writer, and abort-versus-resume races through the real stores.
8. **Phase 3: operator transfer surface.** Expose offer details, exclusions, target capability failures, progress, source-fenced state, receipts, retry, reject, and safe abort. Make the cold-start boundary and any approval invalidation explicit.
9. **Phase 3: observability and retention.** Add redacted audit events, transfer timing and failure reason metrics, bounded payload/transcript retention, garbage collection for expired reservations and payloads, and a support export that excludes trust material.
