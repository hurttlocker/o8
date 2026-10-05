# Managed Pi SDK prototype

This is an opt-in server-side prototype under issue #3230. It is not registered
in the runtime catalog, exposed as a public route, selected by default, or part
of native first-run acceptance. Existing external Pi RPC behavior is unchanged.

## Entry point and ownership

`createPiSdkSession` in `src/lib/pi/sdk/session.ts` starts the full pinned Pi SDK
in an on-demand child through the existing `StdioJsonRpcPeer`. The caller must
already have authority over the canonical workspace, a separate private state
directory, the selected managed model, and any injected host adapters. This API
must not be wired directly to untrusted request parameters.

The worker receives only model metadata, two tool definitions, and owned session
paths. It does not inherit provider credentials, `NODE_OPTIONS`, proxy settings,
user extensions, project instructions, or user Pi settings. Stock tools and
resource discovery are disabled. Read and write requests return to the host.

The host reuses descriptor-based workspace file IO and the existing approval
inbox. Writes show the exact proposed content and the existing content when
present. Existing files stay open across approval; path, identity and content
changes cause rejection. The narrow prototype refuses symlinks, hard-linked
files, `.git`, and `.env` paths. Reads and writes are bounded to 50 KB. These
application controls are not an OS sandbox and do not contain a compromised
worker process or arbitrary third-party code. No third-party code is enabled.

A restored session uses `prompt`, not queue-only `follow_up`. It must belong to
the same workspace and owned state directory. Session IDs remain stable across
restart. Host results require `agent_settled`; an accepted command or an
`agent_end` event alone is not completion. Failed and aborted outcomes retain
their stop reason and cannot reuse text from a previous turn. Stop cancels host
model/tool work before asking the worker to abort; close uses the shared
cooperative-to-forced child shutdown ladder.

## Managed inference boundary

`createManagedPiTransport` resolves `resolveOpenRouterRoute({ managedOnly: true })`
for every model request. No entitlement means no request, and there is no local,
BYOK or subscription fallback. Credentials remain in the host. Pi's full OpenAI
stream parser handles text and fragmented tool calls, but a host-owned fetch
adapter fixes destination, credential headers, HTTP method and redirect policy.
The desktop UI proxy stream is not used as a model endpoint.

The worker cannot choose the transport, route, model or budget. Defaults are eight
model calls, sixteen tool calls, a 120-second run deadline, a 60-second inference
deadline and a 4096-token output limit. These are prototype anti-runaway bounds,
not a substitute for server-side entitlement, model allowlists or spend limits.
Automatic provider retries, compaction and cache warming are disabled in this
slice. Non-2xx and successful-HTTP SSE errors are sanitized before the worker or
persisted transcript receives them.

## Reproduce offline

Use Node 22.19 or newer for the SDK. The repository currently declares Node 22.x
for its full application gates. The prototype never installs or changes Node.
Approved writes need the native helper in `src-tauri/sidecars/pi-write`; the
tests build it with cargo, so a Rust toolchain is required. After the normal
repository dependency setup, run:

```sh
npx vitest run tests/pi-sdk-worker-real-path.test.ts --maxWorkers=1
npm run test:integration -- tests/pi-sdk-worker-real-path.test.ts
npx tsc --noEmit
npm test
```

The worker fixtures use real child processes and the installed full SDK, with
synthetic model responses or a mocked fetch transport. They do not contact a
provider, consume credits, obtain credentials or claim model quality. Fixtures
cover persistence/resume, Unicode text, approval denial and target drift,
protected aliases, disabled ambient extensions, Stop, budgets, HTTP errors,
SSE-error redaction and fragmented managed tool streaming.

## Platform and concurrency limits

macOS and Linux only: `createPiSdkSession` and the approved-write helper refuse
Windows, which has no tested directory-descriptor write path.

Approved writes go through a native helper (#3289) that works relative to the
verified parent directory descriptor, so it follows the directory if it moves.
A new file is published with a no-replace rename. A replacement is one atomic
exchange, so the name is never absent. Before its commit point the helper
verifies the published inode, its link count, its bytes and the parent location,
and applies the target's mode. An uncommitted stage is wiped through a
descriptor, so a hard-link alias keeps no approved bytes. The helper removes or
moves an entry only after capturing it under a random name and proving it is its
own; anything else goes back without overwriting. If a signal ends the helper,
the host runs a recovery pass with the stage identity, captured names and commit
point it reported. `tests/pi-sdk-approved-write-races-real-path.test.ts` drives
the real helper at named points with concurrent renames, links, edits, mode
changes and kills.

Known limit: a process that renames the hidden stage away keeps a name for that
inode. If the helper is then killed, recovery has no name through which to wipe
it. A process with that access can already write the workspace directly.

## Remaining gates

Before a user-facing integration, bind this API to the existing authenticated
principal, canonical runtime/session registry and durable run receipts. Prove
crash/restart recovery and idempotent command replay through that entry point.
Then verify real managed model allowlists, quota accounting, token revocation,
production approval UX, and signed clean-Mac installation/update behavior.
Package the worker with the app's supported runtime rather than assuming the
source-tree worker path exists in a distribution. An existing compatible Node
installation is a prototype prerequisite; no-Node onboarding is separate work.

None of the offline evidence establishes OS containment, live billing behavior,
a working installed agent, or readiness to change the default.
