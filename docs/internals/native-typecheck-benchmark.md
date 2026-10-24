# Native TypeScript checker benchmark

Experiment for [#3348](https://github.com/o8-run/o8/issues/3348), measured on
2026-10-24 at commit `262603d826899c95540dcc5b33d51ba405eebee5`.

## Results and recommendation

**Defer adoption. Keep TypeScript 5.8.2 as the required checker.** Both native
candidates substantially reduce checker-only time, but neither preserves the
baseline's diagnostics or successful exit status. No option or file exclusion
was changed to make either candidate pass.

Cold and warm columns are median seconds from three runs each. Peak RSS is the
largest observed MiB across all six runs for that row.

| Tool | Version | Scope | Cold (s) | Warm (s) | Peak RSS (MiB) | Exact diagnostic parity |
| --- | --- | --- | ---: | ---: | ---: | --- |
| JavaScript tsc | 5.8.2 | Checker only | 175.07 | 24.86 | 5180.38 | Baseline; 0 diagnostics |
| Native TypeScript (Go) | 7.0.2 | Checker only | 28.85 | 10.44 | 5131.44 | No; 13 extra diagnostics |
| tsrs (auto workers) | 0.18.0-ts7.1.0-dev.20260929 | Checker only | 6.59 | 2.18 | 1650.18 | No; 13 extra diagnostics |
| tsrs (4 workers) | same tsrs release | Checker only | 8.74 | 1.92 | 1492.77 | No; 13 extra diagnostics |
| JavaScript tsc | 5.8.2 | Full gate | 215.09 | 67.92 | 5179.26 | Baseline; 0 diagnostics |
| Native TypeScript (Go) | 7.0.2 | Full-gate attempt* | 43.74 | 16.68 | 4807.77 | No; 13 extra diagnostics |
| tsrs (auto workers) | 0.18.0-ts7.1.0-dev.20260929 | Full-gate attempt* | 11.29 | 6.58 | 1646.44 | No; 13 extra diagnostics |

\* Every native full-gate attempt passed route verification and Next type
generation, then failed the root check and short-circuited before the CLI check,
just as the default script does on an application error. These are **failed gate
prefix timings**, not complete passing-gate timings. CLI checks were run
independently and also failed: three diagnostics for Go and two for tsrs. No
passing end-to-end speedup has been established.

The observed checker-only median ratios versus 5.8.2 are 6.1x cold / 2.4x warm
for stable native TypeScript and 26.6x / 11.4x for default tsrs. At four checker
workers each, tsrs is 3.3x faster cold than Go in these samples. Go's maximum RSS
is close to JavaScript tsc's; tsrs uses substantially less memory. These ratios
compare different compiler versions and shared-host runs, with no CPU isolation
or interleaving of tool order. They establish a promising local experiment, not
portable speedup guarantees.

A follow-up evaluation should explain the baseline diagnostic differences and
compare tsrs against its exact upstream compiler revision before attributing
Rust-only behavior to a defect. Do not suppress diagnostics, alter strictness,
remove files, or replace the existing gate to adopt these results. Long-lived
watch/LSP stability and other operating systems were not measured. Default
scripts, required CI, and the dependency manifests are unchanged by this PR.

## Scope and environment

The baseline is JavaScript TypeScript 5.8.2. The stable native candidate is
`typescript@7.0.2`, installed as the development dependency alias
`typescript-native`. The experimental Rust candidate is
`tsrs@0.18.0-ts7.1.0-dev.20260929`. npm's `latest` tags resolved to these versions
on the measurement date. The stable native command is now `tsc`; `tsgo` belongs
to the retired `@typescript/native-preview` package.

The host exposes 10 virtual CPUs, x86_64, Intel Core i7-9750H at 2.60 GHz,
23 GiB RAM, and no swap, running Ubuntu 26.04 LTS and Linux 7.0.0-38-generic.
Node is 22.23.3; npm is 11.8.0. This is a shared VM with other workloads active
during part of the experiment. Measurements run serially; they are observations
on this host, not isolated hardware performance guarantees.

`npm ci` installed 1,588 packages successfully. The original lockfile SHA-256 is
`5e7c8ccd4426eafa947e836b85bcc157a3e7659f44560a4d55d85637082f00a2`;
the root tsconfig SHA-256 is
`b70425257020c0c6e3adbf43b14c12b56332fb09940ac4da95aee9573661e648`.
Next type generation succeeded before checker-only measurements: four generated
files in `.next/types`, none in `.next/dev/types`, and 6,088 root input files.
Compiler options, include/exclude patterns, and dependencies used by application
code remain unchanged.

The complete default gate is `npm run typecheck`: route module shape verification,
removal and regeneration of Next types, the root project check, and a separate
`cli/tsconfig.chat.json` check. Candidate complete-gate commands preserve that
sequence and short-circuit behavior. The CLI project disables incremental mode.
The CI Type Check job also runs protocol verification and a release-channel
fixture; those steps are outside these timings.

## Method

Each checker-only command and each complete-gate command runs three cold/warm
pairs. A cold run deletes root compiler build info; the following unchanged warm
run keeps it. No unmeasured checker warmups run. Next generation setup is excluded
from checker-only times and included in complete-gate times. Complete-gate runs
always regenerate Next types, including warm runs, as the default script does.
Filesystem/page caches are neither dropped nor controlled. Cold therefore means
compiler-cache cold, not filesystem-cache cold.

All commands receive `NODE_OPTIONS=--max-old-space-size=8192`, `NO_COLOR=1`,
`FORCE_COLOR=0`, and `NEXT_TELEMETRY_DISABLED=1`. The heap limit applies to Node,
not native binary allocations. GNU `/usr/bin/time -v` saves wall time and maximum
resident set size separately from stdout and stderr. Its RSS is a maximum process
high-water mark, not the sum of concurrent processes' memory. MiB values divide
the reported KiB by 1,024. Tables report medians and all samples, not best runs.

Candidate packages are installed only for this worktree's experiment. The
baseline `typescript` dependency and its `node_modules/.bin/tsc` link are preserved.
Candidate installation changes to the manifests are restored before committing.
Only this document is intended for the PR.

Thread settings are tool defaults: JavaScript tsc checks on one JavaScript
thread, stable native TypeScript uses four checker workers, and tsrs uses its
automatic per-core policy (10 checker workers for this root project). No
`--singleThreaded`, `GOMAXPROCS`, or thread environment override is set. An
additional tsrs checker-only control uses `--checkers 4` for comparison with the
Go checker's default. These are checker counts, not total OS thread counts.
The CLI project can use fewer tsrs checkers under its small-program cap.

Release and implementation references:

- [Stable TypeScript npm metadata](https://registry.npmjs.org/typescript/7.0.2),
  npm source revision `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`.
- [Native checker pool at the release tag](https://github.com/microsoft/TypeScript/blob/v7.0.2/tsc/internal/compiler/checkerpool.go),
  which selects four checkers unless overridden.
- [tsrs npm metadata](https://registry.npmjs.org/tsrs/0.18.0-ts7.1.0-dev.20260929)
  and [pinned usage documentation](https://github.com/oxc-project/tsrs/blob/v0.18.0/docs/USAGE.md).
- [tsrs upstream compiler pin](https://github.com/oxc-project/tsrs/blob/v0.18.0/Cargo.toml):
  `b85298b6a81f772d080b0455de0ca9d744cd6fd6`, compiler version
  metadata `7.1.0-dev.20260929`. The binary reports
  `Version 7.1.0-dev.20260930.4 (tsrs 0.18.0-ts7.1.0-dev.20260929, microsoft/TypeScript@b85298b6a81f)`.
  This differs from both the 5.8.2 baseline and stable 7.0.2; a diagnostic
  difference alone does not establish a Rust implementation defect.

## Commands

Run from the repository root. Installation and timing are serial. The commands
below identify the setup and measured payloads, rather than extra warmup runs.
Execution order was baseline pairs and touched-file runs; candidate installation;
native pairs, CLI probe, and touched-file runs; Rust pairs, CLI probe, and
touched-file runs; the four-worker Rust control; isolated error fixtures; and
file-list probes. Save the original manifests before adding candidates;
restore those exact bytes after
measurement. This keeps the benchmark PR independent of dependency adoption.

```sh
npm ci
export NODE_OPTIONS=--max-old-space-size=8192
export NO_COLOR=1 FORCE_COLOR=0 NEXT_TELEMETRY_DISABLED=1
node scripts/typecheck.mjs --typegen-only

# Baseline checker-only and full-gate commands:
npx tsc --noEmit
npm run typecheck

# Install after the baseline runs, only in the experiment worktree:
npm install --save-dev --save-exact \
  typescript-native@npm:typescript@7.0.2 \
  tsrs@0.18.0-ts7.1.0-dev.20260929
# Both TypeScript packages export tsc. Preserve the baseline npx entry point:
ln -sfn ../typescript/bin/tsc node_modules/.bin/tsc

# Native checker-only commands, retaining npm invocation overhead:
npx --no-install --call 'node node_modules/typescript-native/bin/tsc --noEmit'
npx --no-install tsrs --noEmit

# Native full gate (replace the executable with tsrs for the Rust run):
bash -c 'npm run verify:routes &&
  node scripts/typecheck.mjs --typegen-only &&
  node node_modules/typescript-native/bin/tsc --noEmit &&
  node node_modules/typescript-native/bin/tsc --noEmit --project cli/tsconfig.chat.json'

# Also check CLI diagnostics independently, so an earlier failure cannot hide them:
node node_modules/typescript-native/bin/tsc --noEmit --project cli/tsconfig.chat.json
node node_modules/tsrs/bin/tsrs --noEmit --project cli/tsconfig.chat.json
```

The six cold/warm measurements per command use the following loop, with a
different `label` for each command. Timing output remains separate from compiler
output; nonzero compiler exits are recorded rather than aborting the experiment.

```sh
run_pairs() {
  label=$1
  shift
  for sample in 1 2 3; do
    rm -f tsconfig.tsbuildinfo cli/tsconfig.chat.tsbuildinfo
    /usr/bin/time -v -o "$label-cold-$sample.time" \
      "$@" >"$label-cold-$sample.stdout" 2>"$label-cold-$sample.stderr"
    /usr/bin/time -v -o "$label-warm-$sample.time" \
      "$@" >"$label-warm-$sample.stdout" 2>"$label-warm-$sample.stderr"
  done
}
run_pairs tsc-checker npx tsc --noEmit
run_pairs tsc-full npm run typecheck
run_pairs native-checker npx --no-install --call \
  'node node_modules/typescript-native/bin/tsc --noEmit'
run_pairs native-full bash -c 'npm run verify:routes && node scripts/typecheck.mjs --typegen-only && node node_modules/typescript-native/bin/tsc --noEmit && node node_modules/typescript-native/bin/tsc --noEmit --project cli/tsconfig.chat.json'
run_pairs tsrs-checker npx --no-install tsrs --noEmit
run_pairs tsrs-full bash -c 'npm run verify:routes && node scripts/typecheck.mjs --typegen-only && node node_modules/tsrs/bin/tsrs --noEmit && node node_modules/tsrs/bin/tsrs --noEmit --project cli/tsconfig.chat.json'
run_pairs tsrs4-checker npx --no-install tsrs --noEmit --checkers 4
```

## One-file edit and negative probes

The touched-file scenario uses the same root project and incremental cache as
the preceding complete-gate runs. It changes just the exported return annotation
of `formatModelLabel` in `src/lib/format.ts` from `string` to `unknown`, then runs
the same checker-only command. This exercises dependent files, including
transitive dependents. Passing a lone filename would bypass the project config
and would not prove dependent checking, so that is not the measured pattern.

For sample `N`, the exact byte transformation is:

```python
original.replace(
    b'formatModelLabel(model: string): string {',
    b'formatModelLabel(model: string): unknown {'
) + f'\n// Native typecheck experiment sample {N}.\n'.encode()
```

After each measured edit, restore the original bytes and run the same project
command again to repopulate the cache. Repeat three times per tool. Restore
commands are also timed and saved, but are not included in edit medians. The
source file is restored in a `finally` block. No reduced file list, changed
compiler option, or suppressed diagnostic is used.

Additional isolated CLI probes run outside the repository's input tree:

| Probe | Config and files | Command arguments |
| --- | --- | --- |
| Ordinary, cross-file, missing export | `strict: true`, `noEmit: true`, `types: []`; `files: [ordinary.ts, export.ts, import.ts]` | `--project <fixture>/tsconfig.json --pretty false` |
| Project references | Root `files: []`, references `lib` and `app`; each child `composite: true`, `strict: true`, `types: []`; app references lib | `--build <fixture>/<tool>/tsconfig.json --pretty false` |

The ordinary fixture source is:

```ts
// ordinary.ts
export const count: number = "wrong";
// export.ts
export const value: string = "value";
// import.ts
import { value } from "./export";
export const count: number = value;
import { missing } from "./export";
```

The reference fixture's `lib/index.ts` exports
`const value: string = "value"`; `app/index.ts` imports `value` from `../lib`
and exports `const count: number = value`. Each child config has
`files: [index.ts]`. Every tool gets its own fresh fixture directory, preserving
real project-reference resolution and declaration/build-info writes without
sharing compiler caches. Fixture paths are normalized to `FIXTURE/` when
diffing; repository diagnostic paths are not normalized beyond removing an
absolute checkout prefix if present.

## Raw samples

Samples are listed in execution order within each triplet. Their min/max values
provide the observed spread. RSS triplets use MiB; exits apply to every sample
in that row, both cold and warm. Each full-gate sample includes four passing
route-shape checks and successful type generation, even when the checker fails.

| Tool / scope | Cold seconds (1, 2, 3) | Warm seconds (1, 2, 3) | Cold RSS MiB (1, 2, 3) | Warm RSS MiB (1, 2, 3) | Exit |
| --- | --- | --- | --- | --- | ---: |
| tsc / checker | 245.95, 165.48, 175.07 | 27.95, 20.61, 24.86 | 5172.55, 5177.89, 5180.38 | 2653.73, 2651.93, 2651.62 | 0 |
| tsc / full | 197.67, 291.13, 215.09 | 67.92, 69.12, 41.44 | 5179.26, 4837.46, 4926.41 | 2651.20, 2652.29, 2650.56 | 0 |
| native / checker | 22.82, 28.85, 37.68 | 7.85, 10.44, 11.29 | 5131.44, 4908.09, 4748.64 | 2055.09, 2056.26, 2023.73 | 1 |
| native / full | 41.38, 43.74, 45.82 | 16.39, 16.68, 19.23 | 4807.77, 4750.20, 4772.56 | 2013.30, 2028.45, 2025.36 | 1 |
| tsrs / checker | 6.54, 6.72, 6.59 | 2.32, 2.08, 2.18 | 1650.18, 1646.79, 1642.64 | 805.72, 802.21, 801.16 | 2 |
| tsrs / full | 11.53, 11.29, 11.01 | 7.22, 6.44, 6.58 | 1645.00, 1638.82, 1646.44 | 798.25, 800.57, 804.48 | 2 |
| tsrs4 / checker | 8.63, 9.00, 8.74 | 2.19, 1.78, 1.92 | 1479.32, 1478.51, 1492.77 | 800.25, 801.01, 804.20 | 2 |

| Tool / edit scenario | Seconds (1, 2, 3) | Median (s) | RSS MiB (1, 2, 3) | Exit | Diagnostics |
| --- | --- | ---: | --- | ---: | ---: |
| tsc / touched | 37.75, 37.38, 38.49 | 37.75 | 3140.95, 3140.58, 3162.55 | 2 | 14 |
| tsc / touch-restore | 36.95, 37.97, 37.03 | 37.03 | 3143.73, 3143.93, 3164.97 | 0 | 0 |
| native / touched | 18.95, 18.17, 19.68 | 18.95 | 2708.30, 2862.37, 2625.79 | 1 | 27 |
| native / touch-restore | 19.42, 20.35, 19.96 | 19.96 | 2854.06, 2857.09, 2846.18 | 1 | 13 |
| tsrs / touched | 4.50, 4.59, 4.76 | 4.59 | 1262.34, 1264.30, 1259.43 | 2 | 27 |
| tsrs / touch-restore | 5.05, 4.88, 4.58 | 4.88 | 1250.63, 1252.02, 1253.11 | 2 | 13 |

Restoring the file removes all 14 induced errors. The restored Go and Rust runs
still report their original 13 extras. No checker crashed or timed out; all
nonzero exits in the experiment accompanied expected diagnostic output. Every
baseline complete gate exited 0. The isolated project-reference fixtures wrote
real declarations and build info; all three tools exited 2 on their intentional
reference error. The ordinary `--noEmit` fixture exited 2 for JavaScript tsc,
1 for Go, and 2 for tsrs, despite identical normalized diagnostic text.

| Independent CLI probe | Seconds | RSS MiB | Exit | Extras versus baseline |
| --- | ---: | ---: | ---: | ---: |
| native | 6.44 | 841.40 | 1 | 3 |
| tsrs | 0.87 | 307.47 | 2 | 2 |

The one-minute system load sampled at measurement completion ranged from 1.43
to 13.02 on the 10-vCPU VM. No result was discarded as an outlier.

### File coverage

After timing and negative probes, each tool also ran `--listFilesOnly` for both
projects. All 6,088 app root inputs and all 12 CLI root inputs were present.
The complete sets of files outside `node_modules` were identical between all
three checkers, including files reached by imports outside the root include set.
Total counts differ under `node_modules`, including compiler-bundled libraries;
the compiler/library versions intentionally differ in this experiment.

| Project | Tool | Total listed files | Files outside node_modules | Missing configured root inputs |
| --- | --- | ---: | ---: | ---: |
| App | JavaScript tsc | 14461 | 6170 | 0 |
| App | Stable native | 14452 | 6170 | 0 |
| App | tsrs | 14456 | 6170 | 0 |
| CLI | JavaScript tsc | 3125 | 1149 | 0 |
| CLI | Stable native | 3079 | 1149 | 0 |
| CLI | tsrs | 3083 | 1149 | 0 |

Exact file-list commands, run after the timed samples:

```sh
for compiler in typescript typescript-native tsrs; do
  executable=node_modules/$compiler/bin/tsc
  if [ "$compiler" = tsrs ]; then executable=node_modules/tsrs/bin/tsrs; fi
  node "$executable" --noEmit --listFilesOnly
  node "$executable" --noEmit --listFilesOnly --project cli/tsconfig.chat.json
done
```

## Diagnostic comparison

The clean 5.8.2 baseline has empty diagnostic output. Neither candidate is an
exact replacement. The following table lists **every extra repository
location/code**; there are no missing baseline diagnostics on the clean project.
The ordinary root runs, full-gate attempts, and restored-file runs have identical
diagnostic output within each tool (15 captures per tool). The four-worker tsrs
control has the same output as default tsrs in all six captures. Each tool's
three touched-file captures also match one another byte for byte.

| File (line, column) | Code | Go extra | tsrs extra | Also in CLI probe |
| --- | --- | --- | --- | --- |
| `scripts/next/verify.ts(71,13)` | TS7022 | No | Yes | No |
| `src/app/api/customize/actions/github-source.test.ts(45,73)` | TS2345 | Yes | Yes | No |
| `src/app/api/customize/actions/github-source.test.ts(46,64)` | TS2345 | Yes | Yes | No |
| `src/app/api/mobile/media/route.ts(75,25)` | TS2345 | Yes | Yes | No |
| `src/app/api/panel/file-asset/route.ts(102,25)` | TS2345 | Yes | Yes | No |
| `src/app/api/panel/serve-image/route.ts(64,29)` | TS2345 | Yes | Yes | No |
| `src/app/api/tts/route.ts(48,29)` | TS2345 | Yes | Yes | No |
| `src/components/desktop/repo-registry/add-repo-flow.test.ts(53,100)` | TS2769 | Yes | Yes | No |
| `src/lib/claude-code/metered-gateway.ts(177,85)` | TS2769 | Yes | Yes | Go, tsrs |
| `src/lib/feedback/hosted-report.ts(36,46)` | TS2322 | Yes | Yes | No |
| `src/lib/mobile/push-client.ts(171,7)` | TS2322 | Yes | Yes | No |
| `src/lib/mobile/relay-http-replay.ts(64,7)` | TS2769 | Yes | Yes | No |
| `src/lib/push/send.ts(103,7)` | TS2769 | Yes | Yes | Go, tsrs |
| `src/lib/supervisor/inbox.ts(727,21)` | TS2871 | Yes | No | Go |

Both candidates preserve all 14 induced dependent-file diagnostic locations and
codes. Each adds its 13 clean-project extras, for 27 diagnostics after the edit.
At four of the preserved locations, the full rendered message differs from
5.8.2 (ordering, quoting, and truncation of printed types):

| Preserved location | Code | Go rendered text | tsrs rendered text |
| --- | --- | --- | --- |
| `src/components/desktop/thoughts/InputButtons.tsx(543,11)` | TS2322 | Changed | Changed |
| `src/components/desktop/thoughts/composer-selector/ComposerPiSelection.test.ts(32,35)` | TS2769 | Changed | Changed |
| `src/components/desktop/thoughts/composer-selector/WorkerOpenRouterSelection.test.ts(28,40)` | TS2769 | Changed | Changed |
| `src/components/desktop/thoughts/composer-selector/useComposerSelectorState.ts(236,7)` | TS2345 | Changed | Changed |

Thus no baseline location/code was lost in these negative probes, but exact
output parity still fails. The Buffer/ArrayBuffer errors and other differences
are version-sensitive observations; this experiment does not establish whether
each difference is a language/library change or a compiler defect. In
particular, tsrs adds TS7022 where stable Go does not, while stable Go adds
TS2871 where tsrs does not. Their upstream compiler versions differ.

### Saved diagnostic output and diffs

Raw stdout, stderr, exit statuses, and GNU time reports were saved per invocation
during the experiment. The diagnostic output is preserved below as canonical
captures plus unified diffs, which reconstruct each candidate's complete output.
Application paths and message text are unchanged. Only fixture directory prefixes
are normalized. Route-test timing banners and the existing Vite configuration
warning are not TypeScript diagnostics and are excluded from diagnostic diffs.
The checker-only baseline's stdout and stderr are both empty (SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).

The exact application comparison is reproducible with these per-run captures:

```sh
diff -u tsc-checker-cold-1.stdout native-checker-cold-1.stdout
diff -u tsc-checker-cold-1.stdout tsrs-checker-cold-1.stdout
diff -u tsc-touched-1.stdout native-touched-1.stdout
diff -u tsc-touched-1.stdout tsrs-touched-1.stdout
```

For brevity, the Rust changed-file capture is stored as a diff against the Go
changed-file capture; together with the baseline and Go diff it reconstructs
the exact same baseline-to-Rust comparison.

<details>
<summary>Stable native clean-project diagnostics (13 extras)</summary>

```text
src/app/api/customize/actions/github-source.test.ts(45,73): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/app/api/customize/actions/github-source.test.ts(46,64): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/app/api/mobile/media/route.ts(75,25): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/app/api/panel/file-asset/route.ts(102,25): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/app/api/panel/serve-image/route.ts(64,29): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/app/api/tts/route.ts(48,29): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/components/desktop/repo-registry/add-repo-flow.test.ts(53,100): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Object literal may only specify known properties, and 'onRepoAdded' does not exist in type 'Attributes'.
src/lib/claude-code/metered-gateway.ts(177,85): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Buffer<ArrayBufferLike> | undefined' is not assignable to type 'BodyInit | null | undefined'.
      Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
        Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/lib/feedback/hosted-report.ts(36,46): error TS2322: Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BlobPart'.
  Type 'Buffer<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is missing the following properties from type 'ArrayBuffer': resizable, resize, detached, transfer, transferToFixedLength
src/lib/mobile/push-client.ts(171,7): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'string | BufferSource | null | undefined'.
  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is missing the following properties from type 'ArrayBuffer': resizable, resize, detached, transfer, transferToFixedLength
src/lib/mobile/relay-http-replay.ts(64,7): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Buffer<ArrayBufferLike> | undefined' is not assignable to type 'BodyInit | null | undefined'.
      Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
        Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/lib/push/send.ts(103,7): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
      Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
src/lib/supervisor/inbox.ts(727,21): error TS2871: This expression is always nullish.
```

</details>

<details>
<summary>Rust clean-project diff versus stable native (13 extras, different set)</summary>

```diff
--- native-clean
+++ tsrs-clean
@@ -1,3 +1,4 @@
+scripts/next/verify.ts(71,13): error TS7022: 'native' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer.
 src/app/api/customize/actions/github-source.test.ts(45,73): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
   Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
 src/app/api/customize/actions/github-source.test.ts(46,64): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
@@ -37,4 +38,3 @@
   The last overload gave the following error.
     Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
       Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
-src/lib/supervisor/inbox.ts(727,21): error TS2871: This expression is always nullish.
```

</details>

<details>
<summary>JavaScript baseline after the one-file edit (14 diagnostics)</summary>

```text
src/components/desktop/onboarding/OnboardingDispatchStep.tsx(273,89): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
src/components/desktop/onboarding/OnboardingDispatchStep.tsx(281,87): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
src/components/desktop/thoughts/InputButtons.tsx(543,11): error TS2322: Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "o8" | "codex" | "claude" | "opencode" | "muse" | "hermes" | "openclaw" | "acp"; label: string; searchable?: boolean | undefined; }[]' is not assignable to type 'ComposerModelGroup[]'.
  Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "claude" | "codex" | "openclaw" | "hermes" | "o8" | "opencode" | "acp" | "muse"; label: string; searchable?: boolean; }' is not assignable to type 'ComposerModelGroup'.
    Types of property 'options' are incompatible.
      Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
        Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
          Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
            Types of property 'label' are incompatible.
              Type 'unknown' is not assignable to type 'string'.
src/components/desktop/thoughts/ModelThinkingChip.tsx(168,13): error TS2322: Type 'ComposerModelOption | { value: string; label: string; triggerLabel: unknown; backend: "claude"; model: string; sub: string; }' is not assignable to type 'ComposerModelOption'.
  Type '{ value: string; label: string; triggerLabel: unknown; backend: "claude"; model: string; sub: string; }' is not assignable to type 'ComposerModelOption'.
    Types of property 'triggerLabel' are incompatible.
      Type 'unknown' is not assignable to type 'string | undefined'.
src/components/desktop/thoughts/ModelThinkingChip.tsx(172,15): error TS2322: Type 'unknown' is not assignable to type 'string | undefined'.
src/components/desktop/thoughts/chat-panel/TurnSummaryCard.tsx(124,9): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
src/components/desktop/thoughts/chat-panel/TurnSummaryCard.tsx(133,58): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
src/components/desktop/thoughts/composer-selector/ComposerPiSelection.test.ts(32,35): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
      Type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
        Types of property 'composerModelGroups' are incompatible.
          Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "o8" | "codex" | "claude" | "opencode" | "muse" | "hermes" | "openclaw" | "acp"; label: string; searchable?: boolean | undefined; }[]' is not assignable to type 'ComposerModelGroup[]'.
            Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "claude" | "codex" | "openclaw" | "hermes" | "o8" | "opencode" | "acp" | "muse"; label: string; searchable?: boolean; }' is not assignable to type 'ComposerModelGroup'.
              Types of property 'options' are incompatible.
                Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
                  Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
                    Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
                      Types of property 'label' are incompatible.
                        Type 'unknown' is not assignable to type 'string'.
src/components/desktop/thoughts/composer-selector/WorkerOpenRouterSelection.test.ts(28,40): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
      Type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
        Types of property 'composerModelGroups' are incompatible.
          Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "o8" | "codex" | "claude" | "opencode" | "muse" | "hermes" | "openclaw" | "acp"; label: string; searchable?: boolean | undefined; }[]' is not assignable to type 'ComposerModelGroup[]'.
            Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "claude" | "codex" | "openclaw" | "hermes" | "o8" | "opencode" | "acp" | "muse"; label: string; searchable?: boolean; }' is not assignable to type 'ComposerModelGroup'.
              Types of property 'options' are incompatible.
                Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
                  Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
                    Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
                      Types of property 'label' are incompatible.
                        Type 'unknown' is not assignable to type 'string'.
src/components/desktop/thoughts/composer-selector/useComposerSelectorState.ts(236,7): error TS2345: Argument of type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to parameter of type 'readonly ComposerLeadCatalogueOption[]'.
  Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerLeadCatalogueOption'.
    Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerLeadCatalogueOption'.
      Types of property 'label' are incompatible.
        Type 'unknown' is not assignable to type 'string'.
src/components/desktop/thoughts/useBackendSwitchChoice.ts(20,3): error TS2322: Type 'unknown' is not assignable to type 'string'.
src/components/mobile/OrchestratorView.tsx(77,3): error TS2322: Type 'unknown' is not assignable to type 'string'.
src/lib/slash-commands/handoff.ts(51,13): error TS2322: Type 'unknown' is not assignable to type 'string'.
src/lib/slash-commands/handoff.ts(65,11): error TS2322: Type 'unknown' is not assignable to type 'string'.
```

</details>

<details>
<summary>Stable native changed-file diff versus baseline (27 diagnostics)</summary>

```diff
--- tsc-touched
+++ native-touched
@@ -1,11 +1,26 @@
+src/app/api/customize/actions/github-source.test.ts(45,73): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
+  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/app/api/customize/actions/github-source.test.ts(46,64): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
+  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/app/api/mobile/media/route.ts(75,25): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
+  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/app/api/panel/file-asset/route.ts(102,25): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
+  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/app/api/panel/serve-image/route.ts(64,29): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
+  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/app/api/tts/route.ts(48,29): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
+  Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
 src/components/desktop/onboarding/OnboardingDispatchStep.tsx(273,89): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
 src/components/desktop/onboarding/OnboardingDispatchStep.tsx(281,87): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
-src/components/desktop/thoughts/InputButtons.tsx(543,11): error TS2322: Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "o8" | "codex" | "claude" | "opencode" | "muse" | "hermes" | "openclaw" | "acp"; label: string; searchable?: boolean | undefined; }[]' is not assignable to type 'ComposerModelGroup[]'.
-  Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "claude" | "codex" | "openclaw" | "hermes" | "o8" | "opencode" | "acp" | "muse"; label: string; searchable?: boolean; }' is not assignable to type 'ComposerModelGroup'.
+src/components/desktop/repo-registry/add-repo-flow.test.ts(53,100): error TS2769: No overload matches this call.
+  The last overload gave the following error.
+    Object literal may only specify known properties, and 'onRepoAdded' does not exist in type 'Attributes'.
+src/components/desktop/thoughts/InputButtons.tsx(543,11): error TS2322: Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | { ...; })[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
+  Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | { ...; })[]; }' is not assignable to type 'ComposerModelGroup'.
     Types of property 'options' are incompatible.
       Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
         Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
-          Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
+          Type '{ value: string; label: unknown; backend: 'codex'; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
             Types of property 'label' are incompatible.
               Type 'unknown' is not assignable to type 'string'.
 src/components/desktop/thoughts/ModelThinkingChip.tsx(168,13): error TS2322: Type 'ComposerModelOption | { value: string; label: string; triggerLabel: unknown; backend: "claude"; model: string; sub: string; }' is not assignable to type 'ComposerModelOption'.
@@ -17,36 +32,61 @@
 src/components/desktop/thoughts/chat-panel/TurnSummaryCard.tsx(133,58): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
 src/components/desktop/thoughts/composer-selector/ComposerPiSelection.test.ts(32,35): error TS2769: No overload matches this call.
   The last overload gave the following error.
-    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
-      Type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+      Type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
         Types of property 'composerModelGroups' are incompatible.
-          Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "o8" | "codex" | "claude" | "opencode" | "muse" | "hermes" | "openclaw" | "acp"; label: string; searchable?: boolean | undefined; }[]' is not assignable to type 'ComposerModelGroup[]'.
-            Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "claude" | "codex" | "openclaw" | "hermes" | "o8" | "opencode" | "acp" | "muse"; label: string; searchable?: boolean; }' is not assignable to type 'ComposerModelGroup'.
+          Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | { ...; })[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
+            Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | { ...; })[]; }' is not assignable to type 'ComposerModelGroup'.
               Types of property 'options' are incompatible.
                 Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
                   Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
-                    Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
+                    Type '{ value: string; label: unknown; backend: 'codex'; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
                       Types of property 'label' are incompatible.
                         Type 'unknown' is not assignable to type 'string'.
 src/components/desktop/thoughts/composer-selector/WorkerOpenRouterSelection.test.ts(28,40): error TS2769: No overload matches this call.
   The last overload gave the following error.
-    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
-      Type '{ state: ResolvedComposerSelectorState; defaults: { claudeCodeProviderModel: string | null; defaultDispatchRuntime: OrchestratorRuntime; ... 5 more ...; claudeWorkerEffort?: ThinkingEffort; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+      Type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
         Types of property 'composerModelGroups' are incompatible.
-          Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "o8" | "codex" | "claude" | "opencode" | "muse" | "hermes" | "openclaw" | "acp"; label: string; searchable?: boolean | undefined; }[]' is not assignable to type 'ComposerModelGroup[]'.
-            Type '{ options: (ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]; key: "claude" | "codex" | "openclaw" | "hermes" | "o8" | "opencode" | "acp" | "muse"; label: string; searchable?: boolean; }' is not assignable to type 'ComposerModelGroup'.
+          Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | { ...; })[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
+            Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | { ...; })[]; }' is not assignable to type 'ComposerModelGroup'.
               Types of property 'options' are incompatible.
                 Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
                   Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
-                    Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
+                    Type '{ value: string; label: unknown; backend: 'codex'; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
                       Types of property 'label' are incompatible.
                         Type 'unknown' is not assignable to type 'string'.
 src/components/desktop/thoughts/composer-selector/useComposerSelectorState.ts(236,7): error TS2345: Argument of type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to parameter of type 'readonly ComposerLeadCatalogueOption[]'.
   Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerLeadCatalogueOption'.
-    Type '{ value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerLeadCatalogueOption'.
+    Type '{ value: string; label: unknown; backend: 'codex'; model: string | undefined; sub: string; }' is not assignable to type 'ComposerLeadCatalogueOption'.
       Types of property 'label' are incompatible.
         Type 'unknown' is not assignable to type 'string'.
 src/components/desktop/thoughts/useBackendSwitchChoice.ts(20,3): error TS2322: Type 'unknown' is not assignable to type 'string'.
 src/components/mobile/OrchestratorView.tsx(77,3): error TS2322: Type 'unknown' is not assignable to type 'string'.
+src/lib/claude-code/metered-gateway.ts(177,85): error TS2769: No overload matches this call.
+  The last overload gave the following error.
+    Type 'Buffer<ArrayBufferLike> | undefined' is not assignable to type 'BodyInit | null | undefined'.
+      Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
+        Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/lib/feedback/hosted-report.ts(36,46): error TS2322: Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BlobPart'.
+  Type 'Buffer<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
+    Types of property 'buffer' are incompatible.
+      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
+        Type 'SharedArrayBuffer' is missing the following properties from type 'ArrayBuffer': resizable, resize, detached, transfer, transferToFixedLength
+src/lib/mobile/push-client.ts(171,7): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'string | BufferSource | null | undefined'.
+  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
+    Types of property 'buffer' are incompatible.
+      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
+        Type 'SharedArrayBuffer' is missing the following properties from type 'ArrayBuffer': resizable, resize, detached, transfer, transferToFixedLength
+src/lib/mobile/relay-http-replay.ts(64,7): error TS2769: No overload matches this call.
+  The last overload gave the following error.
+    Type 'Buffer<ArrayBufferLike> | undefined' is not assignable to type 'BodyInit | null | undefined'.
+      Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
+        Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
+src/lib/push/send.ts(103,7): error TS2769: No overload matches this call.
+  The last overload gave the following error.
+    Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'.
+      Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
 src/lib/slash-commands/handoff.ts(51,13): error TS2322: Type 'unknown' is not assignable to type 'string'.
 src/lib/slash-commands/handoff.ts(65,11): error TS2322: Type 'unknown' is not assignable to type 'string'.
+src/lib/supervisor/inbox.ts(727,21): error TS2871: This expression is always nullish.
```

</details>

<details>
<summary>Rust changed-file diff versus stable native (27 diagnostics)</summary>

```diff
--- native-touched
+++ tsrs-touched
@@ -1,3 +1,4 @@
+scripts/next/verify.ts(71,13): error TS7022: 'native' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer.
 src/app/api/customize/actions/github-source.test.ts(45,73): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
   Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
 src/app/api/customize/actions/github-source.test.ts(46,64): error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'BodyInit | null | undefined'.
@@ -15,8 +16,8 @@
 src/components/desktop/repo-registry/add-repo-flow.test.ts(53,100): error TS2769: No overload matches this call.
   The last overload gave the following error.
     Object literal may only specify known properties, and 'onRepoAdded' does not exist in type 'Attributes'.
-src/components/desktop/thoughts/InputButtons.tsx(543,11): error TS2322: Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | { ...; })[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
-  Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | { ...; })[]; }' is not assignable to type 'ComposerModelGroup'.
+src/components/desktop/thoughts/InputButtons.tsx(543,11): error TS2322: Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | ...)[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
+  Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | ...)[]; }' is not assignable to type 'ComposerModelGroup'.
     Types of property 'options' are incompatible.
       Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
         Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
@@ -32,11 +33,11 @@
 src/components/desktop/thoughts/chat-panel/TurnSummaryCard.tsx(133,58): error TS2322: Type 'unknown' is not assignable to type 'ReactNode'.
 src/components/desktop/thoughts/composer-selector/ComposerPiSelection.test.ts(32,35): error TS2769: No overload matches this call.
   The last overload gave the following error.
-    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
-      Type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: ...; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ... | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+      Type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: ...; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
         Types of property 'composerModelGroups' are incompatible.
-          Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | { ...; })[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
-            Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | { ...; })[]; }' is not assignable to type 'ComposerModelGroup'.
+          Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | ...)[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
+            Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | ...)[]; }' is not assignable to type 'ComposerModelGroup'.
               Types of property 'options' are incompatible.
                 Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
                   Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
@@ -45,11 +46,11 @@
                         Type 'unknown' is not assignable to type 'string'.
 src/components/desktop/thoughts/composer-selector/WorkerOpenRouterSelection.test.ts(28,40): error TS2769: No overload matches this call.
   The last overload gave the following error.
-    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
-      Type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: { ...; }; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+    Argument of type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: ...; }' is not assignable to parameter of type 'Attributes & { state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ... | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
+      Type '{ state: ResolvedComposerSelectorState; defaults: { defaultDispatchRuntime: OrchestratorRuntime; defaultDispatchModel: string; opencodeWorkerModel: string | null; ... 4 more ...; claudeCodeProviderModel: string | null; }; ... 13 more ...; workerLocks: ...; }' is not assignable to type '{ state: ResolvedComposerSelectorState; composerModelGroups: ComposerModelGroup[]; onModelChange?: ((model: string) => void) | undefined; ... 4 more ...; saving?: boolean | undefined; }'.
         Types of property 'composerModelGroups' are incompatible.
-          Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | { ...; })[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
-            Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | { ...; })[]; }' is not assignable to type 'ComposerModelGroup'.
+          Type '{ key: "acp" | "claude" | "codex" | "hermes" | "muse" | "o8" | "openclaw" | "opencode"; label: string; searchable?: boolean | undefined; options: (ComposerModelOption | ...)[]; }[]' is not assignable to type 'ComposerModelGroup[]'.
+            Type '{ key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8' | 'opencode' | 'acp' | 'muse'; label: string; searchable?: boolean; options: (ComposerModelOption | ...)[]; }' is not assignable to type 'ComposerModelGroup'.
               Types of property 'options' are incompatible.
                 Type '(ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; })[]' is not assignable to type 'ComposerModelOption[]'.
                   Type 'ComposerModelOption | { value: string; label: unknown; backend: "codex"; model: string | undefined; sub: string; }' is not assignable to type 'ComposerModelOption'.
@@ -89,4 +90,3 @@
       Type 'Buffer<ArrayBufferLike>' is missing the following properties from type 'URLSearchParams': size, append, delete, get, and 2 more.
 src/lib/slash-commands/handoff.ts(51,13): error TS2322: Type 'unknown' is not assignable to type 'string'.
 src/lib/slash-commands/handoff.ts(65,11): error TS2322: Type 'unknown' is not assignable to type 'string'.
-src/lib/supervisor/inbox.ts(727,21): error TS2871: This expression is always nullish.
```

</details>

<details>
<summary>Ordinary/cross-file and project-reference fixtures (identical for all tools)</summary>

```text
FIXTURE/import.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.
FIXTURE/import.ts(3,10): error TS2305: Module '"./export"' has no exported member 'missing'.
FIXTURE/ordinary.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
FIXTURE/references/app/index.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

</details>

## Delivery validation

The dependency installation preserved every existing locked package version.
The two experiment-only development dependencies and lockfile additions were
removed from the committed manifests by restoring the original bytes. The
controlled source edit was also restored byte for byte. The PR contains this
document only. Its external links, recorded medians, diagnostic diffs, and
public-artifact hygiene were checked; all 75 timing/RSS/exit receipts matched
their saved GNU time reports. Applying the saved diffs reconstructed the
candidate diagnostic stdout byte for byte. `git diff --check`, the documentation
drift dry run, and the read-only roadmap status check passed. Dependency cleanup
removes only this worktree's
`node_modules` after measurement; the branch and benchmark evidence remain.
