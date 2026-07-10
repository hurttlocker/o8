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
