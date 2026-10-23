# Native ACL startup: release measurement

Issue [#4380](https://github.com/o8-run/o8/issues/4380), measured 2026-10-23.
The [numeric receipt](native-acl-startup.json) contains three samples per arm,
artifact hashes and the unchanged capability hash. No installed app was
controlled. Both artifacts were unsigned, uninstalled release builds.

## Results

| Release sample | Context before / after, ms | Loader FCP before / after, ms | Matcher before / after, MiB |
| --- | ---: | ---: | ---: |
| 1 | 3,201 / 9 | 4,362 / 663 | 479.808 / 0.531 |
| 2 | 3,946 / 11 | 4,910 / 683 | 479.808 / 0.531 |
| 3 | 3,439 / 12 | 4,278 / 765 | 479.808 / 0.531 |
| Median | 3,439 / 11 | 4,362 / 683 | 479.808 / 0.531 |
| Worst | 3,946 / 12 | 4,910 / 765 | 479.808 / 0.531 |

Live URL matcher allocations were exactly 503,115,264 bytes before and 556,544
bytes after in each of the three diagnostic runs. These sum stack-attributed
URL-pattern regex and other URL-pattern-owned allocations, not process RSS,
allocator reservation or dominator-retained size. Other shell regexes are
excluded. Diagnostic launch latency is excluded from the latency population.

## Method and limits

The before artifact uses source base `251e92c57`, whose native code, dependency
lockfile and capabilities match the measurement branch of
[the baseline PR](https://github.com/o8-run/o8/pull/4374). The after artifact adds
the pinned context-codegen patch described in
[VENDORED.md](../../src-tauri/vendor/tauri-codegen-2.6.3/VENDORED.md). No capability
or command permission was removed, merged or broadened for this comparison.

Both artifacts used normal Cargo release optimization, custom protocol and
`dev-mcp-plugin`. The generated frontend loader came directly from the existing
export template. The baseline's
[paint observer](https://github.com/o8-run/o8/blob/8f24a794bd1a7edf17df7c5ec24f18d6cd3f633e/scripts/speed/native-paint.mjs)
and
[allocation attribution](https://github.com/o8-run/o8/blob/8f24a794bd1a7edf17df7c5ec24f18d6cd3f633e/scripts/speed/allocation-summary.mjs)
were reused in an isolated local runner. Application sidecars were excluded;
a no-op server resource selected the isolated native boot branch and its
provisioned ports. This measures launch to the original loader's first paint,
not dashboard navigation or accepted input. FCP is WebKit Paint Timing,
not OS compositor presentation. Optional speech helpers were excluded from
these disposable builds to avoid their build-time signing step.

The build command was:

```sh
cargo build --release --locked --manifest-path src-tauri/Cargo.toml \
  --features tauri/custom-protocol,dev-mcp-plugin
```

A temporary `TAURI_CONFIG` supplied a separate application identifier and empty
`bundle.externalBin`; no saved config was edited. Each launch used the native
test contract: `O8_PRESHIP_GATE=1`, `O8_FORCE_BUNDLED_SERVERS=1`, identical
`O8_DATA_DIR`/`CORTEX_IDE_DATA_DIR` in a fresh disposable profile, a disposable
repository, private `O8_TAURI_MCP_SOCKET`, and non-production API/WS ports.
`O8_BOOT_TRACE=1` supplied timestamps immediately before and after
`generate_context!()`. A loopback listener recorded the loader's FCP epoch
relative to process launch. Each owned process group closed before the next
launch. No competing build or test from this task ran during measurement.
Other host activity was not controlled; these are local observations.

Memory used three additional launches per arm with `MallocStackLogging=lite`
and an owned logging directory. After loader FCP, `malloc_history -allBySize`
provided live allocation stacks. Raw logs and allocation dumps remain private.
`codesign -dv` reported `code object is not signed at all` for both artifacts.
No signing, notarization, installation, release or saved app configuration
change was performed.

## ACL verification

The unpatched runtime authority resolved the actual generated manifests and
capabilities before the patch and recorded the fixed decision table in
[`acl-decisions.json`](../../src-tauri/tests/fixtures/acl-decisions.json).
The test [`acl_context_parity.rs`](../../src-tauri/tests/acl_context_parity.rs)
then checks the real `generate_context!()` output through `resolve_access`:
133,588 command/window/webview/origin decisions, 25,396 allowed. The full-table
SHA-256 is in the numeric receipt. The coverage guard checks the current
manifest's commands and capability windows against the frozen table.

The codegen regression failed first with four parse expressions for two
patterns and passes after sharing bindings. The parser, authority matcher,
per-command labels, scopes and debug references remain upstream code.
