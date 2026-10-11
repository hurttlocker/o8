# Native Clerk dependency patches

These are complete copies of the crates already pinned by the application,
with diagnostic-only changes applied through `src-tauri/Cargo.toml`'s
`[patch.crates-io]` entries. Versions and dependency declarations are unchanged.

## Sources and verification

- `tauri-plugin-clerk` 0.1.1:
  <https://static.crates.io/crates/tauri-plugin-clerk/tauri-plugin-clerk-0.1.1.crate>
  SHA-256 `732241dc88d07526e0f9c47339fcd72c3c137cfa0f461d3ae1ea2bc0214871bb`
- `clerk-fapi-rs` 0.2.0:
  <https://static.crates.io/crates/clerk-fapi-rs/clerk-fapi-rs-0.2.0.crate>
  SHA-256 `8e239d6a45c0bc0725bd254dbdd6f89918ea27c634cc753c173caca2f5b60fd0`

Both archives were downloaded from the official crates.io storage endpoint and
their checksums matched the application's pre-patch Cargo.lock. Their manifests,
source, and provenance metadata are retained. `tauri-plugin-clerk` includes its
upstream MIT license file. `clerk-fapi-rs` declares `license = "MIT"` in its
manifest but includes no license text in the published archive. The upstream
repository tree at archive commit `286b3f709ecc2c99bb55ee6aaa13901a401177da`
also has no license file. Its existing license declaration is preserved; no
copyright notice is invented.

## Local changes

`native-auth-diagnostics.patch` is the complete diff against the downloaded
upstream sources. Auth state and SDK errors never become diagnostic arguments,
even with debug logging enabled. Diagnostics contain fixed event descriptions;
the redundant direct stdout error print is removed. Auth events, store writes,
request headers, return values, and error variants are unchanged.

`tests/auth-native-logging.test.ts` checks the native diagnostic source boundary
and verifies that Cargo selects these local versions. This source regression
guard is not a compiled native runtime test. A Rust toolchain is still required
for `cargo check --locked` and native integration verification.

When updating either dependency, verify the new archive, preserve its license,
review every diagnostic sink, and regenerate the upstream diff before updating
the application lockfile.
