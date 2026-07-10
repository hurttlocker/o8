> **⚠️ HOLD MERGE — read this first (updated after 0.1.578 shipped).**
> 0.1.578 (disclaimed spawn) did NOT fix capture: the helper still records
> -91 dB silence and no permission prompt appears. Worse, my permission
> diagnosis was WRONG. tccd receipts on the affected machine show the
> disclaimed helper's `kTCCServiceMicrophone` resolves **Allowed**, and the
> `kTCCServiceAudioCapture: Unknown (None)` verdict I flagged as the smoking
> gun is **normal** — a Terminal-run ffmpeg capturing real audio at -28.8 dB
> gets the identical verdict (control run, 2026-07-10 10:04Z).
>
> **The zero-fill is therefore NOT a TCC permission problem.** Root cause is
> still OPEN. My earlier "disclaim spawn = real audio" validation was
> confounded: it was spawned from python under Terminal (a responsible
> process with healthy capture), not from o8.app.
>
> What is safe to merge here: the honest error message + the zero-fill/stall
> watchdogs (they make the failure loud), and the speak-selection chord fix
> (independent, verified reasoning). The disclaimed spawn itself is
> behavior-neutral-with-fallback but is NOT the cure — do not ship it as one.
>
> **A/B evidence (2026-07-10 10:20Z, Intel MacBook, back-to-back):**
> | Helper | Spawned by | Result |
> |---|---|---|
> | shipped 0.1.576 (pre-fix) | Terminal | **no WAV at all** — the cold-start stall |
> | this branch's helper | Terminal | **-17.9 dB, perfect transcript**, zero health events |
> | this branch's helper | **o8.app** | **-91 dB zeros** + rebuild churn |
>
> So: the helper is correct, the mic is correct, TCC is correct. Capture only
> dies when **o8.app is the parent**. The engine-recreation fix genuinely
> repairs the stall (row 1 → row 2). The zero-fill is an APP-PROCESS
> phenomenon and it predates this branch (a -91 dB WAV was captured from the
> stock 0.1.576 app before any helper swap).
>
> **Next experiment (decisive, not yet run — needs a build):** boot o8 with
> `sound::spawn_worker()` and TTS init disabled, and with whatever opens an
> audio INPUT client in the app process (tccd shows `ai.o8.desktop` itself
> requesting kTCCServiceMicrophone at 09:49:13Z — why does the APP need the
> mic if the helper does the capture?). Measure the helper's WAV level. If
> levels come back, the app's own CoreAudio client is starving the helper's
> input AUHAL on Intel — the fix is to stop opening it, or to move capture
> fully into one process.
>
> **Also note:** the config-change observer this branch adds fires during its
> own rebuild in-app (`config_changed_rebuilding` → `stalled_rebuilding` →
> `zero_fill` inside 2s, 13:54:42-44Z). It does not reproduce standalone, but
> it should be fenced (ignore notifications while a rebuild is in flight)
> before this lands, regardless of the root cause.

# fix(voice): spawn speech helper with disclaimed TCC responsibility — cures zero-filled Intel capture (#1534 follow-up)

**Branch:** `fix/intel-mic-tcc-disclaim` → `main`. Follow-up to #1535 (which fixed the engine cold-restart stall and added the capture watchdogs). Refs #1534.

## The remaining bug (proven live on the Intel MacBook, 0.1.577)

With #1535 shipped, the stall watchdogs work (health events fire, engine rebuilds) — but Finder-launched dictation still records **exact digital silence**: -91.0 dB WAVs, zero-valued buffers flowing normally. tccd logs show the helper's mic requests resolving through the app as responsible process and returning **Allowed** — the zero-fill happens BELOW TCC, in CoreAudio's treatment of the attribution chain. Matrix on the same machine, same minute, same binary:

| Spawn shape | Capture |
|---|---|
| Helper spawned by o8.app (any launch mode) | ❌ zeros (-91.0 dB) |
| Helper run directly from a terminal | ✅ real audio |
| **Helper posix_spawned with `responsibility_spawnattrs_setdisclaim(1)`** | ✅ **real audio, transcribed correctly** |

The third row is this PR — validated empirically against the exact shipped 0.1.577 helper binary before writing the Rust.

## What changed (`src/stt/mod.rs` only)

- `spawn_helper()`: on macOS, spawn the helper via raw `posix_spawn` with **TCC responsibility disclaimed** (`responsibility_spawnattrs_setdisclaim` — the same private-but-stable libSystem API Chromium uses for its helper processes). The helper becomes its own TCC client: macOS prompts once for "o8 Speech Helper" (usage strings already ship in its embedded Info.plist) and creates a helper-keyed TCC entry — the attribution shape that demonstrably captures. **Any failure on the disclaim path falls back to the classic `Command` spawn (exact status-quo behavior), so dictation can never regress.**
- `DaemonChild` enum wraps both spawn shapes behind `id()/poll()/kill_and_reap()`; `is_running`/`respawn`/`shutdown`/`Drop` semantics preserved 1:1 (SIGTERM grace → 3s → SIGKILL; stdin-EOF still quits the daemon).
- Spawn path is logged via `log::` (`[stt] helper spawned with disclaimed TCC responsibility` / fallback warning) so the field evidence shows which shape is running.

## Also in this PR: speak-selection dead under remote control (one-line fix)

`wait_for_chord_release` polled CGEventSourceFlagsState(1) believing 1 = combined session state — 1 is actually kCGEventSourceStateHIDSystemState (hardware-only). Chords injected by Chrome Remote Desktop are synthetic and never appear in hardware state, so the poll returned "released" instantly and the synthetic Cmd+C merged with the still-held Ctrl+Shift → "no selection to speak" every time the operator drove the machine remotely (field log 04:40Z). Fixed to 0 (combined = hardware + synthetic). The similar constant in fn_hotkey's poll fallback is intentionally untouched (it only ever arms on hardware Fn, where hardware state is correct).

## UX note for review

First dictation after this ships will raise ONE new macOS prompt: "o8 Speech Helper" wants to use the microphone (and possibly Speech Recognition). That is by design — the helper needs its own grant. Consider a release-note line. If the prompt is deemed unacceptable, the alternative is moving capture into the main app process (architecture change — the app's own mic attribution is healthy per tccd logs).

## Verification

- `cargo test --lib`: 116 passed. `npx tsc --noEmit`: clean (no TS touched).
- Disclaim mechanism validated against the shipped signed helper on the Intel MacBook: real audio, correct transcription, WAV at healthy levels — same session in which app-spawned capture produced -91.0 dB zeros.
- Debug-app boot smoke was inconclusive on the Intel machine (debug binary exits without a frontend); the mechanism-level validation above is the load-bearing evidence, and the fallback path guarantees no regression if the disclaim spawn errors at runtime.
- **Ship verification on the Intel MacBook**: install signed build → dictate → click Allow on the helper prompt → dictate into Notes/TextEdit twice >20s apart — both should now land end-to-end (capture fixed here + delivery/stall fixed in #1535).

## Apple Silicon risk

Low. The disclaim path runs identically on AS; capture there was already healthy, and a working attribution stays working (helper gets its own grant on first prompt). Fallback path is byte-for-byte today's spawn. Lifecycle (respawn/shutdown/Drop) covered by the existing 116-test suite + preserved semantics.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
