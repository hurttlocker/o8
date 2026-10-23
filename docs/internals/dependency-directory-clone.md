# Reusing installed dependencies across source commits

On APFS, workspace preparation can make a private copy-on-write clone of an
existing installed npm tree. Equivalent package, lock, config and patch inputs
can match across different source commits. The donor's own committed tree stays
pinned throughout cloning; changing it during preparation refuses reuse.
Installed resolution, native bindings, directory identity and private writes
retain their existing checks. Recipe and cache identities still include the
packet's complete Git tree.

Root and dependency install scripts can mutate dependency payloads. An unchanged command string
alone does not establish equivalent output: its helper script may have changed.
Without an explicit declaration, enabled install lifecycle requires the same
source tree. A repository can declare its complete workspace read closure in
`package.json`:

```json
"o8DependencyClone": {
  "lifecycleInputs": ["scripts/postinstall.mjs"]
}
```

This is a repository-authored completeness assertion, not automatic dependency
analysis. Include every helper, config and data file read by root or dependency lifecycle
code, including presence-sensitive inputs. All entries must name tracked,
contained regular files. Existing package/config/patch inputs and locked
installed packages are covered separately. An empty list asserts that install
lifecycle reads no additional workspace files. Keep the declaration current
when scripts acquire new inputs. o8's current postinstall reads its own script,
locked dependency packages and the already tracked patch inputs.

Preparation persists a `worktree_preparation_timing` event with stage
`dependency_selection`, the selected `path` and a bounded `reason` before the
chosen operation starts. A refused directory clone records its reason with the
native-install or image selection. These events accompany the completion timing
for `dependency_materialization`.
