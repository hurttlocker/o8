# Mission: land + ship the #1534 Intel dictation fix (branch `fix/intel-paste-delivery`)

You are the o8 orchestrator on the iMac. The MacBook agent finished the #1534 investigation and pushed a fix branch. Your job: review, open the PR, merge, ship signed, then run the verification protocol on the Intel MacBook. Everything below is its handoff.

## What the MacBook agent found (trust this, it's instrumented, not guessed)

**The paste seam was NOT the bug.** On the Intel MacBook (15.7.8, v0.1.576): AX trusted, no SecureInput, no translocation, and the synthetic Cmd+V chain delivered 12/13 content-verified pastes into TextEdit — including one full real dictation (Fn → STT → finalize → paste: "Session 5, Charlie Delta." landed). Dictation "never delivers" because **capture dies upstream** and finalize correctly refuses to paste an empty transcript. Two stacked bugs:

1. **Cold-restart AUHAL stall** (the regression — shipped in `010e2d58` Jul 8, matches "worked Jul 7, broken Jul 9"): after the 15s hot-linger stops the engine, reusing the stopped `AVAudioEngine` singleton reports `isRunning=true` but delivers ZERO tap callbacks for seconds — longer than a whole dictation. Field log signature: `complete`-only sessions (no `final`, no `audio_file`) at 23:36:55, 01:14, reproduced on demand. Proof it's engine reuse: a session started 2s after a dead one captured fine (the AUHAL had finally warmed), and first-after-boot sessions always worked (fresh engine).
2. **TCC zero-fill** (why clean installs are broken and the iMac never reproduces): the **app-spawned** helper receives exact-digital-zero buffers (-91.0 dB WAVs captured as evidence) while macOS reports the mic authorized. Same binary run directly from a terminal captures perfectly at the same moment — TCC attribution. Sydney's clean-install MacBook = same signature.

## What's on the branch (1 commit, `44d42975`, 3 files)

- `helpers/speech_recognizer.swift`: recreate the AVAudioEngine on every cold start (fresh engine ≙ the always-prompt first start; the fix `applySelectedInputDevice`'s KNOWN LIMITATION comment already prescribes); 450ms zero-buffer watchdog (rebuilds once mid-session, surfaces an error instead of finalizing empty); `.AVAudioEngineConfigurationChange` observer; **zero-fill detector** (buffers flowing but session peak == exact 0.0 for 1.5s → `audio_engine_zero_fill` status + actionable error — a real mic never sits at exact zero).
- `src/paste.rs`: frontmost-verified focus settle (poll, 250ms cap, ~35ms on fast machines — replaces fixed 35ms) and arch-scaled clipboard restore (x86_64 1800ms, aarch64 unchanged 700ms; ClipboardGuard semantics untouched); paste outcomes now `log::` so they reach o8.log in prod.
- `src/stt/mod.rs`: helper error/health events now `log::`-logged. (Everything in these paths was `tracing::` → stdout → **discarded by bundled apps** — why #1534 was dark in the field.)

Checks: `cargo test --lib` 116 passed; `npx tsc --noEmit` clean; helper verified standalone on the Intel machine (fresh/cold/rapid sessions transcribe; watchdogs quiet on healthy capture, no false positives).

## Your steps

1. `git fetch && git checkout fix/intel-paste-delivery` — review the diff (small, 3 files). Full PR body draft is on the MacBook at `~/o8-pr-1534-body.md`; the commit message of `44d42975` is a faithful summary if you can't reach it.
2. Open the PR → main referencing #1534 (gh is authed on your side; the MacBook's isn't — no issue comment was posted, add one linking the PR).
3. Merge per normal review flow, then ship signed (`npm version patch` → `git push --follow-tags` → `npm run ship`).
4. **Verification protocol on the Intel MacBook** (it was rebooted tonight — required, its tccd state was churned during diagnosis):
   - Let it auto-update (or install fresh), launch o8 from Finder/Dock normally.
   - Dictate TWICE, >20 seconds apart, into Notes, TextEdit, and a webview field. The SECOND dictation is the real test (exercises the cold-restart path). Verify text content actually lands.
   - Check `~/Library/Logs/ai.o8.desktop/o8.log` for the new `[paste] outcome=` lines and any `audio_engine_*` health warnings.
   - If the dock shows the new "macOS is delivering silent audio to o8" error → the TCC zero-fill layer persists on that machine even signed: the follow-up fix is spawning the helper with `responsibility_spawnattrs_setdisclaim` (own TCC identity + prompt) or a guided re-grant in onboarding. File it as a new issue referencing #1534 — the detector makes it user-visible now instead of a silent failure.
5. Also verify one dictation on the iMac itself (Apple Silicon regression check — expected: zero behavior change; cold-start adds ~tens of ms on an already-cold path).

## Machine-state notes from tonight (MacBook)

- Installed app restored bit-identical (helper swap experiments were reverted, hash-verified). Bundle `codesign --verify --strict` complains only about a pre-existing stray `Contents/Resources/server/.claude/settings.json` (someone's session wrote it; operator declined removal — harmless, but worth cleaning next ship).
- o8's Microphone + Speech Recognition TCC entries were reset and re-granted during diagnosis; the machine was rebooted after. If capture still fails post-reboot pre-update, terminal-launching `/Applications/o8.app/Contents/MacOS/o8` is the known-good workaround.
- Repo clone at `~/o8` on the fix branch (node_modules installed, `~/tauri-plugin-mcp` cloned as the sibling dep — it's the public P3GLEG repo; if you have a private fork, note the path expectation `../../tauri-plugin-mcp`).
- This laptop cannot verify signed-context mic behavior: no Developer ID cert, and Sequoia zero-fills adhoc-signed helpers spawned by the signed app (verified live — that's also your explanation for the old "-91 dB local Symon builds" mystery).
