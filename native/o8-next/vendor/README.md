# Taffy dependency backport

`taffy/` contains the published MIT-licensed Taffy 0.9.0 crate from
[crates.io](https://crates.io/crates/taffy/0.9.0). Archive SHA-256:
`a13e5d13f79d558b5d353a98072ca8ca0e99da429467804de959aa8c83c9a004`.
The archive records upstream revision `599b1b7d7410d97e13bafc4c01fbe6d7a9cf060a`.

Published GPUI 0.2.2 requires Taffy exactly 0.9.0, whose Grid 0.18 dependency is
affected by [GHSA-38c5-483c-4qqp](https://github.com/advisories/GHSA-38c5-483c-4qqp).
The only manifest change is `grid = 0.18.0` to `grid = =1.0.1`, in both the
normalized and original manifests. This backports the dependency transition from
[upstream #864](https://github.com/DioxusLabs/taffy/pull/864), with an exact pin to
the patched release. All published Rust source remains byte-for-byte unchanged.
The outer workspace lockfile resolves genuine registry Grid 1.0.1.

Packaging differences: omit Cargo's local cache marker and the unused library
lockfile; include the upstream `LICENSE.md` from the recorded revision because
the published archive omits it. No original attribution has been removed.

Remove this patch when a compatible published GPUI release permits a patched
Grid dependency. Do not relabel a newer Taffy version or suppress the advisory.
