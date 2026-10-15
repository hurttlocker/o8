# Owned session artifact admission

New owned runs share a 4 GiB and 10,000-entry admission threshold across each
resolved runtime's active root and archive sibling. Launch, resume, automatic
retry and missing-CLI diagnostics pass admission before creating a run directory,
prepared run or output writer. A refusal returns the existing unsuccessful store
response with an actionable artifact-admission note and no new run side effect.

Accounting includes ordinary, protected, legacy and unknown regular files. Each
file and directory counts at least 64 KiB, or its rounded logical size or allocated
bytes if greater. Sparse evidence therefore counts even when allocation is small.
Redirected paths, hard links, special files, foreign ownership, aliased identities,
depth beyond 64 and changing observations refuse admission. Traversal stops at
the byte or entry threshold. No file contents are loaded for accounting.

The existing cross-process lifecycle lease serializes admission and supported
archive/restore renames by canonical runtime root. A private, constant-size sibling
binding associates that root with the lease database; another profile's unrelated
lock cannot grant access to the same namespace. Concurrent owners refuse instead
of waiting while holding a session lock. The lease lasts through initial run
preparation and spawn, not the provider's lifetime. Uncoordinated metadata changes
or active output growth during inspection can conservatively hold a new run until
a stable observation is possible. The binding itself is outside artifact accounting.

This is admission control, not a hard cap on already running output. An admitted
run can grow afterward, and initial session/config metadata can cross the threshold
before the next admission. No provider is killed, no transcript is truncated, and
no expiry or automatic deletion is introduced. Required recovery, failure, release
and acceptance evidence is exempt from deletion, never from accounting.

Read and stop do not require admission. Supported archive and exact archived-session
recovery share synchronization but do not require free budget. Archive is a directory
rename, not reclaimed storage. External provider history is outside these roots and
still uses its provider-supported retention controls. The independent portable
[workspace preservation bank policy](workspace-preservation-budget.md) is unchanged.
