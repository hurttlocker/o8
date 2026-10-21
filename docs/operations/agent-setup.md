# Agent-assisted setup

Use the operator MCP tool `o8_setup` or the `o8 setup` CLI. The app must be running; keep onboarding open for workspace entry. These commands use the normal operator credential and existing API discovery.

```sh
o8 setup status
o8 setup configure --lead codex --workers codex --worker-model gpt-5.6-terra
o8 setup open /absolute/project/path
o8 setup status
o8 setup cancel <request-id>
```

`configure` supports `--lead-model` and `--worker-model`. Use runtime and model choices returned by status. The first worker is the default; other workers retain their runtime defaults. Claude uses `claude-code`. Codex and Fable keep their lead presets; per-conversation overrides remain available. Claude and OpenCode save separate lead models.

`status` distinguishes installed tools, local credential evidence, provider acceptance, persisted choices and sources, privacy, and incomplete steps. Credential evidence does not establish that a provider accepts a model; setup does not run a paid probe. Environment/profile overrides require changing their owning source.

`open` registers an existing Git folder and returns a durable request. Registration and `pending` do not mean the workspace opened. Visible onboarding claims it, rechecks the project and tools, follows its normal workspace entry path, and reports `opened`, `needs_tools`, `needs_privacy`, or `error`. An absent app leaves it pending. Repeating open while pending reuses the request; a new open after completion creates a new request. MCP callers can pass the previous `requestId` with the same path to read a retry receipt without reopening.

Cancellation retains registered projects and saved choices. An in-flight app operation cannot be cancelled; read its result first. A cancelled handoff does not prevent a later explicit human action. If the app stops during `applying`, its claim expires after one minute and status becomes `interrupted`. Inspect the workspace before a fresh open or cancellation; the outcome is unknown until checked.

Sign-in, operating-system permissions, and privacy choices stay with the user. The setup tool does not grant permissions, edit credentials, answer consent, run the first task, or install runtimes.

## Recover from an already-open native folder picker

A native folder picker can hold onboarding's action lock while a setup request remains pending. Use the discoverable authenticated operator tools to cancel that exact picker, then use the existing setup service to open the desired Git project. This workflow requires no operator folder selection or pasted path. It does not complete the original picker with a selected URL.

1. Call `o8_view_inspect_directory_dialog` with `{}` and retain its opaque `dialog_id`.
2. Call `o8_view_resolve_directory_dialog` with `{"dialog_id":"<inspection identity>","operation":"cancel","path":null}` once.
3. Inspect until `no_dialog` establishes that the sheet is absent. Cancellation dispatch returns `pending`; it does not prove callback completion or workspace entry. A replaced sheet or an unknown transport outcome requires reconciliation, never mutation replay.
4. Read `o8_setup` with `{"action":"status"}`. If the desired path already has a pending request, observe that request instead of submitting it again. If another path is pending, reconcile its outcome or cancel that durable request by its request ID before opening a different project.
5. Use `o8_setup` with `{"action":"open","path":"/absolute/existing/git-project"}`, then read status until its durable request reaches a terminal result. Verify `opened` and the normal project/workspace path. `needs_tools`, `needs_privacy`, or `error` requires the existing setup workflow; never convert these results to success.

Only a visible, single-directory `NSOpenPanel` attached to this app's `main` window is supported on macOS. File pickers, other windows, unattached dialogs, consent prompts and other operating systems are refused. Inspect has no native side effects. Resolve requires the current identity. Cancellation is single-use and guarded against expired or disconnected requests immediately before dispatch. Nonpicker sheets are refused before picker-specific selectors are sent. No permissions or saved choices are changed.

Direct `operation: "select"` is retained as an explicit refusal: an absolute existing directory is validated on a bounded background worker, then a matching live dialog returns `selection_not_supported` without navigation or OK. Invalid paths, stale identities and wrong dialog types still return their specific errors. Setting AppKit [`directoryURL`](https://developer.apple.com/documentation/appkit/nssavepanel/directoryurl?language=objc) controls the displayed directory; it does not establish the selected URL. [Selected URLs are read-only](https://developer.apple.com/documentation/appkit/nsopenpanel/urls?language=objc). Native acceptance observed navigation remain pending with the prior selection unchanged, so this implementation uses cancellation plus ordinary setup registration rather than claiming picker selection.

The existing authenticated socket commands remain `inspect_directory_dialog` and `resolve_directory_dialog`. Send a string request `id` and normal socket authentication; the payloads are:

```json
{"command":"inspect_directory_dialog","payload":{"window_label":"main"}}
{"command":"resolve_directory_dialog","payload":{"dialog_id":"<inspection identity>","operation":"cancel"}}
```

The MCP resolve schema is a plain strict object with required `dialog_id`, `operation` (`select` or `cancel`) and `path` (string or null). Cancel requires null; the native wire omits the path. Unknown fields and operations are rejected. The client never automatically retries resolution after a disconnect. Native cancellation followed by authenticated setup, ordinary onboarding and persisted project/request reconciliation remains a compiled-app acceptance gate.
