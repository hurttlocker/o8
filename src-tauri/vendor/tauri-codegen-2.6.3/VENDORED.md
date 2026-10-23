# Native ACL context pattern sharing

Issue: [#4380](https://github.com/o8-run/o8/issues/4380).

## Upstream and pin

This is the published `tauri-codegen` 2.6.3 crate, selected by the exact
`=2.6.3` path patch in `src-tauri/Cargo.toml` and the application lockfile.
The original crate archive SHA-256 is
`08279169ff42f8fc45a1dbc9dcae888893ba95288142e5880c59b93a26d2cfc5`.
Its package VCS receipt identifies upstream commit
`6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a`, path `crates/tauri-codegen`.

Upstream references:

- [Context emission at the pinned commit](https://github.com/tauri-apps/tauri/blob/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/crates/tauri-codegen/src/context.rs).
- [Resolved ACL serialization](https://docs.rs/tauri-utils/2.9.3/src/tauri_utils/acl/resolved.rs.html).
- [Remote pattern parsing and shared matcher ownership](https://docs.rs/tauri-utils/2.9.3/src/tauri_utils/acl/mod.rs.html).

The upstream MIT and Apache-2.0 licenses and source notices are retained.
Registry bookkeeping and the upstream package lockfile are omitted. The original
normalized manifest and `Cargo.toml.orig` are retained.

## Patch

[`../native-acl-patterns.patch`](../native-acl-patterns.patch) is the complete
source delta against that crate. Context generation calls `shared_acl::tokens`
instead of directly quoting `Resolved`. Each exact remote URL pattern gets one
local binding in the generated expression; command entries clone its existing
Arc-backed `RemoteUrlPattern`. Allowed and denied commands share those bindings.

The upstream parser, normalization, authority matcher, command order, labels,
scopes and debug metadata are unchanged. Other command fields still use the
upstream serializer. Bindings live only inside one generated context; there is
no global cache or process-lifetime retention. Runtime-added capabilities still
use upstream resolution. This patch targets startup context emission, not
dynamic capability registration or compile-time ACL resolution.

## Verification

From the repository root, use the application lockfile for standalone crate tests:

```sh
cp src-tauri/Cargo.lock src-tauri/vendor/tauri-codegen-2.6.3/Cargo.lock
cargo test --release --offline \
  --manifest-path src-tauri/vendor/tauri-codegen-2.6.3/Cargo.toml \
  --target-dir src-tauri/target --lib
```

The regression test is
`compiles_each_distinct_remote_pattern_once_across_allow_and_deny`.
Before the fix it fails with `left: 4`, `right: 2`; afterwards it passes.
The application test `generated_context_preserves_all_fixed_acl_decisions`
checks the real generated context through `RuntimeAuthority::resolve_access`.
Its fixed table covers 367 commands (including an unknown command), 26
window/webview pairs and 14 origins, including local, loopback, wrong scheme,
wrong host, subdomain and IPv6 cases. Its saved baseline has 133,588 decisions,
25,396 allows, SHA-256
`b1b2e68da8b0853ec06dfd0d0a5c72835e40cbe92012d69f06f403d754122044`.
That baseline was recorded using unpatched runtime authority resolution of the
actual generated manifests and capabilities before this patch. A separate test
checks command, capability and window coverage against the current manifests.
Run the application tests on macOS with custom protocol and the observation
plugin enabled, using the same disposable build inputs as the measurement:

```sh
cargo test --release --config 'profile.release.package.o8.opt-level=0' \
  --locked --manifest-path src-tauri/Cargo.toml \
  --features tauri/custom-protocol,dev-mcp-plugin --lib --test acl_context_parity
```

See [release measurement](../../../docs/internals/native-acl-startup.md) for
before/after numbers and the unsigned artifact method. Correctness tests disable
application-crate optimization while keeping release dependencies; the measured
native artifacts use normal release optimization. The npm suite was excluded
from this issue's scoped verification; no TypeScript changed.

## Removal and upgrades

Remove the path patch, this vendor directory and its patch file when an upstream
release emits shared pattern bindings. Repeat the code-generation regression,
the fixed decision table and three release launches before accepting removal.
Dependency upgrades must verify that the application lockfile still selects the
patched codegen version; the parser and runtime authority must remain paired
with the measured lockfile until explicitly revalidated.
