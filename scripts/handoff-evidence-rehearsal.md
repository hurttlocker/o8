# Provider-free handoff evidence companion

Run from a checkout containing the workspace-freshness patch, with the repository's existing Node.js 22 dependencies available:

```sh
node scripts/handoff-evidence-rehearsal.mjs
```

An optional argument names a **new**, not-yet-existing output directory. Otherwise the command creates a temporary evidence directory and prints it. It never installs dependencies, starts the app, dispatches a worker, calls a provider, or publishes anything. It runs the existing `tests/handoff-packet-real-path.test.ts` through the resource-integration Vitest configuration. Any test failure makes the command fail. Temporary fixture repositories and app data are removed; evidence outputs are retained. Existing output directories are refused, so an old receipt cannot masquerade as a new run.

## What the output establishes

- `receipts.json`: machine-readable observations produced by the actual production inspector, original and refreshed handoff identities, workspace evidence tuples, mutation byte hashes, unchanged HEAD/status evidence, source commit and selected entrypoint hashes
- `report.txt`: concise explanation of passed checks and checks not run
- `vitest.json` and `verification.log`: integration results, with checkout and fixture-root paths redacted
- On failure: nonzero exit plus `run-failure.json` when the output directory remains writable; all pending files are provisional. The accepted `receipts.json` is atomically published only after report writing, path redaction and fixture cleanup succeed

The four scenarios use a disposable real Git repository with both staged and unstaged work:

1. Capture through the authenticated handoff route, persist through the existing chat-history seam, reload and inspect unchanged source: `fresh`
2. Modify an already-dirty tracked file, preserving its length, HEAD and porcelain status: `stale`
3. Remove evidence from an in-memory legacy copy: `unavailable`, with null fingerprints
4. Re-observe current source, persist a new handoff and inspect it: `fresh`; inspect the original again: still `stale`

The normal Git index, original persisted handoff and placeholder narrative intent must remain unchanged. Snapshot capture writes Git objects via an isolated index, so this is not a side-effect-free filesystem reader. Source mutations stay inside the temporary repository; fixture app data and evidence outputs are also written.

## Relationship to the existing demo

This is a small evidence companion to [the portable demo](https://github.com/kvnloo/o8/pull/32) and its [planned experiment](https://github.com/hurttlocker/o8/blob/748874a5886745f69beac66a21be86025e476bda/scripts/intent-continuity-demo/experiment.md). It does not replace its renderer, checker or store. The demo was inspected at `748874a5886745f69beac66a21be86025e476bda`; the admission draft at `16e2dd430e274eeb344a66eec2bbbe7adb3f40d9`; the state comparator draft at `97bd67372bc16e57fa61240b2e6da455da538a9e`. Those revisions are context, not dependencies invoked by this rehearsal.

The same semantic request is retained: “Make this respond faster. Keep the layout and existing behavior. Do not deploy.” It is explicitly placeholder narrative. There is no measured interaction, agreed numeric target, AODL validation, admitted R1, or authored-intent identity. The new handoff receives that narrative explicitly from the fixture; this does not prove automatic authored-ref propagation.

Actors A/B are labels for test code, not live runtimes or agents. `fresh`, `stale`, and `unavailable` are diagnostic observations, not permission or enforced transitions. The local `o8/handoff-evidence-rehearsal/v1` receipt is a test artifact, not a production StatePacket or proposed adapter contract. No production source is changed by this companion.

Still not run: actual worker handoff, receiver enforcement before ACT, compaction, performance/layout acceptance and final verification against admitted R1. Missing evidence remains unknown. Git-normalized trees omit ignored files and do not certify raw bytes normalized away by filters or dirty submodule contents. A fresh observation is not an atomic check-and-ACT guarantee. Production admission, adapter semantics and receiver ownership remain with their existing owners.
