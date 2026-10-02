# Local action plugins

Customize > Plugins links local executable actions. This is a separate contract
from the instruction bundles in Customize > Skills. The host does not download
marketplace packages, run startup hooks, or add terminal panes. A reviewed
project plugin may opt in to bounded `worktree.created` event triggers.

## Manifest

A source folder contains `o8-actions.json` and each declared file. The manifest
uses `o8-actions-v1` and declares one or more named actions. The two examples
under `examples/action-plugins/` are ready to review in the app:

- `project-setup-check` reports Git, Node, npm, and the presence of project
  guidance and package metadata. It declares an optional `worktree.created`
  trigger for its `check` action; linking leaves the trigger off.
- `verification-receipt` records the selected repository's commit and change
  counts. The host saves its output in a durable run receipt; the script does
  not write a file in the repository.

Both examples request `workspace: "registered-project"`. The operator must
select a registered project in Customize before review. The reviewed revision
is bound to that project, and Run is enabled only while that same project is
selected. The server resolves the repository from its registry; a
browser-supplied path that is not registered cannot become the action's working
directory. A plugin that does not need project access declares
`workspace: "none"` and runs from its private installed snapshot. Review
ignores the selected project for that mode; link and invoke do not accept a
repository argument.

The manifest also declares `supportedPlatforms`, stable IDs, a version, exact
file SHA-256 values, action entrypoints, fixed arguments, and timeouts. Paths
inside the package are flat filenames. Unknown manifest fields, links,
traversal, duplicate entries, missing or changed bytes, and unsupported
platforms are rejected. Declared files must be UTF-8 text without NUL bytes so
the app can display the exact executable source before linking. Version 1 runs
on macOS and Linux; Windows needs process-tree cancellation support before
executable actions can run there.

An optional `triggers` array maps a unique trigger ID and the exact
`worktree.created` event to an existing action ID. Trigger manifests must use
`workspace: "registered-project"`. The review shows the trigger, bound project,
files, and manual working directory before linking. Trigger execution uses the
new managed worktree as its working directory; manual **Run** continues to use
the bound project root. The child receives one bounded JSON object on stdin:

```json
{"eventId":"<stable event ID>","event":"worktree.created","repositoryPath":"<registered project>","worktreeId":"<managed ID>","worktreePath":"<created worktree>","branch":"<branch>","createdAt":"<ISO time>"}
```

The event is published after the authoritative worktree creation path records
the ready worktree. A pending marker in that worktree's durable metadata lets
startup reconcile a journal write that failed after creation. The same event
ID is reused for delivery recovery, and the host claims at most one delivery
per plugin and trigger. Consent is checked against the worktree's creation
time, so a later opt-in cannot run an older event. A busy plugin waits for a
later retry; an interrupted claimed run remains visible in receipts and is
not silently rerun. Trigger execution
uses the same installed revision, timeout, output cap, process cancellation,
concurrency rule, and output redaction as a manual action. It is not a file or
network sandbox.

To edit an action, update its file digest and review
the folder again. Version 1 does not have an in-place update command: remove
the old installation, review the new revision, and link it explicitly.

## Operator flow

1. Open Customize > Plugins and enter an absolute local source folder.
2. Select **Review files**. Expand the declared files and inspect their source,
   SHA-256 values, revision, entrypoint, fixed arguments, platform list, exact
   working directory, and environment keys exposed to the child process.
3. Select **Link reviewed revision**. If any declared file changed after
   review, the link fails and a new review is required.
4. Select a registered project if the action requests one, then select **Run**.
   The result appears in Recent runs with status, exit code, and bounded output.
5. For a declared trigger, explicitly select **Turn on** after linking. It is
   off by default and scoped to the bound project. **Turn off** stops future
   deliveries. Recent runs includes the trigger and event IDs, including
   skipped, failed, and interrupted deliveries.
6. Use **Disable** to refuse future runs, or **Remove** and its confirmation
   step to remove the installed snapshot. Receipts remain available after
   removal.

Actions run as the current local user. The host limits runtime and output,
uses an exact installed file snapshot, refuses concurrent runs of the same
plugin, and records the authenticated operator's invocation. A separate process
watchdog terminates the action group if the app server disconnects. It is **not
an OS sandbox**. A script can access files and services available to that user.
Review source code before linking. Output redaction handles known credential
patterns but cannot recognize every possible secret, so actions should avoid
printing private values. The two example scripts print only tool versions,
presence checks, a commit ID, and aggregate change counts.

An invocation uses the panel-authenticated local API at
`/api/customize/actions`. `GET` lists installations and receipts. `POST`
accepts `review`, `link`, `invoke`, `trigger`, `enable`, `disable`, and `remove`
operations.
Mutation and invocation requests include the reviewed revision; stale revisions
fail instead of silently using different code. Each run has a durable receipt
with actor, action, revision, start/end state, exit status, and capped output.

The operator CLI exposes the same installed actions and receipts:

```text
o8 plugin list
o8 plugin action list --plugin project-setup-check
o8 plugin action invoke project-setup-check check --revision <sha256> --repo <registered-path>
o8 plugin log list --plugin project-setup-check
```

The revision is required so a script cannot silently run a changed installation.
The CLI sends the existing operator bearer and refuses worker or explicitly
present spectator credentials. Plugin-specific logs filter before the receipt
cap is applied. An action failure still prints its receipt and exits nonzero.
Receipts label `actorKind: authorization-class` and `actorIdentity: null`:
the local panel boundary authenticates an operator privilege class, not a
specific person or agent. No client-provided actor label is accepted as proof.
