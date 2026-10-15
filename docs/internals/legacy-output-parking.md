# Retained legacy output

The generated-output operator CLI can explicitly park an unregistered `.next` in
an externally managed linked Git checkout and restore the same directory later.
Parking retains storage. It reports zero reclaimed bytes and creates no successful
build, disposal, bank, or containing-workspace ownership receipt.

Run from outside the selected checkout. Use one private lifecycle profile for
parking and the subsequent build; its store marker prevents a different profile
from silently taking authority. The native helper must contain the
`move-directory-no-replace` command. Source tests build the existing helper crate;
packaged use resolves the helper already supplied by the desktop environment.
Missing capability refuses the operation without an ordinary rename fallback.

```sh
# Supply absolute paths for the existing source, checkout, helper, private profile,
# and two distinct retained source/stop evidence files.
export O8_DATA_DIR="$profile"
export CORTEX_IDE_DATA_DIR="$profile"
export O8_PI_WRITE_BIN="$helper"
node "$source/scripts/generated-output.mjs" park-legacy \
  --workspace "$checkout" --intent 'Preserve legacy output before a fresh build' \
  --evidence "$source_evidence" --evidence "$stop_evidence"
node "$source/scripts/generated-output.mjs" legacy-status --workspace "$checkout"
node "$source/scripts/generated-output.mjs" resume-legacy --operation "$operation"
node "$source/scripts/generated-output.mjs" restore-legacy --operation "$operation"
```

A record in `workspace_legacy_output_parks` binds the operation UUID, original
`.next` path, exact sibling `.o8-retained-legacy-<UUID>` destination, workspace and
output identities, reciprocal linked Git custody, intent, evidence hashes, and a
bounded content manifest. The manifest records file bytes and identities without
copying them. Legacy-only inventory also records the inode, mode and raw text of
bounded generated dependency links under `dev/node_modules`. Only the generated
package-name plus 16-hex suffix shape and exact relative target into the checkout's
`node_modules` are accepted, including scoped packages. The lexical target must
remain identical after sibling relocation. Targets are never followed, opened,
scanned or copied; this preserves link nodes without granting dependency custody.
Absolute, external, ambiguous or changed targets, replaced link nodes, redirected
ancestors, special nodes, unsafe evidence, and oversized inventories refuse.
File-bank capture, restoration and disposal continue to reject all symbolic links.
Existing file/directory-only legacy journals retain their original field shape
and are verified with the same identity and content requirements. The original `dev/lock` is retained byte for byte.

Admission requires a fresh clear workspace process snapshot. Any present producer
lock must have supported JSON with a PID freshly observed absent; unknown formats,
live or ambiguous process observations refuse. The lock alone is never stop proof.
Custody, holds, claims, evidence and content are checked before and after movement.
These observations and the lifecycle exclusion cover the supported entry points;
they are not a filesystem-wide lock against arbitrary external actors.

The journal is committed before mutation. `prepared` and `restoring` block fresh
output admission. Native movement pins the parent descriptor, checks source identity,
and uses atomic no-replace rename on macOS/Linux. An occupied destination is never
overwritten. A failed or interrupted helper leaves pending intent, even if the
rename occurred. `resume-legacy` reconciles only the expected original or retained
inode with matching contents; both occupied, both absent, or replaced identities
remain refusals. It does not guess success from a missing path.

`parked` allows a separate fresh build generation. Retained legacy identities and
locations remain non-disposable, and a containing-workspace retirement claim is
blocked by their history. Existing holds are neither released nor bypassed. Restore
requires a vacant original namespace and refuses registered output generations,
even if their files are absent. After a fresh generation has been registered,
legacy output stays retained for a later explicit recovery decision.

`restored` keeps the historical receipt and intrinsic retention. There is no purge,
forget, or automatic cleanup command in this operation. Restoration does not create
a successful build or authorize subsequent deletion. If an operation refuses,
retain the journal and both namespaces for review; do not clear the store marker,
move a competing entry, or use an ordinary filesystem move to bypass the refusal.

## Terminal failed prebuild continuation

A registered terminal failed prebuild is not legacy output. Use its original
lifecycle profile and run maintenance outside the linked checkout:

```sh
node scripts/generated-output.mjs park-failed-prebuild \
  --resource <failed-resource-uuid> \
  --intent 'Retain failed build evidence before a new generation' \
  --evidence /absolute/external/producer-receipt.json \
  --evidence /absolute/external/build-log.txt
node scripts/generated-output.mjs failed-prebuild-status --operation <operation-uuid>
node scripts/generated-output.mjs resume-failed-prebuild --operation <operation-uuid>
```

The command requires linked Git custody, the existing store binding, an unchanged
`failed-held` resource with complete observed child exits, absent producer PIDs,
clear filesystem-user observations, and no independent hold or exact claim. It
uses the existing inventory and native no-replace move to retain the original
inode at `.o8-retained-prebuild-<operation-uuid>`. Links keep the same narrow
relative dependency rules as legacy parking. No bank or disposal rule changes.

The journal begins as `prepared`. An interrupted move stays pending and blocks
new generation admission. Resume verifies both namespaces, original producer
history, external evidence, content and custody before completing the journal.
An occupied or replaced destination is never overwritten. There is no automatic
restore, deletion, expiry, or reclaimed-byte credit.

Only a completed `parked` record releases the old generation's namespace index.
Its original `failed-held` payload, revision, version, ownership and child exits
remain unchanged. The old row is immutable after this release. The normal
prebuild entry point verifies retained evidence before creating a separate
resource with `continuedFrom` pointing to the old resource and operation.
Preflight selects only the generation currently owning `.next`. Replaying a
completed preservation checks the retained directory without moving a newer
`.next`. The journal is bounded to sixteen retained failures per workspace;
reaching the bound requires an explicit future retention policy, not deletion.
