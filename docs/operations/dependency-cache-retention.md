# Dependency download cache retention

Tracked in #1817. This policy covers regenerable package-manager downloads, not
installed dependencies, worktrees, conversation history, release build artifacts,
or the total operator profile.

## Policy and entry point

`runDependencyInstall` reserves its recipe cache before starting an installer.
After a successful runner has settled and its private runtime is retired, the
last reservation for that recipe records its allocated download-cache size.
Maintenance then removes the least recently used eligible recipes until the
managed cache is within both limits:

- Download payload allocation: 2 GiB.
- Completed recipe caches: 12.
- Unused completed recipes expire after 14 days, even below the size limit.

These are initial retention defaults, not measurements or a whole-profile size
promise. Active or uncertain caches can exceed the limits and produce a `held`
receipt. Allocated path sizes are not guaranteed physical bytes reclaimable on a
copy-on-write filesystem. No periodic timer, idle process probe, or pre-dispatch
recursive walk is added. Size measurement occurs after an install, and subsequent
maintenance reads its metadata rather than walking every recipe payload again.

## Safety and recovery

New installs use `package-manager-cache/managed-v1/<manager>/<recipe>/cache` under
the configured data directory. Previous app versions use a different namespace,
so their installers cannot race this policy without reservations. Existing
`package-manager-cache/<manager>/...` caches are preserved. They require a separate
quiescent migration or cleanup with verified ownership; this policy does not
silently adopt them or report their bytes as bounded.

Reservations and eviction share the existing cross-process lifecycle lock.
The managed root is bound to that lock database; another profile with independent
lock state cannot silently share it through a cache-path override.
Multiple installers can use one recipe concurrently; the short mutation lock
does not serialize their package-manager runs. A failed or interrupted runner
retains its reservation because parent-process death alone does not prove that
installer children stopped. Do not remove that reservation based on elapsed time.
Recovery requires establishing that the installer and its children are stopped.

Unknown metadata, changed directory identities, symlinks and incomplete retired
namespaces are held. The remover checks the recorded directory identity, detaches
the exact recipe namespace, and uses the existing captured-directory purge. A
successor install cannot attach to a partially deleted recipe. If retirement is
interrupted, the detached namespace remains visibly held for recovery; it is not
reported as freed. Installed dependency views are private copies and remain valid
when their download cache is evicted.

## Receipts

The install result includes `cacheRetention`. The latest maintenance result is
also persisted as `package-manager-cache/managed-v1/.o8-retention.json`:

- `scope: managed-v1-only` prevents interpreting the result as whole-profile usage.
- `status: within-budget | held` reports whether all managed entries were proved.
- `retainedBytes: null` means a held entry prevented a complete size account.
- `removed` lists successfully retired recipe identities, not estimated savings.
- `held` gives the reason for every unproved or interrupted candidate.
- `legacyPreserved` identifies old manager namespaces outside the policy.

Do not equate `within-budget` with #1817 closure. Its installed-app footprint,
loaded-worker measurements, real-profile history and deployment evidence remain
separate acceptance requirements.

## Verification

The resource-owning tests exercise `runDependencyInstall` and persisted files:

```sh
npx vitest run --config config/vitest/vitest.integration.config.ts \
  src/lib/workspace/dependency-cache-retention-real-path.test.ts \
  src/lib/workspace/dependency-install.test.ts
```

They cover byte/count/age bounds, concurrent cache users, interrupted runners,
preserved legacy caches and installed views, record corruption, directory
replacement, manager symlinks and conflicting profile authorities. TypeScript and the hermetic suite remain
required completion gates.
