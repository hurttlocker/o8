# Pure Rust GPUI transcript arm

Original Apache-2.0 benchmark implementation. The only UI dependency is the
published `gpui = 0.2.2` crate, default features disabled, with `font-kit` enabled.
No application editor, terminal, markdown or GPUIX code is copied or linked.
`Cargo.lock` pins the registry graph. [License audit](../results/pure-license-audit.json)
records normal/build edges for the measured target; no GPL package appears.
Transitive packages have their own declared licenses, including MPL build tools.

Run from the parent spike directory:

```sh
npm run build
cargo +1.97.1 build --manifest-path pure-gpui/Cargo.toml --release --locked --target x86_64-apple-darwin
node license-audit.mjs
node measure.mjs --only=pure
node summarize.mjs
```

The same generated fixture JSON must match its fixed SHA-256 before application
initialization. A variable-height GPUI list keeps all 2,000 logical turns with
cached text runs, lists, inline-code fonts, fenced code and tool-step rows. A
small local formatter supplies these primitives; it is not full markdown or
syntax-highlighted diff parity. No application-level editing crate is used.
The composer accepts text through GPUI's in-process keystroke dispatch.

The window has `show:false`, `focus:false`, no titlebar, and offscreen bounds.
No activation call or OS input API is used. A parent kills a native run at nine
seconds. Each step draws two CPU scenes, matching the prior GPUIX test-flush
boundary. A GPUI canvas paint callback acknowledges input and token state.
The last draw's CPU build/layout/paint duration is recorded separately from the
whole step. These callbacks do not establish GPU completion or presentation.

The first-frame marker follows the initial scene draw. The parent measures from
process spawn through receipt of that marker. Idle memory uses `ps rss` after
that frame and before streaming. This is a fresh process with uncontrolled
filesystem caches, not a power-on cold cache or a displayed-frame measurement.

`node validate-pure.mjs` checks the actual binary entry point with a changed
fixture: it must fail before creating an application or emitting a frame/result.
The three accepted runs supply the valid-fixture, input and stream receipts.
